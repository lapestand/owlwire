import { newId } from '@owlwire/core';
import type { MiddlewareHandler } from 'hono';
import type { Logger } from 'pino';
import type { AppEnv } from '../types.js';

const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function requestId(logger: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const incoming = c.req.header('x-request-id');
    const id = incoming && VALID_REQUEST_ID.test(incoming) ? incoming : newId();
    c.set('requestId', id);
    c.set('log', logger.child({ requestId: id }));
    c.header('x-request-id', id);
    await next();
  };
}
