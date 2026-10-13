const SQLSTATE = /^[0-9A-Z]{5}$/;

/** Returns the Postgres SQLSTATE of an error, following Drizzle's `cause` wrapping. */
export function pgErrorCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; depth < 5; depth++) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && SQLSTATE.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

export class RepoNotFoundError extends Error {
  constructor(
    readonly entity: string,
    readonly id: string,
    readonly constraint?: string,
  ) {
    super(`${entity} not found: ${id}`);
    this.name = 'RepoNotFoundError';
  }
}

export class RepoConflictError extends Error {
  constructor(
    readonly entity: string,
    readonly constraint?: string,
  ) {
    super(`${entity} conflicts with an existing row${constraint ? ` (${constraint})` : ''}`);
    this.name = 'RepoConflictError';
  }
}

export class WorkspaceKeyMissingError extends Error {
  constructor(readonly workspaceId: string) {
    super(`workspace ${workspaceId} has no data encryption key; run legacy secret upgrade`);
    this.name = 'WorkspaceKeyMissingError';
  }
}

export class LegacySecretError extends Error {
  constructor(readonly connectionId: string) {
    super(
      `connection ${connectionId} still uses the P0 KEK-only encryption; run legacy secret upgrade`,
    );
    this.name = 'LegacySecretError';
  }
}

interface PgLike {
  code?: unknown;
  constraint?: unknown;
  cause?: unknown;
}

export function pgErrorOf(err: unknown): { code: string; constraint?: string } | null {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur !== null && typeof cur === 'object'; depth++) {
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
 * bu yüzden `\nparams:` ve sonrası atılır (P0 I-6).
 */
export function safeErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown error';
  const cut = err.message.indexOf('\nparams:');
  return `${err.name}: ${cut === -1 ? err.message : err.message.slice(0, cut)}`;
}

/** Not: PostgreSQL hata veren bir ifadeden sonra transaction'ı iptal eder; eşlenen hata da withTenant'ı geri alır. */
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
    if (pg?.code === '23505') throw new RepoConflictError(entity, pg.constraint);
    if (pg?.code === '23503') {
      if (opts.fkViolation === 'conflict') throw new RepoConflictError(entity, pg.constraint);
      throw new RepoNotFoundError(entity, id, pg.constraint);
    }
    throw err;
  }
}
