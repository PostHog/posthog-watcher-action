import type { DuplicateAssessment } from './duplicate-detector.js';
import type { IssueSnapshot } from './issue-context.js';
import type { RelatedItem } from './related.js';
import type { TriageResult } from './triage-schema.js';

export function findPreExistingFixBlocker(issue: IssueSnapshot, relatedItems: RelatedItem[], triage: TriageResult, duplicate: DuplicateAssessment): string | undefined {
  if (duplicate.duplicate && duplicate.canonical) {
    return `${duplicate.reason}: #${duplicate.canonical.number} ${duplicate.canonical.url}`;
  }

  const relatedPullRequest = relatedItems.find(
    (item) => item.type === 'pull_request' && item.state === 'open' && (item.reason === 'closing-pr' || item.reason === 'title-search'),
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
    return `Triage proposed this issue as ${triage.closeProposal.category} of ${triage.closeProposal.canonicalUrl}; skipping a duplicate fix PR.`;
  }

  return undefined;
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
