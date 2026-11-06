/** Catalog type that every app has; used by POST /v1/hooks. Reserved: apps cannot redefine it. */
export const GENERIC_TYPE_KEY = 'generic';

/** Owlwire's own message types (owlwire.digest, owlwire.test); catalogs cannot use this prefix. */
export const RESERVED_TYPE_PREFIX = 'owlwire.';
