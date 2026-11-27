import {
  CORE_PROMPT,
  DEPLOYMENT_RULES,
  INTERACTIVE_UI_RULES,
  MEDIA_RULES,
  PLATFORM_RULES,
  PREVIEW_RUNTIME_RULES,
  SCOUT_RULES,
  SEO_RULES,
} from "./message-builder.js";
import { MOBILE_TOOL_RULES } from "./expo-tool-rules.js";
import { PLATFORM_PUBLISH_RULES } from "./platform-publish-rules.js";

/**
 * Собирает системный промт под конкретный каталог инструментов запуска.
 *
 * Правило простое: блок, который говорит «зови deploy.status» или «зови expo.build», включается
 * только вместе с этой группой. Иначе модель получает инструкцию про инструмент, которого нет:
 * она либо тратит шаг на отказ, либо обещает пользователю действие, которое не может выполнить.
 *
 * Сам `SYSTEM_PROMPT` остаётся полным — он нужен тестам и совместимости; выбор делает рантайм
 * один раз на запуск, вместе с `selectToolNames`.
 */
export function systemPromptFor(toolNames: readonly string[]): string {
  let deploy = false;
  let expo = false;
  for (const name of toolNames) {
    if (name.startsWith("deploy.")) deploy = true;
    else if (name.startsWith("expo.")) expo = true;
  }
  return CORE_PROMPT +
    (expo ? MOBILE_TOOL_RULES : "") +
    (deploy ? DEPLOYMENT_RULES : "") +
    PLATFORM_PUBLISH_RULES +
    SCOUT_RULES +
    MEDIA_RULES +
    INTERACTIVE_UI_RULES +
    PLATFORM_RULES +
    PREVIEW_RUNTIME_RULES +
    SEO_RULES;
}
