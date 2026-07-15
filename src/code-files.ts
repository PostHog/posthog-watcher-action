// Shared heuristics for deciding which changed files are worth an AI review.
// Used by both commit-review (single commit) and pr-review (pull request diff).

const CODE_FILE_PATTERN = /(?:^|\/)(?:Dockerfile(?:\..+)?|Makefile|CMakeLists\.txt)$|\.(c|cc|clj|cljs|cmake|cpp|cs|css|dart|ex|exs|fs|fsx|go|gradle|h|hpp|html|java|js|json|jsonc|jsx|kt|kts|lua|m|mm|php|pl|properties|proto|py|r|rb|rs|scala|sh|sql|swift|toml|ts|tsx|vue|xml|yml|yaml)$/i;
const DOCS_ONLY_PATTERN = /(^|\/)docs?\/|\.mdx?$/i;

export function isReviewableCodeFile(file: string): boolean {
  return CODE_FILE_PATTERN.test(file) && !DOCS_ONLY_PATTERN.test(file);
}
