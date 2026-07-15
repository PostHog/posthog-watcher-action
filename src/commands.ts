import * as core from '@actions/core';
import * as github from '@actions/github';
import type { Mode } from './inputs.js';

export type WatcherCommand =
  | 'triage'
  | 'investigate'
  | 'review'
  | 'pr-review-reply'
  | 'fix'
  | 'plan'
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
  actor?: string;
  extraInstructions?: string;
  commandMention?: string;
}

interface ParsedWatcherCommand {
  command: WatcherCommand;
  extraInstructions: string;
}

export const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

// Single source of truth for "this command asks the watcher to edit code";
// index.ts fix gates consume it too, so routing and gating cannot drift.
export const FIX_INTENT_COMMANDS = new Set<WatcherCommand>(['fix', 'fix-ci', 'address-review', 'rebase']);

export function resolveCommand(commandMention = configuredCommandMention()): CommandResolution {
  if (github.context.eventName === 'pull_request_review_comment') {
    const payload = github.context.payload as {
      sender?: { login?: string };
      comment?: { body?: string; in_reply_to_id?: number };
    };
    const actor = payload.sender?.login ?? 'unknown';
    const body = payload.comment?.body ?? '';

    // Explicit fix intent keeps the existing PR-repair behavior.
    const parsed = parseWatcherCommandDetails(body, commandMention);
    if (parsed && FIX_INTENT_COMMANDS.has(parsed.command)) {
      core.info(`Treating pull request review comment as ${commandMention} ${parsed.command}.`);
      return { ...commandToResolution(parsed.command), actor, extraInstructions: parsed.extraInstructions, commandMention };
    }

    // Any review comment (thread root or reply) that mentions the watcher
    // without a fix command is a question: answer it read-only in the thread
    // rather than editing code.
    if (bodyMentionsCommand(body, commandMention)) {
      core.info(`Treating pull request review comment as a ${commandMention} review question.`);
      return { ...commandToResolution('pr-review-reply'), actor, extraInstructions: body, commandMention };
    }

    core.info(`Treating pull request review comment as ${commandMention} address review.`);
    return { ...commandToResolution('address-review'), actor, commandMention };
  }

  if (github.context.eventName === 'pull_request_review') {
    const payload = github.context.payload as { review?: { state?: string } };
    if (payload.review?.state === 'commented' || payload.review?.state === 'changes_requested') {
      const actor = github.context.payload.sender?.login ?? 'unknown';
      core.info(`Treating pull request review ${payload.review.state} event as ${commandMention} address review.`);
      return { ...commandToResolution('address-review'), actor, commandMention };
    }
    return { shouldRun: false, reason: `pull request review state does not require repair: ${payload.review?.state ?? 'unknown'}` };
  }

  if (github.context.eventName !== 'issue_comment') {
    return { shouldRun: true, commandMention };
  }

  const payload = github.context.payload as {
    comment?: { body?: string; author_association?: string; user?: { login?: string } | null };
  };

  const parsed = parseWatcherCommandDetails(payload.comment?.body ?? '', commandMention);
  if (!parsed) {
    return { shouldRun: false, reason: `issue comment does not contain a ${commandMention} command` };
  }

  if (parsed.command === 'stop') {
    return { shouldRun: false, command: parsed.command, reason: 'received stop command' };
  }

  const association = payload.comment?.author_association ?? '';
  if (!TRUSTED_ASSOCIATIONS.has(association)) {
    return {
      shouldRun: false,
      command: parsed.command,
      reason: `ignoring ${parsed.command} command from untrusted author association: ${association || 'unknown'}`,
    };
  }

  const actor = payload.comment?.user?.login ?? 'unknown';
  core.info(`Accepted ${commandMention} ${parsed.command} command from ${actor}.`);
  return { ...commandToResolution(parsed.command), actor, extraInstructions: parsed.extraInstructions, commandMention };
}

export function parseWatcherCommand(body: string, commandMention = '@posthog-watcher'): WatcherCommand | undefined {
  return parseWatcherCommandDetails(body, commandMention)?.command;
}

export function bodyMentionsCommand(body: string, commandMention = '@posthog-watcher'): boolean {
  // (?![\w-]) instead of \b: GitHub usernames may continue with a hyphen, so
  // '@posthog-watcher-staging' must not count as a '@posthog-watcher' mention.
  const mention = commandMentionPattern(commandMention);
  return new RegExp(`(?:^|\\s)${mention}(?![\\w-])`, 'i').test(body);
}

export function parseWatcherCommandDetails(body: string, commandMention = '@posthog-watcher'): ParsedWatcherCommand | undefined {
  const mention = commandMentionPattern(commandMention);
  const match = body.match(new RegExp(`(?:^|\\s)${mention}\\s+([\\s\\S]*)`, 'i'));
  const text = match?.[1]?.trim();
  if (!text) return undefined;

  const commandPatterns: Array<[RegExp, WatcherCommand]> = [
    [/^(?:triage|review|re-review|re-run)\b\s*([\s\S]*)$/i, 'triage'],
    [/^investigate\b\s*([\s\S]*)$/i, 'investigate'],
    [/^fix\s+ci\b\s*([\s\S]*)$/i, 'fix-ci'],
    [/^address\s+review\b\s*([\s\S]*)$/i, 'address-review'],
    [/^rebase\b\s*([\s\S]*)$/i, 'rebase'],
    [/^(?:plan|propose\s+fix|propose-fix)\b\s*([\s\S]*)$/i, 'plan'],
    [/^(?:fix|autofix)\b\s*([\s\S]*)$/i, 'fix'],
    [/^status\b\s*([\s\S]*)$/i, 'status'],
    [/^explain\b\s*([\s\S]*)$/i, 'explain'],
    [/^ask\b\s*([\s\S]*)$/i, 'ask'],
    [/^(?:close|autoclose)\b\s*([\s\S]*)$/i, 'close'],
    [/^(?:apply-close|apply close)\b\s*([\s\S]*)$/i, 'apply-close'],
    [/^stop\b\s*([\s\S]*)$/i, 'stop'],
  ];

  for (const [pattern, command] of commandPatterns) {
    const commandMatch = text.match(pattern);
    if (commandMatch) return { command, extraInstructions: (commandMatch[1] ?? '').trim() };
  }

  return undefined;
}

function configuredCommandMention(): string {
  return normalizeCommandMention(core.getInput('command-mention') || '@posthog-watcher');
}

export function normalizeCommandMention(value: string): string {
  const trimmed = value.trim() || '@posthog-watcher';
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
}

function commandMentionPattern(commandMention: string): string {
  const normalized = normalizeCommandMention(commandMention);
  const mention = escapeRegExp(normalized.replace(/^@/, ''));
  return `@${mention}(?:\\[bot\\])?`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    case 'plan':
      return { shouldRun: true, command, mode: 'investigate' };
    case 'pr-review-reply':
      return { shouldRun: true, command, mode: 'pr-review' };
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
