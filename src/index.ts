import * as core from '@actions/core';
import * as github from '@actions/github';
import { replyToCommand } from './command-replies.js';
import { FIX_INTENT_COMMANDS, resolveCommand, TRUSTED_ASSOCIATIONS, type CommandResolution } from './commands.js';
import { buildSecurityComment, buildStatusComment, buildTriageComment } from './comment.js';
import { reviewCommit } from './commit-review.js';
import { assessDuplicate } from './duplicate-detector.js';
import { findPreExistingFixBlocker } from './fix-blocker.js';
import { maybeCreateFixPr } from './fix-runner.js';
import { addLabels, closeIssue, ensureTeamReviewRequested, getIssueComment, getIssueSnapshot, getReviewComment, listRepositoryLabels, removeLabel, resolveIssueNumber, searchOpenIssueNumbers, upsertIssueComment, type Octokit, type RepositoryLabel } from './github.js';
import { getInputs, type ActionInputs } from './inputs.js';
import { formatIssuePrompt, type IssueSnapshot } from './issue-context.js';
import { desiredManagedLabels, staleManagedLabels } from './label-sync.js';
import { filterAllowedLabels } from './labels.js';
import { getPiCallCount, resetPiCallCount } from './pi-budget.js';
import { formatPiSessionMarkdown, piSessionRecordCount, publishPiSessionFiles } from './pi-sessions.js';
import { isPosthogModel, runPi } from './pi-runner.js';
import { replyToPullRequestReviewComment, reviewPullRequest, type PullRequestReviewResult, type ReviewThreadRef } from './pr-review.js';
import { enqueueCurrentPayload, incrementQueueAttempt, readQueue, removeQueueItem, type QueueItem } from './queue.js';
import { redactSecrets } from './redact.js';
import { repairPullRequest } from './pr-repair-runner.js';
import { getRelatedContext } from './related.js';
import { assessIssueSecurity } from './security.js';
import { computeIssueSnapshotHash, findWatcherSnapshot } from './snapshot.js';
import { appendRepoMemory, readRepoMemory, writeStateRecord } from './state.js';
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
  const permissionFailure = await verifyCommandRepositoryPermission(octokit, command);
  if (permissionFailure) {
    core.info(`Skipping run: ${permissionFailure}.`);
    core.setOutput('conclusion', 'skipped');
    return;
  }

  if (rawInputs.mode === 'enqueue') {
    if (isPullRequestPayload()) {
      const pullNumber = resolveIssueNumber(rawInputs.issueNumber);
      if (!(await isWatcherPullRequest(octokit, pullNumber))) {
        core.info(`Skipping enqueue for PR #${pullNumber} because it was not created by posthog-watcher-action.`);
        core.setOutput('conclusion', 'skipped non-watcher PR');
        return;
      }
    }
    const result = await enqueueCurrentPayload(octokit, rawInputs, command);
    if (result.enqueued) await maybeTriggerDrainWorkflow(octokit, rawInputs);
    core.setOutput('conclusion', result.enqueued ? `queued ${result.item.kind} #${result.item.number}` : `already queued ${result.item.kind} #${result.item.number}`);
    core.setOutput('triage-json', JSON.stringify(result));
    return;
  }

  requireModelApiKey(rawInputs);
  // pr-review workflows stay in pr-review: event-inferred command modes (for
  // example address-review => fix from a plain review comment) must not hijack
  // an explicitly configured read-only review run into a repair run.
  const inputs = command.mode && rawInputs.mode !== 'drain-queue' && rawInputs.mode !== 'pr-review' ? { ...rawInputs, mode: command.mode } : rawInputs;

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

  if (inputs.mode === 'pr-review') {
    const pullNumber = resolveIssueNumber(inputs.issueNumber);
    if (command.command === 'pr-review-reply') {
      const thread = pullRequestReviewThread();
      if (!thread) {
        core.info('Skipping pr-review reply because the event payload has no review comment id.');
        core.setOutput('conclusion', 'skipped pr-review reply without a review comment id');
        return;
      }
      const result = await replyToPullRequestReviewComment(octokit, pullNumber, inputs, thread, command.extraInstructions ?? '');
      setPrReviewOutputs(result);
      return;
    }
    if (command.command && command.command !== 'triage') {
      core.info(`pr-review mode is read-only and does not handle ${command.command}; use a workflow with mode auto or fix for repair commands.`);
      core.setOutput('conclusion', `skipped ${command.command} command in pr-review mode`);
      return;
    }
    const result = await reviewPullRequest(octokit, pullNumber, inputs);
    setPrReviewOutputs(result);
    return;
  }

  if (inputs.mode === 'sweep') {
    await sweep(octokit, inputs);
    return;
  }

  const issueNumber = resolveIssueNumber(inputs.issueNumber);
  if (command.command === 'status' || command.command === 'explain' || command.command === 'ask') {
    const result = await replyToCommand(octokit, issueNumber, inputs, command.command, command.extraInstructions || undefined);
    core.setOutput('conclusion', result.conclusion);
    core.setOutput('comment-url', result.commentUrl);
    return;
  }

  if (isPullRequestPayload() || github.context.eventName === 'pull_request') {
    if (inputs.mode === 'fix') {
      const result = await repairPullRequest(octokit, issueNumber, inputs, command.command);
      core.setOutput('conclusion', result.conclusion);
      core.setOutput('pr-url', result.prUrl);
      return;
    }
    // The typed 'review' command parses as 'triage' (commands.ts commandPatterns).
    if (command.command === 'triage') {
      const result = await reviewPullRequest(octokit, issueNumber, inputs);
      setPrReviewOutputs(result);
      return;
    }
    core.info(`PR review/triage requires mode: pr-review or ${inputs.commandMention} review; use ${inputs.commandMention} fix for same-repo PR repair.`);
    core.setOutput('conclusion', 'skipped PR mutation; use pr-review mode or a review/fix command');
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
  const itemInputs = { ...inputs, mode: item.mode, commandMention: item.commandMention ?? inputs.commandMention };
  const itemCommand: CommandResolution = { shouldRun: true, mode: item.mode, command: item.command, applyClose: item.applyClose, extraInstructions: item.extraInstructions, commandMention: item.commandMention };
  core.info(`Draining queued ${item.kind} #${item.number} in ${item.mode} mode${item.command ? ` from ${item.command} command` : ''}.`);

  if (item.kind === 'pull_request') {
    // QueuedMode cannot represent pr-review, so queued review questions are
    // recognized by their command and re-enter the reply path explicitly.
    if (item.command === 'pr-review-reply') {
      if (!item.source.commentId) {
        core.info(`Skipping queued pr-review reply for PR #${item.number} because no review comment id was stored.`);
        return;
      }
      const comment = await getReviewComment(octokit, item.source.commentId);
      const thread = { commentId: item.source.commentId, rootId: comment?.inReplyToId ?? item.source.commentId };
      await replyToPullRequestReviewComment(octokit, item.number, { ...itemInputs, mode: 'pr-review' }, thread, item.extraInstructions ?? '');
      return;
    }
    if (item.mode !== 'fix') {
      core.info(`Skipping queued PR #${item.number} in ${item.mode} mode; the queue only repairs PRs. Use mode: pr-review (unqueued) for code review.`);
      return;
    }
    await repairPullRequest(octokit, item.number, itemInputs, item.command);
    return;
  }

  if (item.command === 'status' || item.command === 'explain' || item.command === 'ask') {
    await replyToCommand(octokit, item.number, itemInputs, item.command, item.extraInstructions || (await queuedCommandBody(octokit, item)));
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
      const result = await processIssue(octokit, issueNumber, itemInputs, { shouldRun: true });
      results.push(result);
      if (result.conclusion === 'skipped trusted author issue') skipped += 1;
    } catch (error) {
      if (error instanceof Error && /Pi call budget exhausted/.test(error.message)) {
        skipped += 1;
        core.warning(`Stopping sweep because pi budget is exhausted: ${error.message}`);
        break;
      }
      throw error;
    }
  }

  core.setOutput('conclusion', `swept ${results.length - skipped} issue(s), skipped ${skipped}`);
  core.setOutput('triage-json', JSON.stringify(results));
}

