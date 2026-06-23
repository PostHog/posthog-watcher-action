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
  assert.match(readme, /Allow GitHub Actions to create and approve pull requests/);
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
  assert.match(source, /remoteBranchExists/);
  assert.match(source, /requireText: false/);
});

test('pre-existing related fixes block duplicate fix PRs', () => {
  const source = read('src/fix-blocker.ts');
  const index = read('src/index.ts');
  const readme = read('README.md');
  assert.match(source, /closing-pr/);
  assert.match(source, /title-search/);
  assert.match(source, /older related issue/);
  assert.match(source, /titleSimilarity/);
  assert.match(source, /duplicate/);
  assert.match(source, /already-fixed/);
  assert.match(index, /findPreExistingFixBlocker/);
  assert.match(readme, /related open PR contains closing syntax/);
});

test('security policy uses word-boundary matching for short terms', () => {
  const source = read('src/security.ts');
  const index = read('src/index.ts');
  const readme = read('README.md');
  assert.match(source, /SECURITY_PATTERNS/);
  assert.match(source, /\\\\b/);
  assert.doesNotMatch(source, /haystack\.includes/);
  assert.match(index, /allowSecurityAi/);
  assert.match(readme, /not sent to pi\/OpenAI/);
});

test('new MVP features are documented', () => {
  const readme = read('README.md');
  assert.match(readme, /Repair loop/);
  assert.match(readme, /Related context and close\/apply/);
  assert.match(readme, /Commit reviews/);
  assert.match(readme, /allow-close: true/);
});

test('advanced hardening features are wired', () => {
  const inputs = read('src/inputs.ts');
  const piRunner = read('src/pi-runner.ts');
  const state = read('src/state.ts');
  const prRepair = read('src/pr-repair-runner.ts');
  const commands = read('src/command-replies.ts');
  const snapshot = read('src/snapshot.ts');
  const index = read('src/index.ts');
  assert.match(inputs, /maxPiCalls/);
  assert.match(inputs, /piTimeoutMs/);
  assert.match(piRunner, /consumePiCall/);
  assert.match(state, /index\.json/);
  assert.match(state, /isConflictLike/);
  assert.match(prRepair, /posthog-watcher:autofix/);
  assert.match(prRepair, /getPullRequestFailureContext/);
  assert.match(commands, /PostHog Watcher \$\{command\}/);
  assert.match(snapshot, /posthog-watcher-snapshot/);
  assert.match(index, /skipped unchanged issue during sweep/);
});

test('pi JSON output parser falls back to final assistant messages', () => {
  const source = read('src/pi-runner.ts');
  assert.match(source, /event\.type === 'message_end'/);
  assert.match(source, /event\.type === 'agent_end'/);
  assert.match(source, /formatPiDiagnostics/);
  assert.match(source, /part\.text/);
  assert.match(source, /message\.errorMessage/);
  assert.match(source, /openai-codex\/\*/);
});

test('workflow actions are pinned to full-length SHAs', () => {
  const workflows = [read('.github/workflows/ci.yml'), read('.github/workflows/commit-review.yml'), read('.github/actions/setup/action.yml')].join('\n');
  assert.doesNotMatch(workflows, /uses:\s+[^\s]+@v\d/);
  assert.match(workflows, /actions\/checkout@[0-9a-f]{40}/);
});
