import * as core from '@actions/core';
import * as github from '@actions/github';
import { replyToCommand } from './command-replies.js';
import { resolveCommand, type CommandResolution } from './commands.js';
import { buildSecurityComment, buildTriageComment } from './comment.js';
import { reviewCommit } from './commit-review.js';
import { assessDuplicate } from './duplicate-detector.js';
import { findPreExistingFixBlocker } from './fix-blocker.js';
import { maybeCreateFixPr } from './fix-runner.js';
import { addLabels, closeIssue, getIssueComment, getIssueSnapshot, listRepositoryLabels, removeLabel, resolveIssueNumber, searchOpenIssueNumbers, upsertIssueComment, type Octokit, type RepositoryLabel } from './github.js';
import { getInputs, type ActionInputs } from './inputs.js';
import { formatIssuePrompt } from './issue-context.js';
import { desiredManagedLabels, staleManagedLabels } from './label-sync.js';
import { filterAllowedLabels } from './labels.js';
import { getPiCallCount, resetPiCallCount } from './pi-budget.js';
import { runPi } from './pi-runner.js';
import { enqueueCurrentPayload, incrementQueueAttempt, readQueue, removeQueueItem, type QueueItem } from './queue.js';
import { redactSecrets } from './redact.js';
import { repairPullRequest } from './pr-repair-runner.js';
import { getRelatedContext } from './related.js';
import { assessIssueSecurity } from './security.js';
import { computeIssueSnapshotHash, findWatcherSnapshot } from './snapshot.js';
import { writeStateRecord } from './state.js';
import { parseTriageResult, type TriageResult } from './triage-schema.js';

async function main(): Promise<void> {
  resetPiCallCount();
  const command = resolveCommand();
  if (!command.shouldRun) {
    core.info(`Skipping run: ${command.reason ?? 'no command matched'}.`);
    core.setOutput('conclusion', 'skipped');
    return;
  }

  const rawInputs = getInputs();
  const octokit = github.getOctokit(rawInputs.githubToken);

  if (rawInputs.mode === 'enqueue') {
    const result = await enqueueCurrentPayload(octokit, rawInputs, command);
    if (result.enqueued) await maybeTriggerDrainWorkflow(octokit, rawInputs);
    core.setOutput('conclusion', result.enqueued ? `queued ${result.item.kind} #${result.item.number}` : `already queued ${result.item.kind} #${result.item.number}`);
    core.setOutput('triage-json', JSON.stringify(result));
    return;
  }

  requireOpenAiApiKey(rawInputs);
  const inputs = command.mode && rawInputs.mode !== 'drain-queue' ? { ...rawInputs, mode: command.mode } : rawInputs;

  if (inputs.mode === 'drain-queue') {
    await drainQueue(octokit, inputs);
    return;
  }

  if (inputs.mode === 'commit-review') {
    const result = await reviewCommit(inputs);
    core.setOutput('conclusion', result.conclusion);
    core.setOutput('triage-json', JSON.stringify(result));
    return;
  }

  if (inputs.mode === 'sweep') {
    await sweep(octokit, inputs);
    return;
  }

  const issueNumber = resolveIssueNumber(inputs.issueNumber);
  if (command.command === 'status' || command.command === 'explain' || command.command === 'ask') {
    const result = await replyToCommand(octokit, issueNumber, inputs, command.command);
    core.setOutput('conclusion', result.conclusion);
    core.setOutput('comment-url', result.commentUrl);
    return;
  }

  if (isPullRequestPayload() || github.context.eventName === 'pull_request') {
    if (inputs.mode !== 'fix') {
      core.info('PR review/triage is read-only in this MVP; use @posthog-watcher fix for same-repo PR repair.');
      core.setOutput('conclusion', 'skipped PR mutation; use fix command');
      return;
    }
    const result = await repairPullRequest(octokit, issueNumber, inputs, command.command);
    core.setOutput('conclusion', result.conclusion);
    core.setOutput('pr-url', result.prUrl);
    return;
  }

  const result = await processIssue(octokit, issueNumber, inputs, command);
  setOutputs(result);
}

interface ProcessIssueResult {
  conclusion: string;
  labels: string[];
  commentUrl: string;
  prUrl?: string;
  triageJson: string;
  closed: boolean;
}

