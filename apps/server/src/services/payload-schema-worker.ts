// Worker thread entry for PayloadSchemaRegistry. It must not import workspace packages: in
// development it runs through the tsx loader without the vitest aliases or source conditions.
import { parentPort, workerData } from 'node:worker_threads';
import { PayloadSchemaEngine, type SchemaCheck } from './payload-schema-engine.js';

export type WorkerRequest =
  | { id: number; op: 'check'; schema: unknown }
  | { id: number; op: 'validate'; key: string; schema: Record<string, unknown>; data: unknown };

export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'result'; id: number; result: SchemaCheck };

const port = parentPort;
if (!port) throw new Error('payload-schema-worker must run in a worker thread');

const { maxEntries } = workerData as { maxEntries: number };
const engine = new PayloadSchemaEngine({ maxEntries });

// Warm Ajv up before taking work, so the first real call is not charged for it.
engine.checkSchema({ type: 'object', properties: { a: { type: 'string', pattern: '^a' } } });

port.on('message', (req: WorkerRequest) => {
  const result =
    req.op === 'check'
      ? engine.checkSchema(req.schema)
      : engine.validate(req.key, req.schema, req.data);
  port.postMessage({ type: 'result', id: req.id, result } satisfies WorkerResponse);
});
port.postMessage({ type: 'ready' } satisfies WorkerResponse);