async function processIssue(octokit: Octokit, issueNumber: number, inputs: ActionInputs, command: CommandResolution, forcedCommentId?: number): Promise<ProcessIssueResult> {
  core.info(`Processing issue #${issueNumber} in ${inputs.mode} mode`);
  const piSessionStartIndex = piSessionRecordCount();

  const issue = await getIssueSnapshot(octokit, issueNumber, inputs.maxComments, forcedCommentId);
  if (await shouldSkipSweepIssueAuthor(octokit, inputs, command, issue)) {
    core.info(`Skipping issue #${issue.number} during sweep because it was created by trusted ${issue.authorAssociation} author ${issue.author}.`);
    return {
      conclusion: 'skipped trusted author issue',
      labels: issue.labels,
      commentUrl: '',
      triageJson: JSON.stringify({ skipped: true, reason: 'trusted-author', author: issue.author, authorAssociation: issue.authorAssociation }),
      closed: false,
    };
  }

  const snapshotHash = computeIssueSnapshotHash(issue, inputs.commentMarker, issueSnapshotHashOptions(inputs));
  const previousSnapshot = findWatcherSnapshot(issue, inputs.commentMarker);
  if (shouldSkipUnchangedIssue(inputs, command, previousSnapshot.hash, snapshotHash)) {
    core.info(`Skipping issue #${issue.number} because its watcher snapshot has not changed.`);
    return {
      conclusion: 'skipped unchanged issue',
      labels: issue.labels,
      commentUrl: previousSnapshot.url ?? '',
      triageJson: JSON.stringify({ skipped: true, reason: 'unchanged', snapshotHash }),
      closed: false,
    };
  }

  await updateIssueStatus(octokit, inputs, issue, 'Preparing', 'Fetching repository labels and checking safety guardrails.', sweepAttentionMention(inputs, issue.owner));

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
    const commentBody = redactSecrets(buildSecurityComment(inputs.commentMarker, issue, managedLabels, security.reasons, snapshotHash, sweepAttentionMention(inputs, issue.owner)), [inputs.openaiApiKey, inputs.posthogApiKey, inputs.posthogCodeApiKey, inputs.githubToken]);
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
    if (inputs.repoMemoryEnabled) {
      await appendRepoMemory(octokit, inputs, {
        owner: issue.owner,
        repo: issue.repo,
        item: `issue #${issue.number}`,
        title: issue.title,
        conclusion: 'security-sensitive; human review required',
        labels: managedLabels,
        url: issue.url,
        findings: [`Routed to human review without AI. Reasons: ${security.reasons.join(', ') || 'unknown'}`],
      });
    }
    return {
      conclusion: 'security-sensitive; human review required',
      labels: managedLabels,
      commentUrl,
      triageJson: JSON.stringify({ security, redacted: true }),
      closed: false,
    };
  }

  const repoMemory = inputs.repoMemoryEnabled ? await readRepoMemory(octokit, inputs, issue.owner, issue.repo) : '';
  const relatedItems = await getRelatedContext(octokit, issue, inputs.maxRelatedItems);
  const duplicate = assessDuplicate(issue, relatedItems);

  await updateIssueStatus(octokit, inputs, issue, 'Triaging with pi', repoMemory ? 'Loaded repository memory and related issue context; asking pi for an evidence-backed triage.' : 'Loaded related issue context; asking pi for an evidence-backed triage.', sweepAttentionMention(inputs, issue.owner));
  const piOutput = await runPi({
    inputs,
    tools: ['read', 'grep', 'find', 'ls'],
    prompt: formatIssuePrompt(issue, allowedExistingLabels, inputs.mode, relatedItems, repoMemory, command.extraInstructions, inputs.commandMention),
  });

  const triage = parseTriageResult(piOutput);
  triage.fix.straightforward = inputs.allowFix && !security.sensitive && triage.confidence >= 0.75 && !triage.needsMoreInfo && triage.fix.risk === 'low';

  const labels = filterAllowedLabels(triage.labels, allowedExistingLabelNames, repositoryLabelNames);
  const managedLabels = desiredManagedLabels(inputs.managedLabelPrefix, triage, security).filter((label) =>
    repositoryLabelNames.some((existing) => existing.toLowerCase() === label.toLowerCase()),
  );
  const staleLabels = inputs.syncManagedLabels ? staleManagedLabels(issue.labels, managedLabels, inputs.managedLabelPrefix) : [];
  const allLabels = [...new Set([...labels, ...managedLabels])];

  await updateIssueStatus(octokit, inputs, issue, 'Applying triage results', `Conclusion: ${triage.conclusion}. Applying labels and evaluating fix/close gates.`, sweepAttentionMention(inputs, issue.owner));

  if (inputs.dryRun) {
    core.info(`[dry-run] Would add labels to #${issue.number}: ${allLabels.join(', ') || '(none)'}`);
    core.info(`[dry-run] Would remove stale managed labels from #${issue.number}: ${staleLabels.join(', ') || '(none)'}`);
  } else {
    for (const label of staleLabels) await removeLabel(octokit, issue.number, label);
    await addLabels(octokit, issue.number, allLabels);
  }

  const preExistingFixBlocker = await findPreExistingFixBlocker(octokit, issue, relatedItems, triage, duplicate);
  const commandFixBlocker = planCommandBlocker(command) ?? fixCommandBlocker(inputs, command) ?? featureFixBlocker(triage, inputs, command);
  if (preExistingFixBlocker?.blockingPullRequest && !commandFixBlocker && shouldReportFixAttempt(triage, inputs)) {
    await ensureBlockingPrTeamReviewRequested(octokit, inputs, preExistingFixBlocker.blockingPullRequest.number);
  }
  const fixBlocker = preExistingFixBlocker?.reason ?? commandFixBlocker;
  if (fixBlocker) core.info(`Skipping fix PR: ${fixBlocker}`);
  if (!security.sensitive && !fixBlocker && shouldReportFixAttempt(triage, inputs)) {
    await updateIssueStatus(octokit, inputs, issue, 'Attempting fix PR', 'Running the guarded repair loop, validation, diff guardrails, and independent review gate.', sweepAttentionMention(inputs, issue.owner));
  }
  const prUrl = security.sensitive || fixBlocker ? undefined : await maybeCreateFixPr(octokit, issue, triage, inputs, command.extraInstructions);
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

  const piSessionReference = await publishPiSessionFiles(octokit, inputs, `issue-${issue.number}`, piSessionStartIndex);
  const piSessionMarkdown = formatPiSessionMarkdown(piSessionReference);
  const commentBody = redactSecrets(buildTriageComment(inputs.commentMarker, issue, triage, allLabels, prUrl, fixBlocker, snapshotHash, sweepAttentionMention(inputs, issue.owner), piSessionMarkdown), [inputs.openaiApiKey, inputs.posthogApiKey, inputs.posthogCodeApiKey, inputs.githubToken]);
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
    data: { triage, relatedItems, duplicate, security, fixBlocker, snapshotHash, command: command.command, piCalls: getPiCallCount(), piSessionReference, runId: github.context.runId, runUrl: runUrl() },
  });
  if (inputs.repoMemoryEnabled) {
    await appendRepoMemory(octokit, inputs, {
      owner: issue.owner,
      repo: issue.repo,
      item: `issue #${issue.number}`,
      title: issue.title,
      conclusion: triage.conclusion,
      labels: allLabels,
      url: issue.url,
      prUrl,
      relevantFiles: triage.investigation.relevantFiles,
      findings: triage.investigation.findings,
      fixReason: triage.fix.reason,
      validationCommand: inputs.validationCommand,
    });
  }

  return {
    conclusion: triage.conclusion,
    labels: allLabels,
    commentUrl,
    prUrl,
    triageJson: JSON.stringify(triage),
    closed,
  };
}

