import type { EventInput } from '@owlwire/contracts';
import { newId } from '@owlwire/core';
import { generateToken, hashToken, tokenPrefix } from '@owlwire/crypto';
import {
  type CreateConnectionInput,
  createApp,
  createConnection,
  createDestination,
  createInstallation,
  createRule,
  createWorkspace,
  type OwlwireDb,
  SYSTEM_ACTOR,
  tenantScope,
  updateConnectionStatus,
  withTenant,
} from '@owlwire/db';

import { ingestEvent } from '../events/ingest.js';
import type { Harness } from './harness.js';

export interface SeedOptions {
  platform: 'telegram' | 'webhook';
  chatId?: string;
  botToken?: string;
  threadId?: string;
  types?: string[];
  name?: string;
}

export interface SeedResult {
  workspaceId: string;
  appId: string;
  installationId: string;
  token: string;
  connectionId: string;
  destinationId: string | null;
  ruleId: string;
}

function destinationKind(opts: SeedOptions, chatId: string): 'dm' | 'group' | 'topic' | 'webhook' {
  if (opts.platform === 'webhook') return 'webhook';
  if (opts.threadId) return 'topic';
  return chatId.startsWith('-') ? 'group' : 'dm';
}

/**
 * A ready delivery route: workspace (+ DEK) + private app + installation + connection (+ destination when a chat id
 * is given) + rule ['*'], all through the tenant repositories in one transaction. Telegram with a bot token is
 * own_bot (config sealed with the workspace DEK, dek_v1); without one it is shared_bot (config null, the instance's
 * shared bot is used). webhook targets the harness's fake adapter, which createHarness registers for that platform.
 */
export async function seedDeliveryWorkspace(db: OwlwireDb, opts: SeedOptions): Promise<SeedResult> {
  const chatId = opts.chatId?.trim() ?? '';
  const botToken = opts.botToken?.trim() ?? '';
  const name = opts.name ?? 'Seed';
  const suffix = newId().slice(-8);
  const token = generateToken('inst');
  const workspaceId = newId();
  const connection: CreateConnectionInput =
    opts.platform === 'webhook'
      ? { platform: 'webhook', kind: 'webhook', displayName: 'Fake adapter', config: null }
      : botToken !== ''
        ? {
            platform: 'telegram',
            kind: 'own_bot',
            displayName: 'Telegram bot',
            config: { botToken },
          }
        : {
            platform: 'telegram',
            kind: 'shared_bot',
            displayName: 'Shared Telegram bot',
            config: null,
          };

  return withTenant(db, tenantScope(workspaceId), async (t) => {
    await createWorkspace(t, { name, slug: `seed-${suffix}`, kind: 'personal' }, SYSTEM_ACTOR);
    const app = await createApp(
      t,
      { name: `${name} app`, slug: `seed-app-${suffix}`, visibility: 'private' },
      SYSTEM_ACTOR,
    );
    const inst = await createInstallation(
      t,
      { appId: app.id, tokenHash: hashToken(token), tokenPrefix: tokenPrefix(token) },
      SYSTEM_ACTOR,
    );
    const conn = await createConnection(t, connection, SYSTEM_ACTOR);
    // Status first, destination after: createDestination takes FOR SHARE on the connection row (see its note).
    await updateConnectionStatus(t, conn.id, 'active', null);
    let destinationId: string | null = null;
    if (chatId !== '') {
      const dest = await createDestination(t, {
        connectionId: conn.id,
        kind: destinationKind(opts, chatId),
        externalId: chatId,
        externalSubId: opts.threadId ?? null,
        name: `${opts.platform}:${chatId}`,
        consentStatus: 'confirmed',
      });
      destinationId = dest.id;
    }
    const rule = await createRule(
      t,
      {
        installationId: inst.id,
        name: 'all events',
        types: opts.types ?? ['*'],
        targets: destinationId ? [{ destinationId }] : [],
      },
      SYSTEM_ACTOR,
    );
    return {
      workspaceId,
      appId: app.id,
      installationId: inst.id,
      token,
      connectionId: conn.id,
      destinationId,
      ruleId: rule.id,
    };
  });
}

export async function ingestFor(
  h: Harness,
  seed: SeedResult,
  input: Partial<EventInput> = {},
): Promise<string> {
  const { eventId } = await ingestEvent(h.deps.db, {
    installation: {
      id: seed.installationId,
      appId: seed.appId,
      workspaceId: seed.workspaceId,
      grantedTypes: null,
    },
    input: { type: 'player.inactive', body: 'Ali went idle', ...input },
    headerIdempotencyKey: undefined,
  });
  return eventId;
}

export async function seedAndIngest(
  h: Harness,
  seedOpts: Partial<SeedOptions> = {},
  input: Partial<EventInput> = {},
): Promise<{ seed: SeedResult; eventId: string }> {
  const seed = await seedDeliveryWorkspace(h.deps.db, {
    platform: 'webhook',
    chatId: `chat-${newId()}`,
    ...seedOpts,
  });
  return { seed, eventId: await ingestFor(h, seed, input) };
}
