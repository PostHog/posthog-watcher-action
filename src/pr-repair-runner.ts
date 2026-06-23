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

async function getPullRequestLabels(octokit: Octokit, pullNumber: number): Promise<string[]> {
  const { owner, repo } = github.context.repo;
  const issue = await octokit.rest.issues.get({ owner, repo, issue_number: pullNumber });
  return issue.data.labels.map((label: string | { name?: string | null }) => (typeof label === 'string' ? label : label.name ?? '')).filter(Boolean);
}

async function getPullRequestFailureContext(octokit: Octokit, pullNumber: number, headSha: string): Promise<string> {
  const { owner, repo } = github.context.repo;
  const parts: string[] = [];
  const checkRuns = await octokit.rest.checks.listForRef({ owner, repo, ref: headSha, per_page: 20 }).catch(() => undefined);
  for (const check of checkRuns?.data.check_runs ?? []) {
    if (check.conclusion && check.conclusion !== 'success' && check.conclusion !== 'neutral' && check.conclusion !== 'skipped') {
      parts.push(`Check ${check.name}: ${check.conclusion} ${check.html_url}`);
      const jobId = extractJobId(check.html_url ?? '');
      if (jobId) {
        const log = await downloadJobLogSnippet(octokit, owner, repo, jobId);
        if (log) parts.push(`Log snippet for ${check.name}:\n${log}`);
      }
    }
  }
  const comments = await octokit.paginate(octokit.rest.pulls.listReviewComments, { owner, repo, pull_number: pullNumber, per_page: 20 }).catch(() => [] as Array<{ path?: string; body?: string }>);
  for (const comment of comments.slice(-10)) {
    if (comment.body) parts.push(`Review comment on ${comment.path ?? 'unknown'}: ${comment.body.slice(0, 500)}`);
  }
  return parts.join('\n');
}

function extractJobId(url: string): number | undefined {
  const match = url.match(/\/actions\/runs\/\d+\/job\/(\d+)/);
  return match?.[1] ? Number(match[1]) : undefined;
}

async function downloadJobLogSnippet(octokit: Octokit, owner: string, repo: string, jobId: number): Promise<string | undefined> {
  try {
    const response = await octokit.request('GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs', {
      owner,
      repo,
      job_id: jobId,
    });
    const data = typeof response.data === 'string' ? response.data : Buffer.from(response.data as ArrayBuffer).toString('utf8');
    return data.split('\n').slice(-120).join('\n').slice(-6000);
  } catch (error) {
    core.debug(`Could not fetch logs for job ${jobId}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

export async function repairPullRequest(octokit: Octokit, pullNumber: number, inputs: ActionInputs, command?: string): Promise<PullRequestRepairResult> {
  const { owner, repo } = github.context.repo;
  const pull = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });
  const pr = pull.data;

  if (pr.head.repo?.full_name !== `${owner}/${repo}`) {
    core.warning(`Skipping PR repair for forked PR #${pullNumber}; GITHUB_TOKEN cannot safely push to fork branches.`);
    return { conclusion: 'skipped fork PR repair', prUrl: pr.html_url, repaired: false };
  }

  if (!command) {
    return { conclusion: 'skipped PR repair because no trusted command was provided', prUrl: pr.html_url, repaired: false };
  }

  if (!inputs.allowFix) {
    core.info('Skipping PR repair because allow-fix is false.');
    return { conclusion: 'skipped because allow-fix is false', prUrl: pr.html_url, repaired: false };
  }

  const labels = await getPullRequestLabels(octokit, pullNumber);
  const branch = pr.head.ref;
  if (!branch.startsWith('posthog-watcher/') && !labels.some((label) => label === 'posthog-watcher:autofix' || label === 'posthog-watcher:adopted')) {
    return { conclusion: 'skipped PR repair because branch is not a watcher branch and PR is not opted in', prUrl: pr.html_url, repaired: false };
  }

  const failureContext = await getPullRequestFailureContext(octokit, pullNumber, pr.head.sha);
  if ((command === 'fix-ci' || command === 'address-review') && !failureContext.trim()) {
    return { conclusion: `skipped ${command} because no failing check or review context was found`, prUrl: pr.html_url, repaired: false };
  }
  await git(['fetch', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  await git(['checkout', '-B', branch, `origin/${branch}`]);

  const prompt = `Repair pull request #${pullNumber}: ${pr.title}

This is PR repair/adoption. Edit the existing PR branch only. Follow karpathy-guidelines. Make the smallest changes needed to address likely CI/review issues. Do not merge, approve, or create a new PR.

Failure/review context:
\`\`\`
${failureContext || '(none provided; keep changes minimal and issue-specific)'}
\`\`\`

PR body:
\`\`\`
${pr.body ?? '(empty)'}
\`\`\``;

  await runPi({ inputs, tools: ['read', 'grep', 'find', 'ls', 'edit', 'write'], prompt, requireText: false });

  if (inputs.validationCommand) await runShell(inputs.validationCommand, process.cwd());

  const stats = parseNumstat(await git(['diff', '--numstat']));
  if (!stats.files.length) {
    return { conclusion: 'skipped PR repair because no files changed', prUrl: pr.html_url, repaired: false };
  }
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
