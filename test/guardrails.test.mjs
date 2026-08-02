import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { transform } from 'esbuild';

const { code } = await transform(readFileSync('src/guardrails.ts', 'utf8'), { loader: 'ts', format: 'esm' });
const { checkDiffGuardrails, checkIssueFixDiffGuardrails } = await import(`data:text/javascript,${encodeURIComponent(code)}`);

const options = { maxChangedFiles: 10, maxDiffLines: 500 };

test('issue fixes reject changeset-only diffs', () => {
  const failures = checkIssueFixDiffGuardrails(
    { files: ['.changeset/fix-slim-analytics-feature-flags.md'], diffLines: 5 },
    options,
  );

  assert.deepEqual(failures, ['no substantive files changed; changeset-only diffs do not constitute an issue fix']);
});

test('issue fixes allow a changeset alongside a substantive change', () => {
  const failures = checkIssueFixDiffGuardrails(
    { files: ['.changeset/friendly-dogs-fix.md', 'src/repair-run.ts', 'test/guardrails.test.mjs'], diffLines: 30 },
    options,
  );

  assert.deepEqual(failures, []);
});

test('issue fixes preserve the existing no-files guardrail', () => {
  const failures = checkIssueFixDiffGuardrails({ files: [], diffLines: 0 }, options);

  assert.deepEqual(failures, ['no files changed']);
});

test('generic diff guardrails still allow changeset-only PR repairs', () => {
  const failures = checkDiffGuardrails(
    { files: ['.changeset/address-review.md'], diffLines: 5 },
    options,
  );

  assert.deepEqual(failures, []);
});
