import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { Handler } from 'hono';
import { notFound } from '../errors.js';
import type { AppEnv } from './types.js';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};
const API_PREFIX = /^\/(v1|api|internal)(\/|$)/;

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export function staticHandler(root: string): Handler<AppEnv> {
  const absRoot = resolve(root);
  return async (c) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      throw notFound();
    }
    if (API_PREFIX.test(pathname) || pathname.includes('\0')) {
      throw notFound();
    }
    const target = resolve(absRoot, `.${pathname}`);
    if (target !== absRoot && !target.startsWith(absRoot + sep)) {
      throw notFound();
    }
    const file = (await isFile(target)) ? target : join(absRoot, 'index.html');
    if (!(await isFile(file))) throw notFound();
    const isIndex = file.endsWith(`${sep}index.html`);
    return c.body(new Uint8Array(await readFile(file)), 200, {
      'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': isIndex ? 'no-cache' : 'public, max-age=3600',
    });
  };
}
