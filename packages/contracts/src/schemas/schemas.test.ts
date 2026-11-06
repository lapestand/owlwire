import { describe, expect, it } from 'vitest';
import {
  AppCreateInput,
  ApprovalDecisionInput,
  CatalogPutInput,
  EventsPostBody,
  HookJsonInput,
  InstallationCreateInput,
  InstallationUpdateInput,
  isReservedTypeKey,
  PROBLEM_CODES,
  PROBLEM_STATUS,
} from '../index.js';

const ev = { type: 'account.inactive', body: 'Player X is inactive' };

describe('EventsPostBody', () => {
  it('accepts a single event', () => {
    expect(EventsPostBody.safeParse(ev).success).toBe(true);
  });

  it('accepts a batch of up to 100 events', () => {
    expect(
      EventsPostBody.safeParse({ events: Array.from({ length: 100 }, () => ev) }).success,
    ).toBe(true);
  });

  it('rejects a batch of 101 events and an empty batch', () => {
    expect(
      EventsPostBody.safeParse({ events: Array.from({ length: 101 }, () => ev) }).success,
    ).toBe(false);
    expect(EventsPostBody.safeParse({ events: [] }).success).toBe(false);
  });

  it('rejects invalid type keys and empty bodies', () => {
    expect(EventsPostBody.safeParse({ ...ev, type: 'Bad Type' }).success).toBe(false);
    expect(EventsPostBody.safeParse({ ...ev, body: '' }).success).toBe(false);
  });
});

describe('CatalogPutInput', () => {
  const t = { key: 'attack.incoming', name: 'Incoming attack' };

  it('defaults severity to info', () => {
    const r = CatalogPutInput.parse({ types: [t] });
    expect(r.types[0]?.defaultSeverity).toBe('info');
  });

  it('rejects duplicate keys', () => {
    expect(CatalogPutInput.safeParse({ types: [t, t] }).success).toBe(false);
  });

  it('rejects the reserved generic key and the owlwire. prefix', () => {
    expect(CatalogPutInput.safeParse({ types: [{ key: 'generic', name: 'x' }] }).success).toBe(
      false,
    );
    expect(
      CatalogPutInput.safeParse({ types: [{ key: 'owlwire.digest', name: 'x' }] }).success,
    ).toBe(false);
    expect(isReservedTypeKey('owlwire.test')).toBe(true);
    expect(isReservedTypeKey('owlwired.alert')).toBe(false);
  });

  it('rejects payload schemas over 16384 bytes', () => {
    const big = { type: 'object', description: 'x'.repeat(16_400) };
    expect(CatalogPutInput.safeParse({ types: [{ ...t, payloadSchema: big }] }).success).toBe(
      false,
    );
  });
});

describe('management inputs', () => {
  it('requires a visibility for apps', () => {
    expect(AppCreateInput.safeParse({ name: 'Tracker' }).success).toBe(false);
    expect(AppCreateInput.safeParse({ name: 'Tracker', visibility: 'public' }).success).toBe(true);
  });

  it('allows null grantedTypes meaning the whole catalog', () => {
    const appId = '01920000-0000-7000-8000-000000000000';
    expect(InstallationCreateInput.safeParse({ appId, grantedTypes: null }).success).toBe(true);
    expect(InstallationCreateInput.safeParse({ appId, grantedTypes: [] }).success).toBe(false);
  });

  it('requires a non-empty hook body', () => {
    expect(HookJsonInput.safeParse({ body: '' }).success).toBe(false);
  });

  it('accepts an approval decision with an optional note and installation revocation', () => {
    expect(ApprovalDecisionInput.safeParse({ decision: 'approve' }).success).toBe(true);
    expect(
      ApprovalDecisionInput.safeParse({
        decision: 'reject',
        note: 'spam',
        revokeInstallations: true,
      }).success,
    ).toBe(true);
    expect(ApprovalDecisionInput.safeParse({ decision: 'maybe' }).success).toBe(false);
  });
});

describe('problem codes', () => {
  it('maps every code to its default http status', () => {
    for (const code of PROBLEM_CODES) expect(PROBLEM_STATUS[code]).toBeGreaterThanOrEqual(400);
    expect(PROBLEM_STATUS.validation_failed).toBe(422);
    expect(PROBLEM_STATUS.unknown_type).toBe(422);
    expect(PROBLEM_STATUS.installation_revoked).toBe(401);
    expect(PROBLEM_STATUS.unavailable).toBe(503);
    expect(PROBLEM_STATUS.app_not_approved).toBe(403);
  });
});

describe('url and strictness hardening', () => {
  it('limits homepageUrl to http and https', () => {
    const base = { name: 'Tracker', visibility: 'public' as const };
    for (const homepageUrl of ['javascript:alert(1)', 'data:text/html,x', 'ftp://x.example/a']) {
      expect(AppCreateInput.safeParse({ ...base, homepageUrl }).success).toBe(false);
    }
    expect(AppCreateInput.safeParse({ ...base, homepageUrl: 'https://x.example' }).success).toBe(
      true,
    );
  });

  it('rejects unknown keys on installation inputs', () => {
    const appId = '01920000-0000-7000-8000-000000000000';
    expect(InstallationCreateInput.safeParse({ appId, grantedType: ['a'] }).success).toBe(false);
    expect(InstallationUpdateInput.safeParse({ grantedTypes: null, extra: 1 }).success).toBe(false);
    expect(InstallationUpdateInput.safeParse({ grantedTypes: ['a'] }).success).toBe(true);
  });
});
