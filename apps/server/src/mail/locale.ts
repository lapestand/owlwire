export type MailLocale = 'tr' | 'en';

/**
 * The supported locale the Accept-Language header prefers most (RFC 9110 §12.5.4): entries are ranked by q-value,
 * ties keep header order, `q=0` means "not acceptable" and a malformed q-value counts as 0. English when nothing
 * matches.
 */
export function pickLocale(acceptLanguage: string | null | undefined): MailLocale {
  if (!acceptLanguage) return 'en';
  const ranked: Array<{ tag: string; q: number }> = [];
  for (const part of acceptLanguage.split(',')) {
    const [rawTag = '', ...params] = part.split(';');
    const tag = rawTag.trim().toLowerCase().replace(/_/g, '-');
    if (!tag) continue;
    let q = 1;
    for (const param of params) {
      const [name = '', value = ''] = param.split('=').map((s) => s.trim());
      if (name.toLowerCase() !== 'q') continue;
      q = /^(0(\.\d{0,3})?|1(\.0{0,3})?)$/.test(value) ? Number(value) : 0;
    }
    if (q > 0) ranked.push({ tag, q });
  }
  // Array.prototype.sort is stable, so equal q-values keep header order.
  ranked.sort((a, b) => b.q - a.q);
  for (const { tag } of ranked) {
    if (tag === 'tr' || tag.startsWith('tr-')) return 'tr';
    if (tag === 'en' || tag.startsWith('en-')) return 'en';
  }
  return 'en';
}
