import type { TriageResult } from './triage-schema.js';
import type { SecurityAssessment } from './security.js';

export function desiredManagedLabels(prefix: string, triage: TriageResult, security: SecurityAssessment): string[] {
  const labels = new Set<string>();
  if (triage.needsMoreInfo) labels.add(`${prefix}needs-info`);
  if (triage.fix.straightforward) labels.add(`${prefix}fix-ready`);
  if (triage.closeProposal.propose) labels.add(`${prefix}close-proposed`);
  if (security.sensitive) labels.add(`${prefix}security-review`);
  if (triage.fix.risk === 'high' && !triage.fix.straightforward) labels.add(`${prefix}blocked`);
  return [...labels];
}

export function staleManagedLabels(existingLabels: string[], desiredLabels: string[], prefix: string): string[] {
  const desired = new Set(desiredLabels.map((label) => label.toLowerCase()));
  return existingLabels.filter((label) => label.toLowerCase().startsWith(prefix.toLowerCase()) && !desired.has(label.toLowerCase()));
}
