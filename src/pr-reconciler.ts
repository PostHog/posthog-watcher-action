import * as core from '@actions/core';
import * as github from '@actions/github';
import { closePullRequest, deleteBranch, findOpenPullRequestForBranch, isOwnWatcherPullRequestHead, listOpenPullRequests, upsertIssueComment, type Octokit, type OpenPullRequest } from './github.js';
import type { ActionInputs } from './inputs.js';
import { writeStateRecord } from './state.js';

export interface ReconcileResult {
  conclusion: string;
  prUrl?: string;
  closed: boolean;
}

const WATCHER_ISSUE_BRANCH = /^posthog-watcher\/issue-(\d+)$/;

export async function reconcileClosedIssuePullRequest(octokit: Octokit, issueNumber: number, inputs: ActionInputs): Promise<ReconcileResult> {
  if (!inputs.allowCloseOwnPrs) {
    core.info(`Skipping watcher PR reconcile for issue #${issueNumber} because allow-close-own-prs is false.`);
    return { conclusion: 'skipped because allow-close-own-prs is false', closed: false };
  }

  const pull = await findOpenPullRequestForBranch(octokit, `posthog-watcher/issue-${issueNumber}`);
  if (!pull) {
    core.info(`No open watcher PR found for issue #${issueNumber}; nothing to reconcile.`);
    return { conclusion: 'no open watcher PR', closed: false };
  }
  return reconcilePullRequest(octokit, pull, issueNumber, inputs);
}