async function updateIssueStatus(octokit: Octokit, inputs: ActionInputs, issue: IssueSnapshot, phase: string, detail: string, attentionMention?: string): Promise<void> {
  if (!inputs.progressComments) return;
  const body = redactSecrets(buildStatusComment(inputs.commentMarker, issue, phase, detail, undefined, attentionMention), [inputs.openaiApiKey, inputs.posthogApiKey, inputs.posthogCodeApiKey, inputs.githubToken]);
  if (inputs.dryRun) {
    core.info(`[dry-run] Would update watcher status for #${issue.number}: ${phase} - ${detail}`);
    return;
  }
  await upsertIssueComment(octokit, issue.number, inputs.commentMarker, body);
}

function shouldReportFixAttempt(triage: TriageResult, inputs: ActionInputs): boolean {
  if (!inputs.allowFix) return false;
  if (inputs.mode === 'triage' || inputs.mode === 'investigate') return false;
  if (triage.confidence < 0.75) return false;
  if (triage.needsMoreInfo) return false;
  return triage.fix.risk === 'low';
}

async function ensureBlockingPrTeamReviewRequested(octokit: Octokit, inputs: ActionInputs, pullNumber: number): Promise<void> {
  if (!inputs.fixPrReviewTeam.trim()) return;
  if (inputs.dryRun) {
    core.info(`[dry-run] Would request review from ${inputs.fixPrReviewTeam} on existing related PR #${pullNumber}.`);
    return;
  }
  await ensureTeamReviewRequested(octokit, pullNumber, inputs.fixPrReviewTeam);
}

