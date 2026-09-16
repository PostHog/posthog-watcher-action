import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as github from '@actions/github';
import { transform } from 'esbuild';

const source = readFileSync('src/commands.ts', 'utf8')
  .replace("'@actions/core'", JSON.stringify(import.meta.resolve('@actions/core')))
  .replace("'@actions/github'", JSON.stringify(import.meta.resolve('@actions/github')));
const { code } = await transform(source, { loader: 'ts', format: 'esm' });
const { parseWatcherCommand, resolveCommand } = await import(`data:text/javascript,${encodeURIComponent(code)}`);

const originalEventName = github.context.eventName;
const originalPayload = github.context.payload;
test.afterEach(() => {
  github.context.eventName = originalEventName;
  github.context.payload = originalPayload;
});

test('standalone review commands are no longer recognized', () => {
  for (const command of ['review', 're-review']) {
    assert.equal(parseWatcherCommand(`@posthog-watcher ${command}`), undefined);
  }
  assert.equal(parseWatcherCommand('@posthog-watcher triage'), 'triage');
  assert.equal(parseWatcherCommand('@posthog-watcher re-run'), 'triage');
});

test('review-thread questions are skipped instead of triggering repair', () => {
  github.context.eventName = 'pull_request_review_comment';
  for (const body of ['@posthog-watcher why is this unsafe?', '@posthog-watcher review', '@posthog-watcher[bot] explain']) {
    github.context.payload = { comment: { body }, sender: { login: 'maintainer' } };
    assert.equal(resolveCommand('@posthog-watcher').shouldRun, false);
  }
});

test('explicit repair commands and external review feedback still trigger repair', () => {
  github.context.eventName = 'pull_request_review_comment';
  for (const [body, command] of [
    ['@posthog-watcher fix', 'fix'],
    ['@posthog-watcher fix ci', 'fix-ci'],
    ['@posthog-watcher address review', 'address-review'],
    ['@posthog-watcher rebase', 'rebase'],
    ['This branch needs to handle an empty input.', 'address-review'],
  ]) {
    github.context.payload = { comment: { body }, sender: { login: 'maintainer' } };
    const result = resolveCommand('@posthog-watcher');
    assert.equal(result.shouldRun, true);
    assert.equal(result.command, command);
    assert.equal(result.mode, 'fix');
  }
  github.context.eventName = 'pull_request_review';
  github.context.payload = { review: { state: 'changes_requested' }, sender: { login: 'reviewer' } };
  assert.equal(resolveCommand('@posthog-watcher').command, 'address-review');
});
