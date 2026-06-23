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

export async function writeStateRecord(octokit: Octokit, inputs: ActionInputs, record: StateRecord): Promise<void> {
  if (!inputs.stateEnabled || inputs.dryRun) return;

  const { owner, repo } = stateRepository(inputs);
  await ensureBranch(octokit, owner, repo, inputs.stateBranch);
  const path = `records/${record.owner}-${record.repo}/${record.kind}s/${record.numberOrSha}.md`;
  const body = renderRecord(record);
  await upsertFile(octokit, owner, repo, inputs.stateBranch, path, body, `Update watcher state for ${record.kind} ${record.numberOrSha}`);
  await upsertFile(octokit, owner, repo, inputs.stateBranch, 'dashboard.md', renderDashboardRow(record), 'Update watcher dashboard');
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
    await octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: base.data.object.sha });
  }
}

async function upsertFile(octokit: Octokit, owner: string, repo: string, branch: string, path: string, content: string, message: string): Promise<void> {
  let sha: string | undefined;
  try {
    const existing = await octokit.rest.repos.getContent({ owner, repo, path, ref: branch });
    if (!Array.isArray(existing.data) && existing.data.type === 'file') sha = existing.data.sha;
  } catch (error) {
    core.debug(`State file ${path} does not exist yet or branch is missing: ${error instanceof Error ? error.message : String(error)}`);
  }

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

function renderRecord(record: StateRecord): string {
  return `# ${record.kind} ${record.numberOrSha}: ${record.title}\n\n- Repo: ${record.owner}/${record.repo}\n- URL: ${record.url}\n- Conclusion: ${record.conclusion}\n- Labels: ${record.labels.join(', ') || '(none)'}\n- PR: ${record.prUrl || '(none)'}\n- Closed: ${record.closed ? 'yes' : 'no'}\n- Updated: ${new Date().toISOString()}\n\n\`\`\`json\n${JSON.stringify(record.data, null, 2)}\n\`\`\`\n`;
}

function renderDashboardRow(record: StateRecord): string {
  return `# PostHog Watcher dashboard\n\nLatest touched item:\n\n| Repo | Item | Conclusion | Labels | PR | Closed | Updated |\n| --- | --- | --- | --- | --- | --- | --- |\n| ${record.owner}/${record.repo} | [${record.kind} ${record.numberOrSha}](${record.url}) | ${record.conclusion} | ${record.labels.join(', ') || ''} | ${record.prUrl || ''} | ${record.closed ? 'yes' : 'no'} | ${new Date().toISOString()} |\n`;
}
