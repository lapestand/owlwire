import { describe, expect, it } from 'vitest';
import {
  applySourceTemplate,
  SOURCE_TEMPLATE_ROOTS,
  type SourceTemplateMapping,
  SourceTemplateMappingSchema,
  selectTemplateHeaders,
} from './source-template.js';
import { TemplateError } from './template.js';

const githubPush = {
  ref: 'refs/heads/main',
  repository: { full_name: 'acme/api', html_url: 'https://github.test/acme/api' },
  pusher: { name: 'ada' },
  head_commit: {
    id: 'abc123',
    message: 'fix the thing',
    url: 'https://github.test/acme/api/commit/abc123',
  },
  commits: [{ id: 'abc123' }, { id: 'def456' }],
};

const githubMapping: SourceTemplateMapping = {
  type: 'github.{{ headers.x-github-event }}',
  title: '{{ payload.repository.full_name }}: {{ payload.ref }}',
  body: '{{ payload.pusher.name }} pushed: {{ payload.head_commit.message }}',
  fields: [
    { label: 'Commit', value: '{{ payload.head_commit.id }}', inline: true },
    { label: 'Second', value: '{{ payload.commits[1].id }}' },
  ],
  url: '{{ payload.head_commit.url }}',
  groupKey: '{{ payload.repository.full_name }}',
  idempotencyKey: '{{ headers.x-github-delivery }}',
};

const alertmanager = {
  status: 'firing',
  groupKey: '{}:{alertname="DiskFull"}',
  commonLabels: { alertname: 'DiskFull', severity: 'critical', 'team name': 'storage' },
  commonAnnotations: { summary: 'Disk almost full', 'runbook.url': 'https://runbooks.test/disk' },
  alerts: [{ labels: { instance: 'db-1:9100' } }],
};

const alertMapping: SourceTemplateMapping = {
  type: 'alertmanager.{{ payload.status }}',
  severity: {
    from: '{{ payload.commonLabels.severity }}',
    map: { critical: 'critical', warning: 'medium' },
  },
  title: '{{ payload.commonLabels.alertname }}',
  body: '{{ payload.commonAnnotations.summary }} on {{ payload.alerts[0].labels.instance }}',
  fields: [{ label: 'Team', value: '{{ payload.commonLabels["team name"] }}' }],
  url: '{{ payload.commonAnnotations["runbook.url"] }}',
  groupKey: '{{ payload.groupKey }}',
  summary: '{{ payload.commonLabels.alertname }} firing',
};

const ctx = (payload: unknown, headers: Record<string, string> = {}) => ({ payload, headers });

function eventOf(mapping: SourceTemplateMapping, c: ReturnType<typeof ctx>) {
  const result = applySourceTemplate(mapping, c);
  if (!result.ok) throw new Error(`unexpected errors: ${JSON.stringify(result.errors)}`);
  return result.event;
}

