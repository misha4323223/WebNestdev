export type QaScenarioStep =
  | { action: "goto"; path: string }
  | { action: "click"; selector: string }
  | { action: "fill"; selector: string; value: string }
  | { action: "press"; selector: string; key: string }
  | { action: "expectText"; text: string }
  | { action: "expectUrl"; pattern: string }
  | { action: "expectVisible"; selector: string };

export type QaScenario = { path: string; steps: QaScenarioStep[]; reason: string; changeKind?: string; confidence?: number };

const route = (value: string) => value.startsWith("/") ? value : "/" + value;

/** Builds a conservative smoke scenario from the task text and affected route.
 * It intentionally prefers observable assertions over destructive actions.
 */
export function planQaScenario(task: string, affectedRoute = "/", changeKind = "unknown", confidence = 0.35): QaScenario {
  const text = task.toLowerCase();
  const path = route(affectedRoute || "/");
  const steps: QaScenarioStep[] = [
    { action: "goto", path },
    { action: "expectVisible", selector: "body" },
  ];

  const checks: Array<[RegExp, string, string]> = [
    [/button|кнопк/i, "button", "Task appears to introduce or change a button."],
    [/link|ссылк|navigate|переход/i, "a", "Task appears to change navigation."],
    [/input|form|поле|форма/i, "input, textarea, select", "Task appears to change a form/input."],
  ];
  for (const [pattern, selector, reason] of checks) {
    if (pattern.test(text)) {
      steps.push({ action: "expectVisible", selector });
      return { path, steps, reason, changeKind, confidence };
    }
  }
  return { path, steps, reason: "Generic route smoke scenario; no safe interactive action was inferred.", changeKind, confidence };
}
