import type { IssueSnapshot } from './issue-context.js';

const SECURITY_TERMS = [
  'security',
  'vulnerability',
  'xss',
  'csrf',
  'rce',
  'token',
  'secret',
  'credential',
  'auth bypass',
  'authentication bypass',
  'authorization bypass',
  'sql injection',
];

export interface SecurityAssessment {
  sensitive: boolean;
  reasons: string[];
}

export function assessIssueSecurity(issue: IssueSnapshot): SecurityAssessment {
  const haystack = [issue.title, issue.body, ...issue.labels, ...issue.comments.map((comment) => comment.body)].join('\n').toLowerCase();
  const reasons = SECURITY_TERMS.filter((term) => haystack.includes(term));
  return { sensitive: reasons.length > 0, reasons };
}
