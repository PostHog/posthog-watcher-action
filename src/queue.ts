import * as core from '@actions/core';
import * as github from '@actions/github';
import type { CommandResolution, WatcherCommand } from './commands.js';
import type { Octokit } from './github.js';
import type { ActionInputs, QueuedMode } from './inputs.js';

const QUEUE_PATH = 'queue.json';
const QUEUE_VERSION = 1;

export type QueueItemKind = 'issue' | 'pull_request';

export interface QueueItem {
  id: string;
  kind: QueueItemKind;
  number: number;
  mode: QueuedMode;
  command?: WatcherCommand;
  applyClose?: boolean;
  enqueuedAt: string;
  source: {
    eventName: string;
    runId: number;
    runUrl: string;
    commentId?: number;
    commentUrl?: string;
  };
  attempts: number;
}

export interface QueueFile {
  version: number;
  items: QueueItem[];
}

export interface EnqueueResult {
  item: QueueItem;
  enqueued: boolean;
  queueLength: number;
}

export async function enqueueCurrentPayload(octokit: Octokit, inputs: ActionInputs, command: CommandResolution): Promise<EnqueueResult> {
  const item = buildQueueItem(inputs, command);
  return mutateQueue<EnqueueResult>(octokit, inputs, (queue) => {
    const existing = queue.items.find((queued) => samePendingItem(queued, item));
    if (existing) return { queue, result: { item: existing, enqueued: false, queueLength: queue.items.length } };
    const next = { ...queue, items: [...queue.items, item] };
    return { queue: next, result: { item, enqueued: true, queueLength: next.items.length } };
  });
}

export async function readQueue(octokit: Octokit, inputs: ActionInputs): Promise<QueueFile> {
  const { owner, repo } = stateRepository(inputs);
  await ensureBranch(octokit, owner, repo, inputs.stateBranch);
  return parseQueue(await readFile(octokit, owner, repo, inputs.stateBranch, QUEUE_PATH));
}

export async function incrementQueueAttempt(octokit: Octokit, inputs: ActionInputs, id: string): Promise<QueueItem | undefined> {
  return mutateQueue(octokit, inputs, (queue) => {
    let updated: QueueItem | undefined;
    const items = queue.items.map((item) => {
      if (item.id !== id) return item;
      updated = { ...item, attempts: item.attempts + 1 };
      return updated;
    });
    return { queue: { ...queue, items }, result: updated };
  });
}

export async function removeQueueItem(octokit: Octokit, inputs: ActionInputs, id: string): Promise<number> {
  return mutateQueue(octokit, inputs, (queue) => {
    const items = queue.items.filter((item) => item.id !== id);
    return { queue: { ...queue, items }, result: queue.items.length - items.length };
  });
}

function buildQueueItem(inputs: ActionInputs, command: CommandResolution): QueueItem {
  const kind = resolveQueueItemKind();
  const number = resolvePayloadNumber(inputs);
  const mode = normalizeQueuedMode(command.mode ?? inputs.queuedMode);
  const now = new Date().toISOString();
  const payload = github.context.payload as { comment?: { id?: number; html_url?: string } };
  return {
    id: `${kind}-${number}-${mode}-${command.command ?? 'none'}-${payload.comment?.id ?? 'no-comment'}-${command.applyClose ? 'apply-close' : 'no-close'}-${Date.now()}`,
    kind,
    number,
    mode,
    command: command.command,
    applyClose: command.applyClose,
    enqueuedAt: now,
    source: {
      eventName: github.context.eventName,
      runId: github.context.runId,
      runUrl: runUrl(),
      commentId: payload.comment?.id,
      commentUrl: payload.comment?.html_url,
    },
    attempts: 0,
  };
}

function resolveQueueItemKind(): QueueItemKind {
  const payload = github.context.payload as { issue?: { pull_request?: unknown }; pull_request?: unknown };
  if (payload.pull_request || payload.issue?.pull_request) return 'pull_request';
  return 'issue';
}

function resolvePayloadNumber(inputs: ActionInputs): number {
  if (inputs.issueNumber) return inputs.issueNumber;
  const payload = github.context.payload as { issue?: { number?: number }; pull_request?: { number?: number } };
  const number = payload.issue?.number ?? payload.pull_request?.number;
  if (!number) throw new Error('No issue or pull request number found to enqueue. Set issue-number.');
  return number;
}

