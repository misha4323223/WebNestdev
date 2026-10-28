/**
 * «Изменения» — это история задач проекта, а не журнал инструментов агента: после каждого
 * удачного запуска в песочнице создаётся коммит, который можно открыть и к которому можно
 * вернуться. Типы здесь — общий язык сервера и панели.
 */
export type CheckpointKind = "task" | "rollback" | "imported" | "manual";

export type CheckpointFileStatus = "added" | "modified" | "deleted";

export type CheckpointFile = {
  path: string;
  status: CheckpointFileStatus;
  /** Сколько строк добавлено и удалено в файле — для списка ревью, как в VS Code. */
  additions?: number;
  deletions?: number;
};

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

/** Рабочее дерево: то, что ещё не стало точкой истории. */
export type WorktreeState = {
  initialized: boolean;
  branch: string;
  files: CheckpointFile[];
  /** Итог по рабочему дереву: одна строка „+N −M“ в заголовке ревью. */
  additions?: number;
  deletions?: number;
};

/** Diff одного файла для Git-панели. */
export type FileDiff = {
  path: string;
  status: CheckpointFileStatus;
  /** Unified diff; пустой, когда файл двоичный или слишком большой. */
  patch: string;
  /** Подсчёт по строкам патча: интерфейс показывает его рядом с именем файла. */
  additions: number;
  deletions: number;
  binary?: boolean;
  truncated?: boolean;
};

export type ChangesOverview = {
  /** Есть ли в проекте созданная нами история. Пока её нет, откатывать нечего. */
  initialized: boolean;
  repository: {
    /** Куда уходят коммиты; старые проекты без поля — GitHub. */
    provider?: "github" | "gitlab" | "gitverse" | "sourcecraft";
    connected: boolean;
    branch: string;
    remoteUrl: string | null;
    lastPushAt: string | null;
    lastPushError: string | null;
  };
  checkpoints: Checkpoint[];
};
