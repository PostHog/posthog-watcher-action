import * as core from '@actions/core';
import * as github from '@actions/github';
import { createHash } from 'node:crypto';
import { isReviewableCodeFile } from './code-files.js';
import { reviewableLinesByFile, type PullRequestFile } from './diff-lines.js';
import {
  createPullRequestReview,
  getPullRequestSnapshot,
  getReviewComment,
  listPullRequestFiles,
  listReviewCommentBodies,
  replyToReviewComment,
  upsertIssueComment,
  type Octokit,
  type PullRequestSnapshot,
  type ReviewComment,
} from './github.js';
import type { ActionInputs } from './inputs.js';
import { getPiCallCount } from './pi-budget.js';
import { beginPiSessionScope, formatPiSessionMarkdown, publishPiSessionFiles } from './pi-sessions.js';
import { runPi } from './pi-runner.js';
import { parsePrReview, type PrReviewResult, type ReviewFinding, type ReviewSeverity } from './pr-review-schema.js';
import { redactSecrets } from './redact.js';
import { assessPullRequestSecurity } from './security.js';
import { writeStateRecord } from './state.js';

const MAX_DIFF_CHARS = 60000;
const SEVERITY_EMOJI: Record<ReviewSeverity, string> = { info: 'ℹ️', warning: '⚠️', blocker: '🚫' };

export interface PullRequestReviewResult {
  conclusion: string;
  verdict?: string;
  commentUrl: string;
  skipped: boolean;
}

export interface ReviewThreadRef {
  commentId: number;
  rootId: number;
}

// Derive the summary-comment marker from the configurable comment-marker input
// so multiple watcher instances on one repository keep separate review
// comments. Hashing keeps the base marker and the derived marker from ever
// being substrings of each other, which upsertIssueComment's includes()
// matching would otherwise conflate.
function prReviewMarker(commentMarker: string): string {
  return `<!-- posthog-watcher-pr-review:${createHash('sha1').update(commentMarker).digest('hex').slice(0, 8)} -->`;
}

