import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const dirs = ['apps', 'packages'].filter((d) => existsSync(d));
const r = spawnSync('depcruise', [...dirs, '--config', '.dependency-cruiser.cjs'], {
  stdio: 'inherit',
});
process.exit(r.status ?? 1);
