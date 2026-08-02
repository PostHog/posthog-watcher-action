import * as core from '@actions/core';
import { git } from './git.js';
import type { ActionInputs } from './inputs.js';
import { runPi } from './pi-runner.js';

export interface ReviewGateResult {
  approve: boolean;
  confidence: number;
  reason: string;
  risks: string[];
}

export interface ReviewGateContext {
  subject: string;
  summary?: string;
  intendedChange?: string;
  failureContext?: string;
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
  "confidence": 0.0,
  "reason": "short reason",
  "risks": ["risk bullets"]
}

Approve only if the diff is narrow, relevant to the supplied issue/PR context, low risk, and does not contain unrelated refactors, secrets, workflow changes, or suspicious code.
Release metadata such as changesets or changelog entries may accompany a substantive fix, but reject a diff that contains only release metadata.

Diff:
\`\`\`diff
${truncated}
\`\`\``,
  });

  const result = parseReviewGate(output);
  core.info(`Review gate: ${result.approve ? 'approved' : 'rejected'} (${Math.round(result.confidence * 100)}%) - ${result.reason}`);
  return result;
}

function formatReviewContext(context: ReviewGateContext | undefined): string {
  if (!context) return '';
  return `Review context:\n- Subject: ${context.subject}\n${context.summary ? `- Summary: ${context.summary}\n` : ''}${context.intendedChange ? `- Intended change: ${context.intendedChange}\n` : ''}${context.failureContext ? `- Failure/review context: ${truncate(context.failureContext, 4000)}\n` : ''}\n`;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n...<truncated>` : value;
}

function parseReviewGate(text: string): ReviewGateResult {
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last <= first) return { approve: false, confidence: 0, reason: 'review gate did not return JSON', risks: [] };
  try {
    const raw = JSON.parse(text.slice(first, last + 1)) as Partial<ReviewGateResult>;
    return {
      approve: Boolean(raw.approve) && typeof raw.confidence === 'number' && raw.confidence >= 0.75,
      confidence: typeof raw.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence)) : 0,
      reason: typeof raw.reason === 'string' ? raw.reason : '',
      risks: Array.isArray(raw.risks) ? raw.risks.filter((risk): risk is string => typeof risk === 'string') : [],
    };
  } catch {
    return { approve: false, confidence: 0, reason: 'review gate JSON parse failed', risks: [] };
  }
}
