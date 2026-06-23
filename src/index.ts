import * as core from '@actions/core';
import * as github from '@actions/github';
import { resolveCommand, type CommandResolution } from './commands.js';
import { buildTriageComment } from './comment.js';
import { reviewCommit } from './commit-review.js';
import { maybeCreateFixPr } from './fix-runner.js';
import { addLabels, closeIssue, getIssueSnapshot, listRepositoryLabels, removeLabel, resolveIssueNumber, searchOpenIssueNumbers, upsertIssueComment, type Octokit } from './github.js';
import { getInputs, type ActionInputs } from './inputs.js';
import { formatIssuePrompt } from './issue-context.js';
import { desiredManagedLabels, staleManagedLabels } from './label-sync.js';
import { filterAllowedLabels } from './labels.js';
import { runPi } from './pi-runner.js';
import { repairPullRequest } from './pr-repair-runner.js';
import { getRelatedContext } from './related.js';
import { assessIssueSecurity } from './security.js';
import { writeStateRecord } from './state.js';
import { parseTriageResult } from './triage-schema.js';

async function main(): Promise<void> {
  const command = resolveCommand();
  if (!command.shouldRun) {
    core.info(`Skipping run: ${command.reason ?? 'no command matched'}.`);
    core.setOutput('conclusion', 'skipped');
    return;
  }

  const rawInputs = getInputs();
  const inputs = command.mode ? { ...rawInputs, mode: command.mode } : rawInputs;
  const octokit = github.getOctokit(inputs.githubToken);

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
  if (isPullRequestPayload() || github.context.eventName === 'pull_request') {
    if (inputs.mode !== 'fix') {
      core.info('PR review/triage is read-only in this MVP; use @posthog-watcher fix for same-repo PR repair.');
      core.setOutput('conclusion', 'skipped PR mutation; use fix command');
      return;
    }
    const result = await repairPullRequest(octokit, issueNumber, inputs);
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

async function sweep(octokit: Octokit, inputs: ActionInputs): Promise<void> {
  const issueNumbers = await searchOpenIssueNumbers(octokit, inputs.sweepQuery, inputs.maxSweepItems);
  core.info(`Sweep found ${issueNumbers.length} open issue(s).`);

  const results: ProcessIssueResult[] = [];
  for (const issueNumber of issueNumbers) {
    results.push(await processIssue(octokit, issueNumber, inputs, { shouldRun: true }));
  }

  core.setOutput('conclusion', `swept ${results.length} issue(s)`);
  core.setOutput('triage-json', JSON.stringify(results));
}

async function processIssue(octokit: Octokit, issueNumber: number, inputs: ActionInputs, command: CommandResolution): Promise<ProcessIssueResult> {
  core.info(`Processing issue #${issueNumber} in ${inputs.mode} mode`);

  const issue = await getIssueSnapshot(octokit, issueNumber, inputs.maxComments);
  const repositoryLabels = await listRepositoryLabels(octokit);
  const allowedExistingLabels = inputs.labelAllowlist.filter((label) =>
    repositoryLabels.some((existing) => existing.toLowerCase() === label.toLowerCase()),
  );

  const relatedItems = await getRelatedContext(octokit, issue, inputs.maxRelatedItems);
  const security = assessIssueSecurity(issue);
  if (security.sensitive) {
    core.warning(`Security-sensitive issue detected. Disabling fix and close actions. Reasons: ${security.reasons.join(', ')}`);
  }

  const piOutput = await runPi({
    inputs,
    tools: ['read', 'grep', 'find', 'ls'],
    prompt: formatIssuePrompt(issue, allowedExistingLabels, inputs.mode, relatedItems),
  });

  const triage = parseTriageResult(piOutput);
  triage.fix.straightforward = inputs.allowFix && !security.sensitive && triage.confidence >= 0.75 && !triage.needsMoreInfo && triage.fix.risk === 'low';

  const labels = filterAllowedLabels(triage.labels, allowedExistingLabels, repositoryLabels);
  const managedLabels = desiredManagedLabels(inputs.managedLabelPrefix, triage, security).filter((label) =>
    repositoryLabels.some((existing) => existing.toLowerCase() === label.toLowerCase()),
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

  const prUrl = security.sensitive ? undefined : await maybeCreateFixPr(octokit, issue, triage, inputs);
  let closed = false;
  if (shouldCloseIssue(inputs, command, triage.closeProposal.propose, triage.closeProposal.confidence, security.sensitive)) {
    if (inputs.dryRun) {
      core.info(`[dry-run] Would close issue #${issue.number}.`);
      closed = true;
    } else {
      await closeIssue(octokit, issue.number);
      closed = true;
    }
  }

  const commentBody = buildTriageComment(inputs.commentMarker, issue, triage, allLabels, prUrl);
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
    data: { triage, relatedItems, security, command: command.command },
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

function shouldCloseIssue(inputs: ActionInputs, command: CommandResolution, proposed: boolean, confidence: number, securitySensitive: boolean): boolean {
  return Boolean(command.applyClose && inputs.allowClose && proposed && confidence >= 0.95 && !securitySensitive);
}

function isPullRequestPayload(): boolean {
  const payload = github.context.payload as { issue?: { pull_request?: unknown }; pull_request?: unknown };
  return Boolean(payload.issue?.pull_request || payload.pull_request);
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