async function drainQueue(octokit: Octokit, inputs: ActionInputs): Promise<void> {
  let processed = 0;
  let dropped = 0;
  let failed = 0;

  for (let index = 0; index < inputs.maxQueueItems; index += 1) {
    const queue = await readQueue(octokit, inputs);
    const item = queue.items[0];
    if (!item) break;

    const attempted = await incrementQueueAttempt(octokit, inputs, item.id);
    if (!attempted) continue;

    try {
      await processQueueItem(octokit, attempted, inputs);
      await removeQueueItem(octokit, inputs, attempted.id);
      processed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempted.attempts >= inputs.maxQueueAttempts) {
        core.warning(`Dropping queued ${attempted.kind} #${attempted.number} after ${attempted.attempts} failed attempt(s): ${message}`);
        await removeQueueItem(octokit, inputs, attempted.id);
        dropped += 1;
        continue;
      }
      core.warning(`Stopping queue drain after queued ${attempted.kind} #${attempted.number} failed attempt ${attempted.attempts}/${inputs.maxQueueAttempts}: ${message}`);
      failed += 1;
      break;
    }
  }

  core.setOutput('conclusion', `queue drained ${processed} item(s), dropped ${dropped}, failed ${failed}`);
  core.setOutput('triage-json', JSON.stringify({ processed, dropped, failed }));
}

async function processQueueItem(octokit: Octokit, item: QueueItem, inputs: ActionInputs): Promise<void> {
  const itemInputs = { ...inputs, mode: item.mode };
  const itemCommand: CommandResolution = { shouldRun: true, mode: item.mode, command: item.command, applyClose: item.applyClose };
  core.info(`Draining queued ${item.kind} #${item.number} in ${item.mode} mode${item.command ? ` from ${item.command} command` : ''}.`);

  if (item.kind === 'pull_request') {
    if (item.mode !== 'fix') {
      core.info('PR review/triage is read-only in this MVP; use @posthog-watcher fix for same-repo PR repair. Removing skipped queued PR item.');
      return;
    }
    await repairPullRequest(octokit, item.number, itemInputs, item.command);
    return;
  }

  if (item.command === 'status' || item.command === 'explain' || item.command === 'ask') {
    await replyToCommand(octokit, item.number, itemInputs, item.command, await queuedCommandBody(octokit, item));
    return;
  }

  await processIssue(octokit, item.number, itemInputs, itemCommand, item.source.commentId);
}

