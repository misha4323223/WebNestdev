import "./ui-blocks.css";
import type { UiBlock } from "../../../lib/ui-blocks";
import { UiActions } from "./UiActions";
import { UiChart } from "./UiChart";
import { UiChecklist } from "./UiChecklist";
import { UiChoice } from "./UiChoice";
import { UiDiff } from "./UiDiff";
import { UiForm } from "./UiForm";
import { UiPreview } from "./UiPreview";
import { UiTable } from "./UiTable";

export type UiActionHandler = (prompt: string) => void;

/**
 * Рендерер интерактивных ответов. Он получает уже проверенные блоки и не пытается
 * исполнять разметку: любой неизвестный тип просто не рисуется. `onAction` отправляет
 * готовый текст следующим сообщением агента, поэтому у блока нет собственного доступа
 * к инструментам или сети.
 */
export function UiBlocks({ blocks, projectId, busy, onAction }: {
  blocks: UiBlock[];
  projectId: string;
  busy?: boolean;
  onAction: UiActionHandler;
}) {
  if (!blocks.length) return null;
  return <div className="ui-blocks">
    {blocks.map((block, index) => {
      const key = block.id ?? block.type + "-" + index;
      if (block.type === "choice") return <UiChoice key={key} block={block} busy={busy} onAction={onAction}/>;
      if (block.type === "form") return <UiForm key={key} block={block} busy={busy} onAction={onAction}/>;
      if (block.type === "actions") return <UiActions key={key} block={block} busy={busy} onAction={onAction}/>;
      if (block.type === "checklist") return <UiChecklist key={key} block={block} busy={busy} onAction={onAction}/>;
      if (block.type === "chart") return <UiChart key={key} block={block}/>;
      if (block.type === "table") return <UiTable key={key} block={block}/>;
      if (block.type === "diff") return <UiDiff key={key} block={block}/>;
      if (block.type === "preview") return <UiPreview key={key} block={block} projectId={projectId}/>;
      return null;
    })}
  </div>;
}
