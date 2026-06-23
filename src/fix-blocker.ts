import type { RelatedItem } from './related.js';
import type { TriageResult } from './triage-schema.js';

export function findPreExistingFixBlocker(relatedItems: RelatedItem[], triage: TriageResult): string | undefined {
  const closingPullRequest = relatedItems.find(
    (item) => item.type === 'pull_request' && item.state === 'open' && item.reason === 'closing-pr',
  );
  if (closingPullRequest) {
    return `An open related PR already appears to address this issue: #${closingPullRequest.number} ${closingPullRequest.url}`;
  }

  if (
    triage.closeProposal.propose &&
    (triage.closeProposal.category === 'duplicate' || triage.closeProposal.category === 'already-fixed') &&
    triage.closeProposal.canonicalUrl
  ) {
    return `Triage proposed this issue as ${triage.closeProposal.category} of ${triage.closeProposal.canonicalUrl}; skipping a duplicate fix PR.`;
  }

  return undefined;
}
