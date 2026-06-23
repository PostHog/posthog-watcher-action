import * as core from '@actions/core';
import { PiAgent } from './agent.js';
import { CommandEnvironment, formatCommandFailure } from './environment.js';
import { checkDiffGuardrails, parseNumstat } from './guardrails.js';
import type { ActionInputs } from './inputs.js';
import type { IssueSnapshot } from './issue-context.js';
import { reviewGeneratedDiff } from './review-gate.js';
import type { TriageResult } from './triage-schema.js';

export interface RepairRunResult {
  files: string[];
}

export interface RepairSequenceResult {
  repaired: boolean;
  files: string[];
  reason: string;
  warning?: string;
}

type ReproductionCheck =
  | { kind: 'none' }
  | { kind: 'command'; command: string }
  | { kind: 'validation'; command: string };

export async function runIssueRepair(issue: IssueSnapshot, triage: TriageResult, inputs: ActionInputs): Promise<RepairRunResult | undefined> {
  const env = new CommandEnvironment();
  const agent = new PiAgent(inputs);
  const reproduction = await prepareReproduction(issue, triage, inputs, env, agent);
  if (!reproduction) return undefined;

  const maxAttempts = Math.min(inputs.maxRepairAttempts, 3);
  let failureSummary = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    core.info(`Starting repair attempt ${attempt}/${maxAttempts}`);
    if (attempt === 1) {
      await agent.fixIssue(issue, triage);
    } else {
      await agent.repairIssue(issue, triage, attempt, failureSummary);
    }

    const reproductionResult = await verifyReproductionAfterAttempt(reproduction, env);
    const validationFailure = reproductionResult.validationAlreadyRun ? undefined : await runValidation(inputs, env);
    const stats = parseNumstat(await env.git(['diff', '--numstat']));
    const guardrailFailures = checkDiffGuardrails(stats, {
      maxChangedFiles: inputs.maxChangedFiles,
      maxDiffLines: inputs.maxDiffLines,
    });

    const failures = [...(reproductionResult.failure ? [reproductionResult.failure] : []), ...(validationFailure ? [validationFailure] : []), ...guardrailFailures];
    if (!failures.length) {
      const reviewGate = await reviewGeneratedDiff(inputs);
      if (reviewGate.approve) {
        return { files: stats.files };
      }
      failures.push(`independent review gate rejected the diff (${Math.round(reviewGate.confidence * 100)}% confidence): ${reviewGate.reason}`);
      if (reviewGate.risks.length) failures.push(`review risks: ${reviewGate.risks.join('; ')}`);
    }

    failureSummary = failures.join('\n');
    core.warning(`Repair attempt ${attempt} failed:\n- ${failures.join('\n- ')}`);
  }

  core.warning('Skipping PR because all repair attempts failed.');
  return undefined;
}

export async function runPullRequestRepairSequence(prompt: string, inputs: ActionInputs): Promise<RepairSequenceResult> {
  const env = new CommandEnvironment();
  const agent = new PiAgent(inputs);
  await agent.runRepairPrompt(prompt);

  if (inputs.validationCommand) await env.expectShell(inputs.validationCommand, 'success');

  const stats = parseNumstat(await env.git(['diff', '--numstat']));
  if (!stats.files.length) {
    return { repaired: false, files: [], reason: 'skipped PR repair because no files changed' };
  }

  const failures = checkDiffGuardrails(stats, { maxChangedFiles: inputs.maxChangedFiles, maxDiffLines: inputs.maxDiffLines });
  if (failures.length) {
    return { repaired: false, files: stats.files, reason: 'skipped because guardrails failed', warning: `Skipping PR branch push because guardrails failed:\n- ${failures.join('\n- ')}` };
  }

  const review = await reviewGeneratedDiff(inputs);
  if (!review.approve) {
    return { repaired: false, files: stats.files, reason: 'skipped because review gate rejected diff', warning: `Skipping PR branch push because review gate rejected the diff: ${review.reason}` };
  }

  return { repaired: true, files: stats.files, reason: 'repair sequence approved' };
}

async function prepareReproduction(
  issue: IssueSnapshot,
  triage: TriageResult,
  inputs: ActionInputs,
  env: CommandEnvironment,
  agent: PiAgent,
): Promise<ReproductionCheck | undefined> {
  if (inputs.reproductionCommand) {
    core.info(`Running reproduction command before fix; it is expected to fail: ${inputs.reproductionCommand}`);
    const result = await env.checkShell(inputs.reproductionCommand, 'failure');
    if (!result.passed) {
      core.warning('Skipping fix because reproduction-command succeeded before any fix; the issue may already be fixed or the reproduction command is not valid for this report.');
      return undefined;
    }
    core.info('Confirmed reproduction-command fails before the fix.');
    return { kind: 'command', command: inputs.reproductionCommand };
  }

  if (!inputs.requireReproduction) return { kind: 'none' };

  if (!inputs.validationCommand) {
    core.warning('Skipping fix because require-reproduction is true but no reproduction-command or validation-command was configured.');
    return undefined;
  }

  core.info('require-reproduction is true; asking pi to add a minimal failing reproduction before implementation.');
  await agent.establishIssueReproduction(issue, triage);
  const result = await env.checkShell(inputs.validationCommand, 'failure');
  if (!result.passed) {
    core.warning('Skipping fix because validation-command did not fail after establishing the reproduction; the issue may already be fixed or no failing reproduction was added.');
    return undefined;
  }
  core.info('Confirmed validation-command fails after reproduction setup and before the fix.');
  return { kind: 'validation', command: inputs.validationCommand };
}

async function verifyReproductionAfterAttempt(reproduction: ReproductionCheck, env: CommandEnvironment): Promise<{ failure?: string; validationAlreadyRun: boolean }> {
  if (reproduction.kind === 'none') return { validationAlreadyRun: false };

  core.info(`Running ${reproduction.kind === 'command' ? 'reproduction-command' : 'validation-command reproduction'} after fix; it is expected to pass: ${reproduction.command}`);
  const result = await env.checkShell(reproduction.command, 'success');
  if (result.passed) return { validationAlreadyRun: reproduction.kind === 'validation' };
  return {
    failure: `${reproduction.kind === 'command' ? 'reproduction-command' : 'validation-command reproduction'} failed after fix: ${formatCommandFailure(result)}`,
    validationAlreadyRun: reproduction.kind === 'validation',
  };
}

async function runValidation(inputs: ActionInputs, env: CommandEnvironment): Promise<string | undefined> {
  if (!inputs.validationCommand) return undefined;

  const result = await env.checkShell(inputs.validationCommand, 'success');
  if (result.passed) return undefined;
  return `validation failed: ${formatCommandFailure(result)}`;
}
