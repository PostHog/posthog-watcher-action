// Parse unified-diff patches (as returned per-file by the GitHub pulls.listFiles
// API) into the set of RIGHT-side line numbers that can carry an inline review
// comment. GitHub rejects a whole review if any inline comment targets a line
// that is not part of the diff, so pr-review validates every finding against
// this set before posting.

export interface PullRequestFile {
  filename: string;
  status?: string;
  patch?: string;
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

// Returns the new-file line numbers that appear on the RIGHT side of the diff
// (added and context lines). These are the lines an inline comment may target
// with `side: 'RIGHT'`.
export function reviewableLines(patch: string | undefined): Set<number> {
  const lines = new Set<number>();
  if (!patch) return lines;

  let newLine = 0;
  let inHunk = false;
  const rawLines = patch.split('\n');
  // A patch ending in '\n' yields a trailing '' that is not a diff line;
  // counting it as context would admit a phantom line number past the hunk.
  if (rawLines[rawLines.length - 1] === '') rawLines.pop();
  for (const raw of rawLines) {
    const header = raw.match(HUNK_HEADER);
    if (header) {
      newLine = Number.parseInt(header[1] ?? '0', 10);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;

    const marker = raw[0];
    if (marker === '+') {
      lines.add(newLine);
      newLine += 1;
    } else if (marker === '-') {
      // Deletion: consumes an old-file line only, does not advance the new file.
    } else if (marker === '\\') {
      // "\ No newline at end of file" — metadata, ignore.
    } else {
      // Context line (leading space, or an empty line inside the hunk).
      lines.add(newLine);
      newLine += 1;
    }
  }
  return lines;
}

export function reviewableLinesByFile(files: PullRequestFile[]): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  for (const file of files) {
    map.set(file.filename, reviewableLines(file.patch));
  }
  return map;
}
