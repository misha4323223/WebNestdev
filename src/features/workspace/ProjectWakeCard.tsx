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
  return (
    <div className="project-wake" role="status" aria-live="polite">
      <div className="project-wake-card">
        <NestLoader size={54} label="Подготовка рабочего пространства" />
        <strong>{error ? "Не удалось подготовить рабочее пространство" : "Подготовка рабочего пространства"}</strong>
        {!error && progress.total > 0 && (
          <div
            className="project-wake-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label="Подготовка рабочего пространства"
          >
            <span style={{ width: percent + "%" }} />
          </div>
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
