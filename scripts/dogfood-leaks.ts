// Dogfooding step 1: which allowlisted files gitleaks flags. Fails closed: if gitleaks cannot run, or reports a
// file that is not on the allowlist, the whole preparation stops instead of letting a leaky file through.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Our own config, so a .gitleaks.toml or .gitleaksignore inside the scanned folder cannot silence findings.
const CONFIG = fileURLToPath(new URL('./dogfood-gitleaks.toml', import.meta.url));

export type Finding = { File: string };
/** Scans one path and returns gitleaks' findings; throws if gitleaks did not run. */
export type Scan = (target: string) => Finding[];

/** Runs the gitleaks binary on a path (`--exit-code 0`: findings are not an error, anything else that fails is). */
export const gitleaksScan: Scan = (target) => {
  const dir = mkdtempSync(join(tmpdir(), 'gitleaks-'));
  const report = join(dir, 'report.json');
  try {
    const args = [
      'dir',
      target,
      '--no-banner',
      '--redact',
      '--exit-code',
      '0',
      '--report-format',
      'json',
      '--ignore-gitleaks-allow',
      '--config',
      CONFIG,
      '--gitleaks-ignore-path',
      dir,
    ];
    execFileSync('gitleaks', [...args, '--report-path', report], { stdio: 'ignore' });
    return JSON.parse(readFileSync(report, 'utf8')) as Finding[];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** Maps a finding's file (absolute, or relative to the cwd) to a source-relative path with forward slashes. */
const relativeTo = (source: string, file: string): string =>
  relative(resolve(source), resolve(file)).replaceAll('\\', '/');

/**
 * Source-relative paths of the allowlisted files that gitleaks flags, scanning `docs` and the root files.
 * Throws if gitleaks cannot run or a finding's path cannot be mapped into the source. A finding in a file that is
 * inside the source but off the list (never sent to an agent) is ignored.
 */
export function leakyFiles(source: string, files: { path: string }[], scan: Scan = gitleaksScan): Set<string> {
  const known = new Set(files.map((f) => f.path));
  const targets = ['docs', ...files.filter((f) => !f.path.includes('/')).map((f) => f.path)];
  const leaky = new Set<string>();
  for (const target of targets) {
    const path = join(source, target);
    if (!existsSync(path)) continue; // e.g. no docs folder.
    let findings: Finding[];
    try {
      findings = scan(path);
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'error';
      throw new Error(`gitleaks did not run (${code}). Install it and put it on PATH; nothing was prepared.`);
    }
    for (const { File } of findings) {
      const rel = relativeTo(source, File);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error(`gitleaks reported a file outside the source (${rel}); the mapping failed, resolve it first.`);
      }
      if (known.has(rel)) leaky.add(rel);
    }
  }
  return leaky;
}
