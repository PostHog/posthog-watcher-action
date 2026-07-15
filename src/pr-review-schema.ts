// Parse and normalize the JSON review pi returns for a pull request. Shares
// the defensive JSON extraction and enum coercion with triage-schema.ts;
// unlike triage, an unparseable review degrades to a summary-only comment
// instead of failing the run.

import { enumValue, extractJson } from './triage-schema.js';

export type ReviewVerdict = 'clean' | 'comment' | 'changes_requested';
export type ReviewSeverity = 'info' | 'warning' | 'blocker';

export interface ReviewFinding {
  path: string;
  line: number;
  severity: ReviewSeverity;
  title: string;
  comment: string;
  suggestion?: string;
}

export interface PrReviewResult {
  verdict: ReviewVerdict;
  summary: string;
  findings: ReviewFinding[];
}

const VERDICTS = ['clean', 'comment', 'changes_requested'] as const;
const SEVERITIES = ['info', 'warning', 'blocker'] as const;

export function parsePrReview(text: string, maxFindings: number): PrReviewResult {
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(extractJson(text)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('review JSON is not an object');
    raw = parsed as Record<string, unknown>;
  } catch {
    return { verdict: 'comment', summary: fallbackSummary(text), findings: [] };
  }

  const findings = Array.isArray(raw.findings)
    ? raw.findings.map(normalizeFinding).filter((finding): finding is ReviewFinding => finding !== undefined).slice(0, maxFindings)
    : [];

  return {
    verdict: enumValue(raw.verdict, VERDICTS, 'comment'),
    summary: typeof raw.summary === 'string' ? raw.summary.trim() : '',
    findings,
  };
}

function normalizeFinding(value: unknown): ReviewFinding | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const entry = value as Record<string, unknown>;
  const path = typeof entry.path === 'string' ? entry.path.trim() : '';
  const line = coerceLine(entry.line);
  const comment = typeof entry.comment === 'string' ? entry.comment.trim() : '';
  if (!path || line === undefined || !comment) return undefined;

  const suggestion = typeof entry.suggestion === 'string' && entry.suggestion.trim() ? entry.suggestion.trim() : undefined;
  return {
    path,
    line,
    severity: enumValue(entry.severity, SEVERITIES, 'info'),
    title: typeof entry.title === 'string' ? entry.title.trim() : '',
    comment,
    suggestion,
  };
}

function coerceLine(value: unknown): number | undefined {
  const line = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : NaN;
  return Number.isInteger(line) && line > 0 ? line : undefined;
}

function fallbackSummary(text: string): string {
  const trimmed = text.trim();
  return trimmed ? trimmed.slice(0, 4000) : 'pi did not return a parseable review.';
}
