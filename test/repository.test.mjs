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
  const commands = read('src/commands.ts');
  assert.match(readme, /@posthog-watcher triage/);
  assert.match(readme, /@posthog-watcher investigate/);
  assert.match(readme, /@posthog-watcher plan/);
  assert.match(readme, /@posthog-watcher propose-fix/);
  assert.match(readme, /@posthog-watcher fix/);
  assert.match(commands, /propose-fix/);
  assert.match(commands, /case 'plan'/);
});

test('pull request review comments trigger watcher PR repair', () => {
  const commands = read('src/commands.ts');
  const readme = read('README.md');
  assert.match(commands, /pull_request_review_comment/);
  assert.match(commands, /pull_request_review/);
  assert.match(commands, /commandToResolution\('address-review'\)/);
  assert.match(readme, /pull_request_review_comment/);
  assert.match(readme, /address review/);
});

test('fix PRs use stable per-issue branches for reuse', () => {
  const source = read('src/fix-runner.ts');
  assert.match(source, /posthog-watcher\/issue-\$\{issue\.number\}/);
  assert.match(source, /title: `fix: \$\{issue\.title\}`/);
  assert.doesNotMatch(source, /title: `Fix #\$\{issue\.number\}/);
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
  assert.match(repairRun, /ls-files', '--others', '--exclude-standard', '-z'/);
  assert.match(repairRun, /'add', '-N'/);
  const reviewGate = read('src/review-gate.ts');
  assert.match(reviewGate, /Review context/);
  assert.match(reviewGate, /Intended change/);
});

test('pre-existing related fixes block duplicate fix PRs', () => {
  const source = read('src/fix-blocker.ts');
  const index = read('src/index.ts');
  const readme = read('README.md');
  assert.match(source, /closing-pr/);
  assert.match(source, /title-search/);
  assert.match(source, /titleSimilarity\(issue\.title, item\.title\) >= 0\.3/);
  assert.match(source, /older related issue/);
  assert.match(source, /titleSimilarity/);
  const detector = read('src/duplicate-detector.ts');
  assert.match(detector, /signalSimilarity/);
  assert.match(detector, /candidate\.score >= 0\.42/);
  assert.match(detector, /curl/);
  assert.match(source, /duplicate/);
  assert.match(source, /blockingPullRequest/);
  assert.match(source, /formatDuplicateReason/);
  assert.match(source, /formatRelatedItemReference/);
  assert.doesNotMatch(source, /duplicate\.reason\}: #\$\{duplicate\.canonical\.number\} \$\{duplicate\.canonical\.url\}/);
  assert.match(index, /preExistingFixBlocker/);
  assert.match(index, /ensureBlockingPrTeamReviewRequested/);
  assert.match(source, /already-fixed/);
  assert.match(source, /closed unmerged PR/);
  assert.match(source, /merged_at/);
  assert.match(index, /await findPreExistingFixBlocker/);
  const related = read('src/related.ts');
  assert.match(related, /titleSimilarity\(issue\.title, item\.title\) >= 0\.2/);
  assert.match(readme, /related open PR contains closing syntax/);
});

test('security policy uses word-boundary matching and credential evidence', () => {
  const source = read('src/security.ts');
  const index = read('src/index.ts');
  const readme = read('README.md');
  const guardrails = read('src/guardrails.ts');
  const redact = read('src/redact.ts');
  assert.match(source, /SECURITY_REPORT_PATTERNS/);
  assert.match(source, /CREDENTIAL_VALUE_PATTERNS/);
  assert.match(source, /looksLikeCredentialValue/);
  assert.match(source, /isWatcherGeneratedComment/);
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
  assert.match(inputs, /piRetries/);
  assert.match(inputs, /queuedMode/);
  assert.match(inputs, /maxQueueItems/);
  assert.match(inputs, /maxQueueAttempts/);
  assert.match(piRunner, /consumePiCall/);
  assert.match(piRunner, /retrying without changing model/);
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
  assert.match(prRepair, /not created by posthog-watcher-action/);
  assert.match(prRepair, /getPullRequestFailureContext/);
  assert.match(prRepair, /restoreCheckout/);
  assert.match(commands, /PostHog Watcher \$\{command\}/);
  assert.match(snapshot, /posthog-watcher-snapshot/);
  assert.match(snapshot, /watcherConfig/);
  assert.match(index, /shouldSkipUnchangedIssue/);
  assert.match(index, /skipped unchanged issue/);
});

test('dedicated queue modes are wired without requiring OpenAI for enqueue', () => {
  const action = read('action.yml');
  const inputs = read('src/inputs.ts');
  const index = read('src/index.ts');
  const queue = read('src/queue.ts');
  const readme = read('README.md');
  assert.match(action, /enqueue, or drain-queue/);
  assert.match(action, /queued-mode/);
  assert.match(action, /trigger-drain-workflow/);
  assert.match(action, /drain-workflow/);
  assert.match(action, /max-queue-items/);
  assert.match(action, /max-queue-attempts/);
  assert.match(action, /required: false/);
  assert.match(inputs, /optionalSecret\('openai-api-key'\)/);
  assert.match(inputs, /triggerDrainWorkflow/);
  assert.match(inputs, /drainWorkflow/);
  assert.match(inputs, /'enqueue'/);
  assert.match(inputs, /'drain-queue'/);
  assert.match(index, /rawInputs\.mode === 'enqueue'/);
  assert.match(index, /isWatcherPullRequest/);
  assert.match(index, /skipped non-watcher PR/);
  assert.match(index, /maybeTriggerDrainWorkflow/);
  assert.match(index, /createWorkflowDispatch/);
  assert.match(index, /requireOpenAiApiKey\(rawInputs\)/);
  assert.match(index, /inputs\.mode === 'drain-queue'/);
  assert.match(index, /replyToCommand\(octokit, item\.number, itemInputs, item\.command, await queuedCommandBody/);
  assert.match(queue, /queue\.json/);
  assert.match(queue, /samePendingItem/);
  assert.match(queue, /commentId: payload\.comment\?\.id/);
  assert.match(queue, /commandSourceKey/);
  assert.match(queue, /attempts: 0/);
  assert.match(readme, /Dedicated queue worker/);
  assert.match(readme, /trigger-drain-workflow/);
  assert.match(readme, /actions: write/);
  assert.match(readme, /without `pi` or `openai-api-key`/);
});

test('pi session sharing is opt-in and links forkable JSONL sessions', () => {
  const action = read('action.yml');
  const inputs = read('src/inputs.ts');
  const piRunner = read('src/pi-runner.ts');
  const piSessions = read('src/pi-sessions.ts');
  const comment = read('src/comment.ts');
  const readme = read('README.md');
  assert.match(action, /pi-session-sharing/);
  assert.match(action, /default: 'false'/);
  assert.match(inputs, /piSessionSharing/);
  assert.match(piRunner, /beginPiSessionCapture/);
  assert.match(piSessions, /--no-session/);
  assert.match(piSessions, /--session-dir/);
  assert.match(piSessions, /pi --fork path\/to\/session\.jsonl/);
  assert.match(piSessions, /pi-sessions\//);
  assert.match(comment, /piSessionMarkdown/);
  assert.match(readme, /pi-session-sharing/);
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

test('repository labels can be used dynamically with descriptions', () => {
  const action = read('action.yml');
  const githubSource = read('src/github.ts');
  const index = read('src/index.ts');
  const issueContext = read('src/issue-context.ts');
  const readme = read('README.md');
  const inputs = read('src/inputs.ts');
  assert.match(action, /default: '\*'/);
  assert.match(inputs, /core\.getInput\('labels'\) \|\| '\*'/);
  assert.match(githubSource, /description: label\.description/);
  assert.match(index, /allowedRepositoryLabels/);
  assert.match(index, /allowlist\.includes\('\*'\)/);
  assert.match(index, /!label\.name\.startsWith\(managedLabelPrefix\)/);
  assert.match(issueContext, /formatAllowedLabels/);
  assert.match(issueContext, /label\.description/);
  assert.match(readme, /Label descriptions are included/);
});

test('fix PRs request a configurable team review when configured', () => {
  const fixRunner = read('src/fix-runner.ts');
  const github = read('src/github.ts');
  const inputs = read('src/inputs.ts');
  const action = read('action.yml');
  const readme = read('README.md');
  const index = read('src/index.ts');
  assert.match(fixRunner, /ensureTeamReviewRequested/);
  assert.match(fixRunner, /inputs\.fixPrReviewTeam/);
  assert.match(index, /ensureTeamReviewRequested/);
  assert.match(index, /existing related PR/);
  assert.match(github, /parseTeamReviewer/);
  assert.match(github, /requested_teams/);
  assert.match(github, /team_reviewers: \[team\.slug\]/);
  assert.match(inputs, /fixPrReviewTeam: core\.getInput\('fix-pr-review-team'\)\.trim\(\)/);
  assert.match(action, /fix-pr-review-team/);
  assert.match(readme, /`fix-pr-review-team`/);
});

test('sweep comments can mention the configured fix PR review team', () => {
  const index = read('src/index.ts');
  const comment = read('src/comment.ts');
  const readme = read('README.md');
  assert.match(index, /sweepAttentionMention/);
  assert.match(index, /inputs\.mode !== 'sweep'/);
  assert.match(index, /inputs\.fixPrReviewTeam/);
  assert.match(comment, /please review this sweep triage/);
  assert.match(readme, /new sweep triage\/security comments mention that team/);
});

test('scheduled sweeps can ignore trusted author issues by default', () => {
  const action = read('action.yml');
  const inputs = read('src/inputs.ts');
  const index = read('src/index.ts');
  const githubSource = read('src/github.ts');
  const issueContext = read('src/issue-context.ts');
  const commands = read('src/commands.ts');
  const readme = read('README.md');
  assert.match(commands, /export const TRUSTED_ASSOCIATIONS/);
  assert.match(githubSource, /authorAssociation: issue\.author_association \?\? 'NONE'/);
  assert.match(issueContext, /authorAssociation: string/);
  assert.match(action, /skip-sweep-trusted-authors/);
  assert.match(inputs, /skipSweepTrustedAuthors: parseBoolean\(core\.getInput\('skip-sweep-trusted-authors'\) \|\| 'true'\)/);
  assert.match(index, /shouldSkipSweepIssueAuthor/);
  assert.match(index, /!inputs\.skipSweepTrustedAuthors/);
  assert.match(index, /skipped trusted author issue/);
  assert.match(index, /TRUSTED_ASSOCIATIONS\.has\(issue\.authorAssociation\.toUpperCase\(\)\)/);
  assert.match(index, /getCollaboratorPermissionLevel/);
  assert.match(index, /TRUSTED_REPOSITORY_PERMISSIONS/);
  assert.match(readme, /collaborator-permission fallback/);
  assert.match(readme, /`skip-sweep-trusted-authors`/);
});

test('state memory and progressive status comments are wired', () => {
  const readme = read('README.md');
  const state = read('src/state.ts');
  const issueContext = read('src/issue-context.ts');
  const comment = read('src/comment.ts');
  const index = read('src/index.ts');
  assert.match(readme, /repo memory/);
  assert.match(readme, /phase\/status updates/);
  assert.match(readme, /repo-memory-enabled/);
  assert.match(readme, /progress-comments/);
  const inputs = read('src/inputs.ts');
  const action = read('action.yml');
  assert.match(inputs, /repoMemoryEnabled/);
  assert.match(inputs, /progressComments/);
  assert.match(action, /repo-memory-enabled/);
  assert.match(action, /progress-comments/);
  assert.match(state, /readRepoMemory/);
  assert.match(state, /appendRepoMemory/);
  assert.match(state, /memory\//);
  assert.match(issueContext, /Repository memory from prior watcher runs/);
  assert.match(comment, /buildStatusComment/);
  assert.match(index, /updateIssueStatus/);
  assert.match(index, /inputs\.progressComments/);
  assert.match(index, /inputs\.repoMemoryEnabled/);
  assert.match(index, /appendRepoMemory/);
});

test('feature requests require explicit fix intent before draft PRs by default', () => {
  const index = read('src/index.ts');
  const inputs = read('src/inputs.ts');
  const action = read('action.yml');
  const readme = read('README.md');
  assert.match(index, /featureFixBlocker/);
  assert.match(index, /!inputs\.blockFeatureFixes/);
  assert.match(index, /triage\.issueType !== 'feature'/);
  assert.match(index, /feature requests require an explicit trusted fix command or mode: fix/);
  assert.match(index, /fixExplicitlyRequested/);
  assert.match(inputs, /blockFeatureFixes: parseBoolean\(core\.getInput\('block-feature-fixes'\) \|\| 'true'\)/);
  assert.match(action, /block-feature-fixes/);
  assert.match(readme, /`block-feature-fixes`/);
});

test('fix PRs use host pull request template when present', () => {
  const fixRunner = read('src/fix-runner.ts');
  const readme = read('README.md');
  assert.match(fixRunner, /\.github\/pull_request_template\.md/);
  assert.match(fixRunner, /readPullRequestTemplate/);
  assert.match(fixRunner, /template\.trimEnd\(\)/);
  assert.match(readme, /Uses `\.github\/pull_request_template\.md`/);
});

test('fix and PR repair commits are GitHub-signed', () => {
  const fixRunner = read('src/fix-runner.ts');
  const prRepair = read('src/pr-repair-runner.ts');
  const signedCommit = read('src/signed-commit.ts');
  const readme = read('README.md');
  assert.match(fixRunner, /commitChangesWithGitHubSignature/);
  assert.match(prRepair, /commitChangesWithGitHubSignature/);
  assert.match(signedCommit, /createCommitOnBranch/);
  assert.match(signedCommit, /createRef/);
  assert.doesNotMatch(fixRunner, /git\(\['commit'/);
  assert.doesNotMatch(prRepair, /git\(\['commit'/);
  assert.match(readme, /planetscale\/ghcommit-action/);
  assert.match(readme, /Verified commits/);
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
