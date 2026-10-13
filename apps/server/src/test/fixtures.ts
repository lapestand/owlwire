import type { EventInput } from '@owlwire/contracts';
import { newId } from '@owlwire/core';
import { ingestEvent } from '../events/ingest.js';
import { type SeedOptions, type SeedResult, seedDevWorkspace } from '../system/dev-seed.js';
import type { Harness } from './harness.js';

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
  const seed = await seedDevWorkspace(h.deps.db, h.deps.crypto, h.deps.clock, {
    platform: 'webhook',
    chatId: `chat-${newId()}`,
    ...seedOpts,
  });
  return { seed, eventId: await ingestFor(h, seed, input) };
}
