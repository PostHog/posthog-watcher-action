import * as core from '@actions/core';

export type Mode = 'auto' | 'triage' | 'investigate' | 'fix' | 'commit-review';

export interface ActionInputs {
  openaiApiKey: string;
  githubToken: string;
  model: string;
  issueNumber?: number;
  mode: Mode;
  allowFix: boolean;
  dryRun: boolean;
  labelAllowlist: string[];
  maxComments: number;
  maxChangedFiles: number;
  maxDiffLines: number;
  maxRepairAttempts: number;
  maxRelatedItems: number;
  validationCommand: string;
  commitSha?: string;
  commentMarker: string;
  piVersion: string;
}

export function getInputs(): ActionInputs {
  const issueNumberInput = core.getInput('issue-number');
  const mode = normalizeMode(core.getInput('mode') || 'auto');

  return {
    openaiApiKey: required('openai-api-key'),
    githubToken: required('github-token'),
    model: core.getInput('model') || 'openai-codex/gpt-5.5:high',
    issueNumber: issueNumberInput ? parsePositiveInt(issueNumberInput, 'issue-number') : undefined,
    mode,
    allowFix: parseBoolean(core.getInput('allow-fix')),
    dryRun: parseBoolean(core.getInput('dry-run')),
    labelAllowlist: parseCsv(core.getInput('labels')),
    maxComments: parsePositiveInt(core.getInput('max-comments') || '20', 'max-comments'),
    maxChangedFiles: parsePositiveInt(core.getInput('max-changed-files') || '5', 'max-changed-files'),
    maxDiffLines: parsePositiveInt(core.getInput('max-diff-lines') || '500', 'max-diff-lines'),
    maxRepairAttempts: parsePositiveInt(core.getInput('max-repair-attempts') || '2', 'max-repair-attempts'),
    maxRelatedItems: parsePositiveInt(core.getInput('max-related-items') || '5', 'max-related-items'),
    validationCommand: core.getInput('validation-command'),
    commitSha: core.getInput('commit-sha') || undefined,
    commentMarker: core.getInput('comment-marker') || '<!-- posthog-watcher-action -->',
    piVersion: core.getInput('pi-version') || '0.79.10',
  };
}

function required(name: string): string {
  const value = core.getInput(name, { required: true });
  core.setSecret(value);
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

function parseCsv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeMode(value: string): Mode {
  if (value === 'auto' || value === 'triage' || value === 'investigate' || value === 'fix' || value === 'commit-review') {
    return value;
  }
  throw new Error('mode must be one of: auto, triage, investigate, fix, commit-review');
}
