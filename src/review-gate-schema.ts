export interface ReviewGateResult {
  approve: boolean;
  substantiveFix: boolean;
  confidence: number;
  reason: string;
  risks: string[];
}

export function parseReviewGate(text: string, requireSubstantiveFix = false): ReviewGateResult {
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last <= first) return rejectedResult('review gate did not return JSON');

  try {
    const raw = JSON.parse(text.slice(first, last + 1)) as Partial<ReviewGateResult>;
    const confidence = typeof raw.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence)) : 0;
    const substantiveFix = raw.substantiveFix === true;
    return {
      approve: Boolean(raw.approve) && confidence >= 0.75 && (!requireSubstantiveFix || substantiveFix),
      substantiveFix,
      confidence,
      reason: typeof raw.reason === 'string' ? raw.reason : '',
      risks: Array.isArray(raw.risks) ? raw.risks.filter((risk): risk is string => typeof risk === 'string') : [],
    };
  } catch {
    return rejectedResult('review gate JSON parse failed');
  }
}

function rejectedResult(reason: string): ReviewGateResult {
  return { approve: false, substantiveFix: false, confidence: 0, reason, risks: [] };
}
