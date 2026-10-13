#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const KINDS = ['patch', 'minor', 'major'];
const WORKSPACE_DIRS = ['apps', 'packages', 'packages/adapters'];
const VERSION_FIELD = /("version"\s*:\s*")([^"]*)(")/;

export function nextVersion(version, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`invalid version: ${version}`);
  let major = Number(m[1]);
  let minor = Number(m[2]);
  let patch = Number(m[3]);
  if (kind === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (kind === 'minor') {
    minor += 1;
    patch = 0;
  } else if (kind === 'patch') {
    patch += 1;
  } else {
    throw new Error(`invalid bump kind: ${kind} (expected ${KINDS.join('|')})`);
  }
  return `${major}.${minor}.${patch}`;
}

export function listPackageJsonFiles(root) {
  const files = [join(root, 'package.json')];
  for (const dir of WORKSPACE_DIRS) {
    const abs = join(root, dir);
    if (!existsSync(abs)) continue;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkg = join(abs, entry.name, 'package.json');
      if (existsSync(pkg)) files.push(pkg);
    }
  }
  return files;
}

export function bumpAll(root, kind) {
  const rootText = readFileSync(join(root, 'package.json'), 'utf8');
  const version = nextVersion(JSON.parse(rootText).version, kind);
  const files = listPackageJsonFiles(root);
  for (const file of files) {
    if (!VERSION_FIELD.test(readFileSync(file, 'utf8'))) {
      throw new Error(`${file} has no "version" field`);
    }
  }
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    writeFileSync(file, text.replace(VERSION_FIELD, `$1${version}$3`));
  }
  return version;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  console.log(bumpAll(root, process.argv[2]));
}
