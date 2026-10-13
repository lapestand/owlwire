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
 * P0/P1a dev helper: workspace (+ DEK) + private app + installation + connection (+ destination when a chat id is
 * given) + rule ['*'], all through the tenant repositories in one transaction. Telegram with a bot token is own_bot
 * (config sealed with the workspace DEK, dek_v1); without one it is shared_bot (config null, R2). webhook is P0's
 * OWLWIRE_DEV_FAKE_ADAPTER fake adapter (R48).
 */
export async function seedDevWorkspace(db: OwlwireDb, opts: SeedOptions): Promise<SeedResult> {
  const chatId = opts.chatId?.trim() ?? '';
  const botToken = opts.botToken?.trim() ?? '';
  const name = opts.name ?? 'Dev';
  const suffix = newId().slice(-8);
  const token = generateToken('inst');
  const workspaceId = newId();
  const connection: CreateConnectionInput =
    opts.platform === 'webhook'
      ? { platform: 'webhook', kind: 'webhook', displayName: 'Fake adapter (dev)', config: null }
      : botToken !== ''
        ? {
            platform: 'telegram',
            kind: 'own_bot',
            displayName: 'Telegram bot (dev)',
            config: { botToken },
          }
        : {
            platform: 'telegram',
            kind: 'shared_bot',
            displayName: 'Shared Telegram bot (dev)',
            config: null,
          };

  return withTenant(db, tenantScope(workspaceId), async (t) => {
    await createWorkspace(t, { name, slug: `dev-${suffix}`, kind: 'personal' }, SYSTEM_ACTOR);
    const app = await createApp(
      t,
      { name: `${name} app`, slug: `dev-app-${suffix}`, visibility: 'private' },
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
        name: 'all events (dev)',
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

export function formatSeedResult(r: SeedResult, opts: { port: number; platform: string }): string {
  const base = `http://localhost:${opts.port}`;
  return [
    'Owlwire dev seed complete',
    `  workspace:    ${r.workspaceId}`,
    `  installation: ${r.installationId}`,
    `  connection:   ${r.connectionId} (${opts.platform})`,
    `  destination:  ${r.destinationId ?? '-'}`,
    `  token:        ${r.token}`,
    '',
    'Send a test event:',
    `  curl -X POST "${base}/v1/hooks?token=${r.token}" -H 'content-type: text/plain' --data 'Hello from Owlwire'`,
    `  curl -X POST "${base}/v1/events" -H "authorization: Bearer ${r.token}" -H 'content-type: application/json' --data '{"type":"demo.ping","title":"Ping","body":"**Hello** from Owlwire"}'`,
    '',
  ].join('\n');
}
