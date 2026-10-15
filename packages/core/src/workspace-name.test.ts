import { describe, expect, it } from 'vitest';
import { clampWorkspaceName, WORKSPACE_NAME_MAX, workspaceNameLength } from './workspace-name.js';

describe('workspace names', () => {
  it('measures code points, so an emoji counts once', () => {
    expect(workspaceNameLength('ab')).toBe(2);
    expect(workspaceNameLength('🦉🦉')).toBe(2);
    expect('🦉🦉'.length).toBe(4);
  });

  it('clamps to the limit without splitting a surrogate pair', () => {
    const owls = '🦉'.repeat(WORKSPACE_NAME_MAX + 5);
    const clamped = clampWorkspaceName(owls);
    expect(workspaceNameLength(clamped)).toBe(WORKSPACE_NAME_MAX);
    expect(clamped).toBe('🦉'.repeat(WORKSPACE_NAME_MAX));
  });

  it('trims before and after cutting', () => {
    expect(clampWorkspaceName('  Kurt  ')).toBe('Kurt');
    expect(clampWorkspaceName(`${'a'.repeat(WORKSPACE_NAME_MAX - 1)} b`)).toBe(
      'a'.repeat(WORKSPACE_NAME_MAX - 1),
    );
  });
});
