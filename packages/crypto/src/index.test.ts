import { describe, expect, it } from 'vitest';
import * as crypto from './index.js';

describe('@owlwire/crypto public exports', () => {
  it('does not expose the legacy per-secret DEK wrap helpers', () => {
    expect(crypto).not.toHaveProperty('wrapDek');
    expect(crypto).not.toHaveProperty('unwrapDek');
  });

  it('still exposes the workspace DEK helpers and the legacy secret box', () => {
    expect(typeof crypto.wrapWorkspaceDek).toBe('function');
    expect(typeof crypto.unwrapWorkspaceDek).toBe('function');
    expect(typeof crypto.createSecretBox).toBe('function');
    expect(typeof crypto.generateDek).toBe('function');
  });
});
