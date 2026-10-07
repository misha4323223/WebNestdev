export type QaChangeKind = "ui" | "route" | "form" | "api" | "style" | "config" | "test" | "unknown";

export type QaChangeAnalysis = {
  kind: QaChangeKind;
  confidence: number;
  files: string[];
  reasons: string[];
  requiresBrowser: boolean;
};

export function analyzeChangedFiles(files: string[]): QaChangeAnalysis {
  const normalized = files.map(file => file.replaceAll("\\\\", "/"));
  const text = normalized.join(" ").toLowerCase();
  const reasons: string[] = [];
  let kind: QaChangeKind = "unknown";
  let confidence = 0.35;
  let requiresBrowser = false;

  if (/\\.(tsx|jsx|vue|svelte)$/.test(text)) {
    kind = "ui"; confidence = 0.9; requiresBrowser = true;
    reasons.push("UI component source changed.");
  } else if (/(route|router|pages?\\/|app\\/|navigation)/.test(text)) {
    kind = "route"; confidence = 0.85; requiresBrowser = true;
    reasons.push("Routing or page source changed.");
  } else if (/(form|input|checkout|login|signup|register)/.test(text)) {
    kind = "form"; confidence = 0.9; requiresBrowser = true;
    reasons.push("Form or user-input code changed.");
  } else if (/(api|controller|endpoint|server|backend)/.test(text)) {
    kind = "api"; confidence = 0.8;
    reasons.push("Server/API code changed.");
  } else if (/\\.(css|scss|sass|less)$/.test(text)) {
    kind = "style"; confidence = 0.8; requiresBrowser = true;
    reasons.push("Browser-visible styling changed.");
  } else if (/\\.(yml|yaml|json|env|config|toml)$/.test(text)) {
    kind = "config"; confidence = 0.7;
    reasons.push("Configuration changed.");
  } else if (/(test|spec)/.test(text)) {
    kind = "test"; confidence = 0.85;
    reasons.push("Test source changed.");
  }

  return { kind, confidence, files: normalized, reasons, requiresBrowser };
}
