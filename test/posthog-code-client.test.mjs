import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { transform } from 'esbuild';

const { code } = await transform(readFileSync('src/posthog-code-client.ts', 'utf8'), { loader: 'ts', format: 'esm' });
const { PostHogCodeClient, TERMINAL_RUN_STATUSES, findPullRequestUrl, parsePullRequestNumber } = await import(
  `data:text/javascript,${encodeURIComponent(code)}`
);

test('base url scopes requests to host and project id', () => {
  const client = new PostHogCodeClient('phx_test', '12345', 'https://us.posthog.com/');
  assert.equal(client.baseUrl, 'https://us.posthog.com/api/projects/12345');
});

test('terminal statuses cover completed, failed, and cancelled only', () => {
  assert.deepEqual([...TERMINAL_RUN_STATUSES].sort(), ['cancelled', 'completed', 'failed']);
  assert.ok(!TERMINAL_RUN_STATUSES.has('in_progress'));
  assert.ok(!TERMINAL_RUN_STATUSES.has('queued'));
});

test('findPullRequestUrl scans strings and nested run payloads', () => {
  assert.equal(
    findPullRequestUrl('PostHog Code opened https://github.com/PostHog/posthog-js/pull/42 for you'),
    'https://github.com/PostHog/posthog-js/pull/42',
  );
  assert.equal(
    findPullRequestUrl(undefined, { state: { result: { pr: 'https://github.com/PostHog/posthog.com/pull/7' } } }),
    'https://github.com/PostHog/posthog.com/pull/7',
  );
  assert.equal(findPullRequestUrl(null, undefined, { output: 'no links here' }), undefined);
});

test('parsePullRequestNumber extracts the PR number for review requests', () => {
  assert.equal(parsePullRequestNumber('https://github.com/PostHog/posthog-js/pull/42'), 42);
  assert.equal(parsePullRequestNumber('https://github.com/PostHog/posthog-js/issues/42'), undefined);
});

test('client sends bearer auth and returns latest_run from the run endpoint', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ id: 'task-1', latest_run: { id: 'run-1', status: 'queued' } }), { status: 200 });
  });

  const client = new PostHogCodeClient('phx_test', '12345', 'https://us.posthog.com');
  const task = await client.startRun('task-1', { runtimeAdapter: 'claude', model: 'claude-opus-4-8' });

  assert.equal(task.latest_run.id, 'run-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://us.posthog.com/api/projects/12345/tasks/task-1/run/');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer phx_test');
  assert.deepEqual(JSON.parse(calls[0].init.body), { mode: 'background', runtime_adapter: 'claude', model: 'claude-opus-4-8' });
});

test('client surfaces non-2xx responses with status and body excerpt', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('model is required when selecting a cloud runtime', { status: 400 }));

  const client = new PostHogCodeClient('phx_test', '12345', 'https://us.posthog.com');
  await assert.rejects(() => client.getTask('task-1'), /PostHog Code GET \/tasks\/task-1\/ failed \(400\): model is required/);
});
