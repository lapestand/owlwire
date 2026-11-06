import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { MAX_PAYLOAD_SCHEMA_BYTES } from '@owlwire/contracts';
import type { SchemaCheck } from './payload-schema-engine.js';
import type { WorkerRequest, WorkerResponse } from './payload-schema-worker.js';

export type { SchemaCheck };

/**
 * Hard limit for running a compiled validator on one payload inside a worker. Static limits
 * cannot bound what an app's schema costs to evaluate (ref fan-out, repeated `uniqueItems`,
 * ...), so a run that takes longer has its worker terminated and fails closed. Ordinary
 * payloads take well under a millisecond.
 */
const RUN_DEADLINE_MS = 250;
/**
 * Hard limit for compiling a schema (checkSchema, and a validate call whose validator is not
 * cached). Kept apart from the run deadline: a plain near-16 KB schema takes 100-250 ms to
 * compile, which must not make its events fail. A schema slower than this is refused.
 * Both deadlines count from the moment the call reaches a ready worker, not queue wait.
 */
const COMPILE_DEADLINE_MS = 2000;
const DEFAULT_MAX_QUEUED = 256;
const DEFAULT_MAX_ENTRIES = 500;
// Heap per worker; running out ends the worker like a timeout does.
const WORKER_HEAP_MB = 128;

const TOO_EXPENSIVE = 'payload too expensive to validate';
const SCHEMA_TOO_EXPENSIVE = 'payloadSchema too expensive to compile';
const BUSY = 'payload validator is busy';
const CLOSED = 'payload validator is closed';
const STOPPED = 'payload validator stopped unexpectedly';

type Request =
  | { op: 'check'; schema: unknown }
  | { op: 'validate'; key: string; schema: Record<string, unknown>; data: unknown };

interface Job {
  request: Request;
  resolve: (result: SchemaCheck) => void;
}

interface Running extends Job {
  id: number;
  timer: NodeJS.Timeout;
  /** Compiling until the worker reports `compiled`, then running the validator. */
  phase: 'compile' | 'run';
}

interface Slot {
  worker: Worker;
  ready: boolean;
  job: Running | null;
}

/**
 * The worker runs from source through the tsx loader in development and tests, and from the
 * file tsup emits next to main.js in the built server (an entry in tsup.config.ts).
 */
function workerEntry(): { url: URL; execArgv: string[] } {
  const here = import.meta.url;
  if (here.endsWith('.ts')) {
    const tsx = createRequire(here).resolve('tsx');
    return {
      url: new URL('./payload-schema-worker.ts', here),
      execArgv: ['--import', pathToFileURL(tsx).href],
    };
  }
  return { url: new URL('./payload-schema-worker.js', here), execArgv: [] };
}

const UNAVAILABLE: ReadonlySet<string> = new Set([BUSY, CLOSED, STOPPED]);

/**
 * True for a failure that says nothing about the schema or the payload: the validator could not
 * take the call (queue full, closed, or a worker that stopped). Callers report it as a retryable
 * server condition, not as invalid input.
 */