describe('applySourceTemplate', () => {
  it('maps a GitHub-like push body with the event header', () => {
    const event = eventOf(
      githubMapping,
      ctx(githubPush, { 'x-github-event': 'push', 'x-github-delivery': 'd-1' }),
    );
    expect(event).toEqual({
      type: 'github.push',
      title: 'acme/api: refs/heads/main',
      body: 'ada pushed: fix the thing',
      fields: [
        { label: 'Commit', value: 'abc123', inline: true },
        { label: 'Second', value: 'def456' },
      ],
      url: 'https://github.test/acme/api/commit/abc123',
      groupKey: 'acme/api',
      idempotencyKey: 'd-1',
      data: githubPush,
    });
  });

  it('maps an Alertmanager-like body', () => {
    expect(eventOf(alertMapping, ctx(alertmanager))).toEqual({
      type: 'alertmanager.firing',
      severity: 'critical',
      title: 'DiskFull',
      body: 'Disk almost full on db-1:9100',
      fields: [{ label: 'Team', value: 'storage' }],
      url: 'https://runbooks.test/disk',
      groupKey: '{}:{alertname="DiskFull"}',
      summary: 'DiskFull firing',
      data: alertmanager,
    });
  });

  it('derives different types from the same template through the headers', () => {
    const mapping: SourceTemplateMapping = {
      type: 'github.{{ headers.x-github-event }}',
      body: 'event',
    };
    expect(
      eventOf(mapping, ctx({}, selectTemplateHeaders([['X-GitHub-Event', 'push']]))).type,
    ).toBe('github.push');
    expect(
      eventOf(mapping, ctx({}, selectTemplateHeaders([['X-GitHub-Event', 'issues']]))).type,
    ).toBe('github.issues');
  });

  it('renders a filtered header as empty text', () => {
    const headers = selectTemplateHeaders([
      ['Authorization', 'Bearer not-a-real-token'],
      ['X-GitHub-Event', 'push'],
    ]);
    const mapping: SourceTemplateMapping = { type: 't', body: '[{{ headers.authorization }}]' };
    expect(eventOf(mapping, ctx({}, headers)).body).toBe('[]');
  });

  describe('severity', () => {
    const base = { type: 't', body: 'b' };
    it('looks the rendered value up in map first', () => {
      const m = {
        ...base,
        severity: {
          from: '{{ payload.level }}',
          map: { warn: 'medium' as const, info: 'high' as const },
        },
      };
      expect(eventOf(m, ctx({ level: 'warn' })).severity).toBe('medium');
      expect(eventOf(m, ctx({ level: 'info' })).severity).toBe('high');
    });

    it('uses the rendered value directly when it is a severity', () => {
      const m = {
        ...base,
        severity: { from: '{{ payload.level }}', map: { warn: 'medium' as const } },
      };
      expect(eventOf(m, ctx({ level: 'low' })).severity).toBe('low');
      expect(
        eventOf({ ...base, severity: { from: '{{ payload.level }}' } }, ctx({ level: 'high' }))
          .severity,
      ).toBe('high');
    });

    it('falls back to default', () => {
      const m = { ...base, severity: { from: '{{ payload.level }}', default: 'low' as const } };
      expect(eventOf(m, ctx({ level: 'bogus' })).severity).toBe('low');
      expect(eventOf(m, ctx({})).severity).toBe('low');
      expect(eventOf({ ...base, severity: { default: 'info' as const } }, ctx({})).severity).toBe(
        'info',
      );
    });

    it('omits severity when nothing matches', () => {
      const event = eventOf(
        { ...base, severity: { from: '{{ payload.level }}', map: {} } },
        ctx({ level: 'bogus' }),
      );
      expect('severity' in event).toBe(false);
      expect('severity' in eventOf(base, ctx({}))).toBe(false);
    });

    it('does not resolve map entries through the prototype', () => {
      const m = {
        ...base,
        severity: { from: '{{ payload.level }}', map: { warn: 'medium' as const } },
      };
      expect('severity' in eventOf(m, ctx({ level: 'toString' }))).toBe(false);
    });
  });

  it('reports empty type and body with their paths and keeps collecting', () => {
    const result = applySourceTemplate(
      { type: '{{ payload.kind }}', body: '{{ payload.text }}' },
      ctx({}),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.path)).toEqual(['type', 'body']);
    for (const e of result.errors) expect(e.message).not.toBe('');
  });

  it('reports an invalid template in an unchecked mapping instead of throwing', () => {
    const result = applySourceTemplate(
      { type: 't', body: 'b', fields: [{ label: 'x', value: '{{ a + b }}' }] },
      ctx({}),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.path)).toEqual(['fields.0.value']);
  });

  it('drops optional fields that render empty', () => {
    const mapping: SourceTemplateMapping = {
      type: 't',
      body: 'b',
      title: '{{ payload.missing }}',
      url: '{{ payload.missing }}',
      imageUrl: '{{ payload.missing }}',
      groupKey: '{{ payload.missing }}',
      summary: '{{ payload.missing }}',
      idempotencyKey: '{{ payload.missing }}',
      fields: [
        { label: 'Empty', value: '{{ payload.missing }}' },
        { label: 'Kept', value: '{{ payload.here }}' },
        { label: 'Null', value: '{{ payload.nothing }}' },
      ],
    };
    expect(eventOf(mapping, ctx({ here: 'yes', nothing: null }))).toEqual({
      type: 't',
      body: 'b',
      fields: [{ label: 'Kept', value: 'yes' }],
      data: { here: 'yes', nothing: null },
    });
    const allEmpty = eventOf(
      { type: 't', body: 'b', fields: [{ label: 'E', value: '' }] },
      ctx([]),
    );
    expect('fields' in allEmpty).toBe(false);
  });

  it('leaves data out for a payload that is not a plain object', () => {
    for (const payload of [[1, 2], 'text', 42, null, undefined, new Date(0)]) {
      expect('data' in eventOf({ type: 't', body: 'b' }, ctx(payload))).toBe(false);
    }
  });

  it('passes an object payload through as data, without headers', () => {
    const payload = { a: 1 };
    const event = eventOf({ type: 't', body: 'b' }, ctx(payload, { 'x-github-event': 'push' }));
    expect(event.data).toBe(payload);
    expect(JSON.stringify(event.data)).not.toContain('x-github-event');
    expect(eventOf({ type: 't', body: 'b' }, ctx(Object.create(null))).data).toBeDefined();
  });
});

