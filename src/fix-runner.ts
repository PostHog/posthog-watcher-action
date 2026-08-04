import * as core from '@actions/core';
import { readFile } from 'node:fs/promises';
import { filterExistingFiles, readAffectedPackageNames } from './affected-packages.js';
import { createDraftPullRequest, defaultBranch, ensurePullRequestAssignee, ensureTeamReviewRequested, findOpenPullRequestForBranch, type Octokit } from './github.js';
import { git } from './git.js';
import type { ActionInputs } from './inputs.js';
import type { IssueSnapshot } from './issue-context.js';
import { cloudModelFromPiModel } from './posthog-code-client.js';
import { buildPullRequestBody } from './pull-request-body.js';
import { delegateFixToPostHogCode } from './posthog-code-fix-runner.js';
import { runIssueRepair } from './repair-run.js';
import { commitChangesWithGitHubSignature } from './signed-commit.js';
import type { TriageResult } from './triage-schema.js';

export async function maybeCreateFixPr(
  octokit: Octokit,
  issue: IssueSnapshot,
  triage: TriageResult,
  inputs: ActionInputs,
  trustedInstructions = '',
  humanDriver?: string,
): Promise<string | undefined> {
  if (!shouldAttemptFix(triage, inputs)) return undefined;

  if (inputs.fixExecutor === 'posthog-code') {
    // Delegated mode: PostHog Code's cloud sandbox runs the agent loop and
    // opens the PR itself, so the local checkout/repair/guardrail/signed
    // commit path below is bypassed entirely.
    if (inputs.dryRun) {
      core.info(`[dry-run] Would delegate the fix for #${issue.number} to PostHog Code cloud (${cloudModelFromPiModel(inputs.model)}).`);
      return undefined;
    }
    return delegateFixToPostHogCode(octokit, issue, triage, inputs, trustedInstructions);
  }

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
    let expectedHeadOid: string;
    if (existingPr || existingRemoteBranch) {
      core.info(existingPr ? `Reusing existing draft PR branch ${branch}: ${existingPr.url}` : `Reusing existing remote branch ${branch}.`);
      await checkoutExistingBranch(branch);
      expectedHeadOid = await git(['rev-parse', `origin/${branch}`]);
    } else {
      await git(['checkout', '-B', branch]);
      expectedHeadOid = await git(['rev-parse', 'HEAD']);
    }

    const pullRequestTemplate = await readPullRequestTemplate();
    const repair = await runIssueRepair(issue, triage, inputs, trustedInstructions);
    if (!repair) {
      return undefined;
    }

    const affectedPackages = await readAffectedPackageNames(repair.files);
    const existingFiles = await filterExistingFiles(repair.files);
    const commit = await commitChangesWithGitHubSignature(octokit, {
      branch,
      message: `Fix #${issue.number}: ${issue.title.slice(0, 80)}`,
      expectedHeadOid,
      createBranch: !existingPr && !existingRemoteBranch,
    });
    core.info(`Created GitHub-signed commit: ${commit.url}`);

    if (existingPr) {
      await ensureTeamReviewRequested(octokit, existingPr.number, inputs.fixPrReviewTeam);
      core.info(`Updated existing draft PR: ${existingPr.url}`);
      return existingPr.url;
    }

    const pr = await createDraftPullRequest(octokit, {
      title: `fix: ${issue.title}`,
      head: branch,
      base,
      body: buildPullRequestBody({
        issue,
        triage,
        files: repair.files,
        validationCommand: inputs.validationCommand,
        template: pullRequestTemplate,
        humanDriver,
        affectedPackages,
        existingFiles,
      }),
    });
    await ensurePullRequestAssignee(octokit, pr.number, humanDriver);
    await ensureTeamReviewRequested(octokit, pr.number, inputs.fixPrReviewTeam);

    core.info(`Created draft PR: ${pr.url}`);
    return pr.url;
  } finally {
    await restoreCheckout(originalRef);
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

async function readPullRequestTemplate(): Promise<string | undefined> {
  try {
    return await readFile('.github/pull_request_template.md', 'utf8');
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
