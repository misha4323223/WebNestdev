export type ParsedChange = {
  kind: "ui-element" | "route" | "form-field";
  file: string;
  action: "added" | "removed";
  element?: "button" | "link" | "input" | "textarea" | "select" | "form";
  selector?: string;
  text?: string;
  route?: string;
  evidence: string;
};

export type ChangeParseResult = { changes: ParsedChange[]; files: string[] };

function selectorFromAttrs(element: string, attrs: string) {
  const data = attrs.match(/(data-[\w-]+)\s*=\s*["']([^"']+)["']/i);
  const id = attrs.match(/\bid\s*=\s*["']([^"']+)["']/i);
  const name = attrs.match(/\bname\s*=\s*["']([^"']+)["']/i);
  const aria = attrs.match(/aria-label\s*=\s*["']([^"']+)["']/i);
  if (data) return `[${data[1]}="${data[2].replace(/"/g, '\\"')}"]`;
  if (id) return `#${id[1]}`;
  if (name) return `${element}[name="${name[1]}"]`;
  if (aria) return `${element}[aria-label="${aria[1]}"]`;
  return element;
}

function parseLine(file: string, source: string, action: "added" | "removed"): ParsedChange | null {
  const tag = source.match(/<\s*(button|a|input|textarea|select|form)\b([^>]*)>/i);
  if (!tag) return null;
  const element = tag[1].toLowerCase() as ParsedChange["element"];
  const selector = selectorFromAttrs(element || "button", tag[2]);
  const text = /^(input|textarea|select|form)$/i.test(element || "")
    ? undefined
    : source.replace(/<[^>]+>/g, "").trim() || undefined;
  const kind = /^(input|textarea|select|form)$/i.test(element || "") ? "form-field" : "ui-element";
  return { kind, file, action, element, selector, text, evidence: source.trim().slice(0, 240) };
}

function parseLines(file: string, lines: string[], changes: ParsedChange[]) {
  for (const raw of lines) {
    const line = raw.trimEnd();
    const added = line.startsWith("+") && !line.startsWith("+++");
    const removed = line.startsWith("-") && !line.startsWith("---");
    if (!added && !removed) continue;
    const action = added ? "added" : "removed";
    const source = line.slice(1);
    const element = parseLine(file, source, action);
    if (element) changes.push(element);
    const route = source.match(/(?:path|route|to|href)\s*[:=]\s*["']([^"']+)["']/i);
    if (route && route[1].startsWith("/")) changes.push({ kind: "route", file, action, route: route[1], evidence: source.slice(0, 240) });
  }
}

export function parseUnifiedDiff(diff: string): ChangeParseResult {
  const changes: ParsedChange[] = [];
  const files = new Set<string>();
  let file = "";
  for (const raw of diff.split(/\r?\n/)) {
    const header = raw.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (header) { file = header[2]; files.add(file); continue; }
    if (file) parseLines(file, [raw], changes);
  }
  return { changes, files: [...files] };
}

export function parseChangedSource(file: string, content: string): ChangeParseResult {
  const changes: ParsedChange[] = [];
  parseLines(file, content.split(/\r?\n/).map(line => "+" + line), changes);
  return { changes, files: [file] };
}