async function queuedCommandBody(octokit: Octokit, item: QueueItem): Promise<string | undefined> {
  if (!item.source.commentId) return undefined;
  const { owner, repo } = github.context.repo;
  const comment = await getIssueComment(octokit, owner, repo, item.source.commentId).catch((error) => {
    core.warning(`Could not fetch queued command comment ${item.source.commentId}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  });
  return comment?.body ?? undefined;
}

async function sweep(octokit: Octokit, inputs: ActionInputs): Promise<void> {
  const issueNumbers = await searchOpenIssueNumbers(octokit, inputs.sweepQuery, inputs.maxSweepItems);
  core.info(`Sweep found ${issueNumbers.length} open issue(s).`);

  const results: ProcessIssueResult[] = [];
  let skipped = 0;
  for (const [index, issueNumber] of issueNumbers.entries()) {
    const itemInputs = { ...inputs, allowFix: inputs.allowFix && index < inputs.maxSweepFixItems, allowClose: false };
    try {
      results.push(await processIssue(octokit, issueNumber, itemInputs, { shouldRun: true }));
    } catch (error) {
      if (error instanceof Error && /Pi call budget exhausted/.test(error.message)) {
        skipped += 1;
        core.warning(`Stopping sweep because pi budget is exhausted: ${error.message}`);
        break;
      }
      throw error;
    }
  }

  core.setOutput('conclusion', `swept ${results.length} issue(s), skipped ${skipped}`);
  core.setOutput('triage-json', JSON.stringify(results));
}

async function processIssue(octokit: Octokit, issueNumber: number, inputs: ActionInputs, command: CommandResolution, forcedCommentId?: number): Promise<ProcessIssueResult> {
  core.info(`Processing issue #${issueNumber} in ${inputs.mode} mode`);

  const issue = await getIssueSnapshot(octokit, issueNumber, inputs.maxComments, forcedCommentId);
  const snapshotHash = computeIssueSnapshotHash(issue, inputs.commentMarker);
  const previousSnapshot = findWatcherSnapshot(issue, inputs.commentMarker);
  if (inputs.mode === 'sweep' && previousSnapshot.hash === snapshotHash) {
    core.info(`Skipping issue #${issue.number} during sweep because its snapshot has not changed.`);
    return {
      conclusion: 'skipped unchanged issue during sweep',
      labels: issue.labels,
      commentUrl: previousSnapshot.url ?? '',
      triageJson: JSON.stringify({ skipped: true, reason: 'unchanged', snapshotHash }),
      closed: false,
    };
  }

  const repositoryLabels = await listRepositoryLabels(octokit);
  const repositoryLabelNames = repositoryLabels.map((label) => label.name);
  const allowedExistingLabels = allowedRepositoryLabels(inputs.labelAllowlist, repositoryLabels, inputs.managedLabelPrefix);
  const allowedExistingLabelNames = allowedExistingLabels.map((label) => label.name);

  const security = assessIssueSecurity(issue);
  if (security.sensitive) {
    core.warning(`Security-sensitive issue detected. Reasons: ${security.reasons.join(', ')}`);
  }

  if (security.sensitive && !inputs.allowSecurityAi) {
    const managedLabels = desiredManagedLabels(inputs.managedLabelPrefix, minimalSecurityTriage(), security).filter((label) =>
      repositoryLabelNames.some((existing) => existing.toLowerCase() === label.toLowerCase()),
    );
    const staleLabels = inputs.syncManagedLabels ? staleManagedLabels(issue.labels, managedLabels, inputs.managedLabelPrefix) : [];
    if (inputs.dryRun) {
      core.info(`[dry-run] Would route security-sensitive issue #${issue.number} to human review without pi.`);
    } else {
      for (const label of staleLabels) await removeLabel(octokit, issue.number, label);
      await addLabels(octokit, issue.number, managedLabels);
    }
    const commentBody = redactSecrets(buildSecurityComment(inputs.commentMarker, issue, managedLabels, security.reasons, snapshotHash), [inputs.openaiApiKey, inputs.githubToken]);
    const commentUrl = inputs.dryRun ? '' : await upsertIssueComment(octokit, issue.number, inputs.commentMarker, commentBody);
    await writeStateRecord(octokit, inputs, {
      kind: 'issue',
      owner: issue.owner,
      repo: issue.repo,
      numberOrSha: String(issue.number),
      title: issue.title,
      conclusion: 'security-sensitive; human review required',
      labels: managedLabels,
      url: issue.url,
      closed: false,
      data: { security, redacted: true, snapshotHash, piCalls: getPiCallCount() },
    });
    return {
      conclusion: 'security-sensitive; human review required',
      labels: managedLabels,
      commentUrl,
      triageJson: JSON.stringify({ security, redacted: true }),
      closed: false,
    };
  }

  const relatedItems = await getRelatedContext(octokit, issue, inputs.maxRelatedItems);
  const duplicate = assessDuplicate(issue, relatedItems);

  const piOutput = await runPi({
    inputs,
    tools: ['read', 'grep', 'find', 'ls'],
    prompt: formatIssuePrompt(issue, allowedExistingLabels, inputs.mode, relatedItems),
  });

  const triage = parseTriageResult(piOutput);
  triage.fix.straightforward = inputs.allowFix && !security.sensitive && triage.confidence >= 0.75 && !triage.needsMoreInfo && triage.fix.risk === 'low';

  const labels = filterAllowedLabels(triage.labels, allowedExistingLabelNames, repositoryLabelNames);
  const managedLabels = desiredManagedLabels(inputs.managedLabelPrefix, triage, security).filter((label) =>
    repositoryLabelNames.some((existing) => existing.toLowerCase() === label.toLowerCase()),
  );
  const staleLabels = inputs.syncManagedLabels ? staleManagedLabels(issue.labels, managedLabels, inputs.managedLabelPrefix) : [];
  const allLabels = [...new Set([...labels, ...managedLabels])];

  if (inputs.dryRun) {
    core.info(`[dry-run] Would add labels to #${issue.number}: ${allLabels.join(', ') || '(none)'}`);
    core.info(`[dry-run] Would remove stale managed labels from #${issue.number}: ${staleLabels.join(', ') || '(none)'}`);
  } else {
    for (const label of staleLabels) await removeLabel(octokit, issue.number, label);
    await addLabels(octokit, issue.number, allLabels);
  }

  const fixBlocker = (await findPreExistingFixBlocker(octokit, issue, relatedItems, triage, duplicate)) ?? fixCommandBlocker(inputs, command);
  if (fixBlocker) core.info(`Skipping fix PR: ${fixBlocker}`);
  const prUrl = security.sensitive || fixBlocker ? undefined : await maybeCreateFixPr(octokit, issue, triage, inputs);
  let closed = false;
  if (shouldCloseIssue(inputs, command, triage.closeProposal.propose, triage.closeProposal.confidence, duplicate.duplicate, duplicate.score, security.sensitive)) {
    if (inputs.dryRun) {
      core.info(`[dry-run] Would close issue #${issue.number}.`);
      closed = true;
    } else {
      await closeIssue(octokit, issue.number);
      closed = true;
    }
  }

  const commentBody = redactSecrets(buildTriageComment(inputs.commentMarker, issue, triage, allLabels, prUrl, fixBlocker, snapshotHash), [inputs.openaiApiKey, inputs.githubToken]);
  let commentUrl = '';
  if (inputs.dryRun) {
    core.info(`[dry-run] Would upsert issue comment:\n${commentBody}`);
  } else {
    commentUrl = await upsertIssueComment(octokit, issue.number, inputs.commentMarker, commentBody);
  }

  await writeStateRecord(octokit, inputs, {
    kind: 'issue',
    owner: issue.owner,
    repo: issue.repo,
    numberOrSha: String(issue.number),
    title: issue.title,
    conclusion: triage.conclusion,
    labels: allLabels,
    url: issue.url,
    prUrl,
    closed,
    data: { triage, relatedItems, duplicate, security, fixBlocker, snapshotHash, command: command.command, piCalls: getPiCallCount(), runId: github.context.runId, runUrl: runUrl() },
  });

  return {
    conclusion: triage.conclusion,
    labels: allLabels,
    commentUrl,
    prUrl,
    triageJson: JSON.stringify(triage),
    closed,
  };
}

function fixCommandBlocker(inputs: ActionInputs, command: CommandResolution): string | undefined {
  if (!inputs.requireFixCommand) return undefined;
  return command.command === 'fix' || command.command === 'fix-ci' || command.command === 'address-review' || command.command === 'rebase'
    ? undefined
    : 'require-fix-command is enabled and no trusted fix command was provided';
}

async function maybeTriggerDrainWorkflow(octokit: Octokit, inputs: ActionInputs): Promise<void> {
  if (!inputs.triggerDrainWorkflow) return;

  const { owner, repo } = github.context.repo;
  const ref = defaultBranchRef();
  try {
    await octokit.rest.actions.createWorkflowDispatch({
      owner,
      repo,
      workflow_id: inputs.drainWorkflow,
      ref,
    });
    core.info(`Dispatched ${inputs.drainWorkflow} on ${ref} to drain the watcher queue.`);
  } catch (error) {
    core.warning(`Queued item, but could not dispatch ${inputs.drainWorkflow}. Ensure the enqueue workflow grants actions: write. ${error instanceof Error ? error.message : String(error)}`);
  }
}

function defaultBranchRef(): string {
  const payload = github.context.payload as { repository?: { default_branch?: string } };
  return payload.repository?.default_branch ?? 'main';
}

function shouldCloseIssue(
  inputs: ActionInputs,
  command: CommandResolution,
  proposed: boolean,
  confidence: number,
  duplicate: boolean,
  duplicateScore: number,
  securitySensitive: boolean,
): boolean {
  return Boolean(command.applyClose && inputs.allowClose && !securitySensitive && ((proposed && confidence >= 0.95) || (duplicate && duplicateScore >= 0.55)));
}

function minimalSecurityTriage(): TriageResult {
  return {
    conclusion: 'security-sensitive; human review required',
    summary: 'Security-sensitive report routed to human review without AI processing.',
    issueType: 'unknown',
    confidence: 1,
    labels: [],
    needsMoreInfo: false,
    maintainerComment: 'Security-sensitive report routed to human review.',
    investigation: { relevantFiles: [], findings: [] },
    fix: { straightforward: false, reason: 'security-sensitive', suggestedApproach: '', risk: 'high' },
    closeProposal: { propose: false, category: 'none', confidence: 0, reason: '', canonicalUrl: '' },
  };
}

function allowedRepositoryLabels(allowlist: string[], repositoryLabels: RepositoryLabel[], managedLabelPrefix: string): RepositoryLabel[] {
  if (allowlist.includes('*')) {
    return repositoryLabels.filter((label) => !label.name.startsWith(managedLabelPrefix));
  }

  const allowed = new Set(allowlist.map((label) => label.trim().toLowerCase()));
  return repositoryLabels.filter((label) => allowed.has(label.name.toLowerCase()));
}

function runUrl(): string {
  const { owner, repo } = github.context.repo;
  return `https://github.com/${owner}/${repo}/actions/runs/${github.context.runId}`;
}

function isPullRequestPayload(): boolean {
  const payload = github.context.payload as { issue?: { pull_request?: unknown }; pull_request?: unknown };
  return Boolean(payload.issue?.pull_request || payload.pull_request);
}

function requireOpenAiApiKey(inputs: ActionInputs): void {
  if (!inputs.openaiApiKey) {
    throw new Error('openai-api-key is required for modes that process items with pi/OpenAI. It may be omitted only when mode is enqueue.');
  }
}

function setOutputs(result: ProcessIssueResult): void {
  core.setOutput('conclusion', result.conclusion);
  core.setOutput('labels', result.labels.join(','));
  core.setOutput('comment-url', result.commentUrl);
  core.setOutput('pr-url', result.prUrl ?? '');
  core.setOutput('closed', String(result.closed));
  core.setOutput('triage-json', result.triageJson);
}

main().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
