import * as core from '@actions/core';
import { git } from './git.js';
import type { ActionInputs } from './inputs.js';
import { runPi } from './pi-runner.js';
import { parseReviewGate, type ReviewGateResult } from './review-gate-schema.js';

export type { ReviewGateResult } from './review-gate-schema.js';

export interface ReviewGateContext {
  subject: string;
  summary?: string;
  intendedChange?: string;
  failureContext?: string;
  requireSubstantiveFix?: boolean;
}

export async function reviewGeneratedDiff(inputs: ActionInputs, context?: ReviewGateContext): Promise<ReviewGateResult> {
  const diff = await git(['diff', '--unified=80']);
  const truncated = diff.length > 60000 ? `${diff.slice(0, 60000)}\n...<diff truncated>` : diff;
  const output = await runPi({
    inputs,
    tools: ['read', 'grep', 'find', 'ls'],
    prompt: `Independently review this generated diff before a bot PR is pushed.

${formatReviewContext(context)}Return ONLY JSON:
{
  "approve": true,
  "substantiveFix": true,
  "confidence": 0.0,
  "reason": "short reason",
  "risks": ["risk bullets"]
}

Approve only if the diff is narrow, relevant to the supplied issue/PR context, low risk, and does not contain unrelated refactors, secrets, workflow changes, or suspicious code.
${formatSubstantiveFixRequirement(context)}
Diff:
\`\`\`diff
${truncated}
\`\`\``,
  });

  const result = parseReviewGate(output, context?.requireSubstantiveFix);
  core.info(`Review gate: ${result.approve ? 'approved' : 'rejected'} (${Math.round(result.confidence * 100)}%) - ${result.reason}`);
  return result;
}

function formatReviewContext(context: ReviewGateContext | undefined): string {
  if (!context) return '';
  return `Review context:\n- Subject: ${context.subject}\n${context.summary ? `- Summary: ${context.summary}\n` : ''}${context.intendedChange ? `- Intended change: ${context.intendedChange}\n` : ''}${context.failureContext ? `- Failure/review context: ${truncate(context.failureContext, 4000)}\n` : ''}\n`;
}

function formatSubstantiveFixRequirement(context: ReviewGateContext | undefined): string {
  if (!context?.requireSubstantiveFix) return '';
  return `Set substantiveFix to true only when the diff itself contains an implementation, test, configuration, or documentation change that directly addresses the issue. Release or version metadata alone is not a substantive fix. This review must reject the diff unless substantiveFix is true.\n`;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n...<truncated>` : value;
}
