// Worker thread entry for PayloadSchemaRegistry. It must not import workspace packages: in
// development it runs through the tsx loader without the vitest aliases or source conditions.
import { parentPort, workerData } from 'node:worker_threads';
import { PayloadSchemaEngine, type SchemaCheck } from './payload-schema-engine.js';

export type WorkerRequest =
  | { id: number; op: 'check'; schema: unknown }
  | { id: number; op: 'validate'; key: string; schema: Record<string, unknown>; data: unknown };

export type WorkerResponse =
  | { type: 'ready' }
  // Sent during a validate call once its validator is compiled (or cached), before it runs.
  | { type: 'compiled'; id: number }
  | { type: 'result'; id: number; result: SchemaCheck };

const port = parentPort;
if (!port) throw new Error('payload-schema-worker must run in a worker thread');

const { maxEntries } = workerData as { maxEntries: number };
const engine = new PayloadSchemaEngine({ maxEntries });

// Warm up before reporting ready: load Ajv, its meta-schemas and the RE2 adapter and run the
// common keywords once, so cold start is never charged to an app's first call.
const warmup = {
  $defs: { s: { type: 'string', maxLength: 8, pattern: '^[a-z]+$' } },
  type: 'object',
  required: ['a'],
  properties: {
    a: { $ref: '#/$defs/s' },
    n: { type: 'integer', minimum: 0 },
    l: { type: 'array', items: { enum: ['x', 'y'] }, uniqueItems: true },
  },
  patternProperties: { '^x-': { type: 'boolean' } },
  additionalProperties: false,
};
const warm = new PayloadSchemaEngine({ maxEntries: 1 });
warm.checkSchema(warmup);
warm.validate('warmup', warmup, { a: 'ab', n: 1, l: ['x'], 'x-a': true });
warm.validate('warmup', warmup, { a: 'AB' });

port.on('message', (req: WorkerRequest) => {
  const result =
    req.op === 'check'
      ? engine.checkSchema(req.schema)
      : engine.validate(req.key, req.schema, req.data, () =>
          port.postMessage({ type: 'compiled', id: req.id } satisfies WorkerResponse),
        );
  port.postMessage({ type: 'result', id: req.id, result } satisfies WorkerResponse);
});
port.postMessage({ type: 'ready' } satisfies WorkerResponse);