export async function reconcileWatcherPullRequests(octokit: Octokit, inputs: ActionInputs): Promise<ReconcileResult[]> {
  if (!inputs.allowCloseOwnPrs) {
    core.info('Skipping watcher PR reconcile pass because allow-close-own-prs is false.');
    return [];
  }

  const results: ReconcileResult[] = [];
  for (const pull of await listOpenPullRequests(octokit)) {
    const issueNumber = issueNumberFromBranch(pull.head.ref);
    if (issueNumber === undefined) continue;
    try {
      results.push(await reconcilePullRequest(octokit, pull, issueNumber, inputs));
    } catch (error) {
      core.warning(`Could not reconcile watcher PR #${pull.number}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  core.info(`Watcher PR reconcile pass checked ${results.length} PR(s) and closed ${results.filter((result) => result.closed).length}.`);
  return results;
}

export function issueNumberFromBranch(branch: string): number | undefined {
  const match = branch.match(WATCHER_ISSUE_BRANCH);
  return match?.[1] ? Number(match[1]) : undefined;
}

async function reconcilePullRequest(octokit: Octokit, pull: OpenPullRequest, issueNumber: number, inputs: ActionInputs): Promise<ReconcileResult> {
  if (!isOwnWatcherPullRequestHead(pull.head)) {
    core.info(`Skipping PR #${pull.number} because head ${pull.head.repoFullName ?? 'unknown'}:${pull.head.ref} was not created by posthog-watcher-action.`);
    return { conclusion: 'skipped PR not created by posthog-watcher-action', prUrl: pull.url, closed: false };
  }

  const closure = await getIssueClosure(octokit, issueNumber);
  if (!closure) {
    core.info(`Leaving PR #${pull.number} open because issue #${issueNumber} is still open.`);
    return { conclusion: 'skipped because the linked issue is still open', prUrl: pull.url, closed: false };
  }

  const closedVia = await findClosingPullRequestNumber(octokit, issueNumber);
  const closedReason = `#${issueNumber} was closed on ${closure.closedOn}${closedVia ? ` via #${closedVia}` : ''}`;

  if (!pull.draft) {
    return leaveOpen(octokit, pull, inputs, `${closedReason}, but this PR was left open because it is no longer a draft. Close it manually if it is no longer needed.`, 'skipped PR that is no longer a draft');
  }

  const otherAuthors = await commitAuthorsOtherThan(octokit, pull);
  if (otherAuthors.length) {
    return leaveOpen(octokit, pull, inputs, `${closedReason}, but this PR was left open because it has commits from ${otherAuthors.join(', ')}. Close it manually if it is no longer needed.`, 'skipped PR with commits from other authors');
  }

  const body = `Closing: ${closedReason}, so this draft is no longer needed. Reopen if the issue is reopened.`;
  if (inputs.dryRun) {
    core.info(`[dry-run] Would comment on PR #${pull.number}, close it, and delete branch ${pull.head.ref}: ${body}`);
    return { conclusion: 'dry-run would close stale watcher PR', prUrl: pull.url, closed: false };
  }

  await upsertIssueComment(octokit, pull.number, inputs.commentMarker, `${inputs.commentMarker}\n${body}`);
  await closePullRequest(octokit, pull.number);
  await deleteBranch(octokit, pull.head.ref);
  core.info(`Closed stale watcher PR #${pull.number} and deleted branch ${pull.head.ref}.`);

  const { owner, repo } = github.context.repo;
  await writeStateRecord(octokit, inputs, {
    kind: 'pr',
    owner,
    repo,
    numberOrSha: String(pull.number),
    title: pull.title,
    conclusion: 'closed stale draft PR after linked issue closed',
    labels: [],
    url: pull.url,
    closed: true,
    data: { issueNumber, closedOn: closure.closedOn, closedVia, branch: pull.head.ref, runId: github.context.runId },
  });
  return { conclusion: 'closed stale watcher PR', prUrl: pull.url, closed: true };
}

async function leaveOpen(octokit: Octokit, pull: OpenPullRequest, inputs: ActionInputs, body: string, conclusion: string): Promise<ReconcileResult> {
  if (inputs.dryRun) {
    core.info(`[dry-run] Would leave PR #${pull.number} open and comment: ${body}`);
  } else {
    await upsertIssueComment(octokit, pull.number, inputs.commentMarker, `${inputs.commentMarker}\n${body}`);
  }
  core.info(`Leaving PR #${pull.number} open: ${conclusion}.`);
  return { conclusion, prUrl: pull.url, closed: false };
}

async function getIssueClosure(octokit: Octokit, issueNumber: number): Promise<{ closedOn: string } | undefined> {
  const { owner, repo } = github.context.repo;
  const issue = await octokit.rest.issues.get({ owner, repo, issue_number: issueNumber });
  if (issue.data.pull_request || issue.data.state !== 'closed') return undefined;
  return { closedOn: (issue.data.closed_at ?? new Date().toISOString()).slice(0, 10) };
}

async function findClosingPullRequestNumber(octokit: Octokit, issueNumber: number): Promise<number | undefined> {
  const { owner, repo } = github.context.repo;
  try {
    const events = (await octokit.paginate(octokit.rest.issues.listEventsForTimeline, { owner, repo, issue_number: issueNumber, per_page: 100 })) as Array<{ event?: string; commit_id?: string | null }>;
    const commitSha = [...events].reverse().find((event) => event.event === 'closed')?.commit_id;
    if (!commitSha) return undefined;
    const pulls = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({ owner, repo, commit_sha: commitSha });
    return pulls.data.find((pull) => pull.merged_at)?.number;
  } catch (error) {
    core.warning(`Could not resolve the PR that closed issue #${issueNumber}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function commitAuthorsOtherThan(octokit: Octokit, pull: OpenPullRequest): Promise<string[]> {
  const { owner, repo } = github.context.repo;
  const commits = (await octokit.paginate(octokit.rest.pulls.listCommits, { owner, repo, pull_number: pull.number, per_page: 100 })) as Array<{ author?: { login?: string } | null; commit: { author?: { name?: string } | null } }>;
  const authors = commits.map((commit) => commit.author?.login ?? commit.commit.author?.name ?? 'unknown');
  return [...new Set(authors.filter((author) => !pull.author || author !== pull.author))];
}