export async function reviewPullRequest(octokit: Octokit, pullNumber: number, inputs: ActionInputs): Promise<PullRequestReviewResult> {
  if (!inputs.allowPrReview) {
    core.info('Skipping PR review because allow-pr-review is false.');
    return { conclusion: 'skipped because allow-pr-review is false', commentUrl: '', skipped: true };
  }

  const pr = await getPullRequestSnapshot(octokit, pullNumber);
  if (!pr.isSameRepo) {
    core.info(`Skipping PR review for fork PR #${pullNumber} (${pr.headRepoFullName ?? 'unknown fork'}); only same-repo pull requests are reviewed.`);
    return { conclusion: 'skipped fork PR review', commentUrl: '', skipped: true };
  }

  const piSessionStartIndex = beginPiSessionScope();
  const allFiles = await listPullRequestFiles(octokit, pullNumber);
  const codeFiles = allFiles.filter((file) => isReviewableCodeFile(file.filename) && file.status !== 'removed');
  if (!codeFiles.length) {
    core.info(`Skipping PR review for #${pullNumber}: no reviewable code files changed.`);
    return { conclusion: 'skipped PR with no reviewable code files', commentUrl: '', skipped: true };
  }

  const reviewFiles = codeFiles.slice(0, inputs.maxReviewFiles);
  if (codeFiles.length > reviewFiles.length) {
    core.warning(`PR #${pullNumber} changes ${codeFiles.length} code files; reviewing the first ${reviewFiles.length} (max-review-files). The rest are not reviewed.`);
  }

  const diff = buildDiffBlock(reviewFiles);
  const security = assessPullRequestSecurity({ title: pr.title, body: pr.body, diff });
  if (security.sensitive && !inputs.allowSecurityAi) {
    core.warning(`Skipping PR review for #${pullNumber}: security-sensitive content detected (${security.reasons.join(', ')}). Set allow-security-ai: true to review anyway.`);
    return { conclusion: 'security-sensitive; human review required', commentUrl: '', skipped: true };
  }

  const lineMap = reviewableLinesByFile(reviewFiles);
  const output = await runPi({
    inputs,
    tools: ['read', 'grep', 'find', 'ls'],
    requireText: false,
    prompt: buildReviewPrompt(pr, reviewFiles, diff),
  });

  const review = parsePrReview(output, inputs.maxReviewFindings);
  const valid = review.findings.filter((finding) => lineMap.get(finding.path)?.has(finding.line));
  const dropped = review.findings.length - valid.length;
  if (dropped) core.warning(`Dropped ${dropped} review finding(s) that did not target a changed line in the diff.`);

  const existingFingerprints = valid.length ? await collectExistingFingerprints(octokit, pullNumber) : new Set<string>();
  const fresh = valid.filter((finding) => !existingFingerprints.has(fingerprint(finding)));
  const skippedDuplicates = valid.length - fresh.length;
  if (skippedDuplicates) core.info(`Skipping ${skippedDuplicates} finding(s) already posted on PR #${pullNumber}.`);

  const secrets = [inputs.openaiApiKey, inputs.posthogApiKey, inputs.githubToken];
  const piSessionReference = await publishPiSessionFiles(octokit, inputs, `pr-${pullNumber}`, piSessionStartIndex);

  let inlinePosted = false;
  if (fresh.length && !inputs.dryRun) {
    inlinePosted = await postInlineComments(octokit, pullNumber, fresh, secrets);
  } else if (fresh.length) {
    core.info(`[dry-run] Would post ${fresh.length} inline review comment(s) on PR #${pullNumber}.`);
  }

  const summaryBody = redactSecrets(
    buildSummaryComment(prReviewMarker(inputs.commentMarker), review, valid, fresh, inlinePosted || inputs.dryRun, formatPiSessionMarkdown(piSessionReference)),
    secrets,
  );

  let commentUrl = '';
  if (inputs.dryRun) {
    core.info(`[dry-run] Would upsert PR review summary on #${pullNumber}:\n${summaryBody}`);
  } else {
    commentUrl = await upsertIssueComment(octokit, pullNumber, prReviewMarker(inputs.commentMarker), summaryBody);
  }

  await writeStateRecord(octokit, inputs, {
    kind: 'pr',
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    numberOrSha: String(pullNumber),
    title: pr.title,
    conclusion: `pr-review: ${review.verdict}`,
    labels: [],
    url: pr.url,
    data: { verdict: review.verdict, findings: valid.length, posted: fresh.length, dropped, skippedDuplicates, piCalls: getPiCallCount() },
  });

  core.info(`PR review #${pullNumber}: verdict ${review.verdict}, ${fresh.length} new finding(s) posted.`);
  return { conclusion: `pr-review: ${review.verdict}`, verdict: review.verdict, commentUrl, skipped: false };
}

