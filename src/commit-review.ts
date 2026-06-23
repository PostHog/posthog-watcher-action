import * as core from '@actions/core';
import * as github from '@actions/github';
import { git } from './git.js';
import type { ActionInputs } from './inputs.js';
import { runPi } from './pi-runner.js';

export interface CommitReviewResult {
  sha: string;
  conclusion: string;
  skipped: boolean;
  response: string;
}

const CODE_FILE_PATTERN = /\.(c|cc|cpp|cs|css|dart|go|h|hpp|java|js|jsx|kt|kts|m|mm|py|rb|rs|sh|swift|ts|tsx|vue|yml|yaml)$/i;
const DOCS_ONLY_PATTERN = /(^|\/)(docs?|examples?)\/|\.mdx?$/i;

export async function reviewCommit(inputs: ActionInputs): Promise<CommitReviewResult> {
  const sha = inputs.commitSha ?? github.context.sha;
  if (!sha) throw new Error('No commit SHA provided and github.sha is unavailable.');

  const nameStatus = await git(['show', '--name-only', '--format=', sha]);
  const files = nameStatus.split('\n').map((file) => file.trim()).filter(Boolean);
  const codeFiles = files.filter((file) => CODE_FILE_PATTERN.test(file) && !DOCS_ONLY_PATTERN.test(file));

  if (!codeFiles.length) {
    const result = {
      sha,
      conclusion: 'skipped non-code commit',
      skipped: true,
      response: `Skipped commit ${sha}: no code files detected.`,
    };
    await writeSummary(result);
    return result;
  }

  const metadata = await git(['show', '--stat', '--name-status', '--format=fuller', '--find-renames', sha]);
  const patch = await git(['show', '--format=', '--find-renames', '--unified=80', sha]);
  const truncatedPatch = patch.length > 60000 ? `${patch.slice(0, 60000)}\n...<patch truncated>` : patch;

  const response = await runPi({
    inputs,
    tools: ['read', 'grep', 'find', 'ls'],
    prompt: `Review commit ${sha} for narrow, actionable regressions.

This is a manual commit review for a PostHog SDK repository. Follow the karpathy-guidelines skill. Be conservative and evidence-backed.

Changed code files:
${codeFiles.map((file) => `- ${file}`).join('\n')}

Commit metadata:
\`\`\`
${metadata}
\`\`\`

Patch:
\`\`\`
${truncatedPatch}
\`\`\`

Return concise markdown with:
- Verdict: clean | findings | uncertain
- Findings: bullet list with file/line evidence, or none
- Suggested maintainer action

Do not modify files and do not make GitHub API calls.`,
  });

  const result = {
    sha,
    conclusion: summarizeConclusion(response),
    skipped: false,
    response,
  };
  await writeSummary(result);
  return result;
}

async function writeSummary(result: CommitReviewResult): Promise<void> {
  await core.summary
    .addHeading(`PostHog Watcher commit review: ${result.sha}`)
    .addRaw(result.response)
    .write();
}

function summarizeConclusion(response: string): string {
  const verdict = response.match(/Verdict:\s*([^\n]+)/i)?.[1]?.trim();
  return verdict || 'commit review completed';
}
