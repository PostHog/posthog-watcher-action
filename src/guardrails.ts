export interface GuardrailOptions {
  maxChangedFiles: number;
  maxDiffLines: number;
}

export interface DiffStats {
  files: string[];
  diffLines: number;
}

export function checkDiffGuardrails(stats: DiffStats, options: GuardrailOptions): string[] {
  const failures: string[] = [];

  if (stats.files.length === 0) failures.push('no files changed');
  if (stats.files.length > options.maxChangedFiles) failures.push(`changed ${stats.files.length} files, limit is ${options.maxChangedFiles}`);
  if (stats.diffLines > options.maxDiffLines) failures.push(`diff has ${stats.diffLines} added/deleted lines, limit is ${options.maxDiffLines}`);

  for (const file of stats.files) {
    if (file.startsWith('.github/workflows/')) failures.push(`workflow file changed: ${file}`);
    if (/(^|\/)package-lock\.json$|(^|\/)pnpm-lock\.yaml$|(^|\/)yarn\.lock$/.test(file)) failures.push(`lockfile changed: ${file}`);
    if (/\.min\.(js|css)$/.test(file)) failures.push(`minified file changed: ${file}`);
    if (/(^|\/)\.env(\.|$)/.test(file)) failures.push(`environment file changed: ${file}`);
    if (/(^|\/)(\.npmrc|\.pypirc|\.netrc|id_rsa|id_ed25519)$/.test(file)) failures.push(`credential file changed: ${file}`);
    if (/(secret|credential|token|private[-_]?key)/i.test(file)) failures.push(`secret-like path changed: ${file}`);
  }

  return failures;
}

export function parseNumstat(output: string): DiffStats {
  const files: string[] = [];
  let diffLines = 0;

  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const [added, deleted, file] = line.split('\t');
    if (!file) continue;
    files.push(file);
    diffLines += numericStat(added) + numericStat(deleted);
  }

  return { files, diffLines };
}

function numericStat(value: string | undefined): number {
  if (!value || value === '-') return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}
