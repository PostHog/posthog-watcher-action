import * as core from '@actions/core';
import * as github from '@actions/github';
import { checkDiffGuardrails, parseNumstat } from './guardrails.js';
import { git, runShell } from './git.js';
import type { Octokit } from './github.js';
import type { ActionInputs } from './inputs.js';
import { runPi } from './pi-runner.js';
import { reviewGeneratedDiff } from './review-gate.js';

export interface PullRequestRepairResult {
  conclusion: string;
  prUrl: string;
  repaired: boolean;
}

export async function repairPullRequest(octokit: Octokit, pullNumber: number, inputs: ActionInputs): Promise<PullRequestRepairResult> {
  const { owner, repo } = github.context.repo;
  const pull = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });
  const pr = pull.data;

  if (pr.head.repo?.full_name !== `${owner}/${repo}`) {
    core.warning(`Skipping PR repair for forked PR #${pullNumber}; GITHUB_TOKEN cannot safely push to fork branches.`);
    return { conclusion: 'skipped fork PR repair', prUrl: pr.html_url, repaired: false };
  }

  if (!inputs.allowFix) {
    core.info('Skipping PR repair because allow-fix is false.');
    return { conclusion: 'skipped because allow-fix is false', prUrl: pr.html_url, repaired: false };
  }

  const branch = pr.head.ref;
  await git(['fetch', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  await git(['checkout', '-B', branch, `origin/${branch}`]);

  const prompt = `Repair pull request #${pullNumber}: ${pr.title}

This is PR repair/adoption. Edit the existing PR branch only. Follow karpathy-guidelines. Make the smallest changes needed to address likely CI/review issues. Do not merge, approve, or create a new PR.

PR body:
\`\`\`
${pr.body ?? '(empty)'}
\`\`\``;

  await runPi({ inputs, tools: ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write'], prompt, requireText: false });

  if (inputs.validationCommand) await runShell(inputs.validationCommand, process.cwd());

  const stats = parseNumstat(await git(['diff', '--numstat']));
  const failures = checkDiffGuardrails(stats, { maxChangedFiles: inputs.maxChangedFiles, maxDiffLines: inputs.maxDiffLines });
  if (failures.length) {
    core.warning(`Skipping PR branch push because guardrails failed:\n- ${failures.join('\n- ')}`);
    return { conclusion: 'skipped because guardrails failed', prUrl: pr.html_url, repaired: false };
  }

  const review = await reviewGeneratedDiff(inputs);
  if (!review.approve) {
    core.warning(`Skipping PR branch push because review gate rejected the diff: ${review.reason}`);
    return { conclusion: 'skipped because review gate rejected diff', prUrl: pr.html_url, repaired: false };
  }

  if (inputs.dryRun) {
    core.info(`[dry-run] Would push PR branch ${branch}.`);
    return { conclusion: 'dry-run PR repair completed', prUrl: pr.html_url, repaired: true };
  }

  await git(['config', 'user.name', 'posthog-watcher-action']);
  await git(['config', 'user.email', 'posthog-watcher-action@users.noreply.github.com']);
  await git(['add', '--', ...stats.files]);
  await git(['commit', '-m', `Repair PR #${pullNumber}: ${pr.title.slice(0, 80)}`]);
  await git(['push', 'origin', branch]);
  return { conclusion: 'PR branch repaired', prUrl: pr.html_url, repaired: true };
}
