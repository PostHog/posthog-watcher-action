import { createHash } from 'node:crypto';
import type { IssueSnapshot } from './issue-context.js';

export function computeIssueSnapshotHash(issue: IssueSnapshot, commentMarker: string): string {
  const payload = {
    title: issue.title,
    body: issue.body,
    labels: issue.labels.filter((label) => !label.startsWith('posthog-watcher:')).sort(),
    comments: issue.comments
      .filter((comment) => !comment.body.includes(commentMarker))
      .map((comment) => ({ author: comment.author, body: comment.body, createdAt: comment.createdAt })),
  };

  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function findWatcherSnapshot(issue: IssueSnapshot, commentMarker: string): { hash?: string; url?: string } {
  const watcherComment = [...issue.comments].reverse().find((comment) => comment.body.includes(commentMarker));
  if (!watcherComment) return {};
  const hash = watcherComment.body.match(/<!-- posthog-watcher-snapshot:([a-f0-9]{64}) -->/)?.[1];
  return { hash, url: watcherComment.url };
}
