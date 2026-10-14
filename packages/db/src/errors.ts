import { cutQueryParams, errorName, withholdEchoedInput } from '@owlwire/core';

const SQLSTATE = /^[0-9A-Z]{5}$/;

/** How far `pgErrorOf`/`pgErrorCode` follow the `cause` chain (Drizzle wraps the pg error once or twice). */
const MAX_CAUSE_DEPTH = 5;

/** Returns the Postgres SQLSTATE of an error, following Drizzle's `cause` wrapping. */
export function pgErrorCode(err: unknown): string | undefined {
  return pgErrorOf(err)?.code;
}

export class RepoNotFoundError extends Error {
  constructor(
    readonly entity: string,
    readonly id: string,
    readonly constraint?: string,
    options?: ErrorOptions,
  ) {
    super(`${entity} not found: ${id}`, options);
    this.name = 'RepoNotFoundError';
  }
}

export class RepoConflictError extends Error {
  constructor(
    readonly entity: string,
    readonly constraint?: string,
    options?: ErrorOptions,
  ) {
    super(
      `${entity} conflicts with an existing row${constraint ? ` (${constraint})` : ''}`,
      options,
    );
    this.name = 'RepoConflictError';
  }
}

/** Çağıranın girdisi geçersiz (ör. boş idempotency anahtarı, hedefin bağlantısıyla uyuşmayan kuyruk). Değer içermez. */
export class RepoInputError extends Error {
  constructor(
    readonly entity: string,
    readonly reason: string,
  ) {
    super(`invalid ${entity} input: ${reason}`);
    this.name = 'RepoInputError';
  }
}

export class WorkspaceKeyMissingError extends Error {
  constructor(readonly workspaceId: string) {
    super(
      `workspace ${workspaceId} has no data encryption key; run the system backfill (backfillWorkspaceKeys)`,
    );
    this.name = 'WorkspaceKeyMissingError';
  }
}

export class LegacySecretError extends Error {
  constructor(readonly connectionId: string) {
    super(
      `connection ${connectionId} still uses the legacy KEK-only encryption; run legacy secret upgrade`,
    );
    this.name = 'LegacySecretError';
  }
}

/**
 * Eski (KEK ile doğrudan mühürlü) config çözülemedi. Mesaj yalnız sabit bir gerekçe taşır (izin listesi, `legacyDecryptFailureReason`);
 * enjekte edilen çözücünün hata metni (düz metin ya da şifreli metin yankılayabilir) ve `cause` taşınmaz.
 */
export class LegacyDecryptFailedError extends Error {
  /** `missingKekVersion`: şifreli metnin KEK sürümü anahtarlıkta yok (yapılandırma eksiği). */
  constructor(
    readonly reason: string,
    readonly missingKekVersion?: number,
  ) {
    super(`legacy connection config could not be decrypted (${reason})`);
    this.name = 'LegacyDecryptFailedError';
  }
}

interface PgLike {
  code?: unknown;
  constraint?: unknown;
  cause?: unknown;
}

export function pgErrorOf(err: unknown): { code: string; constraint?: string } | null {
  let cur: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cur !== null && typeof cur === 'object'; depth++) {
    const e = cur as PgLike;
    if (typeof e.code === 'string' && SQLSTATE.test(e.code)) {
      return {
        code: e.code,
        constraint: typeof e.constraint === 'string' ? e.constraint : undefined,
      };
    }
    cur = e.cause;
  }
  return null;
}

/**
 * Sistem işlemlerinin sonuç listelerine (`failed[].error`) yazılan güvenli hata metni. Drizzle `DrizzleQueryError`
 * mesajı `Failed query: <sql>\nparams: <değerler>` biçimindedir; değerler sarılı DEK, şifreli config vb. olabilir,
 * bu yüzden `\nparams:` ve sonrası atılır. Girdi yankılayan mesajlar `withholdEchoedInput`'tan geçer.
 */
export function safeErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown error';
  return withholdEchoedInput(err, `${errorName(err)}: ${cutQueryParams(err.message)}`);
}

/**
 * Not: PostgreSQL hata veren bir ifadeden sonra transaction'ı iptal eder; eşlenen hata da withTenant'ı geri alır.
 * Eşlenen hata özgün hatayı `cause` olarak taşır; özgün DrizzleQueryError mesajı sorgu parametrelerini içerir,
 * bu yüzden loglarken `safeErrorMessage` / log redaksiyonu kullanılır.
 * 42501 (RLS WITH CHECK / yetki ihlali) eşlenmez, olduğu gibi fırlatılır: repository workspace_id'yi TenantTx'ten
 * aldığı için bu bir hatadır ve sıradan bir "bulunamadı" gibi görünmemelidir.
 */
export async function mapPgErrors<T>(
  entity: string,
  id: string,
  fn: () => Promise<T>,
  opts: { fkViolation?: 'not_found' | 'conflict' } = {},
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const pg = pgErrorOf(err);
    if (pg?.code === '23505') throw new RepoConflictError(entity, pg.constraint, { cause: err });
    if (pg?.code === '23503') {
      if (opts.fkViolation === 'conflict') {
        throw new RepoConflictError(entity, pg.constraint, { cause: err });
      }
      throw new RepoNotFoundError(entity, id, pg.constraint, { cause: err });
    }
    throw err;
  }
}
