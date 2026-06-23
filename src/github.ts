import * as github from '@actions/github';
import type { IssueSnapshot } from './issue-context.js';

export type Octokit = ReturnType<typeof github.getOctokit>;

export function resolveIssueNumber(inputIssueNumber?: number): number {
  if (inputIssueNumber) return inputIssueNumber;
  const payload = github.context.payload as { issue?: { number?: number }; pull_request?: { number?: number } };
  const number = payload.issue?.number ?? payload.pull_request?.number;
  if (!number) {
    throw new Error('No issue number provided and current event payload does not contain an issue. Set issue-number.');
  }
  return number;
}

export async function getIssueSnapshot(octokit: Octokit, issueNumber: number, maxComments: number): Promise<IssueSnapshot> {
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

  return {
    owner,
    repo,
    number: issueNumber,
    title: issue.title,
    body: issue.body ?? '',
    author: issue.user?.login ?? 'unknown',
    url: issue.html_url,
    labels: issue.labels.map((label: string | { name?: string | null }) => (typeof label === 'string' ? label : label.name ?? '')).filter(Boolean),
    comments: comments.slice(-maxComments).map((comment: { user?: { login?: string } | null; body?: string | null; html_url: string; created_at: string }) => ({
      author: comment.user?.login ?? 'unknown',
      body: comment.body ?? '',
      url: comment.html_url,
      createdAt: comment.created_at,
    })),
  };
}

export async function listRepositoryLabels(octokit: Octokit): Promise<string[]> {
  const { owner, repo } = github.context.repo;
  const labels = await octokit.paginate(octokit.rest.issues.listLabelsForRepo, { owner, repo, per_page: 100 });
  return labels.map((label: { name: string }) => label.name);
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
}): Promise<string> {
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
  return created.data.html_url;
}

export function defaultBranch(): string {
  const payload = github.context.payload as { repository?: { default_branch?: string } };
  return payload.repository?.default_branch ?? 'main';
}
