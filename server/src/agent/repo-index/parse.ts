import type { RepoFile, RepoImport, RepoLanguage } from "./types.js";

/**
 * A small, dependency-free parser for the index.
 *
 * The production image installs only runtime dependencies, so importing the TypeScript compiler
 * here would either add tens of megabytes to the server or fail at runtime. The index does not need
 * a type checker: it needs import edges and exported names for search, and `fs.outline` remains the
 * exact symbol reader. The regexes below are deliberately conservative; an edge that is missed is
 * better than a false target that sends the model to the wrong file.
 */
const JS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const JS_IMPORT_RE = /\bimport\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g;
const JS_EXPORT_FROM_RE = /\bexport\s+(?:type\s+)?[^'"]*?\s+from\s+["']([^"']+)["']/g;
const JS_REQUIRE_RE = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
const JS_DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const PY_FROM_RE = /^\s*from\s+(\.+[\w.]*)\s+import\b/gm;
const PY_IMPORT_RE = /^\s*import\s+([\w.]+)/gm;
const CSS_IMPORT_RE = /@import\s+(?:url\()?["']?([^"')\s;]+)/g;
const HTML_LOCAL_RE = /\b(?:src|href)=["']([^"'#]+)["']/g;

const JS_SYMBOL_RES = [
  /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm,
  /^\s*export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
  /^\s*export\s+(?:interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
  /^\s*export\s*\{([^}]*)\}/gm,
];
const PY_SYMBOL_RES = [
  /^(?:async\s+)?def\s+([A-Za-z_]\w*)/gm,
  /^class\s+([A-Za-z_]\w*)/gm,
];

const MAX_IMPORTS_PER_FILE = 200;
const MAX_SYMBOLS_PER_FILE = 100;

export function languageFor(extension: string): RepoLanguage {
  if (extension === ".ts" || extension === ".mts" || extension === ".cts") return "ts";
  if (extension === ".tsx") return "tsx";
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return "js";
  if (extension === ".jsx") return "jsx";
  if (extension === ".py" || extension === ".pyi") return "python";
  if (extension === ".css" || extension === ".scss" || extension === ".sass" || extension === ".less") return "css";
  if (extension === ".html" || extension === ".htm") return "html";
  if (extension === ".json" || extension === ".jsonc") return "json";
  return "other";
}

export function isJavaScriptLanguage(language: RepoLanguage) {
  return language === "ts" || language === "tsx" || language === "js" || language === "jsx";
}

/** Remove comments before looking for imports: a commented-out import is not a dependency. */
function withoutJsComments(value: string) {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function withoutPythonComments(value: string) {
  return value.replace(/(^|[^#])#.*$/gm, "$1");
}

function normalizeSpecifier(value: string) {
  const specifier = value.trim().replace(/[?#].*$/, "");
  if (!specifier || /^(?:https?:|data:|mailto:|tel:|#)/i.test(specifier)) return "";
  return specifier;
}

function addSpecifier(result: Map<string, RepoImport>, raw: string) {
  const specifier = normalizeSpecifier(raw);
  if (!specifier || result.has(specifier)) return;
  const local = specifier.startsWith(".") || specifier.startsWith("/");
  result.set(specifier, { specifier, external: !local });
}

function parseJavaScript(content: string, result: Map<string, RepoImport>) {
  const cleaned = withoutJsComments(content);
  for (const expression of [JS_IMPORT_RE, JS_EXPORT_FROM_RE, JS_REQUIRE_RE, JS_DYNAMIC_IMPORT_RE]) {
    expression.lastIndex = 0;
    for (const match of cleaned.matchAll(expression)) {
      if (match[1]) addSpecifier(result, match[1]);
    }
  }
}

function parsePython(content: string, result: Map<string, RepoImport>) {
  const cleaned = withoutPythonComments(content);
  PY_FROM_RE.lastIndex = 0;
  for (const match of cleaned.matchAll(PY_FROM_RE)) {
    if (match[1]) addSpecifier(result, match[1]);
  }
  PY_IMPORT_RE.lastIndex = 0;
  for (const match of cleaned.matchAll(PY_IMPORT_RE)) {
    if (match[1]) addSpecifier(result, match[1]);
  }
}

function parseCss(content: string, result: Map<string, RepoImport>) {
  CSS_IMPORT_RE.lastIndex = 0;
  for (const match of content.matchAll(CSS_IMPORT_RE)) {
    if (match[1]) addSpecifier(result, match[1]);
  }
}

function parseHtml(content: string, result: Map<string, RepoImport>) {
  HTML_LOCAL_RE.lastIndex = 0;
  for (const match of content.matchAll(HTML_LOCAL_RE)) {
    if (match[1]) addSpecifier(result, match[1]);
  }
}

function parseJavaScriptSymbols(content: string) {
  const names = new Set<string>();
  for (const expression of JS_SYMBOL_RES.slice(0, 3)) {
    expression.lastIndex = 0;
    for (const match of content.matchAll(expression)) {
      if (match[1]) names.add(match[1]);
    }
  }
  const exported = JS_SYMBOL_RES[3];
  exported.lastIndex = 0;
  for (const match of content.matchAll(exported)) {
    for (const part of (match[1] ?? "").split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return [...names];
}

function parsePythonSymbols(content: string) {
  const names = new Set<string>();
  for (const expression of PY_SYMBOL_RES) {
    expression.lastIndex = 0;
    for (const match of content.matchAll(expression)) {
      if (match[1]) names.add(match[1]);
    }
  }
  return [...names];
}

export type ParsedSource = Pick<RepoFile, "language" | "lines" | "imports" | "symbols">;

/** Parse one text file. Input is already checked for binary content by the builder. */
export function parseSource(extension: string, content: string): ParsedSource {
  const language = languageFor(extension);
  const imports = new Map<string, RepoImport>();
  if (isJavaScriptLanguage(language)) parseJavaScript(content, imports);
  else if (language === "python") parsePython(content, imports);
  else if (language === "css") parseCss(content, imports);
  else if (language === "html") parseHtml(content, imports);

  let symbols: string[] = [];
  if (isJavaScriptLanguage(language)) symbols = parseJavaScriptSymbols(content);
  else if (language === "python") symbols = parsePythonSymbols(content);

  return {
    language,
    lines: content ? content.split(/\r?\n/).length : 0,
    imports: [...imports.values()].slice(0, MAX_IMPORTS_PER_FILE),
    symbols: symbols.slice(0, MAX_SYMBOLS_PER_FILE),
  };
}

export function isLocalSpecifier(specifier: string) {
  return specifier.startsWith(".") || specifier.startsWith("/");
}
