import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { transform } from 'esbuild';

const { code } = await transform(readFileSync('src/security.ts', 'utf8'), { loader: 'ts', format: 'esm' });
const { assessIssueSecurity } = await import(`data:text/javascript,${encodeURIComponent(code)}`);

function issue(overrides = {}) {
  return {
    owner: 'example-org',
    repo: 'example-project',
    number: 1,
    title: 'Bug report',
    body: '',
    author: 'reporter',
    url: 'https://github.com/example-org/example-project/issues/1',
    labels: [],
    comments: [],
    ...overrides,
  };
}

test('token placeholders in issue examples are not treated as sensitive', () => {
  const assessment = assessIssueSecurity(issue({
    body: '```js\nanalytics.init(token, { enabled: true })\n```',
  }));

  assert.equal(assessment.sensitive, false);
  assert.deepEqual(assessment.reasons, []);
});

test('credential placeholders in assignments are not treated as sensitive', () => {
  const assessment = assessIssueSecurity(issue({
    body: 'const token = "YOUR_PROJECT_API_KEY";\nsecret: example-secret-goes-here',
  }));

  assert.equal(assessment.sensitive, false);
  assert.deepEqual(assessment.reasons, []);
});

test('real-looking credential values are treated as sensitive', () => {
  const assessment = assessIssueSecurity(issue({
    body: 'Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz1234567890',
  }));

  assert.equal(assessment.sensitive, true);
  assert.deepEqual(assessment.reasons, ['token']);
});

test('security labels and reports remain sensitive without credential evidence', () => {
  const assessment = assessIssueSecurity(issue({
    labels: ['security'],
    body: 'Reproduction details omitted.',
  }));

  assert.equal(assessment.sensitive, true);
  assert.deepEqual(assessment.reasons, ['security']);
});

test('watcher-generated bot comments do not poison later security assessments', () => {
  const assessment = assessIssueSecurity(issue({
    comments: [{
      author: 'github-actions[bot]',
      body: '<!-- custom-watcher-marker -->\nThis issue looks security-sensitive. Detected terms: token',
      url: 'https://github.com/example-org/example-project/issues/1#issuecomment-1',
      createdAt: '2026-07-01T00:00:00Z',
    }],
  }), '<!-- custom-watcher-marker -->');

  assert.equal(assessment.sensitive, false);
  assert.deepEqual(assessment.reasons, []);
});

test('legacy watcher comments remain ignored when a custom marker is configured', () => {
  const assessment = assessIssueSecurity(issue({
    comments: [{
      author: 'github-actions[bot]',
      body: '<!-- posthog-watcher-action -->\nThis issue looks security-sensitive. Detected terms: token',
      url: 'https://github.com/example-org/example-project/issues/1#issuecomment-2',
      createdAt: '2026-07-01T00:00:00Z',
    }],
  }), '<!-- custom-watcher-marker -->');

  assert.equal(assessment.sensitive, false);
  assert.deepEqual(assessment.reasons, []);
});

test('non-bot comments cannot hide security text by mentioning watcher marker', () => {
  const assessment = assessIssueSecurity(issue({
    comments: [{
      author: 'reporter',
      body: '<!-- posthog-watcher-action -->\nPotential security issue.',
      url: 'https://github.com/example-org/example-project/issues/1#issuecomment-3',
      createdAt: '2026-07-01T00:00:00Z',
    }],
  }));

  assert.equal(assessment.sensitive, true);
  assert.deepEqual(assessment.reasons, ['security']);
});
