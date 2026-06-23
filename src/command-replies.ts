import * as github from '@actions/github';
import { findOpenPullRequestForBranch, type Octokit, upsertIssueComment } from './github.js';
import type { ActionInputs } from './inputs.js';
import { runPi } from './pi-runner.js';
import { redactSecrets } from './redact.js';
import { assessIssueSecurity } from './security.js';

export async function replyToCommand(octokit: Octokit, issueNumber: number, inputs: ActionInputs, command: string): Promise<{ conclusion: string; commentUrl: string }> {
  const { owner, repo } = github.context.repo;
  const issue = await octokit.rest.issues.get({ owner, repo, issue_number: issueNumber });
  const labels = issue.data.labels.map((label: string | { name?: string | null }) => (typeof label === 'string' ? label : label.name ?? '')).filter(Boolean);
  const branch = `posthog-watcher/issue-${issueNumber}`;
  const existingPr = await findOpenPullRequestForBranch(octokit, branch);
  const marker = `${inputs.commentMarker} command:${command}`;

  let body = `${marker}\n\n## PostHog Watcher ${command}\n\n`;

  if (command === 'status') {
    body += `- Issue/PR: #${issueNumber}\n- State: ${issue.data.state}\n- Labels: ${labels.join(', ') || '(none)'}\n- Watcher branch: \`${branch}\`\n- Existing watcher PR: ${existingPr?.url ?? '(none)'}\n`;
  } else if (command === 'explain') {
    body += `Latest visible watcher state can be found in the marker-backed triage comment.\n\n- Labels: ${labels.join(', ') || '(none)'}\n- Existing watcher PR: ${existingPr?.url ?? '(none)'}\n`;
  } else if (command === 'ask') {
    const security = assessIssueSecurity({
      owner,
      repo,
      number: issueNumber,
      title: issue.data.title,
      body: issue.data.body ?? '',
      author: issue.data.user?.login ?? 'unknown',
      url: issue.data.html_url,
      labels,
      comments: [],
    });
    if (security.sensitive && !inputs.allowSecurityAi) {
      body += 'This item looks security-sensitive, so watcher did not send it to pi/OpenAI. Human review is required.';
    } else {
      const question = getCommentBody();
      const answer = await runPi({
        inputs,
        tools: ['read', 'grep', 'find', 'ls'],
        prompt: `Answer this maintainer question about issue/PR #${issueNumber}. Be concise. Do not mutate files or GitHub state.\n\nQuestion/comment:\n\`\`\`\n${question}\n\`\`\``,
      });
      body += answer;
    }
  }

  body = redactSecrets(body, [inputs.openaiApiKey, inputs.githubToken]);
  const commentUrl = inputs.dryRun ? '' : await upsertIssueComment(octokit, issueNumber, marker, body);
  return { conclusion: `${command} replied`, commentUrl };
}

function getCommentBody(): string {
  const payload = github.context.payload as { comment?: { body?: string } };
  return payload.comment?.body ?? '';
}
