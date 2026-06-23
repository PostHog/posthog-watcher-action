import * as core from '@actions/core';
import * as github from '@actions/github';
import { resolveCommand } from './commands.js';
import { buildTriageComment } from './comment.js';
import { reviewCommit } from './commit-review.js';
import { maybeCreateFixPr } from './fix-runner.js';
import { addLabels, getIssueSnapshot, listRepositoryLabels, resolveIssueNumber, upsertIssueComment } from './github.js';
import { getInputs } from './inputs.js';
import { formatIssuePrompt } from './issue-context.js';
import { filterAllowedLabels } from './labels.js';
import { runPi } from './pi-runner.js';
import { getRelatedContext } from './related.js';
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
  if (inputs.mode === 'commit-review') {
    const result = await reviewCommit(inputs);
    core.setOutput('conclusion', result.conclusion);
    core.setOutput('triage-json', JSON.stringify(result));
    return;
  }

  const octokit = github.getOctokit(inputs.githubToken);
  const issueNumber = resolveIssueNumber(inputs.issueNumber);

  core.info(`Processing issue #${issueNumber} in ${inputs.mode} mode`);

  const issue = await getIssueSnapshot(octokit, issueNumber, inputs.maxComments);
  const repositoryLabels = await listRepositoryLabels(octokit);
  const allowedExistingLabels = inputs.labelAllowlist.filter((label) =>
    repositoryLabels.some((existing) => existing.toLowerCase() === label.toLowerCase()),
  );

  const relatedItems = await getRelatedContext(octokit, issue, inputs.maxRelatedItems);
  const piOutput = await runPi({
    inputs,
    tools: ['read', 'grep', 'find', 'ls'],
    prompt: formatIssuePrompt(issue, allowedExistingLabels, inputs.mode, relatedItems),
  });

  const triage = parseTriageResult(piOutput);
  triage.fix.straightforward = inputs.allowFix && triage.confidence >= 0.75 && !triage.needsMoreInfo && triage.fix.risk === 'low';
  const labels = filterAllowedLabels(triage.labels, allowedExistingLabels, repositoryLabels);

  if (inputs.dryRun) {
    core.info(`[dry-run] Would add labels to #${issue.number}: ${labels.join(', ') || '(none)'}`);
  } else {
    await addLabels(octokit, issue.number, labels);
  }

  const prUrl = await maybeCreateFixPr(octokit, issue, triage, inputs);
  const commentBody = buildTriageComment(inputs.commentMarker, issue, triage, labels, prUrl);
  let commentUrl = '';

  if (inputs.dryRun) {
    core.info(`[dry-run] Would upsert issue comment:\n${commentBody}`);
  } else {
    commentUrl = await upsertIssueComment(octokit, issue.number, inputs.commentMarker, commentBody);
  }

  core.setOutput('conclusion', triage.conclusion);
  core.setOutput('labels', labels.join(','));
  core.setOutput('comment-url', commentUrl);
  core.setOutput('pr-url', prUrl ?? '');
  core.setOutput('triage-json', JSON.stringify(triage));
}

main().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
