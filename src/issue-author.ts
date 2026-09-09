import * as core from '@actions/core';
import { TRUSTED_ASSOCIATIONS, type CommandResolution } from './commands.js';
import type { Octokit } from './github.js';
import type { ActionInputs } from './inputs.js';
import type { IssueSnapshot } from './issue-context.js';

export async function shouldSkipIssueAuthor(octokit: Octokit, inputs: ActionInputs, command: CommandResolution, issue: IssueSnapshot): Promise<boolean> {
  if (!inputs.skipSweepTrustedAuthors) return false;
  if (inputs.mode !== 'auto' && inputs.mode !== 'triage' && inputs.mode !== 'investigate' && inputs.mode !== 'sweep') return false;
  if (command.command) return false;
  if (TRUSTED_ASSOCIATIONS.has(issue.authorAssociation.toUpperCase())) return true;

  const permission = await getIssueAuthorRepositoryPermission(octokit, issue);
  if (!permission) return false;
  return TRUSTED_REPOSITORY_PERMISSIONS.has(permission.toLowerCase());
}

const TRUSTED_REPOSITORY_PERMISSIONS = new Set(['admin', 'maintain', 'write', 'triage']);

async function getIssueAuthorRepositoryPermission(octokit: Octokit, issue: IssueSnapshot): Promise<string | undefined> {
  if (!issue.author || issue.author === 'unknown') return undefined;

  try {
    const response = await octokit.rest.repos.getCollaboratorPermissionLevel({
      owner: issue.owner,
      repo: issue.repo,
      username: issue.author,
    });
    const permission = response.data.permission;
    if (permission) {
      core.info(`Issue #${issue.number} author ${issue.author} has repository permission: ${permission}.`);
    }
    return permission;
  } catch (error) {
    const status = typeof error === 'object' && error !== null && 'status' in error ? (error as { status?: number }).status : undefined;
    if (status !== 404) {
      core.warning(`Could not check repository permission for issue #${issue.number} author ${issue.author}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return undefined;
  }
}
