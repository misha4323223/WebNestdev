import { NestLoader } from "../../components/NestLoader";
import type { WakeProgress } from "./useProjectWake";

/** Карточка вместо панелей, пока рабочая папка едет из бакета и распаковывается. */
export function ProjectWakeCard({
  progress,
  error,
  onRetry,
}: {
  progress: WakeProgress;
  error: string;
  onRetry: () => void;
}) {
  const percent = progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;
  const unpacking = progress.phase === "unpacking";
  return (
    <div className="project-wake" role="status" aria-live="polite">
      <div className="project-wake-card">
        <NestLoader size={54} label="Проект просыпается" />
        <strong>{error ? "Проект не проснулся" : "Проект просыпается"}</strong>
        <p>
          {error
            ? "Рабочая область не тронута. Проверьте соединение и попробуйте ещё раз."
            : unpacking
              ? "Архив скачан, распаковываем рабочую папку…"
              : "Возвращаем файлы проекта из холодного архива. Обычно это занимает несколько секунд."}
        </p>
        {!error && progress.total > 0 && (
          <>
            <div
              className="project-wake-track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              aria-label="Восстановление проекта"
            >
              <span style={{ width: percent + "%" }} />
            </div>
            <div className="project-wake-meta">
              <span>
                {megabytes(progress.done)} из {megabytes(progress.total)}
              </span>
              <b>{percent}%</b>
            </div>
          </>
        )}
        {error && <div className="project-wake-error">{error}</div>}
        {error && (
          <button className="ghost-button" onClick={onRetry}>
            Повторить
          </button>
        )}
      </div>
    </div>
  );
}

function megabytes(bytes: number) {
  const value = bytes / (1024 * 1024);
  return (value >= 100 ? value.toFixed(0) : value.toFixed(1)) + " МБ";
}
