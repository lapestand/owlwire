import { hashToken, isInstallationToken } from '@owlwire/crypto';
import type { OwlwireDb } from '@owlwire/db';
import {
  findInstallationByTokenHash,
  type InstallationAuthRecord,
  SYSTEM,
  withSystem,
} from '@owlwire/db/system';

export type InstallationAuthResult =
  | { ok: true; installation: InstallationAuthRecord }
  | { ok: false; code: 'unauthorized' | 'installation_revoked' };

/**
 * Token → kurulum (kiracılar arası sistem okuması). Sistem kapsamı burada kapanır; çağıran kiracı kapsamını ancak
 * bundan sonra açar (kapsamlar iç içe açılamaz). Yalnız `status = 'active'` kurulum kabul edilir.
 * TODO(P1c): workspace soft-delete (`workspaces.deleted_at`) ve app onayı (`apps.approval_status`) token kullanımında
 * da denetlenmeli (Görev 10 ertelemesi).
 */
export async function authenticateInstallationToken(
  db: OwlwireDb,
  token: string,
): Promise<InstallationAuthResult> {
  if (!isInstallationToken(token)) return { ok: false, code: 'unauthorized' };
  const installation = await withSystem(db, SYSTEM, (s) =>
    findInstallationByTokenHash(s, hashToken(token)),
  );
  if (!installation) return { ok: false, code: 'unauthorized' };
  if (installation.status !== 'active') return { ok: false, code: 'installation_revoked' };
  return { ok: true, installation };
}
