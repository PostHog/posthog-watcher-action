import * as core from '@actions/core';
import * as github from '@actions/github';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Octokit } from './github.js';
import type { ActionInputs } from './inputs.js';

export interface PiSessionCapture {
  enabled: boolean;
  args: string[];
  callNumber: number;
  before: Set<string>;
}

export interface PiSessionRecord {
  callNumber: number;
  path: string;
}

export interface PiSessionReference {
  branch: string;
  files: Array<{ name: string; url: string }>;
}

const sessionRoot = path.join(os.tmpdir(), 'posthog-watcher-pi-sessions');
const records: PiSessionRecord[] = [];
const recordedPaths = new Set<string>();

export async function beginPiSessionCapture(inputs: ActionInputs, callNumber: number): Promise<PiSessionCapture> {
  if (!inputs.piSessionSharing) {
    return { enabled: false, args: ['--no-session'], callNumber, before: new Set() };
  }

  await mkdir(sessionRoot, { recursive: true });
  return {
    enabled: true,
    args: ['--session-dir', sessionRoot, '--name', `posthog-watcher call ${callNumber}`],
    callNumber,
    before: new Set(await listSessionFiles()),
  };
}

export async function finishPiSessionCapture(capture: PiSessionCapture): Promise<void> {
  if (!capture.enabled) return;

  const after = await listSessionFiles();
  for (const file of after) {
    if (capture.before.has(file) || recordedPaths.has(file)) continue;
    recordedPaths.add(file);
    records.push({ callNumber: capture.callNumber, path: file });
  }
}

export function piSessionRecordCount(): number {
  return records.length;
}

export async function publishPiSessionFiles(octokit: Octokit, inputs: ActionInputs, subject: string, startIndex: number): Promise<PiSessionReference | undefined> {
  if (!inputs.piSessionSharing || inputs.dryRun) return undefined;

  const selected = records.slice(startIndex);
  if (!selected.length) return undefined;

  const state = stateRepository(inputs);
  await ensureBranch(octokit, state.owner, state.repo, inputs.stateBranch);

  const source = github.context.repo;
  const basePath = `pi-sessions/${safePathPart(`${source.owner}-${source.repo}`)}/${safePathPart(subject)}/run-${github.context.runId}-${startIndex + 1}`;
  const files: Array<{ name: string; url: string }> = [];

  for (const [index, record] of selected.entries()) {
    const name = safePathPart(`call-${record.callNumber}-${index + 1}-${path.basename(record.path)}`);
    const filePath = `${basePath}/${name}`;
    const content = await readFile(record.path, 'utf8');
    await upsertFile(octokit, state.owner, state.repo, inputs.stateBranch, filePath, content, `Save pi session for ${subject}`);
    files.push({ name, url: blobUrl(state.owner, state.repo, inputs.stateBranch, filePath) });
  }

  const readmePath = `${basePath}/README.md`;
  await upsertFile(octokit, state.owner, state.repo, inputs.stateBranch, readmePath, renderReadme(source.owner, source.repo, files), `Document pi session for ${subject}`);
  core.info(`Saved ${files.length} pi session file(s) to ${state.owner}/${state.repo}@${inputs.stateBranch}:${basePath}.`);
  return { branch: inputs.stateBranch, files };
}

export function formatPiSessionMarkdown(reference: PiSessionReference | undefined): string {
  if (!reference) return '';
  const fileList = reference.files.map((file) => `- [\`${file.name}\`](${file.url})`).join('\n');
  return `### Pi session

The JSONL pi session file(s) for this run were saved to the \`${reference.branch}\` branch. Download one locally, then fork it into your own pi session:

\`\`\`bash
pi --fork path/to/session.jsonl
\`\`\`

Saved session files:
${fileList}
`;
}

async function listSessionFiles(dir = sessionRoot): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = await Promise.all(entries.map(async (entry) => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return listSessionFiles(entryPath);
      if (entry.isFile() && entry.name.endsWith('.jsonl')) return [entryPath];
      return [];
    }));
    return files.flat().sort();
  } catch (error) {
    if (await isMissing(dir)) return [];
    throw error;
  }
}

async function isMissing(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return false;
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'ENOENT';
  }
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

async function upsertFile(octokit: Octokit, owner: string, repo: string, branch: string, filePath: string, content: string, message: string): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let sha: string | undefined;
    try {
      const existing = await octokit.rest.repos.getContent({ owner, repo, path: filePath, ref: branch });
      if (!Array.isArray(existing.data) && existing.data.type === 'file') sha = existing.data.sha;
    } catch (error) {
      core.debug(`Pi session file ${filePath} does not exist yet or branch is missing: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      await octokit.rest.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: filePath,
        branch,
        message,
        content: Buffer.from(content).toString('base64'),
        sha,
      });
      return;
    } catch (error) {
      if (attempt === 3 || !isConflictLike(error)) throw error;
      await sleep(250 * attempt);
    }
  }
}

function renderReadme(owner: string, repo: string, files: Array<{ name: string; url: string }>): string {
  const fileList = files.map((file) => `- [\`${file.name}\`](${file.url})`).join('\n');
  return `# PostHog Watcher pi sessions

These JSONL files are pi sessions captured from posthog-watcher-action.

To resume locally, download a session file, check out the relevant repository, then fork the session:

\`\`\`bash
gh repo clone ${owner}/${repo}
cd ${repo}
pi --fork path/to/session.jsonl
\`\`\`

Use \`--fork\` rather than \`--session\` when taking over a CI-generated session so your local work continues in a new session file.

Saved session files:
${fileList}
`;
}

function blobUrl(owner: string, repo: string, branch: string, filePath: string): string {
  return `https://github.com/${owner}/${repo}/blob/${encodeURIComponent(branch)}/${filePath.split('/').map(encodeURIComponent).join('/')}`;
}

function safePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 180) || 'pi-session';
}

function isConflictLike(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'status' in error && ((error as { status?: number }).status === 409 || (error as { status?: number }).status === 422));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
