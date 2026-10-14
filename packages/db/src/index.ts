export { authAdapter } from './auth-adapter.js';
export {
  LegacyDecryptFailedError,
  LegacySecretError,
  RepoConflictError,
  RepoInputError,
  RepoNotFoundError,
  safeErrorMessage,
  WorkspaceKeyMissingError,
} from './errors.js';
export { type OpenDatabaseOptions, OwlwireDb, openDatabase } from './handle.js';
export { isQueueSchemaReady } from './readiness.js';
export * from './repos/index.js';
export { tenantPolicySql } from './rls-sql.js';
export {
  InvalidScopeError,
  NestedScopeError,
  ScopeClosedError,
  type SystemTx,
  type TenantScope,
  TenantTx,
  tenantScope,
  withTenant,
} from './scope.js';
