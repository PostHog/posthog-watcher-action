import * as core from '@actions/core';
import * as github from '@actions/github';
import type { PullRequestFile } from './diff-lines.js';
import type { IssueSnapshot } from './issue-context.js';

export type Octokit = ReturnType<typeof github.getOctokit>;

export interface PullRequestSnapshot {
  number: number;
  title: string;
  body: string;
  url: string;
  headRepoFullName?: string;
  isSameRepo: boolean;
}

export interface ReviewComment {
  path: string;
  line: number;
  body: string;
}

interface TeamReviewer {
  display: string;
  org?: string;
  slug: string;
}

export interface RepositoryLabel {
  name: string;
  description?: string | null;
}

export function resolveIssueNumber(inputIssueNumber?: number): number {
  if (inputIssueNumber) return inputIssueNumber;
  const payload = github.context.payload as { issue?: { number?: number }; pull_request?: { number?: number } };
  const number = payload.issue?.number ?? payload.pull_request?.number;
  if (!number) {
    throw new Error('No issue number provided and current event payload does not contain an issue. Set issue-number.');
  }
  return number;
}

export async function getIssueSnapshot(octokit: Octokit, issueNumber: number, maxComments: number, forcedCommentId?: number): Promise<IssueSnapshot> {
  const { owner, repo } = github.context.repo;
  const issueResponse = await octokit.rest.issues.get({ owner, repo, issue_number: issueNumber });
  const issue = issueResponse.data;

  if (issue.pull_request) {
    throw new Error(`#${issueNumber} is a pull request. This MVP handles issues only.`);
  }

  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: Math.min(100, maxComments),
  });
  const recentComments = comments.slice(-maxComments);
  const forcedComment = await findForcedComment(octokit, owner, repo, forcedCommentId, recentComments, comments);
  const selectedComments = [...recentComments, ...(forcedComment ? [forcedComment] : [])];

  return {
    owner,
    repo,
    number: issueNumber,
    title: issue.title,
    body: issue.body ?? '',
    author: issue.user?.login ?? 'unknown',
    authorAssociation: issue.author_association ?? 'NONE',
    url: issue.html_url,
    labels: issue.labels.map((label: string | { name?: string | null }) => (typeof label === 'string' ? label : label.name ?? '')).filter(Boolean),
    comments: selectedComments.map((comment: { user?: { login?: string } | null; body?: string | null; html_url: string; created_at: string }) => ({
      author: comment.user?.login ?? 'unknown',
      body: comment.body ?? '',
      url: comment.html_url,
      createdAt: comment.created_at,
    })),
  };
}

type IssueComment = { id: number; user?: { login?: string } | null; body?: string | null; html_url: string; created_at: string };

async function findForcedComment(octokit: Octokit, owner: string, repo: string, forcedCommentId: number | undefined, selectedComments: Array<{ id?: number }>, allComments: IssueComment[]): Promise<IssueComment | undefined> {
  if (!forcedCommentId || selectedComments.some((comment) => comment.id === forcedCommentId)) return undefined;
  const existing = allComments.find((comment) => comment.id === forcedCommentId);
  if (existing) return existing;
  return getIssueComment(octokit, owner, repo, forcedCommentId).catch(() => undefined);
}

export async function getIssueComment(octokit: Octokit, owner: string, repo: string, commentId: number): Promise<IssueComment> {
  const response = await octokit.rest.issues.getComment({ owner, repo, comment_id: commentId });
  return response.data;
}

export async function listRepositoryLabels(octokit: Octokit): Promise<RepositoryLabel[]> {
  const { owner, repo } = github.context.repo;
  const labels = await octokit.paginate(octokit.rest.issues.listLabelsForRepo, { owner, repo, per_page: 100 });
  return labels.map((label: { name: string; description?: string | null }) => ({
    name: label.name,
    description: label.description ?? undefined,
  }));
}

export async function addLabels(octokit: Octokit, issueNumber: number, labels: string[]): Promise<void> {
  if (!labels.length) return;
  const { owner, repo } = github.context.repo;
  await octokit.rest.issues.addLabels({ owner, repo, issue_number: issueNumber, labels });
}

