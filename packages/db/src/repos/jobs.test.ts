import { describe, expect, it } from 'vitest';
import {
  connectionQueue,
  digestJobKey,
  healthJobKey,
  JOB_NAMES,
  routeQueue,
  sendJobKey,
  TENANT_JOB_PAYLOAD_KEY,
  tenantJobName,
} from './jobs.js';

describe('job names and keys (contract §9)', () => {
  it('lists every job of the contract table', () => {
    expect([...JOB_NAMES].sort()).toEqual(
      [
        'route_event',
        'send_delivery',
        'send_digest',
        'health_check_connection',
        'health_check_all',
        'retention_sweep',
        'send_admin_notification',
        'purge_workspace',
        'status_webhook',
        'expire_link_requests',
        'send_email_consent',
      ].sort(),
    );
  });

  it('builds queue names and job keys', () => {
    expect(routeQueue('i1')).toBe('route:i1');
    expect(connectionQueue('c1')).toBe('conn:c1');
    expect(sendJobKey('d1')).toBe('send:d1');
    expect(digestJobKey('dest1', new Date('2026-10-12T09:00:00.000Z'))).toBe(
      `digest:dest1:${Date.UTC(2026, 9, 12, 9)}`,
    );
    expect(healthJobKey('c1')).toBe('health:c1');
  });

  it('namespaces tenant queue names and job keys by workspace', () => {
    expect(tenantJobName('ws1', sendJobKey('d1'))).toBe('w:ws1:send:d1');
    expect(tenantJobName('ws1', connectionQueue('c1'))).toBe('w:ws1:conn:c1');
    expect(TENANT_JOB_PAYLOAD_KEY).toBe('_ws');
  });
});
