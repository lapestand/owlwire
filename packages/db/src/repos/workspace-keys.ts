import { generateDek, unwrapWorkspaceDek, wrapWorkspaceDek } from '@owlwire/crypto';
import { eq } from 'drizzle-orm';
import { mapPgErrors, WorkspaceKeyMissingError } from '../errors.js';
import { workspaceKeys } from '../schema/index.js';
import type { TenantTx } from '../scope.js';
import { keyringOf, now, q } from './context.js';

/**
 * Paket içi. Yeni DEK üretir, güncel KEK ile sarar (AAD = buildAad('owlwire:dek', workspaceId)).
 * ifMissing: anahtar varsa dokunmaz (eşzamanlı çağrılar birbirini bekler, ikincisi false döner);
 * ifMissing olmadan ikinci anahtar RepoConflictError. Eklendiyse true.
 */
export async function insertWorkspaceKey(
  t: TenantTx,
  opts: { ifMissing?: boolean } = {},
): Promise<boolean> {
  const keyring = keyringOf(t);
  const dek = generateDek();
  let wrappedDek: Buffer;
  try {
    wrappedDek = wrapWorkspaceDek(keyring.current, dek, t.workspaceId);
  } finally {
    dek.fill(0);
  }
  const insert = q(t)
    .insert(workspaceKeys)
    .values({
      workspaceId: t.workspaceId,
      wrappedDek,
      kekVersion: keyring.current.version,
      createdAt: now(t),
    });
  const rows = await mapPgErrors('workspace_key', t.workspaceId, () =>
    opts.ifMissing
      ? insert
          .onConflictDoNothing({ target: workspaceKeys.workspaceId })
          .returning({ id: workspaceKeys.workspaceId })
      : insert.returning({ id: workspaceKeys.workspaceId }),
  );
  return rows.length > 0;
}

/**
 * Paket içi. Açık DEK'i döndürür; tampon çağıranındır: işi bitince `dek.fill(0)` ile sıfırlamalı,
 * hiçbir yere loglamamalı ya da transaction dışına taşımamalıdır.
 */
export async function loadWorkspaceDek(t: TenantTx): Promise<Buffer> {
  const rows = await q(t)
    .select({ wrappedDek: workspaceKeys.wrappedDek, kekVersion: workspaceKeys.kekVersion })
    .from(workspaceKeys)
    .where(eq(workspaceKeys.workspaceId, t.workspaceId));
  const row = rows[0];
  if (!row) throw new WorkspaceKeyMissingError(t.workspaceId);
  return unwrapWorkspaceDek(keyringOf(t), row.wrappedDek, row.kekVersion, t.workspaceId);
}
