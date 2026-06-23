import * as core from '@actions/core';
import { createDraftPullRequest, defaultBranch, findOpenPullRequestForBranch, type Octokit } from './github.js';
import { checkDiffGuardrails, parseNumstat } from './guardrails.js';
import { git, runShell } from './git.js';
import type { ActionInputs } from './inputs.js';
import { formatFixPrompt, formatRepairFeedbackPrompt, type IssueSnapshot } from './issue-context.js';
import { runPi } from './pi-runner.js';
import { reviewGeneratedDiff } from './review-gate.js';
import type { TriageResult } from './triage-schema.js';

export async function maybeCreateFixPr(octokit: Octokit, issue: IssueSnapshot, triage: TriageResult, inputs: ActionInputs): Promise<string | undefined> {
  if (!shouldAttemptFix(triage, inputs)) return undefined;

  const status = await git(['status', '--porcelain']);
  if (status) {
    core.warning('Skipping fix because the checkout has uncommitted changes before pi runs.');
    return undefined;
  }

  const originalRef = await currentCheckoutRef();
  const base = defaultBranch();
  const branch = `posthog-watcher/issue-${issue.number}`;
  const existingPr = await findOpenPullRequestForBranch(octokit, branch);
  const existingRemoteBranch = await remoteBranchExists(branch);

  if (inputs.dryRun) {
    core.info(`[dry-run] Would ${existingPr ? `update existing PR ${existingPr.url}` : existingRemoteBranch ? `reuse remote branch ${branch} and open a draft PR` : `create branch ${branch} and open a draft PR`}.`);
    return existingPr?.url;
  }

  try {
    if (existingPr || existingRemoteBranch) {
      core.info(existingPr ? `Reusing existing draft PR branch ${branch}: ${existingPr.url}` : `Reusing existing remote branch ${branch}.`);
      await checkoutExistingBranch(branch);
    } else {
      await git(['checkout', '-B', branch]);
    }

    const repair = await runRepairLoop(issue, triage, inputs);
    if (!repair) {
      return undefined;
    }

    const reviewGate = await reviewGeneratedDiff(inputs);
    if (!reviewGate.approve) {
      core.warning(`Skipping PR because independent review gate rejected the diff: ${reviewGate.reason}`);
      return undefined;
    }

    await git(['config', 'user.name', 'posthog-watcher-action']);
    await git(['config', 'user.email', 'posthog-watcher-action@users.noreply.github.com']);
    await git(['add', '--', ...repair.files]);
    await git(['commit', '-m', `Fix #${issue.number}: ${issue.title.slice(0, 80)}`]);
    await git(['push', '--set-upstream', 'origin', branch]);

    if (existingPr) {
      core.info(`Updated existing draft PR: ${existingPr.url}`);
      return existingPr.url;
    }

    const prUrl = await createDraftPullRequest(octokit, {
      title: `Fix #${issue.number}: ${issue.title}`,
      head: branch,
      base,
      body: buildPullRequestBody(issue, triage, repair.files, inputs.validationCommand),
    });

    core.info(`Created draft PR: ${prUrl}`);
    return prUrl;
  } finally {
    await restoreCheckout(originalRef);
  }
}

async function runRepairLoop(issue: IssueSnapshot, triage: TriageResult, inputs: ActionInputs): Promise<{ files: string[] } | undefined> {
  const maxAttempts = Math.min(inputs.maxRepairAttempts, 3);
  let failureSummary = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    core.info(`Starting repair attempt ${attempt}/${maxAttempts}`);
    await runPi({
      inputs,
      tools: ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write'],
      prompt: attempt === 1 ? formatFixPrompt(issue, triage) : formatRepairFeedbackPrompt(issue, triage, attempt, failureSummary),
      requireText: false,
    });

    const validationFailure = await runValidation(inputs);
    const numstat = await git(['diff', '--numstat']);
    const stats = parseNumstat(numstat);
    const guardrailFailures = checkDiffGuardrails(stats, {
      maxChangedFiles: inputs.maxChangedFiles,
      maxDiffLines: inputs.maxDiffLines,
    });

    const failures = [...(validationFailure ? [validationFailure] : []), ...guardrailFailures];
    if (!failures.length) {
      return { files: stats.files };
    }

    failureSummary = failures.join('\n');
    core.warning(`Repair attempt ${attempt} failed:\n- ${failures.join('\n- ')}`);
  }

  core.warning('Skipping PR because all repair attempts failed.');
  return undefined;
}

async function runValidation(inputs: ActionInputs): Promise<string | undefined> {
  if (!inputs.validationCommand) return undefined;

  try {
    core.info(`Running validation command: ${inputs.validationCommand}`);
    await runShell(inputs.validationCommand, process.cwd());
    return undefined;
  } catch (error) {
    return `validation failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function currentCheckoutRef(): Promise<string> {
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
  return branch === 'HEAD' ? git(['rev-parse', 'HEAD']) : branch;
}

async function restoreCheckout(originalRef: string): Promise<void> {
  await git(['reset', '--hard', 'HEAD']).catch((error) => core.warning(`Failed to reset worktree before restore: ${error instanceof Error ? error.message : String(error)}`));
  await git(['checkout', originalRef]).catch((error) => core.warning(`Failed to restore original checkout ${originalRef}: ${error instanceof Error ? error.message : String(error)}`));
}

async function remoteBranchExists(branch: string): Promise<boolean> {
  return Boolean(await git(['ls-remote', '--heads', 'origin', branch]));
}

async function checkoutExistingBranch(branch: string): Promise<void> {
  await git(['fetch', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  await git(['checkout', '-B', branch, `origin/${branch}`]);
}

function shouldAttemptFix(triage: TriageResult, inputs: ActionInputs): boolean {
  if (!inputs.allowFix) return false;
  if (inputs.mode === 'triage' || inputs.mode === 'investigate') return false;
  if (triage.confidence < 0.75) return false;
  if (triage.needsMoreInfo) return false;
  if (triage.fix.risk !== 'low') return false;
  return true;
}

function buildPullRequestBody(issue: IssueSnapshot, triage: TriageResult, files: string[], validationCommand: string): string {
  return `Fixes #${issue.number}

Generated by posthog-watcher-action using pi.

## Summary

${triage.summary}

## Triage rationale

${triage.fix.reason}

## Changed files

${files.map((file) => `- \`${file}\``).join('\n')}

## Validation

${validationCommand ? `- \`${validationCommand}\`` : '- No validation command configured.'}
`;
}