export async function removeLabel(octokit: Octokit, issueNumber: number, label: string): Promise<void> {
  const { owner, repo } = github.context.repo;
  await octokit.rest.issues.removeLabel({ owner, repo, issue_number: issueNumber, name: label }).catch(() => undefined);
}

export async function closeIssue(octokit: Octokit, issueNumber: number): Promise<void> {
  const { owner, repo } = github.context.repo;
  await octokit.rest.issues.update({ owner, repo, issue_number: issueNumber, state: 'closed' });
}

export async function searchOpenIssueNumbers(octokit: Octokit, query: string, maxItems: number): Promise<number[]> {
  const { owner, repo } = github.context.repo;
  const response = await octokit.rest.search.issuesAndPullRequests({
    q: `repo:${owner}/${repo} ${query}`,
    per_page: Math.min(100, maxItems),
    sort: 'updated',
    order: 'asc',
  });
  return response.data.items.filter((item) => !item.pull_request).slice(0, maxItems).map((item) => item.number);
}

export async function upsertIssueComment(octokit: Octokit, issueNumber: number, marker: string, body: string): Promise<string> {
  const { owner, repo } = github.context.repo;
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  const existing = comments.find((comment: { body?: string | null }) => comment.body?.includes(marker));

  if (existing) {
    const updated = await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
    return updated.data.html_url;
  }

  const created = await octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body });
  return created.data.html_url;
}

export async function findOpenPullRequestForBranch(octokit: Octokit, branch: string): Promise<{ number: number; url: string } | undefined> {
  const { owner, repo } = github.context.repo;
  const pulls = await octokit.rest.pulls.list({
    owner,
    repo,
    state: 'open',
    head: `${owner}:${branch}`,
    per_page: 10,
  });
  const pull = pulls.data[0];
  return pull ? { number: pull.number, url: pull.html_url } : undefined;
}

export async function createDraftPullRequest(octokit: Octokit, params: {
  title: string;
  head: string;
  base: string;
  body: string;
}): Promise<{ number: number; url: string }> {
  const { owner, repo } = github.context.repo;
  const created = await octokit.rest.pulls.create({
    owner,
    repo,
    title: params.title,
    head: params.head,
    base: params.base,
    body: params.body,
    draft: true,
  });
  return { number: created.data.number, url: created.data.html_url };
}

export async function getPullRequestSnapshot(octokit: Octokit, pullNumber: number): Promise<PullRequestSnapshot> {
  const { owner, repo } = github.context.repo;
  const response = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });
  const pr = response.data;
  const headRepoFullName = pr.head.repo?.full_name ?? undefined;
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? '',
    url: pr.html_url,
    headRepoFullName,
    isSameRepo: headRepoFullName === `${owner}/${repo}`,
  };
}

// Bound pagination: past this many files/comments a review is hopeless anyway,
// and unbounded paginate() burns API quota on exactly the largest PRs.
const MAX_PAGINATED_ITEMS = 500;

export async function listPullRequestFiles(octokit: Octokit, pullNumber: number): Promise<PullRequestFile[]> {
  const { owner, repo } = github.context.repo;
  const collected: PullRequestFile[] = [];
  for await (const response of octokit.paginate.iterator(octokit.rest.pulls.listFiles, { owner, repo, pull_number: pullNumber, per_page: 100 })) {
    for (const file of response.data as Array<{ filename: string; status?: string; patch?: string }>) {
      collected.push({ filename: file.filename, status: file.status, patch: file.patch });
    }
    if (collected.length >= MAX_PAGINATED_ITEMS) {
      core.warning(`PR #${pullNumber} changes more than ${MAX_PAGINATED_ITEMS} files; only the first ${MAX_PAGINATED_ITEMS} are considered.`);
      break;
    }
  }
  return collected;
}

