export type MailLocale = 'tr' | 'en';

/** First Turkish or English tag in an Accept-Language header, in header order; English otherwise. */
export function pickLocale(acceptLanguage: string | null | undefined): MailLocale {
  if (!acceptLanguage) return 'en';
  for (const part of acceptLanguage.split(',')) {
    const tag = part.split(';')[0]?.trim().toLowerCase() ?? '';
    if (tag === 'tr' || tag.startsWith('tr-')) return 'tr';
    if (tag === 'en' || tag.startsWith('en-')) return 'en';
  }
  return 'en';
}
