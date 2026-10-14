export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
export const PERSONAL_SLUG_PATTERN = /^p-[0-9a-f]{32}$/;

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
  const maxBase = 40 - suffix.length - 1;
  const base = slugify(name).slice(0, maxBase).replace(/-+$/, '') || 'workspace';
  return `${base}-${suffix}`;
}

export function personalSlug(userId: string): string {
  return `p-${userId.replace(/-/g, '').toLowerCase()}`;
}
