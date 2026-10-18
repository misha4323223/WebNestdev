/**
 * «Изменения» — это история задач проекта, а не журнал инструментов агента: после каждого
 * удачного запуска в песочнице создаётся коммит, который можно открыть и к которому можно
 * вернуться. Типы здесь — общий язык сервера и панели.
 */
export type CheckpointKind = "task" | "rollback" | "imported";

export type CheckpointFileStatus = "added" | "modified" | "deleted";

export type CheckpointFile = { path: string; status: CheckpointFileStatus };

export type Checkpoint = {
  /** Полный SHA коммита в песочнице: по нему делается откат. */
  sha: string;
  shortSha: string;
  /** Первая строка сообщения — то, что прочитает человек. */
  subject: string;
  message: string;
  kind: CheckpointKind;
  createdAt: string;
  runId?: string;
  conversationId?: string;
  /** Для отката: коммит, состояние которого восстановлено. */
  revertedTo?: string;
  files: CheckpointFile[];
  filesChanged: number;
  /** Изменение уже лежит в ветке на GitHub. */
  pushed: boolean;
  /** Ссылка на коммит на GitHub, когда репозиторий подключён. */
  url?: string;
};

export type PushState = { branch: string; lastPushAt?: string; lastPushError?: string };

export type ChangesOverview = {
  /** Есть ли в проекте созданная нами история. Пока её нет, откатывать нечего. */
  initialized: boolean;
  repository: {
    connected: boolean;
    branch: string;
    remoteUrl: string | null;
    lastPushAt: string | null;
    lastPushError: string | null;
  };
  checkpoints: Checkpoint[];
};
