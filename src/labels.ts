export function filterAllowedLabels(requested: string[], allowlist: string[], existingLabels: string[]): string[] {
  const allow = new Set(allowlist.map(normalize));
  const existingByNormalized = new Map(existingLabels.map((label) => [normalize(label), label]));
  const result: string[] = [];

  for (const label of requested) {
    const normalized = normalize(label);
    const existing = existingByNormalized.get(normalized);
    if (allow.has(normalized) && existing && !result.includes(existing)) {
      result.push(existing);
    }
  }

  return result;
}

const ISSUE_TYPE_LABELS: Record<string, string[]> = {
  bug: ['bug'],
  feature: ['enhancement', 'feature'],
  docs: ['docs', 'documentation'],
  question: ['question'],
};

export function issueTypeLabel(issueType: string, allowlist: string[], existingLabels: string[]): string | undefined {
  const candidates = ISSUE_TYPE_LABELS[issueType] ?? [];
  return filterAllowedLabels(candidates, allowlist, existingLabels)[0];
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
