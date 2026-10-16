/// <reference types="vite/client" />

/**
 * Номер сборки, зашитый в этот бандл. Приходит из окружения сборки образа (`ARG GIT_SHA` →
 * `ENV VITE_BUILD`, см. server/Dockerfile), потому что Vite подставляет в `import.meta.env`
 * переменные с префиксом `VITE_`. Локально (dev-сервер или сборка без переданного SHA) значения
 * нет — тогда проверка версии в src/lib/app-build.ts просто выключена.
 */
interface ImportMetaEnv {
  readonly VITE_BUILD?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
