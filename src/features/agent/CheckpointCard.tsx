import { History } from "lucide-react";
import type { CheckpointNotice } from "./checkpoint-cards";

/**
 * Карточка чекпоинта живёт внутри ответа агента, который завершил запуск. Она не исчезает
 * при следующем сообщении и восстанавливается вместе с историей чата.
 */
export function CheckpointCard({
  checkpoint,
  target,
  busy,
  onPrepare,
  onRollback,
  onCancel,
  onOpenChanges,
}: {
  checkpoint: CheckpointNotice;
  target?: { sha: string; shortSha: string };
  busy?: boolean;
  onPrepare: () => void;
  onRollback: () => void;
  onCancel: () => void;
  onOpenChanges?: () => void;
}) {
  return <div className="changes-card">
    <div className="changes-card-head">
      <History size={14}/>
      <div className="changes-card-text">
        <strong>Изменения сохранены · {checkpoint.shortSha}</strong>
        <small>
          {checkpoint.filesChanged > 0 ? "Файлов: " + checkpoint.filesChanged + ". " : ""}
          {target
            ? "Вернуть файлы к точке " + target.shortSha + "? Всё, что было после неё, останется в истории."
            : "Точка истории проекта. Если этот запуск что-то сломал, можно откатиться."}
        </small>
      </div>
    </div>
    <div className="changes-card-actions">
      {target
        ? <>
            <button type="button" className="ghost-button changes-card-rollback" onClick={onRollback} disabled={busy}>
              {busy ? "Откатываю…" : "Вернуть"}
            </button>
            <button type="button" className="ghost-button changes-card-cancel" onClick={onCancel} disabled={busy}>Отмена</button>
          </>
        : <>
            <button type="button" className="ghost-button changes-card-rollback" onClick={onPrepare} disabled={busy}>Откатить</button>
            {onOpenChanges && <button type="button" className="ghost-button changes-card-open" onClick={onOpenChanges}>Открыть историю</button>}
          </>}
    </div>
  </div>;
}