export async function listReviewCommentBodies(octokit: Octokit, pullNumber: number): Promise<string[]> {
  const { owner, repo } = github.context.repo;
  const collected: string[] = [];
  try {
    for await (const response of octokit.paginate.iterator(octokit.rest.pulls.listReviewComments, { owner, repo, pull_number: pullNumber, per_page: 100 })) {
      for (const comment of response.data as Array<{ body?: string }>) {
        if (comment.body) collected.push(comment.body);
      }
      if (collected.length >= MAX_PAGINATED_ITEMS) break;
    }
  } catch (error) {
    core.warning(`Could not list review comments for PR #${pullNumber}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return collected;
}

export async function getReviewComment(octokit: Octokit, commentId: number): Promise<{ path: string; body: string; diffHunk: string; inReplyToId?: number } | undefined> {
  const { owner, repo } = github.context.repo;
  try {
    const response = await octokit.rest.pulls.getReviewComment({ owner, repo, comment_id: commentId });
    return {
      path: response.data.path,
      body: response.data.body ?? '',
      diffHunk: response.data.diff_hunk ?? '',
      inReplyToId: response.data.in_reply_to_id ?? undefined,
    };
  } catch (error) {
    core.warning(`Could not fetch review comment ${commentId}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

// Post a review with an optional summary body and inline comments. Returns the
// review URL. If GitHub rejects the inline comment positions, the caller is
// expected to fall back to a body-only review.
export async function createPullRequestReview(octokit: Octokit, pullNumber: number, params: { body: string; comments: ReviewComment[] }): Promise<string> {
  const { owner, repo } = github.context.repo;
  const created = await octokit.rest.pulls.createReview({
    owner,
    repo,
    pull_number: pullNumber,
    event: 'COMMENT',
    body: params.body,
    comments: params.comments.map((comment) => ({ path: comment.path, line: comment.line, side: 'RIGHT', body: comment.body })),
  });
  return created.data.html_url;
}

export async function replyToReviewComment(octokit: Octokit, pullNumber: number, commentId: number, body: string): Promise<string> {
  const { owner, repo } = github.context.repo;
  const created = await octokit.rest.pulls.createReplyForReviewComment({
    owner,
    repo,
    pull_number: pullNumber,
    comment_id: commentId,
    body,
  });
  return created.data.html_url;
}

export async function ensureTeamReviewRequested(octokit: Octokit, pullNumber: number, reviewTeam: string): Promise<void> {
  const team = parseTeamReviewer(reviewTeam);
  if (!team) return;

  const { owner, repo } = github.context.repo;
  if (team.org && owner.toLowerCase() !== team.org.toLowerCase()) {
    core.warning(`Skipping ${team.display} review request for ${owner}/${repo}#${pullNumber}; repository is not in the ${team.org} org.`);
    return;
  }

  const pull = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });
  const requestedTeams = (pull.data.requested_teams ?? []) as Array<{ slug?: string | null }>;
  if (requestedTeams.some((requested) => requested.slug?.toLowerCase() === team.slug.toLowerCase())) {
    core.info(`${team.display} is already requested on PR #${pullNumber}.`);
    return;
  }

  try {
    await octokit.rest.pulls.requestReviewers({
      owner,
      repo,
      pull_number: pullNumber,
      team_reviewers: [team.slug],
    });
    core.info(`Requested review from ${team.display} on PR #${pullNumber}.`);
  } catch (error) {
    core.warning(`Could not request review from ${team.display} on ${owner}/${repo}#${pullNumber}: ${error instanceof Error ? error.message : String(error)}. If this is a private org team, use a github-token that can resolve and request reviews from that team.`);
  }
}

function parseTeamReviewer(reviewTeam: string): TeamReviewer | undefined {
  const normalized = reviewTeam.trim().replace(/^@/, '');
  if (!normalized) return undefined;

  const parts = normalized.split('/');
  if (parts.length > 2 || parts.some((part) => !part.trim())) {
    throw new Error('fix-pr-review-team must be a team slug or org/team');
  }

  const org = parts.length === 2 ? parts[0] : undefined;
  const slug = parts.length === 2 ? parts[1] : parts[0];
  if (!slug) throw new Error('fix-pr-review-team must be a team slug or org/team');
  return {
    display: org ? `${org}/${slug}` : slug,
    org,
    slug,
  };
}

export function defaultBranch(): string {
  const payload = github.context.payload as { repository?: { default_branch?: string } };
  return payload.repository?.default_branch ?? 'main';
}
