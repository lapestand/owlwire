import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// CI passed (ci.yml) is the only required status check. A job that it does not list in `needs` could fail
// without blocking a merge, so every other job of the workflow must be listed.
const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const lines = ci.split('\n');

function jobIds(): string[] {
  const start = lines.indexOf('jobs:');
  return lines
    .slice(start + 1)
    .map((l) => /^ {2}([a-z0-9_-]+):\s*$/.exec(l)?.[1])
    .filter((id): id is string => id !== undefined);
}

function gateNeeds(): string[] {
  const gate = lines.indexOf('  ci-passed:');
  const needs = lines.indexOf('    needs:', gate);
  const out: string[] = [];
  for (const l of lines.slice(needs + 1)) {
    const m = /^ {6}- ([a-z0-9_-]+)\s*$/.exec(l);
    if (!m) break;
    out.push(m[1]);
  }
  return out;
}

describe('ci.yml gate', () => {
  it('has a CI passed job that always runs', () => {
    const gate = lines.indexOf('  ci-passed:');
    expect(gate).toBeGreaterThan(-1);
    expect(lines[gate + 1]).toBe('    name: CI passed');
    expect(lines[gate + 2]).toBe('    if: always()');
  });

  it('needs every other job of the workflow', () => {
    const others = jobIds().filter((id) => id !== 'ci-passed');
    expect(others.length).toBeGreaterThan(10);
    expect([...gateNeeds()].sort()).toEqual([...others].sort());
  });
});
