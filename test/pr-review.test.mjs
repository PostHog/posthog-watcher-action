import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { build, transform } from 'esbuild';

async function load(file) {
  const { code } = await transform(readFileSync(file, 'utf8'), { loader: 'ts', format: 'esm' });
  return import(`data:text/javascript,${encodeURIComponent(code)}`);
}

// For modules with relative runtime imports (which data: URLs cannot resolve).
async function loadBundled(file) {
  const result = await build({ entryPoints: [file], bundle: true, write: false, format: 'esm', platform: 'neutral' });
  return import(`data:text/javascript,${encodeURIComponent(result.outputFiles[0].text)}`);
}

const { reviewableLines, reviewableLinesByFile } = await load('src/diff-lines.ts');
const { isReviewableCodeFile } = await load('src/code-files.ts');
const { assessPullRequestSecurity } = await load('src/security.ts');
const { parsePrReview } = await loadBundled('src/pr-review-schema.ts');

const SAMPLE_PATCH = [
  '@@ -1,4 +1,5 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' const d = 5;',
  '@@ -20,2 +21,3 @@',
  ' function f() {',
  '+  return 42;',
  ' }',
].join('\n');

test('reviewableLines maps added and context lines on the new side', () => {
  const lines = reviewableLines(SAMPLE_PATCH);
  // First hunk starts at new line 1: ctx 1, +3 (line2), +4 (line3), ctx (line4).
  assert.ok(lines.has(1));
  assert.ok(lines.has(2));
  assert.ok(lines.has(3));
  assert.ok(lines.has(4));
  // Second hunk starts at new line 21: ctx 21, +22, ctx 23.
  assert.ok(lines.has(21));
  assert.ok(lines.has(22));
  assert.ok(lines.has(23));
});

test('reviewableLines does not advance the new-file counter on deletions', () => {
  const lines = reviewableLines(['@@ -1,3 +1,1 @@', '-gone one', '-gone two', ' kept'].join('\n'));
  assert.deepEqual([...lines].sort((a, b) => a - b), [1]);
});

test('reviewableLines returns an empty set for missing/binary patches', () => {
  assert.equal(reviewableLines(undefined).size, 0);
  assert.equal(reviewableLines('').size, 0);
});

test('reviewableLines ignores a trailing newline instead of adding a phantom line', () => {
  const patch = ['@@ -1,1 +1,2 @@', ' kept', '+added'].join('\n');
  const withNewline = reviewableLines(`${patch}\n`);
  assert.deepEqual([...withNewline].sort((a, b) => a - b), [1, 2]);
  assert.deepEqual([...reviewableLines(patch)].sort((a, b) => a - b), [1, 2]);
});

test('reviewableLinesByFile keys by filename', () => {
  const map = reviewableLinesByFile([{ filename: 'src/a.ts', patch: SAMPLE_PATCH }, { filename: 'src/b.ts', patch: undefined }]);
  assert.ok(map.get('src/a.ts').has(22));
  assert.equal(map.get('src/b.ts').size, 0);
});

test('parsePrReview extracts findings and clamps to the max', () => {
  const findings = Array.from({ length: 5 }, (_, i) => ({ path: 'src/a.ts', line: i + 1, severity: 'warning', title: `t${i}`, comment: `c${i}` }));
  const result = parsePrReview(JSON.stringify({ verdict: 'changes_requested', summary: 'hi', findings }), 3);
  assert.equal(result.verdict, 'changes_requested');
  assert.equal(result.summary, 'hi');
  assert.equal(result.findings.length, 3);
});

test('parsePrReview drops malformed findings and coerces enums', () => {
  const result = parsePrReview(JSON.stringify({
    verdict: 'nonsense',
    summary: 's',
    findings: [
      { path: 'src/a.ts', line: 10, severity: 'huge', title: 'ok', comment: 'valid' },
      { path: '', line: 3, comment: 'no path' },
      { path: 'src/b.ts', comment: 'no line' },
      { path: 'src/c.ts', line: 2, comment: '' },
    ],
  }), 20);
  assert.equal(result.verdict, 'comment'); // unknown verdict → comment
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].severity, 'info'); // unknown severity → info
  assert.equal(result.findings[0].line, 10);
});

test('parsePrReview tolerates prose around the JSON and non-JSON output', () => {
  const wrapped = 'Here is my review:\n{"verdict":"clean","summary":"looks good","findings":[]}\nThanks!';
  const result = parsePrReview(wrapped, 20);
  assert.equal(result.verdict, 'clean');
  assert.equal(result.findings.length, 0);

  const garbage = parsePrReview('no json here', 20);
  assert.equal(garbage.verdict, 'comment');
  assert.equal(garbage.findings.length, 0);
  assert.ok(garbage.summary.length > 0);
});

test('assessPullRequestSecurity flags security terms in title/body but not in the diff', () => {
  const sensitiveBody = assessPullRequestSecurity({ title: 'Fix login', body: 'This patches an auth bypass vulnerability', diff: '+const a = 1;' });
  assert.equal(sensitiveBody.sensitive, true);

  // Code routinely mentions security; terms alone in the diff must not block reviews.
  const codeMentions = assessPullRequestSecurity({ title: 'Refactor', body: 'Cleanup', diff: '+// Security policy: tokens are untrusted\n+function checkSecurity() {}' });
  assert.equal(codeMentions.sensitive, false);
});

test('assessPullRequestSecurity flags real-looking credentials anywhere, including the diff', () => {
  const leakedInDiff = assessPullRequestSecurity({ title: 'Update config', body: 'Routine change', diff: '+const token = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";' });
  assert.equal(leakedInDiff.sensitive, true);
  assert.ok(leakedInDiff.reasons.includes('token'));

  const placeholder = assessPullRequestSecurity({ title: 'Docs', body: 'Example config', diff: '+token = "YOUR_PROJECT_API_KEY"' });
  assert.equal(placeholder.sensitive, false);
});

test('isReviewableCodeFile matches code and manifests but skips docs', () => {
  assert.equal(isReviewableCodeFile('src/index.ts'), true);
  assert.equal(isReviewableCodeFile('lib/foo.py'), true);
  assert.equal(isReviewableCodeFile('Dockerfile'), true);
  assert.equal(isReviewableCodeFile('Makefile'), true);
  // Example code is reviewable so generic repositories get coverage of sample apps.
  assert.equal(isReviewableCodeFile('examples/demo.js'), true);
  assert.equal(isReviewableCodeFile('README.md'), false);
  assert.equal(isReviewableCodeFile('docs/guide.ts'), false);
  assert.equal(isReviewableCodeFile('image.png'), false);
});
