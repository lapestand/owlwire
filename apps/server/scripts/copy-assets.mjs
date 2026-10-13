import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

// [source, target, required]
const assets = [
  [here('../../../packages/db/drizzle'), here('../drizzle'), true],
  [here('../../web/dist'), here('../public'), false],
];

for (const [from, to, required] of assets) {
  rmSync(to, { recursive: true, force: true });
  if (!existsSync(from)) {
    if (required) throw new Error(`missing build asset: ${from}`);
    console.warn(`skipping optional asset, not found: ${from}`);
    continue;
  }
  cpSync(from, to, { recursive: true });
}
