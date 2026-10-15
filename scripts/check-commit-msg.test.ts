import { describe, expect, it } from 'vitest';
import { checkCommitMessage, cleanMessage } from './check-commit-msg.mjs';

describe('checkCommitMessage', () => {
  it.each([
    'feat: add discord adapter',
    'fix(db): close scoped transactions on rollback',
    'feat(api)!: drop the v0 events endpoint',
    'docs: explain key rotation\n\nThe previous key stays readable until every workspace key is rewrapped.',
    'chore(deps): bump pino to the latest minor',
    'ci: scan git history for secrets',
    'test: cover the empty idempotency key',
    'refactor: share the uuid check',
    'perf: index deliveries by workspace and creation time',
    'revert: undo the cursor change',
  ])('accepts %j', (msg) => {
    expect(checkCommitMessage(msg)).toEqual([]);
  });

  it.each([
    'Merge branch "feature/x"',
    'Revert "feat: add discord adapter"',
    'fixup! fix(db): close scoped transactions',
  ])('accepts messages git writes itself: %j', (msg) => {
    expect(checkCommitMessage(msg)).toEqual([]);
  });

  it.each([
    ['add discord adapter', 'header must look like'],
    ['feature: add discord adapter', 'header must look like'],
    ['feat:add discord adapter', 'header must look like'],
    ['feat(DB): add x', 'header must look like'],
    ['feat: Add discord adapter', 'lowercase'],
    ['feat: add discord adapter.', 'punctuation'],
    [`feat: ${'a'.repeat(80)}`, 'longer than'],
    [`feat: ${'a'.repeat(67)} (#12)`, 'longer than'],
    ['feat: add adapter\nbody without blank line', 'blank line'],
    ['feat: discord adaptörü ekle', 'English'],
    ['fix: handle errors\n\nCo-authored-by: Someone <s@example.org>', 'attribution'],
    ['fix: handle errors\n\nGenerated with a tool', 'attribution'],
    ['chore: tidy code written with claude', 'attribution'],
    ['fix: handle errors \u{1F916}', 'attribution'],
    ['docs: add p1a names to contracts', 'internal plans'],
    ['fix(db): apply ruling R123', 'internal plans'],
    ['fix(db): apply ruling R1234', 'internal plans'],
    ["Merge branch 'feature/x'\n\nCo-authored-by: Someone <s@example.org>", 'attribution'],
    ['Revert "feat: add x"\n\nThis reverts the R12 change.', 'internal plans'],
    ['fixup! fix: handle errors\n\nhataları düzelt', 'English'],
    ['fix: close task 7 review findings', 'internal plans'],
    ['fix: address fix round 2', 'internal plans'],
    ['', 'empty'],
  ])('rejects %j', (msg, reason) => {
    const problems = checkCommitMessage(msg);
    expect(problems.join('\n')).toContain(reason);
  });

  it('does not treat SQLSTATE-like codes or versions as plan references', () => {
    expect(checkCommitMessage('fix(db): map sqlstate 22p02 and p0001 errors')).toEqual([]);
    expect(checkCommitMessage('chore(deps): bump node to 26.1')).toEqual([]);
  });

  it('measures a squash-merge header without the pull request suffix', () => {
    expect(checkCommitMessage(`feat: ${'a'.repeat(66)} (#379)`)).toEqual([]);
  });
});

describe('cleanMessage', () => {
  it('drops editor comments and everything below the scissors line', () => {
    const raw =
      'feat: add x\n\nbody\n# Please enter the commit message\n# ------------------------ >8 ------------------------\ndiff --git a b\n';
    expect(cleanMessage(raw)).toBe('feat: add x\n\nbody');
  });
});