// Answer a follow-up question posted on one of the bot's review threads.
// Read-only; posts a threaded reply, never edits code. The reply targets the
// thread ROOT comment: GitHub's replies endpoint expects the top-level review
// comment, and the root holds the original finding being asked about.
export async function replyToPullRequestReviewComment(octokit: Octokit, pullNumber: number, inputs: ActionInputs, thread: ReviewThreadRef, question: string): Promise<PullRequestReviewResult> {
  if (!inputs.allowPrReview) {
    core.info('Skipping PR review reply because allow-pr-review is false.');
    return { conclusion: 'skipped because allow-pr-review is false', commentUrl: '', skipped: true };
  }

  const pr = await getPullRequestSnapshot(octokit, pullNumber);
  if (!pr.isSameRepo) {
    core.info(`Skipping PR review reply for fork PR #${pullNumber}.`);
    return { conclusion: 'skipped fork PR review reply', commentUrl: '', skipped: true };
  }

  const rootComment = await getReviewComment(octokit, thread.rootId);
  if (!rootComment) {
    return { conclusion: 'skipped PR review reply because the thread root comment could not be fetched', commentUrl: '', skipped: true };
  }

  const security = assessPullRequestSecurity({
    title: pr.title,
    body: [pr.body, rootComment.body, question].join('\n'),
    diff: rootComment.diffHunk,
  });
  if (security.sensitive && !inputs.allowSecurityAi) {
    core.warning(`Skipping PR review reply on #${pullNumber}: security-sensitive content detected (${security.reasons.join(', ')}). Set allow-security-ai: true to reply anyway.`);
    return { conclusion: 'security-sensitive; human review required', commentUrl: '', skipped: true };
  }

  const output = await runPi({
    inputs,
    tools: ['read', 'grep', 'find', 'ls'],
    requireText: false,
    prompt: buildReplyPrompt(pr, rootComment, question),
  });

  const secrets = [inputs.openaiApiKey, inputs.posthogApiKey, inputs.githubToken];
  const body = redactSecrets(output.trim() || 'I could not produce an answer for this thread.', secrets);
  if (inputs.dryRun) {
    core.info(`[dry-run] Would reply to review thread ${thread.rootId} on PR #${pullNumber}:\n${body}`);
    return { conclusion: 'dry-run PR review reply', commentUrl: '', skipped: false };
  }

  const url = await replyToReviewComment(octokit, pullNumber, thread.rootId, body);
  core.info(`Replied to review thread ${thread.rootId} on PR #${pullNumber}: ${url}`);
  return { conclusion: 'pr-review reply posted', commentUrl: url, skipped: false };
}

async function postInlineComments(octokit: Octokit, pullNumber: number, findings: ReviewFinding[], secrets: Array<string | undefined>): Promise<boolean> {
  const comments: ReviewComment[] = findings.map((finding) => ({
    path: finding.path,
    line: finding.line,
    body: redactSecrets(formatInlineComment(finding), secrets),
  }));
  try {
    // GitHub requires a non-empty body for a COMMENT review; the full walkthrough
    // lives in the upserted summary comment.
    const url = await createPullRequestReview(octokit, pullNumber, {
      body: 'PostHog Watcher inline review — see the review summary comment for the walkthrough.',
      comments,
    });
    core.info(`Posted ${comments.length} inline review comment(s) on PR #${pullNumber}: ${url}`);
    return true;
  } catch (error) {
    core.warning(`Could not post inline review comments on PR #${pullNumber}; falling back to the summary comment. ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function collectExistingFingerprints(octokit: Octokit, pullNumber: number): Promise<Set<string>> {
  const bodies = await listReviewCommentBodies(octokit, pullNumber);
  const fingerprints = new Set<string>();
  for (const body of bodies) {
    const match = body.match(/<!-- fp:([a-f0-9]{12}) -->/);
    if (match?.[1]) fingerprints.add(match[1]);
  }
  return fingerprints;
}

function fingerprint(finding: ReviewFinding): string {
  return createHash('sha1').update(`${finding.path}:${finding.line}:${finding.title}`).digest('hex').slice(0, 12);
}

function formatInlineComment(finding: ReviewFinding): string {
  const parts = [`${SEVERITY_EMOJI[finding.severity]} **${finding.title || 'Review comment'}**`, '', finding.comment];
  if (finding.suggestion) parts.push('', '```suggestion', finding.suggestion, '```');
  parts.push('', `<!-- fp:${fingerprint(finding)} -->`);
  return parts.join('\n');
}

function buildSummaryComment(marker: string, review: PrReviewResult, valid: ReviewFinding[], fresh: ReviewFinding[], inlinePosted: boolean, piSessionMarkdown: string): string {
  const verdictLabel = { clean: '✅ Clean', comment: '💬 Comments', changes_requested: '🔧 Changes requested' }[review.verdict];
  const lines = [
    marker,
    '## PostHog Watcher code review',
    '',
    `**Verdict:** ${verdictLabel}`,
    '',
    review.summary || '_No summary provided._',
  ];

  if (valid.length) {
    lines.push('', '### Findings');
    for (const finding of valid) {
      lines.push(`- ${SEVERITY_EMOJI[finding.severity]} \`${finding.path}:${finding.line}\` — ${finding.title || finding.comment.split('\n')[0]}`);
    }
  } else {
    lines.push('', '_No inline findings._');
  }

  // If inline comments could not be attached, surface the detail here so nothing is lost.
  if (fresh.length && !inlinePosted) {
    lines.push('', '### Finding details (could not attach inline)');
    for (const finding of fresh) {
      lines.push('', `**${SEVERITY_EMOJI[finding.severity]} \`${finding.path}:${finding.line}\` — ${finding.title}**`, '', finding.comment);
      if (finding.suggestion) lines.push('', '```suggestion', finding.suggestion, '```');
    }
  }

  if (piSessionMarkdown) lines.push('', piSessionMarkdown);
  return lines.join('\n');
}

