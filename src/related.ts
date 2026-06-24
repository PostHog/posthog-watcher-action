import * as github from '@actions/github';
import type { Octokit } from './github.js';
import type { IssueSnapshot } from './issue-context.js';

export interface RelatedItem {
  number: number;
  type: 'issue' | 'pull_request';
  state: string;
  title: string;
  url: string;
  labels: string[];
  bodyExcerpt: string;
  createdAt: string;
  reason: 'explicit-reference' | 'title-search' | 'closing-pr';
}

export async function getRelatedContext(octokit: Octokit, issue: IssueSnapshot, maxItems: number): Promise<RelatedItem[]> {
  const related = new Map<number, RelatedItem>();
  const limit = Math.max(0, maxItems);
  if (limit === 0) return [];

  for (const number of extractSameRepoReferences(issue)) {
    if (number === issue.number || related.size >= limit) continue;
    const item = await fetchIssueLike(octokit, number, 'explicit-reference').catch(() => undefined);
    if (item) related.set(item.number, item);
  }

  if (related.size < limit) {
    const closingPrs = await searchClosingPullRequests(octokit, issue, limit - related.size).catch(() => []);
    for (const item of closingPrs) {
      if (item.number !== issue.number && !related.has(item.number) && related.size < limit) {
        related.set(item.number, item);
      }
    }
  }

  if (related.size < limit) {
    const searched = await searchByTitle(octokit, issue, limit - related.size).catch(() => []);
    for (const item of searched) {
      if (item.number !== issue.number && !related.has(item.number) && related.size < limit) {
        related.set(item.number, item);
      }
    }
  }

  return [...related.values()];
}

function extractSameRepoReferences(issue: IssueSnapshot): number[] {
  const values = new Set<number>();
  const text = [issue.title, issue.body, ...issue.comments.map((comment) => comment.body)].join('\n');
  const escapedOwner = escapeRegExp(issue.owner);
  const escapedRepo = escapeRegExp(issue.repo);

  for (const match of text.matchAll(/(^|\s)#(\d+)\b/g)) {
    values.add(Number(match[2]));
  }

  const urlPattern = new RegExp(`https://github\\.com/${escapedOwner}/${escapedRepo}/(?:issues|pull)/(\\d+)`, 'gi');
  for (const match of text.matchAll(urlPattern)) {
    values.add(Number(match[1]));
  }

  return [...values].filter(Number.isInteger);
}

async function fetchIssueLike(octokit: Octokit, number: number, reason: RelatedItem['reason']): Promise<RelatedItem> {
  const { owner, repo } = github.context.repo;
  const response = await octokit.rest.issues.get({ owner, repo, issue_number: number });
  const item = response.data;
  return {
    number,
    type: item.pull_request ? 'pull_request' : 'issue',
    state: item.state,
    title: item.title,
    url: item.html_url,
    labels: item.labels.map((label: string | { name?: string | null }) => (typeof label === 'string' ? label : label.name ?? '')).filter(Boolean),
    bodyExcerpt: excerpt(item.body ?? ''),
    createdAt: item.created_at,
    reason,
  };
}

async function searchClosingPullRequests(octokit: Octokit, issue: IssueSnapshot, limit: number): Promise<RelatedItem[]> {
  const { owner, repo } = github.context.repo;
  const response = await octokit.rest.search.issuesAndPullRequests({
    q: `repo:${owner}/${repo} is:pr ${issue.number} in:body`,
    per_page: Math.min(10, limit),
  });

  return response.data.items
    .filter((item) => new RegExp(`(fixes|closes|resolves)\\s+#${issue.number}\\b`, 'i').test(item.body ?? ''))
    .slice(0, limit)
    .map((item) => ({
      number: item.number,
      type: 'pull_request' as const,
      state: item.state,
      title: item.title,
      url: item.html_url,
      labels: item.labels.map((label: { name?: string | null }) => label.name ?? '').filter(Boolean),
      bodyExcerpt: excerpt(item.body ?? ''),
      createdAt: item.created_at,
      reason: 'closing-pr' as const,
    }));
}

async function searchByTitle(octokit: Octokit, issue: IssueSnapshot, limit: number): Promise<RelatedItem[]> {
  const { owner, repo } = github.context.repo;
  const terms = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((term) => term.length >= 4)
    .slice(0, 5);

  if (!terms.length) return [];

  const response = await octokit.rest.search.issuesAndPullRequests({
    q: `repo:${owner}/${repo} is:open ${terms.join(' ')}`,
    per_page: Math.min(10, limit),
  });

  return response.data.items
    .filter((item) => titleSimilarity(issue.title, item.title) >= 0.2)
    .slice(0, limit)
    .map((item) => ({
      number: item.number,
      type: item.pull_request ? 'pull_request' : 'issue',
      state: item.state,
      title: item.title,
      url: item.html_url,
      labels: item.labels.map((label: { name?: string | null }) => label.name ?? '').filter(Boolean),
      bodyExcerpt: excerpt(item.body ?? ''),
      createdAt: item.created_at,
      reason: 'title-search' as const,
    }));
}

function titleSimilarity(left: string, right: string): number {
  const leftTokens = titleTokens(left);
  const rightTokens = titleTokens(right);
  if (!leftTokens.size || !rightTokens.size) return 0;

  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return intersection / union;
}

function titleTokens(title: string): Set<string> {
  const stopWords = new Set(['the', 'and', 'for', 'with', 'not', 'api', 'endpoint', 'values', 'value', 'correctly', 'wrong']);
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 4 && !stopWords.has(token)),
  );
}

function excerpt(value: string): string {
  return value.length > 1000 ? `${value.slice(0, 1000)}…` : value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
