import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(path, 'utf8');

test('action uses committed dist bundle on Node 24', () => {
  const action = read('action.yml');
  assert.match(action, /using: node24/);
  assert.match(action, /main: dist\/index\.js/);
});

test('karpathy guidelines skill is vendored for pi runs', () => {
  const skill = read('skills/karpathy-guidelines/SKILL.md');
  assert.match(skill, /name: karpathy-guidelines/);
  assert.match(skill, /Simplicity First/);
});

test('pnpm supply-chain policy is configured', () => {
  const workspace = read('pnpm-workspace.yaml');
  assert.match(workspace, /blockExoticSubdeps: true/);
  assert.match(workspace, /minimumReleaseAge: 10080/);
  assert.match(workspace, /trustPolicy: no-downgrade/);
});

test('readme declares experimental PostHog SDK scope', () => {
  const readme = read('README.md');
  assert.match(readme, /Experimental \/ WIP/);
  assert.match(readme, /PostHog SDK repositories/);
});

test('maintainer issue comment commands are documented', () => {
  const readme = read('README.md');
  assert.match(readme, /@posthog-watcher triage/);
  assert.match(readme, /@posthog-watcher investigate/);
  assert.match(readme, /@posthog-watcher fix/);
});

test('fix PRs use stable per-issue branches for reuse', () => {
  const source = read('src/fix-runner.ts');
  assert.match(source, /posthog-watcher\/issue-\$\{issue\.number\}/);
  assert.match(source, /findOpenPullRequestForBranch/);
});

test('new MVP features are documented', () => {
  const readme = read('README.md');
  assert.match(readme, /Repair loop/);
  assert.match(readme, /Related context and close proposals/);
  assert.match(readme, /Commit reviews/);
  assert.match(readme, /never closes issues/);
});

test('pi JSON output parser falls back to final assistant messages', () => {
  const source = read('src/pi-runner.ts');
  assert.match(source, /event\.type === 'message_end'/);
  assert.match(source, /event\.type === 'agent_end'/);
  assert.match(source, /formatPiDiagnostics/);
  assert.match(source, /part\.text/);
});

test('workflow actions are pinned to full-length SHAs', () => {
  const workflows = [read('.github/workflows/ci.yml'), read('.github/workflows/commit-review.yml'), read('.github/actions/setup/action.yml')].join('\n');
  assert.doesNotMatch(workflows, /uses:\s+[^\s]+@v\d/);
  assert.match(workflows, /actions\/checkout@[0-9a-f]{40}/);
});
