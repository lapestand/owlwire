import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Exit code of dependency-cruiser over apps/ and packages/; start failures are printed, not swallowed. */
export function runDepcruise({
  dirs = ['apps', 'packages'].filter((d) => existsSync(d)),
  spawn = spawnSync,
  log = (line) => console.error(line),
} = {}) {
  const r = spawn('depcruise', [...dirs, '--config', '.dependency-cruiser.cjs'], {
    stdio: 'inherit',
  });
  if (r.error) {
    log(`depcruise could not be started: ${r.error.message}`);
    return 1;
  }
  if (r.status === null) {
    log(`depcruise was terminated by ${r.signal ?? 'an unknown signal'}`);
    return 1;
  }
  return r.status;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  process.exit(runDepcruise());
}
