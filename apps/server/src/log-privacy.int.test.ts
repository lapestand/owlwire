import { type ChannelAdapter, createFakeAdapter } from '@owlwire/adapter-sdk';
import { newId } from '@owlwire/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './http/app.js';
import { createLogger } from './logger.js';
import { ingestFor, seedDeliveryWorkspace } from './test/fixtures.js';
import { createHarness, type Harness } from './test/harness.js';
import { waitFor } from './test/wait.js';
import { startWorker } from './worker/runner.js';

/**
 * Log privacy against real failing queries: values that reach Postgres as query parameters (and come back in DrizzleQueryError
 * messages, pg `detail` rows and data-exception messages) never appear in pino output, problem+json bodies or
 * Graphile's `last_error`.
 */
const SECRET = 'SECRET-6012345678';
const botTokenLike = (tag: string) => `6012345678:AAH-${tag}-${SECRET}`;

/** A webhook adapter whose send fails with a token-like value in its error text (it lands in deliveries.last_error). */
const leakyAdapter: ChannelAdapter = {
  ...createFakeAdapter('webhook'),
  send: async () => {
    throw new Error(`401 Unauthorized for bot${botTokenLike('ADAPTER')}`);
  },
};

let h: Harness;

beforeAll(async () => {
  h = await createHarness({ adapters: [leakyAdapter] });
});
afterAll(async () => {
  await h.close();
});

function capture() {
  const lines: string[] = [];
  const logger = createLogger('debug', { write: (line: string) => void lines.push(line) });
  return { lines, logger };
}

async function seed() {
  return seedDeliveryWorkspace(h.deps.db, { platform: 'webhook', chatId: `chat-${newId()}` });
}

/** Message text of the error and its whole cause chain, plus pg fields: proves the raw error does carry the secret. */
function rawText(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur instanceof Error; i++) {
    parts.push(cur.message, String(cur.stack), JSON.stringify(cur));
    cur = cur.cause;
  }
  return parts.join('\n');
}

/** Rejects any row whose column text contains SECRET; NOT VALID so existing rows are not checked (DDL is fixed text). */
const SECRET_CHECKS = {
  events: {
    add: `alter table events add constraint events_no_secret_ck check (position('SECRET' in message::text) = 0) not valid`,
    drop: 'alter table events drop constraint events_no_secret_ck',
  },
  /** A uuid cast in a CHECK raises a real 22P02 whose message quotes the inserted value. */
  eventsUuidKey: {
    add: `alter table events add constraint events_key_uuid_ck check (idempotency_key::uuid is not null) not valid`,
    drop: 'alter table events drop constraint events_key_uuid_ck',
  },
  deliveries: {
    add: `alter table deliveries add constraint deliveries_no_secret_ck check (position('SECRET' in last_error) = 0) not valid`,
    drop: 'alter table deliveries drop constraint deliveries_no_secret_ck',
  },
};

async function withSecretCheck(table: keyof typeof SECRET_CHECKS, fn: () => Promise<void>) {
  await h.ownerPool.query(SECRET_CHECKS[table].add);
  try {
    await fn();
  } finally {
    await h.ownerPool.query(SECRET_CHECKS[table].drop);
  }
}

