import {
  EventInput as EventInputSchema,
  isReservedTypeKey,
  type SourceTemplateCreateInput,
  type SourceTemplatePreviewInput,
  type SourceTemplatePreviewResult,
  type SourceTemplateUpdateInput,
  TYPE_KEY_PATTERN,
} from '@owlwire/contracts';
import {
  applySourceTemplate,
  GENERIC_TYPE_KEY,
  type SourceTemplateMapping,
  SourceTemplateMappingSchema,
  selectTemplateHeaders,
  TemplateError,
} from '@owlwire/core';
import {
  type AuditActor,
  createSourceTemplate,
  deleteSourceTemplate,
  getSourceTemplate,
  type SourceTemplateRow,
  type TenantScope,
  updateSourceTemplate,
  withTenant,
} from '@owlwire/db';
import { notFound, ProblemError, repositoryProblem } from '../errors.js';
import type { ServiceDeps } from './types.js';

/**
 * Largest sample payload a template may store. Equal to the ingestion body limit; services cannot import the HTTP
 * layer, so the value is repeated here.
 */
const MAX_SAMPLE_PAYLOAD_BYTES = 64 * 1024;
const MAX_REPORTED_ISSUES = 5;

function invalid(detail: string): ProblemError {
  return new ProblemError(422, 'validation_failed', detail);
}

const joinPath = (path: ReadonlyArray<PropertyKey>) => path.map(String).join('.');

/** A mapping that passes the core schema, has no empty key and a valid literal type; anything else is a 422. */
function validateMapping(raw: unknown): SourceTemplateMapping {
  const parsed = SourceTemplateMappingSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues
      .slice(0, MAX_REPORTED_ISSUES)
      .map((i) => `${joinPath(i.path) || 'mapping'}: ${i.message}`);
    throw invalid(lines.join('; '));
  }
  const mapping = parsed.data;
  if (Object.keys(mapping.severity?.map ?? {}).includes('')) {
    throw invalid('severity.map: keys must not be empty');
  }
  if (!mapping.type.includes('{{')) {
    const literal = mapping.type;
    const allowed =
      literal === GENERIC_TYPE_KEY ||
      (TYPE_KEY_PATTERN.test(literal) && !isReservedTypeKey(literal));
    if (!allowed) throw invalid('type: must be a valid, non-reserved type key');
  }
  return mapping;
}

function validateSample(sample: unknown): void {
  if (sample === undefined) return;
  const json = JSON.stringify(sample);
  if (json !== undefined && Buffer.byteLength(json) > MAX_SAMPLE_PAYLOAD_BYTES) {
    throw invalid('samplePayload: larger than 64 KiB');
  }
}

async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw repositoryProblem(err) ?? err;
  }
}

export async function createWorkspaceSourceTemplate(
  d: ServiceDeps,
  scope: TenantScope,
  actor: AuditActor,
  input: SourceTemplateCreateInput,
): Promise<SourceTemplateRow> {
  const mapping = validateMapping(input.mapping);
  validateSample(input.samplePayload);
  return guarded(() =>
    withTenant(d.db, scope, (t) =>
      createSourceTemplate(
        t,
        {
          key: input.key,
          name: input.name,
          ...(input.description !== undefined && { description: input.description }),
          mapping,
          ...(input.samplePayload !== undefined && { samplePayload: input.samplePayload }),
        },
        actor,
      ),
    ),
  );
}

export async function updateWorkspaceSourceTemplate(
  d: ServiceDeps,
  scope: TenantScope,
  actor: AuditActor,
  id: string,
  patch: SourceTemplateUpdateInput,
): Promise<SourceTemplateRow> {
  const mapping = patch.mapping === undefined ? undefined : validateMapping(patch.mapping);
  validateSample(patch.samplePayload);
  const row = await guarded(() =>
    withTenant(d.db, scope, (t) =>
      updateSourceTemplate(
        t,
        id,
        {
          ...(patch.name !== undefined && { name: patch.name }),
          ...(patch.description !== undefined && { description: patch.description }),
          ...(mapping !== undefined && { mapping }),
          ...(patch.samplePayload !== undefined && { samplePayload: patch.samplePayload }),
        },
        actor,
      ),
    ),
  );
  if (!row) throw notFound();
  return row;
}

/** A template an active installation still uses is a 409. */
export async function deleteWorkspaceSourceTemplate(
  d: ServiceDeps,
  scope: TenantScope,
  actor: AuditActor,
  id: string,
): Promise<void> {
  const deleted = await guarded(() =>
    withTenant(d.db, scope, (t) => deleteSourceTemplate(t, id, actor)),
  );
  if (!deleted) throw notFound();
}

/**
 * Renders a mapping (given or stored) on a sample request and checks the result against the event input, the same
 * way ingestion does. Writes nothing and checks neither catalog nor grants, because a template belongs to no app.
 */
export async function previewSourceTemplate(
  d: ServiceDeps,
  scope: TenantScope,
  input: SourceTemplatePreviewInput,
): Promise<SourceTemplatePreviewResult> {
  let mapping: SourceTemplateMapping;
  if ('templateId' in input) {
    const row = await guarded(() =>
      withTenant(d.db, scope, (t) => getSourceTemplate(t, input.templateId)),
    );
    if (!row) throw notFound();
    mapping = validateMapping(row.mapping);
  } else {
    mapping = validateMapping(input.mapping);
  }

  let applied: ReturnType<typeof applySourceTemplate>;
  try {
    applied = applySourceTemplate(mapping, {
      payload: input.payload,
      headers: selectTemplateHeaders(Object.entries(input.headers ?? {})),
    });
  } catch (err) {
    if (err instanceof TemplateError) {
      return { ok: false, errors: [{ path: '', message: err.message }] };
    }
    throw err;
  }
  if (!applied.ok) return applied;
  const checked = EventInputSchema.safeParse(applied.event);
  if (!checked.success) {
    return {
      ok: false,
      errors: checked.error.issues.map((i) => ({ path: joinPath(i.path), message: i.message })),
    };
  }
  return { ok: true, event: checked.data };
}
