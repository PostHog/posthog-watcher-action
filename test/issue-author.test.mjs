import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const dir = mkdtempSync(join(tmpdir(), 'watcher-issue-author-'));
let shouldSkipIssueAuthor;
try {
  const outfile = join(dir, 'issue-author.cjs');
  await build({ entryPoints: ['src/issue-author.ts'], bundle: true, platform: 'node', format: 'cjs', outfile });
  ({ shouldSkipIssueAuthor } = await import(pathToFileURL(outfile).href));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const issue = { owner: 'PostHog', repo: 'posthog-js', number: 4840, author: 'marandaneto', authorAssociation: 'MEMBER' };
const command = { shouldRun: true };
const inputs = { mode: 'auto', skipSweepTrustedAuthors: true };

function octokitWithPermission(permission) {
  const calls = [];
  return {
    calls,
    rest: { repos: { getCollaboratorPermissionLevel: async (params) => {
      calls.push(params);
      return { data: { permission } };
    } } },
  };
}

for (const mode of ['auto', 'triage', 'investigate', 'sweep']) {
  for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
    test(`${mode} skips ${association} issues without a permission lookup`, async () => {
      const octokit = octokitWithPermission('none');
      assert.equal(await shouldSkipIssueAuthor(octokit, { ...inputs, mode }, command, { ...issue, authorAssociation: association }), true);
      assert.equal(octokit.calls.length, 0);
    });
  }

  for (const permission of ['triage', 'write', 'maintain', 'admin']) {
    test(`${mode} skips private members with ${permission} permission`, async () => {
      const octokit = octokitWithPermission(permission);
      assert.equal(await shouldSkipIssueAuthor(octokit, { ...inputs, mode }, command, { ...issue, authorAssociation: 'CONTRIBUTOR' }), true);
      assert.deepEqual(octokit.calls, [{ owner: issue.owner, repo: issue.repo, username: issue.author }]);
    });
  }

  test(`${mode} honors explicit commands and the opt-out`, async () => {
    const octokit = octokitWithPermission('admin');
    for (const name of ['triage', 'investigate', 'plan', 'fix', 'close', 'retry']) {
      assert.equal(await shouldSkipIssueAuthor(octokit, { ...inputs, mode }, { ...command, command: name }, issue), false);
    }
    assert.equal(await shouldSkipIssueAuthor(octokit, { ...inputs, mode, skipSweepTrustedAuthors: false }, command, issue), false);
    assert.equal(octokit.calls.length, 0);
  });

  for (const permission of ['read', 'none', undefined]) {
    test(`${mode} still processes untrusted authors with ${permission} permission`, async () => {
      assert.equal(await shouldSkipIssueAuthor(octokitWithPermission(permission), { ...inputs, mode }, command, { ...issue, authorAssociation: 'NONE' }), false);
    });
  }
}

test('explicit fix mode still processes trusted-author issues', async () => {
  const octokit = octokitWithPermission('admin');
  assert.equal(await shouldSkipIssueAuthor(octokit, { ...inputs, mode: 'fix' }, command, issue), false);
  assert.equal(octokit.calls.length, 0);
});

for (const status of [403, 404]) {
  test(`permission lookup failure (${status}) does not mark an author as trusted`, async () => {
    const octokit = { rest: { repos: { getCollaboratorPermissionLevel: async () => {
      throw Object.assign(new Error('Permission lookup failed'), { status });
    } } } };
    assert.equal(await shouldSkipIssueAuthor(octokit, inputs, command, { ...issue, authorAssociation: 'NONE' }), false);
  });
}
