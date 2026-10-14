import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { TenantTx } from '../scope.js';
import { AuditDataError, assertAuditDataSafe, writeAudit } from './audit.js';

/** Secret-bearing names, written as camelCase word lists so separators and case can be varied per word. */
const SECRET_NAMES = [
  ['token'],
  ['secret'],
  ['password'],
  ['passwd'],
  ['config'],
  ['dek'],
  ['kek'],
  ['authorization'],
  ['cookie'],
  ['api', 'key'],
  ['private', 'key'],
  ['webhook', 'url'],
  ['credential'],
  ['pem'],
];
const SECRET_PREFIXES = [[], ['bot'], ['client'], ['access'], ['refresh'], ['session'], ['old']];
const SECRET_SUFFIXES = [[], ['s'], ['hash'], ['hashes'], ['value'], ['values'], ['value', 's']];

/** Harmless names (none ends in a secret word, even after dropping a plural/hash/value tail). */
const SAFE_WORDS = [
  'id',
  'name',
  'count',
  'status',
  'kind',
  'label',
  'role',
  'enabled',
  'from',
  'to',
  'version',
  'field',
  'names',
  'prefix',
  'target',
  'created',
  'at',
  'processes',
  'url',
  'key',
];

const SEPARATORS = ['', '', '_', '-', '.', ' ', '​', '­', ':', '/'];

/** Spells a word with each character in random case, optionally as its full-width (NFKC-equivalent) form. */
const spell = (word: string) =>
  fc
    .array(fc.constantFrom('lower', 'upper', 'wide'), {
      minLength: word.length,
      maxLength: word.length,
    })
    .map((styles) =>
      [...word]
        .map((c, i) => {
          const style = styles[i];
          if (style === 'upper') return c.toUpperCase();
          if (style === 'wide' && /[a-z]/.test(c))
            return String.fromCharCode(c.charCodeAt(0) + 0xfee0);
          return c;
        })
        .join(''),
    );

/** Joins words with generated separators; each word is spelled with `spell`. */
const joinWords = (words: string[]) =>
  fc
    .tuple(
      fc.tuple(...words.map(spell)),
      fc.array(fc.constantFrom(...SEPARATORS), {
        minLength: words.length,
        maxLength: words.length,
      }),
    )
    .map(([spelled, seps]) => spelled.map((w, i) => (i === 0 ? w : seps[i] + w)).join(''));

const secretKey = fc
  .tuple(
    fc.constantFrom(...SECRET_PREFIXES),
    fc.constantFrom(...SECRET_NAMES),
    fc.constantFrom(...SECRET_SUFFIXES),
  )
  .chain(([prefix, name, suffix]) => joinWords([...prefix, ...name, ...suffix]));

const safeKey = fc
  .array(fc.constantFrom(...SAFE_WORDS), { minLength: 1, maxLength: 3 })
  .filter((ws) => ws.join('') !== 'key' && !/(api|private)key$/.test(ws.join('')))
  .filter((ws) => !ws.join('').endsWith('webhookurl'))
  .chain(joinWords);

const leaf = fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null));

/** Safe JSON objects and arrays of bounded depth, with keys from `safeKey`. */
const { safeValue } = fc.letrec((tie) => ({
  safeValue: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    leaf,
    fc.array(tie('safeValue'), { maxLength: 3 }),
    fc
      .array(fc.tuple(safeKey, tie('safeValue')), { maxLength: 4 })
      .map((entries) => Object.fromEntries(entries)),
  ),
}));

const safeObject = fc
  .array(fc.tuple(safeKey, safeValue), { maxLength: 5 })
  .map((entries) => Object.fromEntries(entries) as Record<string, unknown>);

/** A path from the root to where the secret key is planted: object keys or array slots. */
const path = fc.array(fc.oneof(safeKey, fc.nat({ max: 3 })), { maxLength: 6 });

const define = (target: object, key: string, value: unknown) =>
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });

/** Returns a copy of `root` with `key: value` planted at the end of `steps` (object keys or array slots). */
function plant(
  root: Record<string, unknown>,
  steps: (string | number)[],
  key: string,
  value: unknown,
): Record<string, unknown> {
  const out = structuredClone(root);
  let cur: Record<string, unknown> | unknown[] = out;
  for (const step of steps) {
    const next: Record<string, unknown> | unknown[] = typeof step === 'number' ? [] : {};
    if (Array.isArray(cur)) cur.push(next);
    else define(cur, step as string, next);
    cur = next;
  }
  if (Array.isArray(cur)) cur.push(define({}, key, value));
  else define(cur, key, value);
  return out;
}

const entry = (data: Record<string, unknown>) => ({
  action: 'rule.created' as const,
  actor: { kind: 'system' as const },
  targetType: 'rule' as const,
  targetId: 'r',
  data,
});
// The guard runs before any SQL, so a TenantTx stand-in is never touched.
const tx = {} as TenantTx;

describe('audit data guard properties', () => {
  it('rejects a secret-looking key at any depth, in any case and with any separators', () => {
    fc.assert(
      fc.property(safeObject, path, secretKey, leaf, (root, steps, key, value) => {
        expect(() => assertAuditDataSafe(plant(root, steps, key, value))).toThrow(AuditDataError);
      }),
    );
  });

  it('rejects a secret-looking key smuggled in through toJSON before it reaches the database', async () => {
    await fc.assert(
      fc.asyncProperty(
        safeObject,
        path,
        secretKey,
        leaf,
        safeKey,
        path,
        async (root, steps, key, value, host, hostSteps) => {
          const smuggled = { toJSON: () => plant({}, steps, key, value) };
          const data = plant(root, hostSteps, `${host}Wrapper`, smuggled);
          await expect(writeAudit(tx, entry(data))).rejects.toBeInstanceOf(AuditDataError);
        },
      ),
    );
  });

  it('accepts objects whose keys are all harmless', async () => {
    await fc.assert(
      fc.asyncProperty(safeObject, async (data) => {
        expect(() => assertAuditDataSafe(data)).not.toThrow();
        await expect(writeAudit(tx, entry(data))).rejects.not.toBeInstanceOf(AuditDataError);
      }),
    );
  });
});
