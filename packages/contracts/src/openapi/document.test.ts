import { OpenAPIHono } from '@hono/zod-openapi';
import { describe, expect, it } from 'vitest';
import { allRoutes } from '../routes/index.js';
import { buildOpenApiDocument } from './document.js';

type Op = {
  tags?: string[];
  security?: Array<Record<string, string[]>>;
  responses: Record<string, unknown>;
};

/** Mimics the server: /v1 routes on the root app, management routes on a router mounted at /api. */
function sampleApp() {
  const root = new OpenAPIHono();
  const api = new OpenAPIHono();
  api.openAPIRegistry.registerComponent('securitySchemes', 'cookieAuth', {
    type: 'apiKey',
    in: 'cookie',
    name: 'owlwire.session_token',
  });
  for (const route of allRoutes) {
    if (route.path.startsWith('/v1/')) root.openAPIRegistry.registerPath(route);
    else api.openAPIRegistry.registerPath(route);
  }
  root.route('/api', api);
  return root;
}

describe('buildOpenApiDocument', () => {
  const doc = buildOpenApiDocument(sampleApp());
  const paths = doc.paths as Record<string, Record<string, Op>>;

  it('produces an OpenAPI 3.1 document with a stable version', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.version).toBe('v1');
  });

  it('documents the public v1 API', () => {
    expect(Object.keys(paths['/v1/events'] ?? {})).toEqual(['post']);
    expect(paths['/v1/events']?.post?.responses).toHaveProperty('202');
    expect(paths['/v1/events']?.post?.responses).toHaveProperty('422');
    expect(paths['/v1/events']?.post?.responses).toHaveProperty('429');
    expect(paths['/v1/events/{id}']?.get?.responses).toHaveProperty('200');
    expect(paths['/v1/hooks']?.post?.security).toEqual([{ installationToken: [] }]);
    expect(paths['/v1/catalog']?.put?.security).toEqual([
      { appKey: [] },
      { installationToken: [] },
    ]);
  });

  it('mounts every management route under /api, tagged internal and protected by the session cookie', () => {
    const apiOps = Object.entries(paths)
      .filter(([p]) => p.startsWith('/api/'))
      .flatMap(([, ops]) => Object.values(ops));
    expect(apiOps.length).toBe(18);
    for (const op of apiOps) {
      expect(op.tags).toContain('internal');
      expect(op.security).toEqual([{ cookieAuth: [] }]);
    }
    expect(paths['/api/workspaces/{workspaceId}/apps/available']?.get).toBeDefined();
    expect(paths['/api/admin/apps/approvals/{appId}']?.post).toBeDefined();
  });

  it('registers shared schemas and security schemes', () => {
    const schemas = Object.keys(doc.components?.schemas ?? {});
    expect(schemas).toEqual(
      expect.arrayContaining([
        'EventInput',
        'ProblemDetails',
        'CatalogPutInput',
        'AppView',
        'AppApprovalItem',
      ]),
    );
    expect(Object.keys(doc.components?.securitySchemes ?? {}).sort()).toEqual([
      'appKey',
      'cookieAuth',
      'installationToken',
    ]);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(buildOpenApiDocument(sampleApp()))).toBe(JSON.stringify(doc));
  });
});
