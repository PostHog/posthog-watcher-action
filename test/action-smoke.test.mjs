import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('bundled action entrypoint loads and reads GitHub Action inputs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'posthog-watcher-action-'));
  const eventPath = join(dir, 'event.json');
  writeFileSync(eventPath, '{}');

  const result = spawnSync(process.execPath, ['dist/index.js'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      'INPUT_OPENAI-API-KEY': 'dummy-openai-key',
      'INPUT_GITHUB-TOKEN': 'dummy-github-token',
      INPUT_MODEL: 'openai/gpt-5.5:high',
      'INPUT_DRY-RUN': 'true',
      GITHUB_REPOSITORY: 'PostHog/posthog-watcher-action',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_EVENT_PATH: eventPath,
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /No issue number provided/);
  assert.doesNotMatch(result.stdout + result.stderr, /Input required and not supplied/);
});

test('issue comments without watcher commands are skipped before inputs are required', () => {
  const dir = mkdtempSync(join(tmpdir(), 'posthog-watcher-action-'));
  const eventPath = join(dir, 'event.json');
  writeFileSync(eventPath, JSON.stringify({
    issue: { number: 123 },
    comment: {
      body: 'Thanks for the report!',
      author_association: 'MEMBER',
      user: { login: 'maintainer' },
    },
  }));

  const result = spawnSync(process.execPath, ['dist/index.js'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_REPOSITORY: 'PostHog/posthog-watcher-action',
      GITHUB_EVENT_NAME: 'issue_comment',
      GITHUB_EVENT_PATH: eventPath,
    },
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout + result.stderr, /Skipping run: issue comment does not contain a posthog-watcher command/);
  assert.doesNotMatch(result.stdout + result.stderr, /Input required and not supplied/);
});