export function isValidatorUnavailable(check: SchemaCheck): boolean {
  return !check.ok && UNAVAILABLE.has(check.detail);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Checks and runs payload schemas registered by apps (untrusted input). All compilation and
 * validation happens in a small pool of worker threads, each with its own compiled-validator
 * cache (keyed by the caller's cache key, at most `maxEntries` per worker), so a hostile
 * schema can never block the main event loop, and every call has a hard deadline.
 *
 * Calls never reject. Failures come back as `{ ok: false, detail }`:
 * - compiling took longer than COMPILE_DEADLINE_MS (checkSchema, or validate on a cache miss):
 *   "payloadSchema too expensive to compile"; running the validator took longer than
 *   RUN_DEADLINE_MS: "payload too expensive to validate". Either way the worker is replaced;
 * - more than `maxQueued` calls are waiting for a worker: "payload validator is busy";
 * - after close(): "payload validator is closed".
 *
 * Workers are unreferenced while idle, so they never keep the process alive on their own;
 * close() terminates them.
 */
export class PayloadSchemaRegistry {
  readonly #poolSize: number;
  readonly #maxQueued: number;
  readonly #maxEntries: number;
  readonly #compileDeadlineMs: number;
  readonly #runDeadlineMs: number;
  readonly #slots: Slot[] = [];
  readonly #queue: Job[] = [];
  #nextId = 0;
  #closed = false;

  /** The deadline options exist for tests; production uses the constants. */
  constructor(
    opts: {
      maxEntries?: number;
      poolSize?: number;
      maxQueued?: number;
      compileDeadlineMs?: number;
      runDeadlineMs?: number;
    } = {},
  ) {
    this.#maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.#compileDeadlineMs = opts.compileDeadlineMs ?? COMPILE_DEADLINE_MS;
    this.#runDeadlineMs = opts.runDeadlineMs ?? RUN_DEADLINE_MS;
    this.#poolSize = Math.max(1, opts.poolSize ?? Math.min(2, availableParallelism()));
    this.#maxQueued = opts.maxQueued ?? DEFAULT_MAX_QUEUED;
  }

  checkSchema(schema: unknown): Promise<SchemaCheck> {
    let json: string | undefined;
    try {
      json = JSON.stringify(schema);
    } catch {
      json = undefined;
    }
    if (json === undefined)
      return Promise.resolve({ ok: false, detail: 'payloadSchema is not JSON' });
    if (Buffer.byteLength(json) > MAX_PAYLOAD_SCHEMA_BYTES) {
      return Promise.resolve({
        ok: false,
        detail: `payloadSchema exceeds ${MAX_PAYLOAD_SCHEMA_BYTES} bytes`,
      });
    }
    return this.#run({ op: 'check', schema });
  }

  validate(cacheKey: string, schema: Record<string, unknown>, data: unknown): Promise<SchemaCheck> {
    return this.#run({ op: 'validate', key: cacheKey, schema, data });
  }

  /** Stops every worker; pending and later calls resolve with "payload validator is closed". */
  async close(): Promise<void> {
    this.#closed = true;
    for (const job of this.#queue.splice(0)) job.resolve({ ok: false, detail: CLOSED });
    const slots = this.#slots.splice(0);
    await Promise.all(
      slots.map((slot) => {
        if (slot.job) this.#finish(slot, { ok: false, detail: CLOSED });
        return slot.worker.terminate();
      }),
    );
  }

  #run(request: Request): Promise<SchemaCheck> {
    if (this.#closed) return Promise.resolve({ ok: false, detail: CLOSED });
    if (this.#queue.length >= this.#maxQueued) return Promise.resolve({ ok: false, detail: BUSY });
    return new Promise((resolve) => {
      this.#queue.push({ request, resolve });
      this.#pump();
    });
  }

  #pump(): void {
    while (this.#queue.length > 0) {
      const slot = this.#slots.find((s) => s.ready && !s.job);
      if (!slot) break;
      const job = this.#queue.shift();
      if (job) this.#dispatch(slot, job);
    }
    // Work is waiting and no worker is free: fill the whole pool, so that a later timeout
    // (which takes one worker down) still leaves another one ready.
    if (this.#queue.length > 0) {
      while (this.#slots.length < this.#poolSize) this.#spawn();
    }
  }

  #dispatch(slot: Slot, job: Job): void {
    const id = ++this.#nextId;
    const timer = setTimeout(() => this.#expire(slot), this.#compileDeadlineMs);
    slot.job = { ...job, id, timer, phase: 'compile' };
    slot.worker.ref();
    try {
      slot.worker.postMessage({ id, ...job.request } satisfies WorkerRequest);
    } catch (err) {
      // The payload could not be cloned for the worker (not plain JSON data).
      this.#finish(slot, { ok: false, detail: `payload cannot be validated: ${messageOf(err)}` });
    }
  }

  /** Resolves the slot's current call and marks the worker idle. */
  #finish(slot: Slot, result: SchemaCheck): void {
    const job = slot.job;
    if (!job) return;
    clearTimeout(job.timer);
    slot.job = null;
    slot.worker.unref();
    job.resolve(result);
  }

  /** Detail for a call that missed its deadline or ran its worker out of memory. */
  #expensive(job: Running): string {
    return job.phase === 'compile' ? SCHEMA_TOO_EXPENSIVE : TOO_EXPENSIVE;
  }

  #expire(slot: Slot): void {
    if (slot.job) this.#finish(slot, { ok: false, detail: this.#expensive(slot.job) });
    this.#retire(slot);
    void slot.worker.terminate();
    if (!this.#closed) this.#spawn();
    this.#pump();
  }

  #retire(slot: Slot): void {
    const i = this.#slots.indexOf(slot);
    if (i >= 0) this.#slots.splice(i, 1);
  }

  #spawn(): void {
    const { url, execArgv } = workerEntry();
    const worker = new Worker(url, {
      execArgv,
      workerData: { maxEntries: this.#maxEntries },
      resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
    });
    const slot: Slot = { worker, ready: false, job: null };
    this.#slots.push(slot);
    worker.on('message', (msg: WorkerResponse) => {
      if (msg.type === 'ready') {
        slot.ready = true;
        if (!this.#closed) this.#pump();
        if (!slot.job) worker.unref();
      } else if (msg.type === 'compiled') {
        const job = slot.job;
        if (job?.id !== msg.id || job.phase !== 'compile') return;
        clearTimeout(job.timer);
        job.phase = 'run';
        job.timer = setTimeout(() => this.#expire(slot), this.#runDeadlineMs);
      } else if (slot.job?.id === msg.id) {
        this.#finish(slot, msg.result);
        this.#pump();
      }
    });
    // An 'error' event is always followed by 'exit'; the listener keeps it from being thrown.
    let outOfMemory = false;
    worker.on('error', (err: Error & { code?: string }) => {
      outOfMemory = err.code === 'ERR_WORKER_OUT_OF_MEMORY';
    });
    worker.on('exit', () => {
      if (!this.#slots.includes(slot)) return; // retired or closed on purpose
      this.#retire(slot);
      const job = slot.job;
      if (job) {
        this.#finish(slot, { ok: false, detail: outOfMemory ? this.#expensive(job) : STOPPED });
      }
      if (!slot.ready) {
        // It never started (broken entry or loader): fail what is waiting instead of looping.
        for (const job of this.#queue.splice(0)) job.resolve({ ok: false, detail: STOPPED });
        return;
      }
      this.#pump();
    });
  }
}