describe('log privacy with real failing queries', () => {
  it('keeps query params, pg detail and echoed values out of pino output', async () => {
    const s = await seed();
    const { lines, logger } = capture();

    // 22P02: the value is a query parameter and pg echoes it in its message. Repositories reject malformed ids
    // before SQL, so a uuid cast in a temporary CHECK on a text column produces the real error.
    const badId = botTokenLike('UUID');
    let dataErr: unknown;
    await withSecretCheck('eventsUuidKey', async () => {
      dataErr = await ingestFor(h, s, { idempotencyKey: badId }).catch((e: unknown) => e);
    });
    expect(rawText(dataErr)).toContain(badId);

    // 23514: the value is a query parameter and pg puts the failing row into `detail`.
    let checkErr: unknown;
    await withSecretCheck('events', async () => {
      checkErr = await ingestFor(h, s, { body: botTokenLike('BODY') }).catch((e: unknown) => e);
    });
    expect(rawText(checkErr)).toContain(botTokenLike('BODY'));

    for (const err of [dataErr, checkErr]) {
      logger.error({ err }, 'query failed');
      logger.error(err);
      logger.child({ component: 'test' }).warn({ err });
    }
    expect(lines).toHaveLength(6);
    expect(lines.join('\n')).not.toContain(SECRET);
    const [dataLine, , , checkLine] = lines.map((l) => JSON.parse(l));
    expect(dataLine.err.cause).toMatchObject({ code: '22P02' });
    // The cause echoes the value, so the wrapper's message is withheld from its first quote as well.
    expect(dataLine.err.message).toBe('Failed query: insert into [redacted]');
    expect(dataLine.err.cause.message).toBe('invalid input syntax for type uuid: [redacted]');
    expect(checkLine.err.message).toMatch(
      /^Failed query: insert into "events" .*\nparams: \[redacted\]$/s,
    );
    expect(checkLine.err.cause).toMatchObject({ code: '23514', constraint: 'events_no_secret_ck' });
    expect(checkLine.err.cause.detail).toBeUndefined();
  });

  it('keeps them out of the problem+json body and the request log', async () => {
    const s = await seed();
    const { lines, logger } = capture();
    const app = createApp({ ...h.deps, logger, webDir: null });
    await withSecretCheck('events', async () => {
      const res = await app.request('/v1/events', {
        method: 'POST',
        headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'demo.ping', body: botTokenLike('HTTP') }),
      });
      expect(res.status).toBe(500);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
      const body = await res.text();
      expect(JSON.parse(body)).toMatchObject({ code: 'internal', status: 500 });
      expect(body).not.toContain(SECRET);
    });
    const logged = lines.map((l) => JSON.parse(l)).find((l) => l.msg === 'unhandled error');
    // The 500 log carries the sanitized cause chain: code and constraint stay, detail and params go.
    expect(logged.err.cause).toMatchObject({ code: '23514', constraint: 'events_no_secret_ck' });
    expect(logged.err.cause.detail).toBeUndefined();
    expect(lines.join('\n')).not.toContain(SECRET);
  });

  it("keeps them out of Graphile's last_error and its failed-task log", async () => {
    const s = await seed();
    await ingestFor(h, s);
    const { lines, logger } = capture();
    await withSecretCheck('deliveries', async () => {
      const runner = await startWorker({ ...h.deps, logger }, { pollInterval: 100 });
      try {
        await waitFor(async () => {
          const { rows } = await h.ownerPool.query(
            `select 1 from graphile_worker.jobs where task_identifier = 'send_delivery' and last_error is not null`,
          );
          return rows.length > 0;
        });
      } finally {
        await runner.stop();
      }
    });
    const { rows } = await h.ownerPool.query<{ last_error: string }>(
      `select last_error from graphile_worker.jobs where task_identifier = 'send_delivery' and last_error is not null`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.last_error).toMatch(/^DrizzleQueryError: Failed query: update "deliveries"/);
    expect(rows[0]?.last_error).not.toContain(SECRET);
    const all = lines.join('\n');
    expect(all).toContain('Failed task');
    expect(all).not.toContain(SECRET);
  });

  it('sanitizes last_error for a task registered without its own wrapper', async () => {
    const s = await seed();
    const { lines, logger } = capture();
    const badId = botTokenLike('PROBE');
    // A raw task: it does not wrap itself; startWorker registers it through sanitizeTaskList.
    const probe = async () => {
      await ingestFor(h, s, { idempotencyKey: badId });
    };
    await withSecretCheck('eventsUuidKey', async () => {
      const runner = await startWorker(
        { ...h.deps, logger },
        { pollInterval: 100, extraTasks: { log_privacy_probe: probe } },
      );
      try {
        await h.ownerPool.query(`select graphile_worker.add_job('log_privacy_probe', '{}'::json)`);
        await waitFor(async () => {
          const { rows } = await h.ownerPool.query(
            `select 1 from graphile_worker.jobs where task_identifier = 'log_privacy_probe' and last_error is not null`,
          );
          return rows.length > 0;
        });
      } finally {
        await runner.stop();
      }
    });
    const { rows } = await h.ownerPool.query<{ last_error: string }>(
      `select last_error from graphile_worker.jobs where task_identifier = 'log_privacy_probe'`,
    );
    expect(rows[0]?.last_error).toBe('DrizzleQueryError: Failed query: insert into [redacted]');
    const all = lines.join('\n');
    expect(all).toContain('Failed task');
    expect(all).not.toContain(SECRET);
  });
});
