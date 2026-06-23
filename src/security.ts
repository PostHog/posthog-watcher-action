import type { IssueSnapshot } from './issue-context.js';

const SECURITY_PATTERNS: Array<{ reason: string; pattern: RegExp }> = [
  term('security'),
  term('vulnerability'),
  term('xss'),
  term('csrf'),
  term('rce'),
  term('token'),
  term('secret'),
  term('credential'),
  phrase('auth bypass'),
  phrase('authentication bypass'),
  phrase('authorization bypass'),
  phrase('sql injection'),
];

export interface SecurityAssessment {
  sensitive: boolean;
  reasons: string[];
}

export function assessIssueSecurity(issue: IssueSnapshot): SecurityAssessment {
  const haystack = [issue.title, issue.body, ...issue.labels, ...issue.comments.map((comment) => comment.body)].join('\n').toLowerCase();
  const reasons = SECURITY_PATTERNS.filter(({ pattern }) => pattern.test(haystack)).map(({ reason }) => reason);
  return { sensitive: reasons.length > 0, reasons };
}

function term(value: string): { reason: string; pattern: RegExp } {
  return { reason: value, pattern: new RegExp(`\\b${escapeRegExp(value)}\\b`, 'i') };
}

function phrase(value: string): { reason: string; pattern: RegExp } {
  return { reason: value, pattern: new RegExp(`\\b${value.split(/\s+/).map(escapeRegExp).join('\\s+')}\\b`, 'i') };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
