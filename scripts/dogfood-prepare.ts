// Dogfooding step 1 (SPEC-embeddings.md, Emenda 1): allowlist + gitleaks + batches for the Haiku extraction agents.
// Writes .dogfood/batches.json (gitignored). Prints counts only, never file contents.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { estimateTokens, listAllowed, makeBatches } from './dogfood-lib.ts';

const source = process.env.DOGFOOD_SOURCE ?? 'C:\\Projetos\\chatbot';
const maxBytes = Number(process.argv.find((a) => a.startsWith('--max-bytes='))?.split('=')[1] ?? 120_000);
const out = '.dogfood';
mkdirSync(out, { recursive: true });

const files = listAllowed(source);

/** Paths (relative to the source) where gitleaks reports a finding; those files are never handed to an agent. */
function leakyFiles(): Set<string> {
  const report = join(out, 'gitleaks-report.json');
  const targets = ['docs', ...files.filter((f) => !f.path.includes('/')).map((f) => f.path)];
  const leaky = new Set<string>();
  for (const target of targets) {
    try {
      execFileSync(
        'gitleaks',
        [
          'dir',
          join(source, target),
          '--no-banner',
          '--redact',
          '--exit-code',
          '0',
          '--report-format',
          'json',
          '--report-path',
          report,
        ],
        { stdio: 'ignore' },
      );
    } catch {
      continue; // Missing target (e.g. no docs folder).
    }
    const findings = JSON.parse(readFileSync(report, 'utf8')) as { File: string }[];
    for (const f of findings) leaky.add(f.File.replaceAll('\\', '/').replace(`${source.replaceAll('\\', '/')}/`, ''));
  }
  return leaky;
}

const leaky = leakyFiles();
const clean = files.filter((f) => !leaky.has(f.path));
const batches = makeBatches(clean, maxBytes);
const bytes = clean.reduce((sum, f) => sum + f.bytes, 0);
writeFileSync(
  join(out, 'batches.json'),
  JSON.stringify({ source, createdAt: new Date().toISOString(), skipped: [...leaky], batches }, null, 2),
);
console.log(`arquivos permitidos: ${files.length}`);
console.log(`pulados pelo gitleaks: ${leaky.size}`);
console.log(
  `para extrair: ${clean.length} arquivos, ${(bytes / 1024).toFixed(0)} KiB, ~${estimateTokens(bytes)} tokens`,
);
console.log(`lotes: ${batches.length} (até ${(maxBytes / 1024).toFixed(0)} KiB cada) -> ${join(out, 'batches.json')}`);