async function verifyCommandRepositoryPermission(octokit: Octokit, command: CommandResolution): Promise<string | undefined> {
  if (!command.command || !command.actor || command.actor === 'unknown') return undefined;

  const { owner, repo } = github.context.repo;
  try {
    const response = await octokit.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username: command.actor });
    const permission = response.data.permission?.toLowerCase() ?? 'none';
    core.info(`Command actor @${command.actor} has repository permission: ${permission}.`);
    if (COMMAND_REPOSITORY_PERMISSIONS.has(permission)) return undefined;
    return `ignoring ${command.command} command from @${command.actor}; repository write, maintain, or admin permission is required (found: ${permission})`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `could not verify repository permission for @${command.actor}; refusing to run ${command.command}: ${message}`;
  }
}

const COMMAND_REPOSITORY_PERMISSIONS = new Set(['admin', 'maintain', 'write']);

function planCommandBlocker(command: CommandResolution): string | undefined {
  return command.command === 'plan' ? 'plan command requested a proposal only; no draft PR was opened' : undefined;
}

function fixCommandBlocker(inputs: ActionInputs, command: CommandResolution): string | undefined {
  if (!inputs.requireFixCommand) return undefined;
  return fixExplicitlyRequested(inputs, command) ? undefined : 'require-fix-command is enabled and no trusted fix command was provided';
}

