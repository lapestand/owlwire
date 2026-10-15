import { WORKSPACE_NAME_MAX } from '@owlwire/core';
import { describe, expect, it } from 'vitest';
import { CreateWorkspaceInput, UpdateWorkspaceInput } from './workspaces.js';

describe('workspace input', () => {
  it('trims the name and refuses a blank one', () => {
    expect(CreateWorkspaceInput.parse({ name: '  Kurt  ' })).toEqual({ name: 'Kurt' });
    expect(CreateWorkspaceInput.safeParse({ name: '   ' }).success).toBe(false);
  });

  it('measures the name limit in code points', () => {
    const owls = '🦉'.repeat(WORKSPACE_NAME_MAX);
    expect(CreateWorkspaceInput.safeParse({ name: owls }).success).toBe(true);
    expect(CreateWorkspaceInput.safeParse({ name: `${owls}🦉` }).success).toBe(false);
  });

  it('accepts a well-formed slug and refuses reserved, personal and malformed ones', () => {
    expect(CreateWorkspaceInput.safeParse({ name: 'A', slug: 'kurt-surusu' }).success).toBe(true);
    for (const slug of [
      'api',
      'admin',
      'v1',
      `p-${'a'.repeat(32)}`,
      'ab',
      'Upper',
      'a--b',
      '-ab',
    ]) {
      expect(CreateWorkspaceInput.safeParse({ name: 'A', slug }).success, slug).toBe(false);
    }
  });

  it('needs a name or a slug to update', () => {
    expect(UpdateWorkspaceInput.safeParse({}).success).toBe(false);
    expect(UpdateWorkspaceInput.safeParse({ slug: 'admin' }).success).toBe(false);
    expect(UpdateWorkspaceInput.parse({ name: 'New' })).toEqual({ name: 'New' });
  });
});
