import { describe, expect, it } from 'vitest';
import { formatSeedResult } from './dev-seed.js';

describe('formatSeedResult', () => {
  it('prints the token and ready-to-run curl commands', () => {
    const text = formatSeedResult(
      {
        workspaceId: 'w',
        appId: 'a',
        installationId: 'i',
        token: 'ow_inst_abc',
        connectionId: 'c',
        destinationId: 'd',
        ruleId: 'r',
      },
      { port: 8080, platform: 'telegram' },
    );
    expect(text).toContain('ow_inst_abc');
    expect(text).toContain('curl -X POST "http://localhost:8080/v1/hooks?token=ow_inst_abc"');
    expect(text).toContain('http://localhost:8080/v1/events');
  });
});
