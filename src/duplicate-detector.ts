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
  const closingPr = relatedItems.find((item) => item.type === 'pull_request' && item.state === 'open' && item.reason === 'closing-pr');
  if (closingPr) {
    return { duplicate: true, score: 1, canonical: closingPr, blockingPr: closingPr, reason: `open related PR #${closingPr.number} already appears to cover this report` };
  }

  const titleSearchPr = relatedItems
    .filter((item) => item.type === 'pull_request' && item.state === 'open' && item.reason === 'title-search')
    .map((item) => ({ item, score: Math.max(similarity(issueText(issue), `${item.title}\n${item.bodyExcerpt}`), signalSimilarity(issueText(issue), `${item.title}\n${item.bodyExcerpt}`)) }))
    .find((candidate) => candidate.score >= 0.42);
  if (titleSearchPr) {
    return { duplicate: true, score: titleSearchPr.score, canonical: titleSearchPr.item, blockingPr: titleSearchPr.item, reason: `open related PR #${titleSearchPr.item.number} is similar enough (${Math.round(titleSearchPr.score * 100)}%) to cover this report` };
  }

  let best: { item: RelatedItem; score: number } | undefined;
  for (const item of relatedItems) {
    if (item.number >= issue.number || item.type !== 'issue') continue;
    const score = Math.max(similarity(issueText(issue), `${item.title}\n${item.bodyExcerpt}`), signalSimilarity(issueText(issue), `${item.title}\n${item.bodyExcerpt}`));
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

function signalSimilarity(left: string, right: string): number {
  const leftSignals = signals(left);
  const rightSignals = signals(right);
  if (!leftSignals.size || !rightSignals.size) return 0;
  const intersection = [...leftSignals].filter((signal) => rightSignals.has(signal)).length;
  const union = new Set([...leftSignals, ...rightSignals]).size;
  return intersection / union;
}

function signals(value: string): Set<string> {
  const matches = [
    ...value.matchAll(/\b(?:GET|POST|PUT|PATCH|DELETE)\s+([^\s'"`]+)/gi),
    ...value.matchAll(/curl\s+['"]?([^'"\s`]+)/gi),
    ...value.matchAll(/https?:\/\/[^\s'"`]+/gi),
    ...value.matchAll(/\/[a-z0-9_/-]+\?[a-z0-9_=&.-]+/gi),
    ...value.matchAll(/\{\s*"[^"]+"\s*:\s*[^}]+\}/gi),
    ...value.matchAll(/(?:expected|expects?|should|actual|current)[^\n]{0,120}/gi),
    ...value.matchAll(/(?:test|spec)(?: named)? [`'"]([^`'"]+)[`'"]/gi),
  ];
  return new Set(
    matches
      .map((match) => (match[1] ?? match[0]).toLowerCase().replace(/\s+/g, ' ').trim())
      .filter((match) => match.length >= 4),
  );
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
