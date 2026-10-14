import { isUuid } from './ids.js';

/** Shape of every workspace slug: 3-40 chars, lowercase alphanumerics in dash-separated runs (no leading, trailing or consecutive dashes, which also rules out `xn--`). */
export const SLUG_PATTERN = /^(?=.{3,40}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const PERSONAL_SLUG_PATTERN = /^p-[0-9a-f]{32}$/;

/** Slugs a user may not choose: they collide with URL paths or well-known names. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'api',
  'admin',
  'auth',
  'www',
  'app',
  'static',
  'assets',
  'health',
  'healthz',
  'readyz',
  'login',
  'logout',
  'signup',
  'settings',
  'invite',
  'invitations',
  'workspaces',
  'me',
  // top-level paths the server already serves
  'v1',
  'hooks',
  'events',
  'deliveries',
]);

/**
 * Validates a slug a user picked for a shared workspace: right shape, not reserved,
 * and not in the `p-<32 hex>` namespace that belongs to personal workspaces.
 * @public Consumed by the workspace create and rename endpoints.
 */
export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug) && !RESERVED_SLUGS.has(slug) && !PERSONAL_SLUG_PATTERN.test(slug);
}

const TR_MAP: Record<string, string> = {
  ı: 'i',
  İ: 'i',
  ş: 's',
  Ş: 's',
  ğ: 'g',
  Ğ: 'g',
  ç: 'c',
  Ç: 'c',
  ö: 'o',
  Ö: 'o',
  ü: 'u',
  Ü: 'u',
};

export function slugify(input: string): string {
  const mapped = Array.from(input, (ch) => TR_MAP[ch] ?? ch).join('');
  return mapped
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function generateSlug(name: string, suffix: string): string {
  if (!/^[a-z0-9]{1,16}$/.test(suffix)) {
    throw new RangeError('slug suffix must be 1-16 lowercase alphanumeric characters');
  }
  const maxBase = 40 - suffix.length - 1;
  const base = slugify(name).slice(0, maxBase).replace(/-+$/, '') || 'workspace';
  return `${base}-${suffix}`;
}

export function personalSlug(userId: string): string {
  if (!isUuid(userId)) throw new RangeError('personalSlug requires a UUID');
  return `p-${userId.replace(/-/g, '').toLowerCase()}`;
}
