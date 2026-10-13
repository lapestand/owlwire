import { buildAad, openJson, sealJson } from '@owlwire/crypto';
import type { TenantTx } from '../scope.js';
import { loadWorkspaceDek } from './workspace-keys.js';

/** Paket içi. AAD bağlantı kimliğine bağlıdır: şifreli metin başka satıra taşınırsa açılmaz. */
export const connectionConfigAad = (connectionId: string): string =>
  buildAad('owlwire:connection-config', connectionId);

/** Paket içi. Workspace DEK'i ile mühürler; açık DEK işi biter bitmez sıfırlanır. */
export async function sealConnectionConfig(
  t: TenantTx,
  connectionId: string,
  config: Record<string, unknown>,
): Promise<Buffer> {
  const dek = await loadWorkspaceDek(t);
  try {
    return sealJson(dek, config, connectionConfigAad(connectionId));
  } finally {
    dek.fill(0);
  }
}

/** Paket içi. Başka satırdan ya da başka workspace'ten kopyalanmış şifreli metin `DecryptError` verir. */
export async function openConnectionConfig(
  t: TenantTx,
  connectionId: string,
  sealed: Uint8Array,
): Promise<Record<string, unknown>> {
  const dek = await loadWorkspaceDek(t);
  try {
    return openJson<Record<string, unknown>>(dek, sealed, connectionConfigAad(connectionId));
  } finally {
    dek.fill(0);
  }
}
