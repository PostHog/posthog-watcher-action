import type { TriageResult } from './triage-schema.js';

export interface IssueSnapshot {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  url: string;
  labels: string[];
  comments: Array<{
    author: string;
    body: string;
    url: string;
    createdAt: string;
  }>;
}

export function formatIssuePrompt(issue: IssueSnapshot, allowedLabels: string[], mode: string): string {
  return `You are triaging a GitHub issue for ${issue.owner}/${issue.repo}.

Use the karpathy-guidelines skill when reasoning about code changes: be explicit about assumptions, keep changes simple, and avoid speculative fixes.

Mode: ${mode}
Allowed labels: ${allowedLabels.join(', ') || '(none)'}

Repository files are available in the current working directory. Inspect only what is necessary.

Issue #${issue.number}: ${issue.title}
Author: ${issue.author}
Existing labels: ${issue.labels.join(', ') || '(none)'}
URL: ${issue.url}

Body:
${fence(issue.body || '(empty)')}

Recent comments:
${issue.comments.length ? issue.comments.map((comment, index) => `Comment ${index + 1} by ${comment.author} at ${comment.createdAt} (${comment.url}):\n${fence(comment.body)}`).join('\n\n') : '(none)'}

Return ONLY valid JSON matching this exact shape:
{
  "conclusion": "short human-readable verdict",
  "summary": "short issue summary",
  "issueType": "bug | feature | docs | question | unknown",
  "confidence": 0.0,
  "labels": ["labels from the allowed list only"],
  "needsMoreInfo": false,
  "maintainerComment": "markdown comment for maintainers/reporters",
  "investigation": {
    "relevantFiles": ["paths you inspected or believe are relevant"],
    "findings": ["specific evidence-backed findings"]
  },
  "fix": {
    "straightforward": false,
    "reason": "why a small PR is or is not appropriate",
    "suggestedApproach": "minimal implementation approach if straightforward, otherwise empty",
    "risk": "low | medium | high"
  }
}

Rules:
- Do not invent labels outside the allowed list.
- Prefer needs-info when the report lacks reproduction details.
- Use fix.risk and confidence to describe whether a fix is safe; the action derives fix.straightforward from allow-fix, confidence, needsMoreInfo, and risk.
- If uncertain, lower confidence and explain what information is missing.
`;
}

export function formatFixPrompt(issue: IssueSnapshot, triage: TriageResult): string {
  return `Fix GitHub issue #${issue.number} for ${issue.owner}/${issue.repo}.

First load and follow the karpathy-guidelines skill. Make the smallest surgical code change that addresses the issue. Do not do drive-by refactors.

Issue title: ${issue.title}
Issue body:
${fence(issue.body || '(empty)')}

Triage summary:
${JSON.stringify(triage, null, 2)}

Requirements:
- Make only a straightforward, low-risk fix.
- Add or update tests if the repository has a clear nearby test pattern.
- Use existing style and commands.
- Do not change workflow files, generated files, lockfiles, or unrelated code.
- If the fix is not actually straightforward after inspection, stop without editing and explain why.
- When done, summarize changed files and validation commands run.
`;
}

function fence(value: string): string {
  return `\`\`\`\n${truncate(value, 12000)}\n\`\`\``;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n...<truncated>` : value;
}
