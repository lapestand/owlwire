import { describe, expect, it } from 'vitest';
import { RepoInputError } from '../errors.js';
import type { TenantTx } from '../scope.js';
import { AuditDataError, assertAuditDataSafe, listAuditLog, writeAudit } from './audit.js';

describe('assertAuditDataSafe', () => {
  it.each([
    [{ botToken: 'x' }],
    [{ nested: { client_secret: 'x' } }],
    [{ list: [{ password: 'x' }] }],
    [{ config: { a: 1 } }],
    [{ 'Webhook-URL': 'https://discord.com/api/webhooks/1/abc' }],
    [{ apiKey: 'x' }],
    [{ 'webhook.url': 'x' }],
    [{ 'api.key': 'x' }],
    [{ '\uff54\uff4f\uff4b\uff45\uff4e': 'x' }],
    [{ 'to\u200bken': 'x' }],
    [{ tokens: ['x'] }],
    [{ secretValue: 'x' }],
    [{ password_hash: 'x' }],
    [{ credentials: 'x' }],
    [{ privateKeyPem: 'x' }],
    [{ secretValues: ['x'] }],
    [{ tokenHashes: ['x'] }],
    [{ passwordHashes: ['x'] }],
    [{ api_key_values: ['x'] }],
  ])('rejects %j', (data) => {
    expect(() => assertAuditDataSafe(data)).toThrow(AuditDataError);
  });

  it.each([
    [{ tokenPrefix: 'ow_inst_abcd' }],
    [{ fieldNames: ['config', 'token'] }],
    [{ fromVersion: 1, toVersion: 2 }],
    [{ processes: 2, hashes: ['a'], values: [1] }],
    [{}],
  ])('accepts %j', (data) => {
    expect(() => assertAuditDataSafe(data)).not.toThrow();
  });
});

describe('writeAudit canonicalisation', () => {
  const entry = (data: Record<string, unknown>) => ({
    action: 'rule.created' as const,
    actor: { kind: 'system' as const },
    targetType: 'rule' as const,
    targetId: 'r',
    data,
  });
  // The guard runs before any SQL, so a TenantTx stand-in is never touched.
  const tx = {} as TenantTx;
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;

  it.each([
    ['toJSON-smuggled secret', { conn: { toJSON: () => ({ botToken: 'x' }) } }],
    ['cycle', cyclic],
    ['BigInt', { n: 1n }],
  ])('rejects %s with AuditDataError', async (_name, data) => {
    await expect(writeAudit(tx, entry(data as Record<string, unknown>))).rejects.toBeInstanceOf(
      AuditDataError,
    );
  });
});

describe('listAuditLog validation', () => {
  const tx = {} as TenantTx;
  it.each([
    [{ limit: 0 }],
    [{ limit: 201 }],
    [{ limit: 2.5 }],
    [{ limit: Number.NaN }],
    [{ before: { createdAt: new Date('x'), id: '0192f0a0-0000-7000-8000-00000000000a' } }],
    [{ before: { createdAt: new Date(), id: 'nope' } }],
    [{ before: { createdAt: '2026-10-13T00:00:00Z', id: '0192f0a0-0000-7000-8000-00000000000a' } }],
    [{ before: 'not-a-cursor' }],
    [{ before: null }],
  ])('rejects %j with RepoInputError', async (opts) => {
    const err = await listAuditLog(tx, opts as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepoInputError);
    expect(err).not.toBeInstanceOf(AuditDataError);
    expect(err).toMatchObject({ entity: 'audit' });
  });
});
