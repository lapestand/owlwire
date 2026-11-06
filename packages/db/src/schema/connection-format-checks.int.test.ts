import { CONNECTION_KIND_PATTERN, newId, PLATFORM_ID_PATTERN } from '@owlwire/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DbTestEnv, setupDbTestEnv } from '../__test__/env.js';
import { createTestWorkspace } from '../__test__/fixtures.js';

// Same examples as packages/core/src/platform.test.ts: the core regex and the database check must agree.
const VALID_PLATFORMS = [
  'telegram',
  'discord',
  'whatsapp',
  'webhook',
  'fake-a',
  'x1',
  `a${'b'.repeat(31)}`,
];
const INVALID_PLATFORMS = [
  '',
  'a',
  'Telegram',
  '1abc',
  'tele_gram',
  'tele gram',
  '-abc',
  `a${'b'.repeat(32)}`,
];
const VALID_KINDS = ['shared_bot', 'own_bot', 'webhook', 'number', 'smtp'];
const INVALID_KINDS = ['shared-bot', 'Own', '_x', ''];

let env: DbTestEnv;
let ws: string;

beforeAll(async () => {
  env = await setupDbTestEnv();
  ws = await createTestWorkspace(env.db, 'formats');
}, 120_000);

afterAll(async () => {
  await env?.stop();
});

function insert(platform: string, kind: string) {
  return env.owner.query(
    `insert into connections (id, workspace_id, platform, kind, display_name)
     values ($1, $2, $3, $4, 'c')`,
    [newId(), ws, platform, kind],
  );
}

describe('connection format checks', () => {
  it('replaces the closed checks with format checks', async () => {
    const { rows } = await env.owner.query<{ conname: string }>(
      `select conname from pg_constraint
       where conrelid = 'connections'::regclass and contype = 'c' and conname like 'connections_%'`,
    );
    const names = rows.map((r) => r.conname);
    expect(names).not.toContain('connections_platform_check');
    expect(names).not.toContain('connections_kind_check');
    expect(names).toContain('connections_platform_format_check');
    expect(names).toContain('connections_kind_format_check');
  });

  it.each(VALID_PLATFORMS)('accepts platform %s', async (platform) => {
    expect(PLATFORM_ID_PATTERN.test(platform)).toBe(true);
    await insert(platform, 'own_bot');
  });

  it.each(INVALID_PLATFORMS)('rejects platform %j', async (platform) => {
    expect(PLATFORM_ID_PATTERN.test(platform)).toBe(false);
    await expect(insert(platform, 'own_bot')).rejects.toMatchObject({
      code: '23514',
      constraint: 'connections_platform_format_check',
    });
  });

  it.each(VALID_KINDS)('accepts kind %s', async (kind) => {
    expect(CONNECTION_KIND_PATTERN.test(kind)).toBe(true);
    await insert('telegram', kind);
  });

  it.each(INVALID_KINDS)('rejects kind %j', async (kind) => {
    expect(CONNECTION_KIND_PATTERN.test(kind)).toBe(false);
    await expect(insert('telegram', kind)).rejects.toMatchObject({
      code: '23514',
      constraint: 'connections_kind_format_check',
    });
  });

  it('keeps rows written with the previous platform and kind values readable', async () => {
    const pairs = [
      ['telegram', 'shared_bot'],
      ['discord', 'own_bot'],
      ['whatsapp', 'number'],
      ['webhook', 'webhook'],
    ] as const;
    for (const [platform, kind] of pairs) await insert(platform, kind);
    const { rows } = await env.owner.query<{ platform: string; kind: string }>(
      `select platform, kind from connections where workspace_id = $1
       and (platform, kind) in (('telegram','shared_bot'),('discord','own_bot'),('whatsapp','number'),('webhook','webhook'))`,
      [ws],
    );
    expect(rows.length).toBeGreaterThanOrEqual(pairs.length);
  });
});
