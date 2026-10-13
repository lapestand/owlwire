import { describe, expect, it } from 'vitest';
import { ruleMatches } from './route-event.js';

const rule = { types: ['*'], minSeverity: 'info', enabled: true };

describe('ruleMatches', () => {
  it('matches every type with a wildcard and exact types otherwise', () => {
    expect(ruleMatches(rule, { type: 'a.b', severity: 'info' })).toBe(true);
    expect(ruleMatches({ ...rule, types: ['a.b'] }, { type: 'a.b', severity: 'info' })).toBe(true);
    expect(ruleMatches({ ...rule, types: ['a.c'] }, { type: 'a.b', severity: 'info' })).toBe(false);
  });

  it('respects the minimum severity and the enabled flag', () => {
    const high = { ...rule, minSeverity: 'high' };
    expect(ruleMatches(high, { type: 'x', severity: 'medium' })).toBe(false);
    expect(ruleMatches(high, { type: 'x', severity: 'critical' })).toBe(true);
    expect(ruleMatches({ ...rule, enabled: false }, { type: 'x', severity: 'critical' })).toBe(
      false,
    );
  });

  it('treats an unknown stored severity as info', () => {
    expect(ruleMatches({ ...rule, minSeverity: 'weird' }, { type: 'x', severity: 'info' })).toBe(
      true,
    );
  });
});
