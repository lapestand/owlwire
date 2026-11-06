import { describe, expect, it } from 'vitest';
import {
  InstallationCreateInput,
  InstallationUpdateInput,
  SourceTemplateCreateInput,
  SourceTemplatePreviewInput,
  SourceTemplateUpdateInput,
} from '../index.js';

const mapping = { type: 'generic', body: '{{payload.text}}' };
const appId = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';

describe('SourceTemplateCreateInput', () => {
  it('accepts a minimal and a full input', () => {
    expect(
      SourceTemplateCreateInput.safeParse({ key: 'github', name: 'GitHub', mapping }).success,
    ).toBe(true);
    expect(
      SourceTemplateCreateInput.safeParse({
        key: 'github',
        name: 'GitHub',
        description: 'd',
        mapping,
        samplePayload: { a: 1 },
      }).success,
    ).toBe(true);
  });

  it('rejects a bad key, name, description and unknown fields', () => {
    const base = { key: 'github', name: 'GitHub', mapping };
    expect(SourceTemplateCreateInput.safeParse({ ...base, key: 'Bad Key' }).success).toBe(false);
    expect(SourceTemplateCreateInput.safeParse({ ...base, name: '' }).success).toBe(false);
    expect(SourceTemplateCreateInput.safeParse({ ...base, name: 'x'.repeat(101) }).success).toBe(
      false,
    );
    expect(
      SourceTemplateCreateInput.safeParse({ ...base, description: 'x'.repeat(501) }).success,
    ).toBe(false);
    expect(SourceTemplateCreateInput.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(SourceTemplateCreateInput.safeParse({ key: 'github', name: 'GitHub' }).success).toBe(
      false,
    );
  });
});

describe('SourceTemplateUpdateInput', () => {
  it('needs at least one field', () => {
    expect(SourceTemplateUpdateInput.safeParse({}).success).toBe(false);
    expect(SourceTemplateUpdateInput.safeParse({ name: 'n' }).success).toBe(true);
    expect(SourceTemplateUpdateInput.safeParse({ key: 'other' }).success).toBe(false);
  });
});

describe('SourceTemplatePreviewInput', () => {
  it('takes a mapping or a template id, with optional headers', () => {
    expect(SourceTemplatePreviewInput.safeParse({ mapping, payload: {} }).success).toBe(true);
    expect(
      SourceTemplatePreviewInput.safeParse({ templateId: appId, payload: 1, headers: { a: 'b' } })
        .success,
    ).toBe(true);
    expect(SourceTemplatePreviewInput.safeParse({ payload: {} }).success).toBe(false);
    expect(
      SourceTemplatePreviewInput.safeParse({ mapping, templateId: appId, payload: {} }).success,
    ).toBe(false);
    expect(
      SourceTemplatePreviewInput.safeParse({ mapping, payload: {}, headers: { a: 1 } }).success,
    ).toBe(false);
  });
});

describe('installation source template fields', () => {
  it('accepts a template id or null on create', () => {
    expect(InstallationCreateInput.safeParse({ appId, sourceTemplateId: appId }).success).toBe(
      true,
    );
    expect(InstallationCreateInput.safeParse({ appId, sourceTemplateId: null }).success).toBe(true);
    expect(InstallationCreateInput.safeParse({ appId, sourceTemplateId: 'x' }).success).toBe(false);
  });

  it('rejects an empty update and accepts either field', () => {
    expect(InstallationUpdateInput.safeParse({}).success).toBe(false);
    expect(InstallationUpdateInput.safeParse({ sourceTemplateId: null }).success).toBe(true);
    expect(InstallationUpdateInput.safeParse({ sourceTemplateId: appId }).success).toBe(true);
    expect(InstallationUpdateInput.safeParse({ grantedTypes: null }).success).toBe(true);
  });
});
