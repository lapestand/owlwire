import { inject } from 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

export function pgAdminUrl(): string {
  return inject('pgAdminUrl');
}
