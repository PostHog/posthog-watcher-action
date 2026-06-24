import * as github from '@actions/github';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { git } from './git.js';
import type { Octokit } from './github.js';

interface CommitChangesOptions {
  branch: string;
  message: string;
  expectedHeadOid: string;
  createBranch: boolean;
  cwd?: string;
}

interface GraphqlCommitResponse {
  createCommitOnBranch: {
    commit: {
      oid: string;
      url: string;
    };
  };
}

interface FileAddition {
  path: string;
  contents: string;
}

interface FileDeletion {
  path: string;
}

export async function commitChangesWithGitHubSignature(octokit: Octokit, options: CommitChangesOptions): Promise<{ oid: string; url: string }> {
  const cwd = options.cwd ?? process.cwd();
  const changes = await collectWorkingTreeChanges(cwd);
  if (!changes.additions.length && !changes.deletions.length) {
    throw new Error('No tracked file changes to commit.');
  }

  const { owner, repo } = github.context.repo;
  if (options.createBranch) {
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${options.branch}`,
      sha: options.expectedHeadOid,
    });
  }

  const response = await octokit.graphql<GraphqlCommitResponse>(
    `mutation CreateSignedCommit($input: CreateCommitOnBranchInput!) {
      createCommitOnBranch(input: $input) {
        commit {
          oid
          url
        }
      }
    }`,
    {
      input: {
        branch: {
          repositoryNameWithOwner: `${owner}/${repo}`,
          branchName: options.branch,
        },
        expectedHeadOid: options.expectedHeadOid,
        message: {
          headline: options.message,
        },
        fileChanges: changes,
      },
    },
  );

  return response.createCommitOnBranch.commit;
}

async function collectWorkingTreeChanges(cwd: string): Promise<{ additions: FileAddition[]; deletions: FileDeletion[] }> {
  const status = await git(['diff', '--name-status', '-z'], cwd);
  const entries = parseNameStatus(status);
  const additions: FileAddition[] = [];
  const deletions: FileDeletion[] = [];

  for (const entry of entries) {
    if (entry.deletePath) deletions.push({ path: entry.deletePath });
    if (entry.addPath) {
      const contents = await readFile(path.join(cwd, entry.addPath));
      additions.push({ path: entry.addPath, contents: contents.toString('base64') });
    }
  }

  return { additions, deletions };
}

function parseNameStatus(output: string): Array<{ addPath?: string; deletePath?: string }> {
  const parts = output.split('\0').filter(Boolean);
  const entries: Array<{ addPath?: string; deletePath?: string }> = [];

  for (let index = 0; index < parts.length; ) {
    const status = parts[index++];
    if (!status) break;
    const code = status[0];

    if (code === 'R' || code === 'C') {
      const oldPath = parts[index++];
      const newPath = parts[index++];
      if (!oldPath || !newPath) break;
      if (code === 'R') entries.push({ deletePath: oldPath, addPath: newPath });
      else entries.push({ addPath: newPath });
      continue;
    }

    const changedPath = parts[index++];
    if (!changedPath) break;
    if (code === 'D') entries.push({ deletePath: changedPath });
    else entries.push({ addPath: changedPath });
  }

  return entries;
}