describe('applySourceTemplate output budget', () => {
  const bigPayload = { blob: 'x'.repeat(64 * 1024) };
  const amplifier = '{{payload}}'.repeat(727);

  it('refuses a template that amplifies the payload, quickly', () => {
    const started = performance.now();
    let caught: unknown;
    try {
      applySourceTemplate({ type: 't', body: amplifier }, ctx(bigPayload));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TemplateError);
    expect((caught as TemplateError).code).toBe('output_too_large');
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('leaves a normal mapping unaffected', () => {
    const event = eventOf(
      { type: 't', body: '{{ payload.blob }}', title: '{{ payload.short }}' },
      ctx({ blob: 'y'.repeat(60_000), short: 'ok' }),
    );
    expect(event.body).toHaveLength(60_000);
    expect(event.title).toBe('ok');
  });

  it('shares the budget across fields', () => {
    const payload = { half: 'z'.repeat(40_000) };
    expect(eventOf({ type: 't', body: '{{ payload.half }}' }, ctx(payload)).body).toHaveLength(
      40_000,
    );
    expect(() =>
      applySourceTemplate(
        { type: 't', body: '{{ payload.half }}', summary: '{{ payload.half }}' },
        ctx(payload),
      ),
    ).toThrow(expect.objectContaining({ code: 'output_too_large' }));
  });
});

describe('selectTemplateHeaders', () => {
  it('lower-cases names, drops secret headers and joins duplicates', () => {
    const headers = selectTemplateHeaders([
      ['Authorization', 'Basic x'],
      ['Cookie', 'sid=x'],
      ['Proxy-Authorization', 'Basic x'],
      ['X-Api-Key', 'x'],
      ['Idempotency-Key', 'x'],
      ['X-Hub-Signature-256', 'sha256=x'],
      ['X-Gitlab-Token', 'x'],
      ['X-Webhook-Secret', 'x'],
      ['X-Forwarded-Authorization', 'x'],
      ['X-Serverless-Authorization', 'x'],
      ['X-Shopify-Hmac-Sha256', 'x'],
      ['X-Auth-User', 'x'],
      ['X-Password', 'x'],
      ['X-Client-Credentials', 'x'],
      ['X-GitHub-Event', 'push'],
      ['User-Agent', 'GitHub-Hookshot/1'],
      ['Accept', 'a'],
      ['accept', 'b'],
    ]);
    expect(headers).toEqual({
      'x-github-event': 'push',
      'user-agent': 'GitHub-Hookshot/1',
      accept: 'a, b',
    });
  });

  it('takes Headers entries and keeps odd names as own data', () => {
    const h = new Headers({ 'X-GitHub-Event': 'ping', Authorization: 'x' });
    expect(selectTemplateHeaders(h.entries())).toEqual({ 'x-github-event': 'ping' });
    const odd = selectTemplateHeaders([['__proto__', 'v']]);
    expect(Object.getPrototypeOf(odd)).toBe(Object.prototype);
    expect(Object.hasOwn(odd, '__proto__')).toBe(true);
  });
});

describe('SourceTemplateMappingSchema', () => {
  it('exposes the template roots', () => {
    expect(SOURCE_TEMPLATE_ROOTS).toEqual(['payload', 'headers']);
  });

  it('accepts the example mappings', () => {
    expect(SourceTemplateMappingSchema.safeParse(githubMapping).success).toBe(true);
    expect(SourceTemplateMappingSchema.safeParse(alertMapping).success).toBe(true);
    expect(
      SourceTemplateMappingSchema.safeParse({ type: 't', body: 'b', severity: { default: 'info' } })
        .success,
    ).toBe(true);
  });

  const issuesOf = (input: unknown) => {
    const r = SourceTemplateMappingSchema.safeParse(input);
    expect(r.success).toBe(false);
    return r.error?.issues ?? [];
  };

  it('rejects unknown keys, also nested', () => {
    issuesOf({ type: 't', body: 'b', extra: 1 });
    issuesOf({ type: 't', body: 'b', severity: { from: 'x', extra: 1 } });
    issuesOf({ type: 't', body: 'b', fields: [{ label: 'l', value: 'v', extra: 1 }] });
  });

  it('rejects severities outside the list', () => {
    issuesOf({ type: 't', body: 'b', severity: { default: 'urgent' } });
    issuesOf({ type: 't', body: 'b', severity: { map: { a: 'urgent' } } });
  });

  it('rejects more than 20 fields', () => {
    const field = { label: 'l', value: 'v' };
    expect(
      SourceTemplateMappingSchema.safeParse({ type: 't', body: 'b', fields: Array(20).fill(field) })
        .success,
    ).toBe(true);
    issuesOf({ type: 't', body: 'b', fields: Array(21).fill(field) });
  });

  it('rejects an invalid template at the field path', () => {
    const issues = issuesOf({
      type: 't',
      body: 'b',
      fields: [
        { label: 'a', value: 'v' },
        { label: 'b', value: 'v' },
        { label: 'c', value: '{{ payload.a | upper }}' },
      ],
    });
    expect(issues.map((i) => i.path.join('.'))).toEqual(['fields.2.value']);
    expect(issuesOf({ type: 't', body: '{{ open' }).map((i) => i.path.join('.'))).toEqual(['body']);
    expect(
      issuesOf({ type: 't', body: 'b', severity: { from: '{{ }}' } }).map((i) => i.path.join('.')),
    ).toEqual(['severity.from']);
  });

  it('rejects a path whose root is not payload or headers', () => {
    const issues = issuesOf({ type: 't', body: '{{ alerts[0] }}' });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(['body']);
    expect(issues[0]?.message).toMatch(/unknown template root/);
    issuesOf({ type: '{{ ctx.payload }}', body: 'b' });
    issuesOf({ type: 't', body: 'b', title: '{{ payload.a }} {{ __proto__ }}' });
  });
});
