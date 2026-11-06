import { createRoute, z } from '@hono/zod-openapi';
import {
  AppApprovalItem,
  AppApprovalListResponse,
  ApprovalDecisionInput,
} from '../schemas/apps.js';
import { jsonContent, problemResponses, UuidParam } from './common.js';

const tags = ['internal', 'admin'];
const security = [{ cookieAuth: [] }];

export const listAppApprovalsRoute = createRoute({
  method: 'get',
  path: '/admin/apps/approvals',
  tags,
  security,
  responses: {
    200: jsonContent(AppApprovalListResponse, 'Public apps waiting for approval'),
    ...problemResponses(401, 403),
  },
});

export const decideAppApprovalRoute = createRoute({
  method: 'post',
  path: '/admin/apps/approvals/{appId}',
  tags,
  security,
  request: {
    params: z.object({ appId: UuidParam('appId') }),
    body: { required: true, content: { 'application/json': { schema: ApprovalDecisionInput } } },
  },
  // The decision response is the updated approval item, the same shape as a list item.
  responses: {
    200: jsonContent(AppApprovalItem, 'Decision stored'),
    ...problemResponses(400, 401, 403, 404, 422),
  },
});
