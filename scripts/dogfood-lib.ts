// Pure helpers for the chatbot dogfooding (SPEC-embeddings.md, Emenda 1). Kept apart so they are unit-tested.
import { readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

/** Root-level files that are read besides docs/**. */
const ROOT_FILES = ['README.md', 'CLAUDE.md', 'AGENTS.md'];
/** Never walked or read, at any depth: dependencies, runtime data, VCS and agent tooling folders. */
const EXCLUDED_DIRS = new Set([
  'vendor',
  'node_modules',
  'storage',
  '.git',
  '.claude',
  '.agents',
  '.codex',
  '.gemini',
  '.kiro',
  '.superpowers',
  '.referencias',
  '.codegraph',
]);

/** True for the allowlist: docs/**\/*.md and the root guides, never .env* or excluded folders. */
export function isAllowed(relPath: string): boolean {
  const parts = relPath.split(/[\\/]/);
  const file = parts.at(-1) ?? '';
  if (file.startsWith('.env')) return false;
  if (parts.some((p) => EXCLUDED_DIRS.has(p))) return false;
  if (parts.length === 1) return ROOT_FILES.includes(file);
  return parts[0] === 'docs' && file.toLowerCase().endsWith('.md');
}

export type SourceFile = { path: string; bytes: number };

/** Allowed files under `root`, as posix paths relative to it, sorted. Walks only docs/, never excluded folders. */
export function listAllowed(root: string): SourceFile[] {
  const found: SourceFile[] = [];
  const add = (rel: string) => {
    if (isAllowed(rel)) found.push({ path: rel, bytes: statSync(join(root, rel)).size });
  };
  for (const file of ROOT_FILES) {
    try {
      if (statSync(join(root, file)).isFile()) add(file);
    } catch {
      // Missing root guide: nothing to add.
    }
  }
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const child = posix.join(rel, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) walk(child);
      } else if (entry.isFile()) add(child);
    }
  };
  try {
    walk('docs');
  } catch {
    // No docs folder.
  }
  return found.sort((a, b) => (a.path < b.path ? -1 : 1));
}

export type Batch = { id: string; files: string[]; bytes: number };

/** Greedy batches in path order, each up to `maxBytes`; a file bigger than that goes alone. Every file once. */
export function makeBatches(files: SourceFile[], maxBytes: number): Batch[] {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new RangeError(`maxBytes must be a positive integer`);
  const batches: Batch[] = [];
  let current: Batch | undefined;
  for (const file of files) {
    if (!current || current.bytes + file.bytes > maxBytes) {
      current = { id: `b${String(batches.length + 1).padStart(3, '0')}`, files: [], bytes: 0 };
      batches.push(current);
    }
    current.files.push(file.path);
    current.bytes += file.bytes;
  }
  return batches;
}

/** Rough token estimate for planning only: ~4 bytes per token. */
export const estimateTokens = (bytes: number) => Math.ceil(bytes / 4);
