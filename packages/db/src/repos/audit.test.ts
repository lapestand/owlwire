import { describe, expect, it } from 'vitest';
import { AuditDataError, assertAuditDataSafe } from './audit.js';

describe('assertAuditDataSafe', () => {
  it.each([
    [{ botToken: 'x' }],
    [{ nested: { client_secret: 'x' } }],
    [{ list: [{ password: 'x' }] }],
    [{ config: { a: 1 } }],
    [{ 'Webhook-URL': 'https://discord.com/api/webhooks/1/abc' }],
    [{ apiKey: 'x' }],
  ])('rejects %j', (data) => {
    expect(() => assertAuditDataSafe(data)).toThrow(AuditDataError);
  });

  it.each([
    [{ tokenPrefix: 'ow_inst_abcd' }],
    [{ fieldNames: ['config', 'token'] }],
    [{ fromVersion: 1, toVersion: 2 }],
    [{}],
  ])('accepts %j', (data) => {
    expect(() => assertAuditDataSafe(data)).not.toThrow();
  });
});
