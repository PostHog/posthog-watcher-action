import { createHash } from 'node:crypto';
import type { IssueSnapshot } from './issue-context.js';

export interface IssueSnapshotHashOptions {
  managedLabelPrefix?: string;
  mode?: string;
  allowFix?: boolean;
  allowClose?: boolean;
  requireFixCommand?: boolean;
  blockFeatureFixes?: boolean;
  validationCommand?: string;
  reproductionCommand?: string;
  requireReproduction?: boolean;
  repoMemoryEnabled?: boolean;
  progressComments?: boolean;
}

export function computeIssueSnapshotHash(issue: IssueSnapshot, commentMarker: string, options: IssueSnapshotHashOptions = {}): string {
  const managedLabelPrefix = options.managedLabelPrefix ?? 'posthog-watcher:';
  const payload = {
    title: issue.title,
    body: issue.body,
    labels: issue.labels.filter((label) => !label.startsWith(managedLabelPrefix)).sort(),
    comments: issue.comments
      .filter((comment) => !comment.body.includes(commentMarker))
      .map((comment) => ({ author: comment.author, body: comment.body, createdAt: comment.createdAt })),
    watcherConfig: {
      mode: options.mode,
      allowFix: Boolean(options.allowFix),
      allowClose: Boolean(options.allowClose),
      requireFixCommand: Boolean(options.requireFixCommand),
      blockFeatureFixes: Boolean(options.blockFeatureFixes),
      validationCommand: options.validationCommand ?? '',
      reproductionCommand: options.reproductionCommand ?? '',
      requireReproduction: Boolean(options.requireReproduction),
      repoMemoryEnabled: options.repoMemoryEnabled !== false,
      progressComments: options.progressComments !== false,
    },
  };

  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function findWatcherSnapshot(issue: IssueSnapshot, commentMarker: string): { hash?: string; url?: string } {
  const watcherComment = [...issue.comments].reverse().find((comment) => comment.body.includes(commentMarker));
  if (!watcherComment) return {};
  const hash = watcherComment.body.match(/<!-- posthog-watcher-snapshot:([a-f0-9]{64}) -->/)?.[1];
  return { hash, url: watcherComment.url };
}
