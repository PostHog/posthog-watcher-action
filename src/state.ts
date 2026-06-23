import * as core from '@actions/core';
import * as github from '@actions/github';
import type { Octokit } from './github.js';
import type { ActionInputs } from './inputs.js';

export interface StateRecord {
  kind: 'issue' | 'pr' | 'commit' | 'sweep';
  owner: string;
  repo: string;
  numberOrSha: string;
  title: string;
  conclusion: string;
  labels: string[];
  url: string;
  prUrl?: string;
  closed?: boolean;
  data: unknown;
}

interface DashboardEntry {
  key: string;
  repo: string;
  item: string;
  url: string;
  conclusion: string;
  labels: string[];
  prUrl?: string;
  closed: boolean;
  updatedAt: string;
}

export async function writeStateRecord(octokit: Octokit, inputs: ActionInputs, record: StateRecord): Promise<void> {
  if (!inputs.stateEnabled || inputs.dryRun) return;

  const { owner, repo } = stateRepository(inputs);
  await ensureBranch(octokit, owner, repo, inputs.stateBranch);
  const path = `records/${record.owner}-${record.repo}/${record.kind}s/${record.numberOrSha}.md`;
  const body = renderRecord(record);
  await upsertFile(octokit, owner, repo, inputs.stateBranch, path, body, `Update watcher state for ${record.kind} ${record.numberOrSha}`);

  const index = await readIndex(octokit, owner, repo, inputs.stateBranch);
  const entry = toDashboardEntry(record);
  index[entry.key] = entry;
  const sorted = Object.fromEntries(Object.entries(index).sort(([, left], [, right]) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 200));
  await upsertFile(octokit, owner, repo, inputs.stateBranch, 'index.json', `${JSON.stringify(sorted, null, 2)}\n`, 'Update watcher state index');
  await upsertFile(octokit, owner, repo, inputs.stateBranch, 'dashboard.md', renderDashboard(sorted), 'Update watcher dashboard');
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

async function readIndex(octokit: Octokit, owner: string, repo: string, branch: string): Promise<Record<string, DashboardEntry>> {
  const content = await readFile(octokit, owner, repo, branch, 'index.json');
  if (!content) return {};
  try {
    return JSON.parse(content) as Record<string, DashboardEntry>;
  } catch {
    return {};
  }
}

async function readFile(octokit: Octokit, owner: string, repo: string, branch: string, path: string): Promise<string | undefined> {
  try {
    const existing = await octokit.rest.repos.getContent({ owner, repo, path, ref: branch });
    if (!Array.isArray(existing.data) && existing.data.type === 'file' && 'content' in existing.data) {
      return Buffer.from(existing.data.content, 'base64').toString('utf8');
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function upsertFile(octokit: Octokit, owner: string, repo: string, branch: string, path: string, content: string, message: string): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let sha: string | undefined;
    try {
      const existing = await octokit.rest.repos.getContent({ owner, repo, path, ref: branch });
      if (!Array.isArray(existing.data) && existing.data.type === 'file') sha = existing.data.sha;
    } catch (error) {
      core.debug(`State file ${path} does not exist yet or branch is missing: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      await octokit.rest.repos.createOrUpdateFileContents({
        owner,
        repo,
        path,
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

function renderRecord(record: StateRecord): string {
  return `# ${record.kind} ${record.numberOrSha}: ${record.title}\n\n- Repo: ${record.owner}/${record.repo}\n- URL: ${record.url}\n- Conclusion: ${record.conclusion}\n- Labels: ${record.labels.join(', ') || '(none)'}\n- PR: ${record.prUrl || '(none)'}\n- Closed: ${record.closed ? 'yes' : 'no'}\n- Run: ${runUrl()}\n- Updated: ${new Date().toISOString()}\n\n\`\`\`json\n${JSON.stringify(record.data, null, 2)}\n\`\`\`\n`;
}

function toDashboardEntry(record: StateRecord): DashboardEntry {
  return {
    key: `${record.owner}/${record.repo}/${record.kind}/${record.numberOrSha}`,
    repo: `${record.owner}/${record.repo}`,
    item: `${record.kind} ${record.numberOrSha}`,
    url: record.url,
    conclusion: record.conclusion,
    labels: record.labels,
    prUrl: record.prUrl,
    closed: Boolean(record.closed),
    updatedAt: new Date().toISOString(),
  };
}

function renderDashboard(index: Record<string, DashboardEntry>): string {
  const rows = Object.values(index)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((entry) => `| ${entry.repo} | [${entry.item}](${entry.url}) | ${entry.conclusion} | ${entry.labels.join(', ') || ''} | ${entry.prUrl || ''} | ${entry.closed ? 'yes' : 'no'} | ${entry.updatedAt} |`)
    .join('\n');
  return `# PostHog Watcher dashboard\n\n| Repo | Item | Conclusion | Labels | PR | Closed | Updated |\n| --- | --- | --- | --- | --- | --- | --- |\n${rows}\n`;
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
