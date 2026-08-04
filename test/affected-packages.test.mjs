import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { filterExistingFiles, readAffectedPackageNames } from '../src/affected-packages.ts';

test('finds nearest nested and root package manifests', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'posthog-watcher-packages-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(path.join(cwd, 'src'), { recursive: true });
  await mkdir(path.join(cwd, 'packages', 'child', 'src'), { recursive: true });
  await mkdir(path.join(cwd, '.changeset'), { recursive: true });
  await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: 'root-package' }));
  await writeFile(path.join(cwd, 'packages', 'child', 'package.json'), JSON.stringify({ name: '@example/child' }));

  const names = await readAffectedPackageNames(['src/index.ts', 'packages/child/src/index.ts', '.changeset/release.md'], cwd);

  assert.deepEqual(names.sort(), ['@example/child', 'root-package']);
});

test('ignores malformed package metadata because checklist inference is optional', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'posthog-watcher-malformed-package-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(path.join(cwd, 'src'), { recursive: true });
  await writeFile(path.join(cwd, 'package.json'), '{ invalid json');

  const names = await readAffectedPackageNames(['src/index.ts'], cwd);

  assert.deepEqual(names, []);
});

test('filters deleted paths before deriving verified checklist facts', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'posthog-watcher-files-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(path.join(cwd, 'tests'), { recursive: true });
  await writeFile(path.join(cwd, 'tests', 'kept.test.ts'), '');

  const existing = await filterExistingFiles(['tests/kept.test.ts', 'tests/deleted.test.ts'], cwd);

  assert.deepEqual(existing, ['tests/kept.test.ts']);
});
