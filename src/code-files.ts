// Shared heuristics for deciding which changed files are worth an AI review.
// Used by both commit-review (single commit) and pr-review (pull request diff).

const CODE_FILE_PATTERN = /\.(c|cc|cpp|cs|css|dart|go|h|hpp|java|js|jsx|kt|kts|m|mm|py|rb|rs|sh|swift|ts|tsx|vue|yml|yaml)$/i;
const DOCS_ONLY_PATTERN = /(^|\/)(docs?|examples?)\/|\.mdx?$/i;

export function isReviewableCodeFile(file: string): boolean {
  return CODE_FILE_PATTERN.test(file) && !DOCS_ONLY_PATTERN.test(file);
}