function buildReviewPrompt(pr: PullRequestSnapshot, files: PullRequestFile[], diff: string): string {
  const fileList = files.map((file) => `- ${file.filename} (${file.status ?? 'modified'})`).join('\n');
  return `Review pull request #${pr.number}: ${pr.title}

This is a code review for the current repository. Follow the karpathy-guidelines skill. Be conservative and evidence-backed: only report issues you are confident about (bugs, correctness, security, clear maintainability problems). Do not nitpick style. Use the read/grep/find/ls tools to inspect surrounding code before commenting. Do not modify files and do not make GitHub API calls.

Only comment on lines that are part of this diff. Report the line number using the NEW file's line numbering (the right side of the diff).

PR description:
\`\`\`
${pr.body || '(empty)'}
\`\`\`

Changed code files:
${fileList}

Unified diff (truncated if large):
\`\`\`diff
${diff}
\`\`\`

Return ONLY JSON in this shape:
{
  "verdict": "clean | comment | changes_requested",
  "summary": "short markdown walkthrough of the change and overall assessment",
  "findings": [
    {
      "path": "path/to/file.ts",
      "line": 42,
      "severity": "info | warning | blocker",
      "title": "short title",
      "comment": "what is wrong and why, with evidence",
      "suggestion": "optional replacement code for exactly that line/block"
    }
  ]
}

Use "clean" with an empty findings array when the change looks good.`;
}

function buildReplyPrompt(pr: PullRequestSnapshot, comment: { path: string; body: string; diffHunk: string }, question: string): string {
  return `Answer a follow-up question on a code review thread for pull request #${pr.number}: ${pr.title}

This is a read-only Q&A on an existing review comment. Follow the karpathy-guidelines skill. Use the read/grep/find/ls tools to check the code before answering. Be concise and concrete. Do not modify files and do not make GitHub API calls. Answer in GitHub-flavored markdown; this text is posted verbatim as a threaded reply.

File under discussion: ${comment.path}

Diff hunk the thread is anchored to:
\`\`\`diff
${comment.diffHunk || '(unavailable)'}
\`\`\`

Original review comment:
\`\`\`
${comment.body || '(unavailable)'}
\`\`\`

Follow-up question:
\`\`\`
${question || '(no explicit question; clarify or expand on the review comment)'}
\`\`\``;
}

function buildDiffBlock(files: PullRequestFile[]): string {
  const blocks: string[] = [];
  let size = 0;
  let truncated = false;
  for (const file of files) {
    if (!file.patch) continue;
    const block = `diff --git a/${file.filename} b/${file.filename}\n${file.patch}`;
    if (size + block.length > MAX_DIFF_CHARS) {
      truncated = true;
      break;
    }
    blocks.push(block);
    size += block.length + 1;
  }
  if (truncated) {
    core.warning(`PR diff exceeds ${MAX_DIFF_CHARS} characters; later files were omitted from the review prompt.`);
    blocks.push('...<diff truncated>');
  }
  return blocks.join('\n');
}
