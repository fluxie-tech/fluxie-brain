// Dogfooding step 1 (SPEC-embeddings.md, Emenda 1): allowlist + gitleaks + batches for the Haiku extraction agents.
// Writes .dogfood/batches.json (gitignored). Prints counts only, never file contents.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { leakyFiles } from './dogfood-leaks.ts';
import { estimateTokens, listAllowed, makeBatches } from './dogfood-lib.ts';

const source = process.env.DOGFOOD_SOURCE;
if (!source) {
  throw new Error('Set DOGFOOD_SOURCE to the project whose docs feed the dogfooding (no default path).');
}
const maxBytes = Number(process.argv.find((a) => a.startsWith('--max-bytes='))?.split('=')[1] ?? 120_000);
const out = '.dogfood';
mkdirSync(out, { recursive: true });

const files = listAllowed(source);

const leaky = leakyFiles(source, files);
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
