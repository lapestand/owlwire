import { createRoute } from '@hono/zod-openapi';
import {
  SourceTemplateCreateInput,
  SourceTemplateListResponse,
  SourceTemplatePreviewInput,
  SourceTemplatePreviewResult,
  SourceTemplateUpdateInput,
  SourceTemplateView,
} from '../schemas/source-templates.js';
import { jsonContent, problemResponses, UuidParam, WorkspaceParams } from './common.js';

const tags = ['internal', 'source-templates'];
const security = [{ cookieAuth: [] }];
const TemplateParams = WorkspaceParams.extend({ templateId: UuidParam('templateId') });
const body = <
  T extends
    | typeof SourceTemplateCreateInput
    | typeof SourceTemplateUpdateInput
    | typeof SourceTemplatePreviewInput,
>(
  schema: T,
) => ({ required: true as const, content: { 'application/json': { schema } } });

export const listSourceTemplatesRoute = createRoute({
  method: 'get',
  path: '/workspaces/{workspaceId}/source-templates',
  tags,
  security,
  request: { params: WorkspaceParams },
  responses: {
    200: jsonContent(SourceTemplateListResponse, 'Source templates of the workspace'),
    ...problemResponses(401, 404, 422),
  },
});

export const createSourceTemplateRoute = createRoute({
  method: 'post',
  path: '/workspaces/{workspaceId}/source-templates',
  tags,
  security,
  request: { params: WorkspaceParams, body: body(SourceTemplateCreateInput) },
  responses: {
    201: jsonContent(SourceTemplateView, 'Created'),
    ...problemResponses(400, 401, 403, 404, 409, 422),
  },
});

// Registered before the {templateId} routes so "preview" is never read as an id.
export const previewSourceTemplateRoute = createRoute({
  method: 'post',
  path: '/workspaces/{workspaceId}/source-templates/preview',
  tags,
  security,
  request: { params: WorkspaceParams, body: body(SourceTemplatePreviewInput) },
  responses: {
    200: jsonContent(SourceTemplatePreviewResult, 'The event the template produces, or its errors'),
    ...problemResponses(400, 401, 403, 404, 422),
  },
});

export const getSourceTemplateRoute = createRoute({
  method: 'get',
  path: '/workspaces/{workspaceId}/source-templates/{templateId}',
  tags,
  security,
  request: { params: TemplateParams },
  responses: {
    200: jsonContent(SourceTemplateView, 'The source template'),
    ...problemResponses(401, 404, 422),
  },
});

export const updateSourceTemplateRoute = createRoute({
  method: 'patch',
  path: '/workspaces/{workspaceId}/source-templates/{templateId}',
  tags,
  security,
  request: { params: TemplateParams, body: body(SourceTemplateUpdateInput) },
  responses: {
    200: jsonContent(SourceTemplateView, 'Updated'),
    ...problemResponses(400, 401, 403, 404, 422),
  },
});

export const deleteSourceTemplateRoute = createRoute({
  method: 'delete',
  path: '/workspaces/{workspaceId}/source-templates/{templateId}',
  tags,
  security,
  request: { params: TemplateParams },
  responses: {
    204: { description: 'Deleted' },
    ...problemResponses(401, 403, 404, 409, 422),
  },
});
