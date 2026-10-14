import type { TestProject } from 'vitest/node';
import { POSTGRES_IMAGE, startPostgres } from './postgres.js';
import { TEST_OWNER } from './test-roles.js';

export default async function setup(project: TestProject) {
  // Süper kullanıcı TEST_OWNER (owlwire) olur: startTestDatabase sahip rolü olarak bu kullanıcıyı kullanır.
  const pg = await startPostgres(process.env.OWLWIRE_TEST_PG_IMAGE ?? POSTGRES_IMAGE, TEST_OWNER);
  project.provide('pgAdminUrl', pg.url);
  return async () => {
    await pg.stop();
  };
}
