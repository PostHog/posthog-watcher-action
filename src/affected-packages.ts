import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

export async function readAffectedPackageNames(files: string[], cwd = process.cwd()): Promise<string[]> {
  const names = new Set<string>();
  for (const file of files) {
    if (file.startsWith('.changeset/')) continue;
    let directory = path.dirname(file);
    while (true) {
      try {
        const manifest = JSON.parse(await readFile(path.join(cwd, directory, 'package.json'), 'utf8')) as { name?: unknown };
        if (typeof manifest.name === 'string' && manifest.name.trim()) names.add(manifest.name.trim());
        break;
      } catch (error) {
        if (!isNotFoundError(error)) break;
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
  }
  return [...names];
}

export async function filterExistingFiles(files: string[], cwd = process.cwd()): Promise<string[]> {
  const existing = await Promise.all(
    files.map(async (file) => {
      try {
        await access(path.join(cwd, file));
        return file;
      } catch {
        return undefined;
      }
    }),
  );
  return existing.filter((file): file is string => Boolean(file));
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
