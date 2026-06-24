import * as core from '@actions/core';
import * as github from '@actions/github';
import type { Mode } from './inputs.js';

export type WatcherCommand =
  | 'triage'
  | 'investigate'
  | 'review'
  | 'fix'
  | 'fix-ci'
  | 'address-review'
  | 'rebase'
  | 'status'
  | 'explain'
  | 'ask'
  | 'close'
  | 'apply-close'
  | 'stop';

export interface CommandResolution {
  shouldRun: boolean;
  mode?: Mode;
  command?: WatcherCommand;
  applyClose?: boolean;
  reason?: string;
}

const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export function resolveCommand(): CommandResolution {
  if (github.context.eventName === 'pull_request_review_comment') {
    core.info('Treating pull request review comment as @posthog-watcher address review.');
    return commandToResolution('address-review');
  }

  if (github.context.eventName === 'pull_request_review') {
    const payload = github.context.payload as { review?: { state?: string } };
    if (payload.review?.state === 'commented' || payload.review?.state === 'changes_requested') {
      core.info(`Treating pull request review ${payload.review.state} event as @posthog-watcher address review.`);
      return commandToResolution('address-review');
    }
    return { shouldRun: false, reason: `pull request review state does not require repair: ${payload.review?.state ?? 'unknown'}` };
  }

  if (github.context.eventName !== 'issue_comment') {
    return { shouldRun: true };
  }

  const payload = github.context.payload as {
    comment?: { body?: string; author_association?: string; user?: { login?: string } | null };
  };

  const command = parseWatcherCommand(payload.comment?.body ?? '');
  if (!command) {
    return { shouldRun: false, reason: 'issue comment does not contain a posthog-watcher command' };
  }

  if (command === 'stop') {
    return { shouldRun: false, command, reason: 'received stop command' };
  }

  const association = payload.comment?.author_association ?? '';
  if (!TRUSTED_ASSOCIATIONS.has(association)) {
    return {
      shouldRun: false,
      command,
      reason: `ignoring ${command} command from untrusted author association: ${association || 'unknown'}`,
    };
  }

  core.info(`Accepted @posthog-watcher ${command} command from ${payload.comment?.user?.login ?? 'unknown'}.`);
  return commandToResolution(command);
}

export function parseWatcherCommand(body: string): WatcherCommand | undefined {
  const match = body.match(/(?:^|\s)@(?:posthog-watcher|posthog-watcher-action)(?:\[bot\])?\s+([^\n]+)/i);
  const text = match?.[1]?.trim().toLowerCase();
  if (!text) return undefined;

  if (/^(triage|review|re-review|re-run)\b/.test(text)) return 'triage';
  if (/^investigate\b/.test(text)) return 'investigate';
  if (/^fix\s+ci\b/.test(text)) return 'fix-ci';
  if (/^address\s+review\b/.test(text)) return 'address-review';
  if (/^rebase\b/.test(text)) return 'rebase';
  if (/^(fix|autofix)\b/.test(text)) return 'fix';
  if (/^status\b/.test(text)) return 'status';
  if (/^explain\b/.test(text)) return 'explain';
  if (/^ask\b/.test(text)) return 'ask';
  if (/^(close|autoclose)\b/.test(text)) return 'close';
  if (/^(apply-close|apply close)\b/.test(text)) return 'apply-close';
  if (/^stop\b/.test(text)) return 'stop';

  return undefined;
}

function commandToResolution(command: WatcherCommand): CommandResolution {
  switch (command) {
    case 'triage':
    case 'review':
    case 'status':
    case 'explain':
    case 'ask':
      return { shouldRun: true, command, mode: 'triage' };
    case 'investigate':
      return { shouldRun: true, command, mode: 'investigate' };
    case 'fix':
    case 'fix-ci':
    case 'address-review':
    case 'rebase':
      return { shouldRun: true, command, mode: 'fix' };
    case 'close':
    case 'apply-close':
      return { shouldRun: true, command, mode: 'auto', applyClose: true };
    case 'stop':
      return { shouldRun: false, command, reason: 'received stop command' };
  }
}
