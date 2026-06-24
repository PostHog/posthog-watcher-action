import * as core from '@actions/core';

export type QueuedMode = 'auto' | 'triage' | 'investigate' | 'fix';
export type Mode = QueuedMode | 'commit-review' | 'sweep' | 'enqueue' | 'drain-queue';

export interface ActionInputs {
  openaiApiKey: string;
  githubToken: string;
  model: string;
  issueNumber?: number;
  mode: Mode;
  allowFix: boolean;
  allowClose: boolean;
  allowSecurityAi: boolean;
  requireFixCommand: boolean;
  dryRun: boolean;
  labelAllowlist: string[];
  managedLabelPrefix: string;
  syncManagedLabels: boolean;
  maxComments: number;
  maxChangedFiles: number;
  maxDiffLines: number;
  maxRepairAttempts: number;
  maxRelatedItems: number;
  validationCommand: string;
  reproductionCommand: string;
  requireReproduction: boolean;
  commitSha?: string;
  maxSweepItems: number;
  maxSweepFixItems: number;
  sweepQuery: string;
  queuedMode: QueuedMode;
  maxQueueItems: number;
  maxQueueAttempts: number;
  maxPiCalls: number;
  piTimeoutMs: number;
  approveProjectResources: boolean;
  stateEnabled: boolean;
  stateRepo: string;
  stateBranch: string;
  commentMarker: string;
  piVersion: string;
}

export function getInputs(): ActionInputs {
  const issueNumberInput = core.getInput('issue-number');
  const mode = normalizeMode(core.getInput('mode') || 'auto');

  return {
    openaiApiKey: optionalSecret('openai-api-key'),
    githubToken: required('github-token'),
    model: core.getInput('model') || 'openai/gpt-5.5:high',
    issueNumber: issueNumberInput ? parsePositiveInt(issueNumberInput, 'issue-number') : undefined,
    mode,
    allowFix: parseBoolean(core.getInput('allow-fix')),
    allowClose: parseBoolean(core.getInput('allow-close')),
    allowSecurityAi: parseBoolean(core.getInput('allow-security-ai')),
    requireFixCommand: parseBoolean(core.getInput('require-fix-command')),
    dryRun: parseBoolean(core.getInput('dry-run')),
    labelAllowlist: parseCsv(core.getInput('labels') || '*'),
    managedLabelPrefix: core.getInput('managed-label-prefix') || 'posthog-watcher:',
    syncManagedLabels: parseBoolean(core.getInput('sync-managed-labels') || 'true'),
    maxComments: parsePositiveInt(core.getInput('max-comments') || '20', 'max-comments'),
    maxChangedFiles: parsePositiveInt(core.getInput('max-changed-files') || '5', 'max-changed-files'),
    maxDiffLines: parsePositiveInt(core.getInput('max-diff-lines') || '500', 'max-diff-lines'),
    maxRepairAttempts: parsePositiveInt(core.getInput('max-repair-attempts') || '2', 'max-repair-attempts'),
    maxRelatedItems: parsePositiveInt(core.getInput('max-related-items') || '5', 'max-related-items'),
    validationCommand: core.getInput('validation-command'),
    reproductionCommand: core.getInput('reproduction-command'),
    requireReproduction: parseBoolean(core.getInput('require-reproduction')),
    commitSha: core.getInput('commit-sha') || undefined,
    maxSweepItems: parsePositiveInt(core.getInput('max-sweep-items') || '10', 'max-sweep-items'),
    maxSweepFixItems: parseNonNegativeInt(core.getInput('max-sweep-fix-items') || '0', 'max-sweep-fix-items'),
    sweepQuery: core.getInput('sweep-query') || 'is:issue is:open archived:false',
    queuedMode: normalizeQueuedMode(core.getInput('queued-mode') || 'auto'),
    maxQueueItems: parsePositiveInt(core.getInput('max-queue-items') || '5', 'max-queue-items'),
    maxQueueAttempts: parsePositiveInt(core.getInput('max-queue-attempts') || '3', 'max-queue-attempts'),
    maxPiCalls: parsePositiveInt(core.getInput('max-pi-calls') || '16', 'max-pi-calls'),
    piTimeoutMs: parsePositiveInt(core.getInput('pi-timeout-ms') || '600000', 'pi-timeout-ms'),
    approveProjectResources: parseBoolean(core.getInput('approve-project-resources')),
    stateEnabled: parseBoolean(core.getInput('state-enabled')),
    stateRepo: core.getInput('state-repo'),
    stateBranch: core.getInput('state-branch') || 'posthog-watcher-state',
    commentMarker: core.getInput('comment-marker') || '<!-- posthog-watcher-action -->',
    piVersion: core.getInput('pi-version') || '0.79.10',
  };
}

function required(name: string): string {
  const value = core.getInput(name, { required: true });
  core.setSecret(value);
  return value;
}

function optionalSecret(name: string): string {
  const value = core.getInput(name);
  if (value) core.setSecret(value);
  return value;
}

function parseBoolean(value: string): boolean {
  return ['1', 'true', 'yes', 'y', 'on'].includes(value.trim().toLowerCase());
}

function parsePositiveInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function parseCsv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeQueuedMode(value: string): QueuedMode {
  if (value === 'auto' || value === 'triage' || value === 'investigate' || value === 'fix') {
    return value;
  }
  throw new Error('queued-mode must be one of: auto, triage, investigate, fix');
}

function normalizeMode(value: string): Mode {
  if (value === 'auto' || value === 'triage' || value === 'investigate' || value === 'fix' || value === 'commit-review' || value === 'sweep' || value === 'enqueue' || value === 'drain-queue') {
    return value;
  }
  throw new Error('mode must be one of: auto, triage, investigate, fix, commit-review, sweep, enqueue, drain-queue');
}
