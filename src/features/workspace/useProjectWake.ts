import { useCallback, useEffect, useRef, useState } from "react";
import { getProjectArchive, startProjectRestore, type ProjectArchiveState } from "../../lib/project-api";

/**
 * Холодный ярус глазами панели: проект после долгого простоя лежит в бакете, и первый доступ
 * запускает восстановление в фоне. Пока файлы едут обратно, рабочая область показывает
 * «проект просыпается» с прогрессом, а не пустые файлы и ошибки 409.
 *
 * Опрос идёт, пока проект не вернётся на диск. Если задание упало, панель честно показывает
 * причину и кнопку «Повторить»: повтор — это явное действие, а не бесконечный ретрай на каждом
 * запросе.
 */

export type WakePhase = "checking" | "waking" | "ready" | "failed";
export type WakeProgress = { done: number; total: number; phase: ProjectArchiveState["phase"] };

const POLL_INTERVAL_MS = 900;

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function useProjectWake(projectId: string, onReady: () => void) {
  const ready = useRef(onReady);
  ready.current = onReady;
  const [phase, setPhase] = useState<WakePhase>("checking");
  const [progress, setProgress] = useState<WakeProgress>({ done: 0, total: 0, phase: null });
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // Пока рабочая область не знает проект, спросить нечего: пустой id — это 404 на каждый вход.
    if (!projectId) {
      setPhase("ready");
      return;
    }
    let alive = true;
    let timer = 0;

    const apply = (archive: ProjectArchiveState) => {
      setProgress({ done: archive.bytesDone, total: archive.bytesTotal, phase: archive.phase });
    };

    const finish = () => {
      setPhase("ready");
      ready.current();
    };

    const poll = async () => {
      let archive: ProjectArchiveState;
      try {
        archive = await getProjectArchive(projectId);
      } catch (failure) {
        if (!alive) return;
        setError(messageOf(failure));
        setPhase("failed");
        return;
      }
      if (!alive) return;
      apply(archive);
      if (!archive.archived && !archive.restoring) {
        finish();
        return;
      }
      if (archive.error && !archive.restoring) {
        setError(archive.error);
        setPhase("failed");
        return;
      }
      // Задание потерялось (например, сервер перезапустился посреди скачивания): отметка архива
      // ещё есть, но восстанавливать некому. Ставим заново — иначе панель ждала бы вечно.
      if (archive.archived && !archive.restoring) {
        await startProjectRestore(projectId).catch(() => undefined);
      }
      timer = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };

    const begin = async () => {
      let archive: ProjectArchiveState;
      try {
        archive = await getProjectArchive(projectId);
      } catch (failure) {
        if (!alive) return;
        setError(messageOf(failure));
        setPhase("failed");
        return;
      }
      if (!alive) return;
      apply(archive);
      if (!archive.archived && !archive.restoring) {
        finish();
        return;
      }
      // Ошибка прошлого задания — не повод начинать скачивание молча: на первом заходе
      // показываем её, а повтор запускает кнопка. Явный повтор (`attempt > 0`) её обходит.
      if (archive.error && !archive.restoring && attempt === 0) {
        setError(archive.error);
        setPhase("failed");
        return;
      }
      if (!archive.restoring) {
        try {
          await startProjectRestore(projectId);
        } catch (failure) {
          if (!alive) return;
          setError(messageOf(failure));
          setPhase("failed");
          return;
        }
      }
      if (!alive) return;
      setError("");
      setPhase("waking");
      timer = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };

    void begin();
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [projectId, attempt]);

  const retry = useCallback(() => {
    setError("");
    setProgress({ done: 0, total: 0, phase: null });
    setPhase("waking");
    setAttempt(value => value + 1);
  }, []);

  /** Фоновая проверка при возврате на вкладку: живой проект отвечает одним запросом и молчит. */
  const recheck = useCallback(async () => {
    if (!projectId) return;
    try {
      const archive = await getProjectArchive(projectId);
      if (!archive.archived && !archive.restoring) return;
      setProgress({ done: archive.bytesDone, total: archive.bytesTotal, phase: archive.phase });
      setPhase("waking");
      setAttempt(value => value + 1);
    } catch {
      // Проверка фоновая: её сбой не должен показывать ошибку поверх рабочей области.
    }
  }, [projectId]);

  return { phase, progress, error, retry, recheck };
}
