import * as core from '@actions/core';
import type { DuplicateAssessment } from './duplicate-detector.js';
import type { Octokit } from './github.js';
import type { IssueSnapshot } from './issue-context.js';
import type { RelatedItem } from './related.js';
import type { TriageResult } from './triage-schema.js';

export async function findPreExistingFixBlocker(octokit: Octokit, issue: IssueSnapshot, relatedItems: RelatedItem[], triage: TriageResult, duplicate: DuplicateAssessment): Promise<string | undefined> {
  if (duplicate.duplicate && duplicate.canonical) {
    return `${duplicate.reason}: #${duplicate.canonical.number} ${duplicate.canonical.url}`;
  }

  const relatedPullRequest = relatedItems.find(
    (item) => item.type === 'pull_request' && item.state === 'open' && (item.reason === 'closing-pr' || (item.reason === 'title-search' && titleSimilarity(issue.title, item.title) >= 0.3)),
  );
  if (relatedPullRequest) {
    return `An open related PR already appears to address this issue: #${relatedPullRequest.number} ${relatedPullRequest.url}`;
  }

  const olderDuplicateIssue = relatedItems.find(
    (item) => item.type === 'issue' && item.state === 'open' && item.number < issue.number && item.reason === 'title-search' && titleSimilarity(issue.title, item.title) >= 0.3,
  );
  if (olderDuplicateIssue) {
    return `An older related issue appears to cover the same report: #${olderDuplicateIssue.number} ${olderDuplicateIssue.url}`;
  }

  if (
    triage.closeProposal.propose &&
    (triage.closeProposal.category === 'duplicate' || triage.closeProposal.category === 'already-fixed') &&
    triage.closeProposal.canonicalUrl
  ) {
    const canonicalPullRequest = await getCanonicalPullRequest(octokit, triage.closeProposal.canonicalUrl);
    if (canonicalPullRequest?.state === 'closed' && !canonicalPullRequest.merged) {
      core.info(`Triage proposed closed unmerged PR ${triage.closeProposal.canonicalUrl} as canonical; continuing fix attempt because it did not land.`);
      return undefined;
    }
    return `Triage proposed this issue as ${triage.closeProposal.category} of ${triage.closeProposal.canonicalUrl}; skipping a duplicate fix PR.`;
  }

  return undefined;
}

async function getCanonicalPullRequest(octokit: Octokit, url: string): Promise<{ state: 'open' | 'closed'; merged: boolean } | undefined> {
  const parsed = parseGitHubPullRequestUrl(url);
  if (!parsed) return undefined;

  try {
    const response = await octokit.rest.pulls.get({ owner: parsed.owner, repo: parsed.repo, pull_number: parsed.number });
    return { state: response.data.state as 'open' | 'closed', merged: Boolean(response.data.merged_at) };
  } catch (error) {
    core.warning(`Could not verify canonical PR ${url}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function parseGitHubPullRequestUrl(url: string): { owner: string; repo: string; number: number } | undefined {
  const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
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
