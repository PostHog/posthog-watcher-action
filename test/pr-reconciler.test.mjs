import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

process.env.GITHUB_REPOSITORY = 'PostHog/posthog-js';

const dir = mkdtempSync(join(tmpdir(), 'watcher-pr-reconciler-'));
let reconcileClosedIssuePullRequest;
let reconcileWatcherPullRequests;
let issueNumberFromBranch;
try {
  const outfile = join(dir, 'pr-reconciler.cjs');
  await build({ entryPoints: ['src/pr-reconciler.ts'], bundle: true, platform: 'node', format: 'cjs', outfile });
  ({ reconcileClosedIssuePullRequest, reconcileWatcherPullRequests, issueNumberFromBranch } = await import(pathToFileURL(outfile).href));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const MARKER = '<!-- posthog-watcher-action -->';
const BOT = 'github-actions[bot]';
const inputs = { allowCloseOwnPrs: true, dryRun: false, stateEnabled: false, commentMarker: MARKER };

function pull(overrides = {}) {
  return {
    number: 5179,
    html_url: 'https://github.com/PostHog/posthog-js/pull/5179',
    title: 'fix: flex layout',
    draft: true,
    user: { login: BOT },
    head: { ref: 'posthog-watcher/issue-5176', repo: { full_name: 'PostHog/posthog-js' } },
    ...overrides,
  };
}

function fakeOctokit({ pulls = [pull()], issue = { state: 'closed', closed_at: '2026-10-01T12:34:56Z' }, commits, timeline, associatedPulls = [] } = {}) {
  const calls = [];
  const record = (name, result) => async (params) => {
    calls.push({ name, params });
    return typeof result === 'function' ? result(params) : result;
  };
  const octokit = {
    calls,
    paginate: async (fn, params) => (await fn(params)).data,
    rest: {
      pulls: {
        list: record('pulls.list', (params) => ({ data: params.head ? pulls.filter((item) => `PostHog:${item.head.ref}` === params.head) : pulls })),
        listCommits: record('pulls.listCommits', { data: commits ?? [{ author: { login: BOT }, commit: { author: { name: BOT } } }] }),
        update: record('pulls.update', { data: {} }),
      },
      issues: {
        get: record('issues.get', { data: issue }),
        listEventsForTimeline: record('issues.listEventsForTimeline', { data: timeline ?? [] }),
        listComments: record('issues.listComments', { data: [] }),
        createComment: record('issues.createComment', { data: { html_url: 'https://github.com/PostHog/posthog-js/pull/5179#issuecomment-1' } }),
        updateComment: record('issues.updateComment', { data: { html_url: 'https://github.com/PostHog/posthog-js/pull/5179#issuecomment-1' } }),
      },
      repos: {
        listPullRequestsAssociatedWithCommit: record('repos.listPullRequestsAssociatedWithCommit', { data: associatedPulls }),
      },
      git: {
        deleteRef: record('git.deleteRef', {}),
      },
    },
  };
  return octokit;
}

const names = (octokit) => octokit.calls.map((call) => call.name);
const call = (octokit, name) => octokit.calls.find((entry) => entry.name === name)?.params;
const mutationNames = ['issues.createComment', 'issues.updateComment', 'pulls.update', 'git.deleteRef'];
const mutations = (octokit) => names(octokit).filter((name) => mutationNames.includes(name));

test('closes its own draft PR with a comment and deletes the branch when the linked issue closed', async () => {
  const octokit = fakeOctokit({
    timeline: [{ event: 'labeled' }, { event: 'closed', commit_id: '108768731aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }],
    associatedPulls: [{ number: 5181, merged_at: '2026-10-01T13:00:00Z' }],
  });
  const result = await reconcileClosedIssuePullRequest(octokit, 5176, inputs);

  assert.deepEqual(result, { conclusion: 'closed stale watcher PR', prUrl: 'https://github.com/PostHog/posthog-js/pull/5179', closed: true });
  assert.deepEqual(mutations(octokit), ['issues.createComment', 'pulls.update', 'git.deleteRef']);
  assert.deepEqual(call(octokit, 'pulls.list'), { owner: 'PostHog', repo: 'posthog-js', state: 'open', head: 'PostHog:posthog-watcher/issue-5176', per_page: 10 });
  assert.deepEqual(call(octokit, 'issues.createComment'), {
    owner: 'PostHog',
    repo: 'posthog-js',
    issue_number: 5179,
    body: `${MARKER}\nClosing: #5176 was closed on 2026-10-01 via #5181, so this draft is no longer needed. Reopen if the issue is reopened.`,
  });
  assert.deepEqual(call(octokit, 'pulls.update'), { owner: 'PostHog', repo: 'posthog-js', pull_number: 5179, state: 'closed' });
  assert.deepEqual(call(octokit, 'git.deleteRef'), { owner: 'PostHog', repo: 'posthog-js', ref: 'heads/posthog-watcher/issue-5176' });
  assert.ok(names(octokit).indexOf('issues.createComment') < names(octokit).indexOf('pulls.update'));
  assert.ok(names(octokit).indexOf('pulls.update') < names(octokit).indexOf('git.deleteRef'));
});

test('omits the via clause when the closing event has no merged PR behind it', async () => {
  const octokit = fakeOctokit({ timeline: [{ event: 'closed', commit_id: null }] });
  await reconcileClosedIssuePullRequest(octokit, 5176, inputs);
  assert.match(call(octokit, 'issues.createComment').body, /Closing: #5176 was closed on 2026-10-01, so this draft is no longer needed\./);
  assert.doesNotMatch(call(octokit, 'issues.createComment').body, /via #/);
  assert.equal(call(octokit, 'repos.listPullRequestsAssociatedWithCommit'), undefined);
});

test('omits the via clause when the associated PR was never merged', async () => {
  const octokit = fakeOctokit({ timeline: [{ event: 'closed', commit_id: 'abc' }], associatedPulls: [{ number: 9999, merged_at: null }] });
  await reconcileClosedIssuePullRequest(octokit, 5176, inputs);
  assert.doesNotMatch(call(octokit, 'issues.createComment').body, /via #/);
});

test('updates an existing marker comment instead of posting a second one', async () => {
  const octokit = fakeOctokit();
  octokit.rest.issues.listComments = async (params) => {
    octokit.calls.push({ name: 'issues.listComments', params });
    return { data: [{ id: 77, body: `${MARKER}\nolder` }] };
  };
  await reconcileClosedIssuePullRequest(octokit, 5176, inputs);
  assert.deepEqual(mutations(octokit), ['issues.updateComment', 'pulls.update', 'git.deleteRef']);
  assert.equal(call(octokit, 'issues.updateComment').comment_id, 77);
});

test('does nothing when allow-close-own-prs is false', async () => {
  const octokit = fakeOctokit();
  const result = await reconcileClosedIssuePullRequest(octokit, 5176, { ...inputs, allowCloseOwnPrs: false });
  assert.deepEqual(result, { conclusion: 'skipped because allow-close-own-prs is false', closed: false });
  assert.deepEqual(names(octokit), []);
});

test('does nothing when no open PR exists for the issue branch', async () => {
  const octokit = fakeOctokit({ pulls: [] });
  const result = await reconcileClosedIssuePullRequest(octokit, 5176, inputs);
  assert.deepEqual(result, { conclusion: 'no open watcher PR', closed: false });
  assert.deepEqual(names(octokit), ['pulls.list']);
});

test('dry-run performs no mutations', async () => {
  const octokit = fakeOctokit();
  const result = await reconcileClosedIssuePullRequest(octokit, 5176, { ...inputs, dryRun: true });
  assert.deepEqual(result, { conclusion: 'dry-run would close stale watcher PR', prUrl: 'https://github.com/PostHog/posthog-js/pull/5179', closed: false });
  assert.deepEqual(mutations(octokit), []);
});

test('leaves the PR open when the linked issue is still open', async () => {
  const octokit = fakeOctokit({ issue: { state: 'open', closed_at: null } });
  const result = await reconcileClosedIssuePullRequest(octokit, 5176, inputs);
  assert.equal(result.conclusion, 'skipped because the linked issue is still open');
  assert.deepEqual(mutations(octokit), []);
});

test('skips PRs whose head is not this repository', async () => {
  const octokit = fakeOctokit({ pulls: [pull({ head: { ref: 'posthog-watcher/issue-5176', repo: { full_name: 'someone/posthog-js' } } })] });
  const result = await reconcileClosedIssuePullRequest(octokit, 5176, inputs);
  assert.equal(result.conclusion, 'skipped PR not created by posthog-watcher-action');
  assert.deepEqual(names(octokit), ['pulls.list']);
});

test('skips PRs whose head is not a watcher branch', async () => {
  const octokit = fakeOctokit({ pulls: [pull({ head: { ref: 'feature/posthog-watcher/issue-5176', repo: { full_name: 'PostHog/posthog-js' } } })] });
  octokit.rest.pulls.list = async (params) => {
    octokit.calls.push({ name: 'pulls.list', params });
    return { data: [pull({ head: { ref: 'feature/posthog-watcher/issue-5176', repo: { full_name: 'PostHog/posthog-js' } } })] };
  };
  const result = await reconcileClosedIssuePullRequest(octokit, 5176, inputs);
  assert.equal(result.conclusion, 'skipped PR not created by posthog-watcher-action');
  assert.deepEqual(mutations(octokit), []);
});

test('leaves a non-draft PR open with a comment instead of closing it', async () => {
  const octokit = fakeOctokit({ pulls: [pull({ draft: false })], timeline: [{ event: 'closed', commit_id: 'abc' }], associatedPulls: [{ number: 5181, merged_at: '2026-10-01T13:00:00Z' }] });
  const result = await reconcileClosedIssuePullRequest(octokit, 5176, inputs);
  assert.equal(result.conclusion, 'skipped PR that is no longer a draft');
  assert.equal(result.closed, false);
  assert.deepEqual(mutations(octokit), ['issues.createComment']);
  assert.equal(call(octokit, 'issues.createComment').body, `${MARKER}\n#5176 was closed on 2026-10-01 via #5181, but this PR was left open because it is no longer a draft. Close it manually if it is no longer needed.`);
  assert.equal(call(octokit, 'pulls.listCommits'), undefined);
});

test('leaves a PR with commits from other authors open with a comment', async () => {
  const octokit = fakeOctokit({
    commits: [
      { author: { login: BOT }, commit: { author: { name: BOT } } },
      { author: { login: 'maintainer' }, commit: { author: { name: 'Maintainer' } } },
      { author: null, commit: { author: { name: 'Unmapped Person' } } },
    ],
  });
  const result = await reconcileClosedIssuePullRequest(octokit, 5176, inputs);
  assert.equal(result.conclusion, 'skipped PR with commits from other authors');
  assert.deepEqual(mutations(octokit), ['issues.createComment']);
  assert.match(call(octokit, 'issues.createComment').body, /commits from maintainer, Unmapped Person\. Close it manually/);
  assert.doesNotMatch(call(octokit, 'issues.createComment').body, /@maintainer/);
});

test('treats every commit as foreign when the PR author is unknown', async () => {
  const octokit = fakeOctokit({ pulls: [pull({ user: null })] });
  const result = await reconcileClosedIssuePullRequest(octokit, 5176, inputs);
  assert.equal(result.conclusion, 'skipped PR with commits from other authors');
  assert.deepEqual(mutations(octokit), ['issues.createComment']);
});

test('still closes when the closing PR lookup fails', async () => {
  const octokit = fakeOctokit();
  octokit.rest.issues.listEventsForTimeline = async () => {
    throw new Error('timeline unavailable');
  };
  const result = await reconcileClosedIssuePullRequest(octokit, 5176, inputs);
  assert.equal(result.closed, true);
  assert.doesNotMatch(call(octokit, 'issues.createComment').body, /via #/);
});

test('writes a pr state record when state is enabled', async () => {
  const octokit = fakeOctokit();
  const written = [];
  octokit.rest.git.getRef = async () => ({ data: { object: { sha: 'base' } } });
  octokit.rest.repos.getContent = async () => {
    throw Object.assign(new Error('missing'), { status: 404 });
  };
  octokit.rest.repos.createOrUpdateFileContents = async (params) => {
    written.push(params.path);
    return {};
  };
  await reconcileClosedIssuePullRequest(octokit, 5176, { ...inputs, stateEnabled: true, stateRepo: '', stateBranch: 'posthog-watcher-state', openaiApiKey: '', posthogApiKey: '', posthogCodeApiKey: '', githubToken: 'token' });
  assert.ok(written.includes('records/PostHog-posthog-js/prs/5179.md'), written.join(', '));
});

test('sweep pass reconciles every open watcher issue branch and ignores other PRs', async () => {
  const octokit = fakeOctokit({
    pulls: [
      pull(),
      pull({ number: 42, html_url: 'https://github.com/PostHog/posthog-js/pull/42', head: { ref: 'feat/unrelated', repo: { full_name: 'PostHog/posthog-js' } } }),
      pull({ number: 43, html_url: 'https://github.com/PostHog/posthog-js/pull/43', head: { ref: 'posthog-watcher/issue-7', repo: { full_name: 'PostHog/posthog-js' } } }),
    ],
  });
  const results = await reconcileWatcherPullRequests(octokit, inputs);
  assert.deepEqual(results.map((result) => [result.prUrl, result.closed]), [
    ['https://github.com/PostHog/posthog-js/pull/5179', true],
    ['https://github.com/PostHog/posthog-js/pull/43', true],
  ]);
  assert.deepEqual(call(octokit, 'pulls.list'), { owner: 'PostHog', repo: 'posthog-js', state: 'open', per_page: 100 });
  assert.deepEqual(octokit.calls.filter((entry) => entry.name === 'issues.get').map((entry) => entry.params.issue_number), [5176, 7]);
  assert.deepEqual(octokit.calls.filter((entry) => entry.name === 'git.deleteRef').map((entry) => entry.params.ref), ['heads/posthog-watcher/issue-5176', 'heads/posthog-watcher/issue-7']);
});

test('sweep pass is a no-op when allow-close-own-prs is false', async () => {
  const octokit = fakeOctokit();
  assert.deepEqual(await reconcileWatcherPullRequests(octokit, { ...inputs, allowCloseOwnPrs: false }), []);
  assert.deepEqual(names(octokit), []);
});

test('sweep pass keeps going when one PR fails', async () => {
  const octokit = fakeOctokit({
    pulls: [pull(), pull({ number: 43, html_url: 'https://github.com/PostHog/posthog-js/pull/43', head: { ref: 'posthog-watcher/issue-7', repo: { full_name: 'PostHog/posthog-js' } } })],
  });
  let issueGets = 0;
  octokit.rest.issues.get = async (params) => {
    issueGets += 1;
    if (issueGets === 1) throw new Error('boom');
    return { data: { state: 'closed', closed_at: '2026-10-01T00:00:00Z' } };
  };
  const results = await reconcileWatcherPullRequests(octokit, inputs);
  assert.deepEqual(results.map((result) => result.prUrl), ['https://github.com/PostHog/posthog-js/pull/43']);
});

test('issue numbers are parsed only from exact watcher issue branches', () => {
  assert.equal(issueNumberFromBranch('posthog-watcher/issue-5176'), 5176);
  assert.equal(issueNumberFromBranch('posthog-watcher/issue-5176-v2'), undefined);
  assert.equal(issueNumberFromBranch('posthog-watcher/pr-5176'), undefined);
  assert.equal(issueNumberFromBranch('feature/posthog-watcher/issue-1'), undefined);
});
