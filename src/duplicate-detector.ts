import type { IssueSnapshot } from './issue-context.js';
import type { RelatedItem } from './related.js';

export interface DuplicateAssessment {
  duplicate: boolean;
  score: number;
  canonical?: RelatedItem;
  reason: string;
  blockingPr?: RelatedItem;
}

export function assessDuplicate(issue: IssueSnapshot, relatedItems: RelatedItem[]): DuplicateAssessment {
  const blockingPr = relatedItems.find((item) => item.type === 'pull_request' && item.state === 'open' && (item.reason === 'closing-pr' || item.reason === 'title-search'));
  if (blockingPr) {
    return { duplicate: true, score: 1, canonical: blockingPr, blockingPr, reason: `open related PR #${blockingPr.number} already appears to cover this report` };
  }

  let best: { item: RelatedItem; score: number } | undefined;
  for (const item of relatedItems) {
    if (item.number >= issue.number || item.type !== 'issue') continue;
    const score = similarity(issueText(issue), `${item.title}\n${item.bodyExcerpt}`);
    if (!best || score > best.score) best = { item, score };
  }

  if (best && best.score >= 0.42) {
    return {
      duplicate: true,
      score: best.score,
      canonical: best.item,
      reason: `older related issue #${best.item.number} is similar enough (${Math.round(best.score * 100)}%) to be treated as canonical`,
    };
  }

  return { duplicate: false, score: best?.score ?? 0, canonical: best?.item, reason: best ? `best duplicate score was ${Math.round(best.score * 100)}%` : 'no related duplicate candidate found' };
}

function issueText(issue: IssueSnapshot): string {
  return `${issue.title}\n${issue.body}`;
}

function similarity(left: string, right: string): number {
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return intersection / union;
}

function tokens(value: string): Set<string> {
  const stopWords = new Set(['this', 'that', 'with', 'from', 'have', 'when', 'then', 'than', 'into', 'should', 'would', 'could', 'correctly', 'wrong', 'issue', 'problem', 'current', 'expected', 'output', 'endpoint', 'values', 'value']);
  return new Set(
    value
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[^a-z0-9\s/-]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 4 && !stopWords.has(token)),
  );
}
