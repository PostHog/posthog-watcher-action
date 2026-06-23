const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /ghs_[A-Za-z0-9_]{20,}/g,
];

export function redactSecrets(value: string, explicitSecrets: Array<string | undefined> = []): string {
  let redacted = value;
  for (const secret of explicitSecrets) {
    if (secret) redacted = redacted.split(secret).join('[REDACTED]');
  }
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED]');
  }
  return redacted;
}

export function redactJson(value: unknown, explicitSecrets: Array<string | undefined> = []): unknown {
  if (typeof value === 'string') return redactSecrets(value, explicitSecrets);
  if (Array.isArray(value)) return value.map((item) => redactJson(item, explicitSecrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactJson(item, explicitSecrets)]));
  }
  return value;
}
