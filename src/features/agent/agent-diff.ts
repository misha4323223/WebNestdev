/** One rendered line of an action's file preview. */
export type CodeLineKind = "context" | "add" | "remove" | "error";
export type CodeLine = {
  kind: CodeLineKind;
  text: string;
  /** Old line number for a removal, new line number for context and additions. */
  line: number;
  sign: "" | "+" | "-" | "!";
};
export type CodePreview = {
  lines: CodeLine[];
  added: number;
  removed: number;
  /** True when the preview was cut by the line limit. */
  truncated: boolean;
  /** Total number of lines in the full preview before the cut. */
  total: number;
};

const MAX_LINES = 2000;
/** Above this many cells the quadratic LCS is replaced by a plain replacement block. */
const MAX_DIFF_CELLS = 900_000;

function splitLines(value: string) {
  return value ? value.split("\n") : [];
}

function clampLines(lines: CodeLine[]): CodePreview {
  const total = lines.length;
  const shown = lines.length > MAX_LINES ? lines.slice(0, MAX_LINES) : lines;
  return {
    lines: shown,
    added: lines.filter(line => line.kind === "add").length,
    removed: lines.filter(line => line.kind === "remove").length,
    truncated: total > shown.length,
    total,
  };
}

function lcsOps(oldLines: string[], newLines: string[]): Array<{ kind: "context" | "add" | "remove"; text: string }> {
  const rows = oldLines.length;
  const cols = newLines.length;
  if (!rows || !cols) {
    return [
      ...oldLines.map(text => ({ kind: "remove" as const, text })),
      ...newLines.map(text => ({ kind: "add" as const, text })),
    ];
  }
  if (rows * cols > MAX_DIFF_CELLS) {
    return [
      ...oldLines.map(text => ({ kind: "remove" as const, text })),
      ...newLines.map(text => ({ kind: "add" as const, text })),
    ];
  }
  const width = cols + 1;
  const table = new Uint32Array((rows + 1) * width);
  for (let row = rows - 1; row >= 0; row--) {
    for (let col = cols - 1; col >= 0; col--) {
      table[row * width + col] = oldLines[row] === newLines[col]
        ? table[(row + 1) * width + col + 1] + 1
        : Math.max(table[(row + 1) * width + col], table[row * width + col + 1]);
    }
  }
  const ops: Array<{ kind: "context" | "add" | "remove"; text: string }> = [];
  let row = 0;
  let col = 0;
  while (row < rows && col < cols) {
    if (oldLines[row] === newLines[col]) {
      ops.push({ kind: "context", text: oldLines[row] });
      row++;
      col++;
    } else if (table[(row + 1) * width + col] >= table[row * width + col + 1]) {
      ops.push({ kind: "remove", text: oldLines[row] });
      row++;
    } else {
      ops.push({ kind: "add", text: newLines[col] });
      col++;
    }
  }
  while (row < rows) ops.push({ kind: "remove", text: oldLines[row++] });
  while (col < cols) ops.push({ kind: "add", text: newLines[col++] });
  return ops;
}

/**
 * A compact line diff with a few lines of context around the changed block.
 * The common prefix and suffix are not walked line by line, so a one-line edit
 * in a large file stays cheap.
 */
export function diffLines(before: string, after: string, context = 3): CodePreview {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix++;

  const oldEnd = oldLines.length - suffix;
  const newEnd = newLines.length - suffix;
  if (prefix === oldEnd && prefix === newEnd) return { lines: [], added: 0, removed: 0, truncated: false, total: 0 };

  const ops = lcsOps(oldLines.slice(prefix, oldEnd), newLines.slice(prefix, newEnd));
  const leadingStart = Math.max(0, prefix - context);
  const leading = oldLines.slice(leadingStart, prefix);
  const trailing = oldLines.slice(oldEnd, Math.min(oldLines.length, oldEnd + context));

  const lines: CodeLine[] = [];
  let oldNumber = leadingStart + 1;
  let newNumber = leadingStart + 1;
  for (const text of leading) {
    lines.push({ kind: "context", text, line: newNumber++, sign: "" });
    oldNumber++;
  }
  for (const op of ops) {
    if (op.kind === "remove") {
      lines.push({ kind: "remove", text: op.text, line: oldNumber++, sign: "-" });
    } else if (op.kind === "add") {
      lines.push({ kind: "add", text: op.text, line: newNumber++, sign: "+" });
    } else {
      lines.push({ kind: "context", text: op.text, line: newNumber++, sign: "" });
      oldNumber++;
    }
  }
  for (const text of trailing) {
    lines.push({ kind: "context", text, line: newNumber++, sign: "" });
    oldNumber++;
  }
  return clampLines(lines);
}

/** A whole file shown as added or removed lines, for a new file or a deletion. */
export function fileLines(value: string, kind: "add" | "remove"): CodePreview {
  const lines = splitLines(value).map((text, index) => ({
    kind,
    text,
    line: index + 1,
    sign: kind === "add" ? "+" as const : "-" as const,
  }));
  return clampLines(lines);
}

/** A read window: line numbers are relative to the window, the offset is named in the header. */
export function readLines(value: string): CodePreview {
  const lines = splitLines(value).map((text, index) => ({
    kind: "context" as const,
    text,
    line: index + 1,
    sign: "" as const,
  }));
  return clampLines(lines);
}

/** Plain command output, with stderr marked in red so a failed command is easy to spot. */
export function commandLines(stdout: string, stderr: string): CodePreview {
  const lines: CodeLine[] = [];
  let number = 1;
  for (const text of splitLines(stdout)) {
    lines.push({ kind: "context", text, line: number++, sign: "" });
  }
  if (stderr.trim()) {
    if (stdout.trim()) lines.push({ kind: "context", text: "", line: number++, sign: "" });
    for (const text of splitLines(stderr)) {
      lines.push({ kind: "error", text, line: number++, sign: "!" });
    }
  }
  return clampLines(lines);
}

/** The text a copy button puts on the clipboard: a real unified-style diff, not the screen markup. */
export function previewToText(preview: CodePreview) {
  return preview.lines
    .map(line => line.kind === "add" ? "+" + line.text : line.kind === "remove" ? "-" + line.text : line.text)
    .join("\n");
}

/** A generic text preview used for tool output that is not a file change. */
export function textLines(value: string, kind: CodeLineKind = "context"): CodePreview {
  const lines = splitLines(value).map((text, index) => ({
    kind,
    text,
    line: index + 1,
    sign: kind === "add" ? "+" as const : kind === "remove" ? "-" as const : kind === "error" ? "!" as const : "" as const,
  }));
  return clampLines(lines);
}
