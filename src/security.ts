import type { IssueSnapshot } from './issue-context.js';

const SECURITY_REPORT_PATTERNS: Array<{ reason: string; pattern: RegExp }> = [
  term('security'),
  term('vulnerability'),
  term('xss'),
  term('csrf'),
  term('rce'),
  phrase('auth bypass'),
  phrase('authentication bypass'),
  phrase('authorization bypass'),
  phrase('sql injection'),
];

const KNOWN_SECRET_PATTERNS: Array<{ reason: string; pattern: RegExp }> = [
  { reason: 'token', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/i },
  { reason: 'token', pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/i },
  { reason: 'token', pattern: /\bghs_[A-Za-z0-9_]{20,}\b/i },
  { reason: 'token', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/i },
  { reason: 'private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/i },
];

const CREDENTIAL_VALUE_PATTERNS: Array<{ reason: string; pattern: RegExp }> = [
  { reason: 'token', pattern: /\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token)\b\s*(?:[:=]|=>)\s*["'`]?([^\s"'`,;\])}]+)/i },
  { reason: 'token', pattern: /\bauthorization\s*:\s*bearer\s+([^\s"'`,;\])}]+)/i },
  { reason: 'credential', pattern: /\b(?:api[_ -]?key|client[_ -]?secret|secret|credential|password)\b\s*(?:[:=]|=>)\s*["'`]?([^\s"'`,;\])}]+)/i },
];

export interface SecurityAssessment {
  sensitive: boolean;
  reasons: string[];
}

export function assessIssueSecurity(issue: IssueSnapshot, commentMarker: string): SecurityAssessment {
  const labelHaystack = issue.labels.join('\n');
  const textHaystack = [issue.title, issue.body, ...issue.comments.filter((comment) => !isWatcherGeneratedComment(comment, commentMarker)).map((comment) => comment.body)].join('\n');
  const reasons = new Set<string>();

  for (const { reason, pattern } of SECURITY_REPORT_PATTERNS) {
    if (pattern.test(labelHaystack) || pattern.test(textHaystack)) reasons.add(reason);
  }

  for (const reason of credentialEvidenceReasons([labelHaystack, textHaystack].join('\n'))) {
    reasons.add(reason);
  }

  return { sensitive: reasons.size > 0, reasons: [...reasons] };
}

// Pull requests get a narrower gate than issues: the title/body are report
// text and use the full term+credential assessment, but the diff is code —
// where words like "security" are routine — so only credential evidence
// (real-looking tokens, keys, secrets) makes a diff sensitive.
export function assessPullRequestSecurity(params: { title: string; body: string; diff: string }): SecurityAssessment {
  const reasons = new Set<string>();
  const reportHaystack = [params.title, params.body].join('\n');

  for (const { reason, pattern } of SECURITY_REPORT_PATTERNS) {
    if (pattern.test(reportHaystack)) reasons.add(reason);
  }

  for (const reason of credentialEvidenceReasons([reportHaystack, params.diff].join('\n'))) {
    reasons.add(reason);
  }

  return { sensitive: reasons.size > 0, reasons: [...reasons] };
}

function credentialEvidenceReasons(value: string): string[] {
  const reasons = new Set<string>();

  for (const { reason, pattern } of KNOWN_SECRET_PATTERNS) {
    if (pattern.test(value)) reasons.add(reason);
  }

  for (const line of value.split(/\r?\n/)) {
    for (const { reason, pattern } of CREDENTIAL_VALUE_PATTERNS) {
      const match = pattern.exec(line);
      if (match?.[1] && looksLikeCredentialValue(match[1])) reasons.add(reason);
    }
  }

  return [...reasons];
}

function looksLikeCredentialValue(value: string): boolean {
  const normalized = value
    .trim()
    .replace(/^["'`<({\[]+/, '')
    .replace(/["'`>)}\],.;]+$/, '');
  if (normalized.length < 16) return false;
  if (/\s/.test(normalized)) return false;
  if (/[<>{}$]/.test(normalized)) return false;
  if (/^(?:token|secret|credential|password|api[_-]?key|bearer|redacted|placeholder|example|dummy|sample|test|your[-_]?token|x+|\.+)$/i.test(normalized)) return false;
  if (/(?:^|[-_])(your|example|sample|dummy|placeholder|redacted|here)(?:$|[-_])/i.test(normalized)) return false;
  if (/^[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL)[A-Z0-9_]*$/.test(normalized)) return false;

  const characterClasses = [/[a-z]/, /[A-Z]/, /\d/, /[._~+/=-]/].filter((pattern) => pattern.test(normalized)).length;
  return characterClasses >= 2;
}

function isWatcherGeneratedComment(comment: IssueSnapshot['comments'][number], commentMarker: string): boolean {
  return comment.author.endsWith('[bot]') && comment.body.includes(commentMarker);
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
