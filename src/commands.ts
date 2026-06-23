import * as core from '@actions/core';
import * as github from '@actions/github';
import type { Mode } from './inputs.js';

export interface CommandResolution {
  shouldRun: boolean;
  mode?: Mode;
  reason?: string;
}

const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export function resolveCommand(): CommandResolution {
  if (github.context.eventName !== 'issue_comment') {
    return { shouldRun: true };
  }

  const payload = github.context.payload as {
    comment?: { body?: string; author_association?: string; user?: { login?: string } | null };
    issue?: { number?: number; pull_request?: unknown };
  };

  const mode = parseWatcherCommand(payload.comment?.body ?? '');
  if (!mode) {
    return { shouldRun: false, reason: 'issue comment does not contain a posthog-watcher command' };
  }

  const association = payload.comment?.author_association ?? '';
  if (!TRUSTED_ASSOCIATIONS.has(association)) {
    return {
      shouldRun: false,
      reason: `ignoring ${mode} command from untrusted author association: ${association || 'unknown'}`,
    };
  }

  core.info(`Accepted @posthog-watcher ${mode} command from ${payload.comment?.user?.login ?? 'unknown'}.`);
  return { shouldRun: true, mode };
}

export function parseWatcherCommand(body: string): Mode | undefined {
  const match = body.match(/(?:^|\s)@(?:posthog-watcher|posthog-watcher-action)(?:\[bot\])?\s+(triage|investigate|fix)\b/i);
  const command = match?.[1]?.toLowerCase();

  if (command === 'triage' || command === 'investigate' || command === 'fix') {
    return command;
  }

  return undefined;
}
