import type { OpenAPIHono } from '@hono/zod-openapi';

/** API contract version, intentionally independent from the product version bumped on every commit. */
export const API_DOC_VERSION = 'v1';

/** Anything with an OpenAPI registry, i.e. the server's root OpenAPIHono app (one source of truth). */
export type OpenApiSource = Pick<OpenAPIHono, 'openAPIRegistry' | 'getOpenAPI31Document'>;

export type OpenApiDocument = ReturnType<OpenApiSource['getOpenAPI31Document']>;

export function buildOpenApiDocument(app: OpenApiSource): OpenApiDocument {
  app.openAPIRegistry.registerComponent('securitySchemes', 'installationToken', {
    type: 'http',
    scheme: 'bearer',
    description: 'Installation token (ow_inst_...)',
  });
  app.openAPIRegistry.registerComponent('securitySchemes', 'appKey', {
    type: 'http',
    scheme: 'bearer',
    description: 'App key (ow_app_...)',
  });
  // The SPDX `identifier` is valid in 3.1 but missing from the 3.0 info type the generator config uses,
  // so the info object is built separately to skip the excess property check.
  const info = {
    title: 'Owlwire API',
    version: API_DOC_VERSION,
    license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
  };
  return app.getOpenAPI31Document({
    openapi: '3.1.0',
    info,
    tags: [
      { name: 'events', description: 'Sending notifications' },
      { name: 'catalog', description: 'Notification type catalog of an app' },
      {
        name: 'internal',
        description:
          'Session-based management API used by the web UI; not covered by /v1 stability',
      },
    ],
  });
}
