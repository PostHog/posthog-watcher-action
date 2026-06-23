export interface TriageResult {
  conclusion: string;
  summary: string;
  issueType: 'bug' | 'feature' | 'docs' | 'question' | 'unknown';
  confidence: number;
  labels: string[];
  needsMoreInfo: boolean;
  maintainerComment: string;
  investigation: {
    relevantFiles: string[];
    findings: string[];
  };
  fix: {
    straightforward: boolean;
    reason: string;
    suggestedApproach: string;
    risk: 'low' | 'medium' | 'high';
  };
  closeProposal: {
    propose: boolean;
    category: 'duplicate' | 'already-fixed' | 'not-reproducible' | 'out-of-scope' | 'insufficient-info' | 'none';
    confidence: number;
    reason: string;
    canonicalUrl: string;
  };
}

export function parseTriageResult(text: string): TriageResult {
  const raw = JSON.parse(extractJson(text)) as unknown;
  return normalizeTriageResult(raw);
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) {
    throw new Error(`pi did not return JSON. Output was:\n${text.slice(0, 4000)}`);
  }
  return text.slice(first, last + 1);
}

function normalizeTriageResult(value: unknown): TriageResult {
  const object = asRecord(value);
  const investigation = asRecord(object.investigation ?? {});
  const fix = asRecord(object.fix ?? {});
  const closeProposal = asRecord(object.closeProposal ?? {});
  const closeProposalCategory = enumValue(
    closeProposal.category,
    ['duplicate', 'already-fixed', 'not-reproducible', 'out-of-scope', 'insufficient-info', 'none'],
    'none',
  );
  const closeProposalConfidence = clampNumber(closeProposal.confidence, 0, 1, 0);

  return {
    conclusion: stringValue(object.conclusion, stringValue(object.issueType, 'unknown')),
    summary: stringValue(object.summary, 'No summary returned.'),
    issueType: enumValue(object.issueType, ['bug', 'feature', 'docs', 'question', 'unknown'], 'unknown'),
    confidence: clampNumber(object.confidence, 0, 1, 0),
    labels: stringArray(object.labels),
    needsMoreInfo: Boolean(object.needsMoreInfo),
    maintainerComment: stringValue(object.maintainerComment, ''),
    investigation: {
      relevantFiles: stringArray(investigation.relevantFiles),
      findings: stringArray(investigation.findings),
    },
    fix: {
      straightforward: Boolean(fix.straightforward),
      reason: stringValue(fix.reason, ''),
      suggestedApproach: stringValue(fix.suggestedApproach, ''),
      risk: enumValue(fix.risk, ['low', 'medium', 'high'], 'high'),
    },
    closeProposal: {
      propose: Boolean(closeProposal.propose) && closeProposalConfidence >= 0.9 && closeProposalCategory !== 'none',
      category: closeProposalCategory,
      confidence: closeProposalConfidence,
      reason: stringValue(closeProposal.reason, ''),
      canonicalUrl: stringValue(closeProposal.canonicalUrl, ''),
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function enumValue<const T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && allowed.includes(value as T) ? (value as T) : fallback;
}
