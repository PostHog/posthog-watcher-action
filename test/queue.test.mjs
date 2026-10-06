import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as github from '@actions/github';
import { transform } from 'esbuild';

const source = readFileSync('src/queue.ts', 'utf8')
  .replace("'@actions/core'", JSON.stringify(import.meta.resolve('@actions/core')))
  .replace("'@actions/github'", JSON.stringify(import.meta.resolve('@actions/github')));
const { code } = await transform(source, { loader: 'ts', format: 'esm' });
const { enqueueCurrentPayload, readQueue } = await import(`data:text/javascript,${encodeURIComponent(code)}`);

process.env.GITHUB_REPOSITORY = 'PostHog/posthog-js';
const inputs = { queuedMode: 'auto', stateRepo: '', stateBranch: 'posthog-watcher-state', commandMention: '@posthog-watcher' };
const command = { shouldRun: true, commandMention: '@posthog-watcher' };

const originalEventName = github.context.eventName;
const originalPayload = github.context.payload;
test.afterEach(() => {
  github.context.eventName = originalEventName;
  github.context.payload = originalPayload;
});

function fakeQueueStore(initial) {
  let content = initial === undefined ? undefined : JSON.stringify(initial);
  let sha = content ? 'sha-0' : undefined;
  let writes = 0;
  return {
    get items() {
      return content ? JSON.parse(content).items : [];
    },
    octokit: {
      rest: {
        git: { getRef: async () => ({ data: { object: { sha: 'base' } } }) },
        repos: {
          getContent: async () => {
            if (content === undefined) throw Object.assign(new Error('missing'), { status: 404 });
            return { data: { type: 'file', content: Buffer.from(content).toString('base64'), sha } };
          },
          createOrUpdateFileContents: async (params) => {
            content = Buffer.from(params.content, 'base64').toString('utf8');
            writes += 1;
            sha = `sha-${writes}`;
            return {};
          },
        },
      },
    },
  };
}

function closedIssueEvent(number) {
  github.context.eventName = 'issues';
  github.context.payload = { action: 'closed', issue: { number } };
}

test('closed issue events enqueue an issue-closed item without a command or comment', async () => {
  closedIssueEvent(5176);
  const store = fakeQueueStore();
  const result = await enqueueCurrentPayload(store.octokit, inputs, command);
  assert.equal(result.enqueued, true);
  assert.equal(result.item.kind, 'issue-closed');
  assert.equal(result.item.number, 5176);
  assert.equal(result.item.mode, 'auto');
  assert.equal(result.item.command, undefined);
  assert.equal(result.item.attempts, 0);
  assert.equal(store.items.length, 1);
});

test('repeated closed events for the same issue dedupe against the pending item', async () => {
  closedIssueEvent(5176);
  const store = fakeQueueStore();
  await enqueueCurrentPayload(store.octokit, inputs, command);
  const second = await enqueueCurrentPayload(store.octokit, inputs, command);
  assert.equal(second.enqueued, false);
  assert.equal(second.queueLength, 1);
});

test('an issue-closed item does not dedupe against a pending triage item for the same issue', async () => {
  const store = fakeQueueStore();
  github.context.eventName = 'issues';
  github.context.payload = { action: 'opened', issue: { number: 5176 } };
  const opened = await enqueueCurrentPayload(store.octokit, inputs, command);
  assert.equal(opened.item.kind, 'issue');

  closedIssueEvent(5176);
  const closed = await enqueueCurrentPayload(store.octokit, inputs, command);
  assert.equal(closed.enqueued, true);
  assert.deepEqual(store.items.map((item) => item.kind), ['issue', 'issue-closed']);
});

test('closed pull request payloads are still queued as pull_request items', async () => {
  github.context.eventName = 'issues';
  github.context.payload = { action: 'closed', issue: { number: 10, pull_request: {} } };
  const store = fakeQueueStore();
  const result = await enqueueCurrentPayload(store.octokit, inputs, command);
  assert.equal(result.item.kind, 'pull_request');
});

test('existing queue files without issue-closed items still parse and keep their items', async () => {
  const legacy = {
    version: 1,
    items: [
      { id: 'issue-1-auto-none-no-comment-no-close-1', kind: 'issue', number: 1, mode: 'auto', enqueuedAt: 'x', source: { eventName: 'issues', runId: 1, runUrl: 'u' }, attempts: 0 },
      { id: 'pull_request-2-fix-fix-5-no-close-2', kind: 'pull_request', number: 2, mode: 'fix', command: 'fix', enqueuedAt: 'x', source: { eventName: 'issue_comment', runId: 1, runUrl: 'u', commentId: 5 }, attempts: 1 },
      { id: 'bogus', kind: 'unknown', number: 3, mode: 'auto' },
    ],
  };
  const store = fakeQueueStore(legacy);
  const queue = await readQueue(store.octokit, inputs);
  assert.deepEqual(queue.items.map((item) => item.kind), ['issue', 'pull_request']);

  closedIssueEvent(1);
  await enqueueCurrentPayload(store.octokit, inputs, command);
  assert.deepEqual(store.items.map((item) => [item.kind, item.number]), [['issue', 1], ['pull_request', 2], ['issue-closed', 1]]);
});