function sweepAttentionMention(inputs: ActionInputs, owner: string): string | undefined {
  if (inputs.mode !== 'sweep') return undefined;
  const reviewTeam = inputs.fixPrReviewTeam.trim().replace(/^@/, '');
  if (!reviewTeam) return undefined;
  return `@${reviewTeam.includes('/') ? reviewTeam : `${owner}/${reviewTeam}`}`;
}

function featureFixBlocker(triage: TriageResult, inputs: ActionInputs, command: CommandResolution): string | undefined {
  if (!inputs.blockFeatureFixes) return undefined;
  if (triage.issueType !== 'feature') return undefined;
  return fixExplicitlyRequested(inputs, command) ? undefined : 'feature requests require an explicit trusted fix command or mode: fix before opening a draft PR';
}

function fixExplicitlyRequested(inputs: ActionInputs, command: CommandResolution): boolean {
  return inputs.mode === 'fix' || (command.command !== undefined && FIX_INTENT_COMMANDS.has(command.command));
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

function shouldSkipUnchangedIssue(inputs: ActionInputs, command: CommandResolution, previousHash: string | undefined, snapshotHash: string): boolean {
  if (previousHash !== snapshotHash) return false;
  if (command.command) return false;
  return inputs.mode === 'auto' || inputs.mode === 'triage' || inputs.mode === 'investigate' || inputs.mode === 'sweep';
}

async function shouldSkipSweepIssueAuthor(octokit: Octokit, inputs: ActionInputs, command: CommandResolution, issue: IssueSnapshot): Promise<boolean> {
  if (!inputs.skipSweepTrustedAuthors) return false;
  if (inputs.mode !== 'sweep') return false;
  if (command.command) return false;
  if (TRUSTED_ASSOCIATIONS.has(issue.authorAssociation.toUpperCase())) return true;

  const permission = await getIssueAuthorRepositoryPermission(octokit, issue);
  if (!permission) return false;
  return TRUSTED_REPOSITORY_PERMISSIONS.has(permission.toLowerCase());
}

const TRUSTED_REPOSITORY_PERMISSIONS = new Set(['admin', 'maintain', 'write', 'triage']);

async function getIssueAuthorRepositoryPermission(octokit: Octokit, issue: IssueSnapshot): Promise<string | undefined> {
  if (!issue.author || issue.author === 'unknown') return undefined;

  try {
    const response = await octokit.rest.repos.getCollaboratorPermissionLevel({
      owner: issue.owner,
      repo: issue.repo,
      username: issue.author,
    });
    const permission = response.data.permission;
    if (permission) {
      core.info(`Issue #${issue.number} author ${issue.author} has repository permission: ${permission}.`);
    }
    return permission;
  } catch (error) {
    const status = typeof error === 'object' && error !== null && 'status' in error ? (error as { status?: number }).status : undefined;
    if (status !== 404) {
      core.warning(`Could not check repository permission for issue #${issue.number} author ${issue.author}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return undefined;
  }
}

function issueSnapshotHashOptions(inputs: ActionInputs) {
  return {
    managedLabelPrefix: inputs.managedLabelPrefix,
    mode: inputs.mode,
    allowFix: inputs.allowFix,
    allowClose: inputs.allowClose,
    requireFixCommand: inputs.requireFixCommand,
    blockFeatureFixes: inputs.blockFeatureFixes,
    validationCommand: inputs.validationCommand,
    reproductionCommand: inputs.reproductionCommand,
    requireReproduction: inputs.requireReproduction,
    skipSweepTrustedAuthors: inputs.skipSweepTrustedAuthors,
    repoMemoryEnabled: inputs.repoMemoryEnabled,
    progressComments: inputs.progressComments,
    piSessionSharing: inputs.piSessionSharing,
    piSessionSharingMode: inputs.piSessionSharingMode,
    commandMention: inputs.commandMention,
  };
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

async function isWatcherPullRequest(octokit: Octokit, pullNumber: number): Promise<boolean> {
  const { owner, repo } = github.context.repo;
  const pull = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });
  return pull.data.head.repo?.full_name === `${owner}/${repo}` && pull.data.head.ref.startsWith('posthog-watcher/');
}

function isPullRequestPayload(): boolean {
  const payload = github.context.payload as { issue?: { pull_request?: unknown }; pull_request?: unknown };
  return Boolean(payload.issue?.pull_request || payload.pull_request);
}

function requireModelApiKey(inputs: ActionInputs): void {
  if (inputs.fixExecutor === 'posthog-code' && (!inputs.posthogCodeApiKey || !inputs.posthogCodeProjectId)) {
    throw new Error('posthog-code-api-key and posthog-code-project-id are required when fix-executor is posthog-code. The key is a personal API key (phx_...), distinct from the pha_ gateway token in posthog-api-key.');
  }
  if (isPosthogModel(inputs.model)) {
    if (!inputs.posthogApiKey) {
      throw new Error('posthog-api-key is required for posthog/* models in modes that process items with pi. It may be omitted only when mode is enqueue.');
    }
    return;
  }
  if (!inputs.openaiApiKey) {
    throw new Error('openai-api-key is required for openai/* models in modes that process items with pi. It may be omitted only when mode is enqueue.');
  }
}

function pullRequestReviewThread(): ReviewThreadRef | undefined {
  const payload = github.context.payload as { comment?: { id?: number; in_reply_to_id?: number } };
  const commentId = payload.comment?.id;
  if (!commentId) return undefined;
  // Replies must target the thread root: GitHub's replies endpoint expects the
  // top-level review comment, and the root holds the finding being asked about.
  return { commentId, rootId: payload.comment?.in_reply_to_id ?? commentId };
}

function setPrReviewOutputs(result: PullRequestReviewResult): void {
  core.setOutput('conclusion', result.conclusion);
  core.setOutput('comment-url', result.commentUrl);
  if (result.verdict) core.setOutput('review-verdict', result.verdict);
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
