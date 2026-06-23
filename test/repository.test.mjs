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
  assert.match(source, /runIssueRepair/);
  assert.match(source, /restoreCheckout/);
  assert.match(source, /reset', '--hard/);
  assert.doesNotMatch(source, /'bash'/);
  const agent = read('src/agent.ts');
  const repairRun = read('src/repair-run.ts');
  assert.match(agent, /requireText: false/);
  assert.doesNotMatch(agent, /'bash'/);
  assert.match(repairRun, /independent review gate rejected the diff/);
});

test('pre-existing related fixes block duplicate fix PRs', () => {
  const source = read('src/fix-blocker.ts');
  const index = read('src/index.ts');
  const readme = read('README.md');
  assert.match(source, /closing-pr/);
  assert.match(source, /title-search/);
  assert.match(source, /older related issue/);
  assert.match(source, /titleSimilarity/);
  const detector = read('src/duplicate-detector.ts');
  assert.match(detector, /signalSimilarity/);
  assert.match(detector, /curl/);
  assert.match(source, /duplicate/);
  assert.match(source, /already-fixed/);
  assert.match(index, /findPreExistingFixBlocker/);
  assert.match(readme, /related open PR contains closing syntax/);
});

test('security policy uses word-boundary matching for short terms', () => {
  const source = read('src/security.ts');
  const index = read('src/index.ts');
  const readme = read('README.md');
  const guardrails = read('src/guardrails.ts');
  const redact = read('src/redact.ts');
  assert.match(source, /SECURITY_PATTERNS/);
  assert.match(source, /\\\\b/);
  assert.doesNotMatch(source, /haystack\.includes/);
  assert.match(index, /allowSecurityAi/);
  assert.match(readme, /not sent to pi\/OpenAI/);
  assert.match(guardrails, /environment file changed/);
  assert.match(guardrails, /credential file changed/);
  assert.match(redact, /github_pat_/);
  assert.match(redact, /sk-/);
});

test('new MVP features are documented', () => {
  const readme = read('README.md');
  assert.match(readme, /Repair loop/);
  assert.match(readme, /Related context and close\/apply/);
  assert.match(readme, /Commit reviews/);
  assert.match(readme, /allow-close: true/);
  assert.match(readme, /GitHub token options/);
  assert.match(readme, /Fine-grained PAT/);
  assert.match(readme, /GitHub App installation token/);
  assert.match(readme, /approve-project-resources` \| `false`/);
  assert.match(readme, /posthog-watcher-\$\{\{ github\.repository \}\}/);
  assert.match(readme, /cancel-in-progress: false/);
  assert.match(readme, /require-fix-command/);
  assert.match(readme, /reproduction-command/);
  assert.match(readme, /require-reproduction/);
  assert.match(readme, /max-comments/);
  assert.match(readme, /max-changed-files/);
  assert.match(readme, /comment-marker/);
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
  assert.match(inputs, /queuedMode/);
  assert.match(inputs, /maxQueueItems/);
  assert.match(inputs, /maxQueueAttempts/);
  assert.match(piRunner, /consumePiCall/);
  assert.match(piRunner, /--approve/);
  assert.doesNotMatch(piRunner, /--api-key/);
  assert.match(piRunner, /OPENAI_API_KEY/);
  assert.match(piRunner, /SAFE_PI_ENV_KEYS/);
  assert.match(piRunner, /key\.startsWith\('RUNNER_'/);
  assert.doesNotMatch(piRunner, /OPENAI_BASE_URL/);
  assert.match(inputs, /approveProjectResources/);
  assert.match(inputs, /requireFixCommand/);
  assert.match(inputs, /reproductionCommand/);
  assert.match(inputs, /requireReproduction/);
  assert.match(state, /index\.json/);
  assert.match(state, /isConflictLike/);
  assert.match(prRepair, /posthog-watcher:autofix/);
  assert.match(prRepair, /getPullRequestFailureContext/);
  assert.match(commands, /PostHog Watcher \$\{command\}/);
  assert.match(snapshot, /posthog-watcher-snapshot/);
  assert.match(index, /skipped unchanged issue during sweep/);
});

test('dedicated queue modes are wired without requiring OpenAI for enqueue', () => {
  const action = read('action.yml');
  const inputs = read('src/inputs.ts');
  const index = read('src/index.ts');
  const queue = read('src/queue.ts');
  const readme = read('README.md');
  assert.match(action, /enqueue, or drain-queue/);
  assert.match(action, /queued-mode/);
  assert.match(action, /max-queue-items/);
  assert.match(action, /max-queue-attempts/);
  assert.match(action, /required: false/);
  assert.match(inputs, /optionalSecret\('openai-api-key'\)/);
  assert.match(inputs, /'enqueue'/);
  assert.match(inputs, /'drain-queue'/);
  assert.match(index, /rawInputs\.mode === 'enqueue'/);
  assert.match(index, /requireOpenAiApiKey\(rawInputs\)/);
  assert.match(index, /inputs\.mode === 'drain-queue'/);
  assert.match(index, /replyToCommand\(octokit, item\.number, itemInputs, item\.command, await queuedCommandBody/);
  assert.match(queue, /queue\.json/);
  assert.match(queue, /samePendingItem/);
  assert.match(queue, /commentId: payload\.comment\?\.id/);
  assert.match(queue, /commandSourceKey/);
  assert.match(queue, /attempts: 0/);
  assert.match(readme, /Dedicated queue worker/);
  assert.match(readme, /without `pi` or `openai-api-key`/);
});

test('queue drain preserves FIFO and retry state', () => {
  const index = read('src/index.ts');
  const queue = read('src/queue.ts');
  const github = read('src/github.ts');
  const commandReplies = read('src/command-replies.ts');
  assert.match(index, /const item = queue\.items\[0\]/);
  assert.match(index, /incrementQueueAttempt/);
  assert.match(index, /Stopping queue drain/);
  assert.match(index, /attempted\.attempts >= inputs\.maxQueueAttempts/);
  assert.match(queue, /items: \[\.\.\.queue\.items, item\]/);
  assert.match(queue, /createOrUpdateFileContents/);
  assert.match(queue, /Queue update conflict/);
  assert.match(index, /queuedCommandBody/);
  assert.match(github, /forcedCommentId/);
  assert.match(github, /findForcedComment/);
  assert.match(github, /recentComments/);
  assert.match(commandReplies, /questionOverride/);
});

test('reproduction-first repair is opt-in and wrapper-owned', () => {
  const action = read('action.yml');
  const inputs = read('src/inputs.ts');
  const repairRun = read('src/repair-run.ts');
  const environment = read('src/environment.ts');
  const issueContext = read('src/issue-context.ts');
  assert.match(action, /reproduction-command/);
  assert.match(action, /require-reproduction/);
  assert.match(inputs, /reproductionCommand: core\.getInput\('reproduction-command'\)/);
  assert.match(inputs, /requireReproduction: parseBoolean\(core\.getInput\('require-reproduction'\)\)/);
  assert.match(repairRun, /if \(!inputs\.requireReproduction\) return \{ kind: 'none' \}/);
  assert.match(repairRun, /expected to fail/);
  assert.match(repairRun, /expected to pass/);
  assert.match(environment, /ExpectedOutcome = 'success' \| 'failure'/);
  assert.match(environment, /runCommandStatus\('\/bin\/bash'/);
  assert.match(issueContext, /fail before the fix and pass after the fix/);
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
