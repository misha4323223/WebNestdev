import { useCallback, useEffect, useRef, useState } from "react";
import { getProjectChanges, getProjectWorktree, type ProjectChanges, type ProjectWorktree } from "../../lib/project-api";
import type { FileChangeState } from "./file-types";

function statusOf(value: string): FileChangeState {
  return value === "added" || value === "deleted" ? value : "modified";
}

/**
 * Какие файлы трогал агент. Последняя точка истории нужна после завершения запуска, а рабочее
 * дерево — пока агент ещё пишет: до коммита изменения видны только там. Пока запуск идёт,
 * список перечитывается нечасто, чтобы подсветка появлялась без ручного «Обновить».
 */
export function useFileChanges(projectId: string, running: boolean) {
  const [changes, setChanges] = useState<Map<string, FileChangeState>>(new Map());
  const [revision, setRevision] = useState(0);
  const signatureRef = useRef("");

  const load = useCallback(async (live?: () => boolean) => {
    if (!projectId) return;
    const [overview, worktree] = await Promise.allSettled([
      getProjectChanges(projectId),
      getProjectWorktree(projectId),
    ]);
    if (live && !live()) return;
    const next = new Map<string, FileChangeState>();
    const checkpoint = (overview.status === "fulfilled" ? overview.value : null) as ProjectChanges | null;
    const tree = (worktree.status === "fulfilled" ? worktree.value : null) as ProjectWorktree | null;
    for (const file of checkpoint?.checkpoints[0]?.files ?? []) next.set(file.path, statusOf(file.status));
    for (const file of tree?.files ?? []) next.set(file.path, statusOf(file.status));
    const signature = [...next]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, status]) => path + ":" + status)
      .join("|");
    if (signature !== signatureRef.current) {
      signatureRef.current = signature;
      setRevision(value => value + 1);
    }
    setChanges(next);
  }, [projectId]);

  useEffect(() => {
    let alive = true;
    void load(() => alive);
    return () => { alive = false; };
  }, [load]);

  // Завершение запуска — ещё одно чтение: последний коммит агента появляется именно тогда.
  useEffect(() => {
    let alive = true;
    if (!running) {
      void load(() => alive);
      return () => { alive = false; };
    }
    const timer = window.setInterval(() => void load(() => alive), 4000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [running, load]);

  return { changes, revision, total: changes.size, refresh: load };
}
