import { type Clock, newId } from '@owlwire/core';
import { generateToken, hashToken, type SecretBox, tokenPrefix } from '@owlwire/crypto';
import {
  apps,
  connections,
  type Db,
  destinations,
  installations,
  rules,
  ruleTargets,
  workspaces,
} from '@owlwire/db';

export interface SeedOptions {
  platform: 'telegram' | 'webhook';
  chatId: string;
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
  destinationId: string;
  ruleId: string;
}

function destinationKind(opts: SeedOptions, chatId: string): 'dm' | 'group' | 'topic' | 'webhook' {
  if (opts.platform === 'webhook') return 'webhook';
  if (opts.threadId) return 'topic';
  return chatId.startsWith('-') ? 'group' : 'dm';
}

/** P0 dev helper: workspace + private app + installation + connection + destination + rule ['*']. */
export async function seedDevWorkspace(
  db: Db,
  box: SecretBox,
  clock: Clock,
  opts: SeedOptions,
): Promise<SeedResult> {
  const chatId = opts.chatId.trim();
  if (chatId === '') throw new Error('--chat-id must not be empty');
  const botToken = opts.botToken?.trim() ?? '';
  if (opts.platform === 'telegram' && botToken === '') {
    throw new Error('--bot-token is required for the telegram platform');
  }
  const now = clock.now();
  const suffix = newId().slice(-8);
  const name = opts.name ?? 'Dev';
  const token = generateToken('inst');
  const ids = {
    workspaceId: newId(),
    appId: newId(),
    installationId: newId(),
    connectionId: newId(),
    destinationId: newId(),
    ruleId: newId(),
  };
  const telegram = opts.platform === 'telegram';

  await db.transaction(async (tx) => {
    await tx.insert(workspaces).values({
      id: ids.workspaceId,
      name,
      slug: `dev-${suffix}`,
      kind: 'personal',
      createdAt: now,
    });
    await tx.insert(apps).values({
      id: ids.appId,
      ownerWorkspaceId: ids.workspaceId,
      name: `${name} app`,
      slug: `dev-app-${suffix}`,
      visibility: 'private',
      approvalStatus: 'approved',
      createdAt: now,
    });
    await tx.insert(installations).values({
      id: ids.installationId,
      appId: ids.appId,
      workspaceId: ids.workspaceId,
      status: 'active',
      tokenHash: hashToken(token),
      tokenPrefix: tokenPrefix(token),
      createdAt: now,
    });
    await tx.insert(connections).values({
      id: ids.connectionId,
      workspaceId: ids.workspaceId,
      platform: opts.platform,
      kind: telegram ? 'own_bot' : 'webhook',
      displayName: telegram ? 'Telegram bot (dev)' : 'Fake adapter (dev)',
      configEnc: telegram ? box.seal({ botToken }) : null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(destinations).values({
      id: ids.destinationId,
      workspaceId: ids.workspaceId,
      connectionId: ids.connectionId,
      kind: destinationKind(opts, chatId),
      externalId: chatId,
      externalSubId: opts.threadId ?? null,
      name: `${opts.platform}:${chatId}`,
      consentStatus: 'confirmed',
      consentedAt: now,
      status: 'active',
      createdAt: now,
    });
    await tx.insert(rules).values({
      id: ids.ruleId,
      workspaceId: ids.workspaceId,
      installationId: ids.installationId,
      name: 'all events (dev)',
      types: opts.types ?? ['*'],
      minSeverity: 'info',
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(ruleTargets).values({
      id: newId(),
      workspaceId: ids.workspaceId,
      ruleId: ids.ruleId,
      destinationId: ids.destinationId,
    });
  });

  return { ...ids, token };
}

export function formatSeedResult(r: SeedResult, opts: { port: number; platform: string }): string {
  const base = `http://localhost:${opts.port}`;
  return [
    'Owlwire dev seed complete',
    `  workspace:    ${r.workspaceId}`,
    `  installation: ${r.installationId}`,
    `  connection:   ${r.connectionId} (${opts.platform})`,
    `  destination:  ${r.destinationId}`,
    `  token:        ${r.token}`,
    '',
    'Send a test event:',
    `  curl -X POST "${base}/v1/hooks?token=${r.token}" -H 'content-type: text/plain' --data 'Hello from Owlwire'`,
    `  curl -X POST "${base}/v1/events" -H "authorization: Bearer ${r.token}" -H 'content-type: application/json' --data '{"type":"demo.ping","title":"Ping","body":"**Hello** from Owlwire"}'`,
    '',
  ].join('\n');
}
