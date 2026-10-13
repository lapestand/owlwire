import type { TestProject } from 'vitest/node';
import { startPostgres } from './postgres.js';

export default async function setup(project: TestProject) {
  const pg = await startPostgres();
  project.provide('pgAdminUrl', pg.url);
  return async () => {
    await pg.stop();
  };
}