function normalizeQueuedMode(mode: string | undefined): QueuedMode {
  if (mode === 'auto' || mode === 'triage' || mode === 'investigate' || mode === 'fix') return mode;
  return 'auto';
}

function samePendingItem(left: QueueItem, right: QueueItem): boolean {
  return (
    left.kind === right.kind &&
    left.number === right.number &&
    left.mode === right.mode &&
    left.command === right.command &&
    Boolean(left.applyClose) === Boolean(right.applyClose) &&
    commandSourceKey(left) === commandSourceKey(right)
  );
}

function commandSourceKey(item: QueueItem): number | undefined {
  return item.command ? item.source.commentId : undefined;
}

async function mutateQueue<T>(octokit: Octokit, inputs: ActionInputs, mutate: (queue: QueueFile) => { queue: QueueFile; result: T }): Promise<T> {
  const { owner, repo } = stateRepository(inputs);
  await ensureBranch(octokit, owner, repo, inputs.stateBranch);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const currentFile = await readFileWithSha(octokit, owner, repo, inputs.stateBranch, QUEUE_PATH);
    const current = parseQueue(currentFile?.content);
    const { queue, result } = mutate(current);
    try {
      await upsertFile(octokit, owner, repo, inputs.stateBranch, QUEUE_PATH, `${JSON.stringify(queue, null, 2)}\n`, 'Update posthog watcher queue', currentFile?.sha);
      return result;
    } catch (error) {
      if (attempt === 3 || !isConflictLike(error)) throw error;
      core.warning(`Queue update conflict; retrying attempt ${attempt + 1}/3.`);
      await sleep(250 * attempt);
    }
  }
  throw new Error('Queue update failed after retries');
}

function parseQueue(content: string | undefined): QueueFile {
  if (!content) return { version: QUEUE_VERSION, items: [] };
  try {
    const parsed = JSON.parse(content) as Partial<QueueFile>;
    if (parsed.version !== QUEUE_VERSION || !Array.isArray(parsed.items)) return { version: QUEUE_VERSION, items: [] };
    return { version: QUEUE_VERSION, items: parsed.items.filter(isQueueItem) };
  } catch {
    return { version: QUEUE_VERSION, items: [] };
  }
}

function isQueueItem(item: unknown): item is QueueItem {
  if (!item || typeof item !== 'object') return false;
  const candidate = item as Partial<QueueItem>;
  return typeof candidate.id === 'string' && (candidate.kind === 'issue' || candidate.kind === 'pull_request') && typeof candidate.number === 'number' && typeof candidate.mode === 'string';
}

function stateRepository(inputs: ActionInputs): { owner: string; repo: string } {
  if (inputs.stateRepo) {
    const [owner, repo] = inputs.stateRepo.split('/');
    if (!owner || !repo) throw new Error('state-repo must be in owner/repo format');
    return { owner, repo };
  }
  return github.context.repo;
}

async function ensureBranch(octokit: Octokit, owner: string, repo: string, branch: string): Promise<void> {
  try {
    await octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
    return;
  } catch {
    const repoInfo = await octokit.rest.repos.get({ owner, repo });
    const base = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${repoInfo.data.default_branch}` });
    await octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: base.data.object.sha }).catch(async (error) => {
      if (isConflictLike(error)) {
        await octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
        return;
      }
      throw error;
    });
  }
}

async function readFile(octokit: Octokit, owner: string, repo: string, branch: string, path: string): Promise<string | undefined> {
  return (await readFileWithSha(octokit, owner, repo, branch, path))?.content;
}

async function readFileWithSha(octokit: Octokit, owner: string, repo: string, branch: string, path: string): Promise<{ content: string; sha: string } | undefined> {
  try {
    const existing = await octokit.rest.repos.getContent({ owner, repo, path, ref: branch });
    if (!Array.isArray(existing.data) && existing.data.type === 'file' && 'content' in existing.data) {
      return { content: Buffer.from(existing.data.content, 'base64').toString('utf8'), sha: existing.data.sha };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function upsertFile(octokit: Octokit, owner: string, repo: string, branch: string, path: string, content: string, message: string, sha?: string): Promise<void> {
  await octokit.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path,
    branch,
    message,
    content: Buffer.from(content).toString('base64'),
    sha,
  });
}

function runUrl(): string {
  const { owner, repo } = github.context.repo;
  return `https://github.com/${owner}/${repo}/actions/runs/${github.context.runId}`;
}

function isConflictLike(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'status' in error && ((error as { status?: number }).status === 409 || (error as { status?: number }).status === 422));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
