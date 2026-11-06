/** Platform ids are open strings so channel plugins can bring their own; only the format is fixed. */
export const PLATFORM_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

export function isPlatformId(v: unknown): v is string {
  return typeof v === 'string' && PLATFORM_ID_PATTERN.test(v);
}

export const CONNECTION_KIND_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;

export const SHARED_BOT_KIND = 'shared_bot';
