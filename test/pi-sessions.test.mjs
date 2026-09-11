import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { after, beforeEach } from 'node:test';
import { build } from 'esbuild';

const dir = await mkdtemp(join(tmpdir(), 'watcher-pi-sessions-test-'));
after(() => rm(dir, { recursive: true, force: true }));
const result = await build({
  stdin: {
    contents: `
      export * from './src/pi-sessions.ts';
      export { warnings } from '@actions/core';
      export { gist } from '@actions/github';
    `,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  plugins: [{
    name: 'session-test-mocks',
    setup(build) {
      build.onResolve({ filter: /^(@actions\/(core|github)|node:os)$/ }, ({ path }) => ({ path, namespace: 'mock' }));
      build.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({
        contents: path === 'node:os'
          ? `export default { tmpdir: () => ${JSON.stringify(dir)} };`
          : path === '@actions/core'
            ? `export const warnings = []; export const warning = message => warnings.push(message); export const info = () => {}; export const debug = () => {};`
            : `
              export const context = { repo: { owner: 'example', repo: 'project' }, runId: 123 };
              export const gist = { calls: [], error: undefined };
              export const getOctokit = token => ({ rest: { gists: { create: async params => {
                gist.calls.push({ token, params });
                if (gist.error) throw gist.error;
                return { data: { id: 'session', html_url: 'https://gist.github.com/session', files: {
                  'session.jsonl': { raw_url: 'https://gist.githubusercontent.com/session/raw' }
                } } };
              } } } });
            `,
        loader: 'js',
      }));
    },
  }],
});
const modulePath = join(dir, 'pi-sessions.mjs');
await writeFile(modulePath, result.outputFiles[0].text);
const { beginPiSessionScope, beginPiSessionCapture, finishPiSessionCapture, publishPiSessionFiles, formatPiSessionMarkdown, warnings, gist } =
  await import(pathToFileURL(modulePath).href);
const inputs = { piSessionSharing: true, piSessionSharingMode: 'gist', piSessionGistToken: 'test-gist-token', dryRun: false };
let startIndex;

beforeEach(async () => {
  warnings.length = 0;
  gist.calls.length = 0;
  gist.error = undefined;
  startIndex = beginPiSessionScope();
  const capture = await beginPiSessionCapture(inputs, startIndex + 1, 'primary');
  await writeFile(join(capture.args[1], `session-${startIndex}.jsonl`), '{"type":"session"}\n');
  await finishPiSessionCapture(capture);
});

test('missing gist token skips session links instead of aborting publication of findings', async () => {
  const reference = await publishPiSessionFiles({}, { ...inputs, piSessionGistToken: '' }, 'issue-4920', startIndex);
  assert.equal(reference, undefined);
  assert.equal(formatPiSessionMarkdown(reference), '');
  assert.equal(gist.calls.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Could not publish pi session for issue-4920/);
  assert.match(warnings[0], /pi-session-gist-token is required/);
});

for (const status of [401, 403, 500]) {
  test(`gist HTTP ${status} skips session links without rejecting`, async () => {
    gist.error = Object.assign(new Error(`Gist request failed (${status})`), { status });
    const reference = await publishPiSessionFiles({}, inputs, 'issue-4920', startIndex);
    assert.equal(reference, undefined);
    assert.equal(formatPiSessionMarkdown(reference), '');
    assert.equal(gist.calls.length, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /continuing without session links/);
  });
}

test('session publication errors do not leak credentials into warnings', async () => {
  gist.error = new Error(`Request failed with ${inputs.piSessionGistToken}`);
  await publishPiSessionFiles({}, inputs, 'issue-4920', startIndex);
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes(inputs.piSessionGistToken));
});

test('successful gist publication still includes session links', async () => {
  const reference = await publishPiSessionFiles({}, inputs, 'issue-4920', startIndex);
  assert.equal(reference.kind, 'gist');
  assert.equal(reference.gistUrl, 'https://gist.github.com/session');
  assert.match(formatPiSessionMarkdown(reference), /### Pi session/);
  assert.match(formatPiSessionMarkdown(reference), /https:\/\/gist.github.com\/session/);
  assert.equal(gist.calls[0].token, inputs.piSessionGistToken);
  assert.equal(gist.calls[0].params.public, false);
  assert.equal(warnings.length, 0);
});

test('state branch access failures also leave findings unblocked', async () => {
  const reject = async () => { throw new Error('Bad credentials'); };
  const octokit = { rest: { git: { getRef: reject }, repos: { get: reject } } };
  const reference = await publishPiSessionFiles(octokit, { ...inputs, piSessionSharingMode: 'state-branch', stateBranch: 'watcher-state' }, 'issue-4920', startIndex);
  assert.equal(reference, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Bad credentials/);
});

test('disabled sharing, dry runs, and empty scopes do not publish or warn', async () => {
  for (const options of [{ ...inputs, piSessionSharing: false }, { ...inputs, dryRun: true }]) {
    assert.equal(await publishPiSessionFiles({}, options, 'issue-4920', startIndex), undefined);
  }
  assert.equal(await publishPiSessionFiles({}, inputs, 'issue-4920', beginPiSessionScope()), undefined);
  assert.equal(gist.calls.length, 0);
  assert.equal(warnings.length, 0);
});
