import { getSandbox } from "../sandbox-manager.js";
import { detectProject } from "../preview/project-kind.js";
import { readDeploymentProfile } from "../deployment/profile.js";
import { readFunctionManifest, FunctionManifestError } from "../functions/manifest.js";
import type { Project } from "../project-store.js";
import type { PlanId } from "../account/plans.js";
import type { HostingStateErrorCode } from "./types.js";
import {
  planAllows,
  planFeatureMessage,
} from "../account/entitlements.js";
import { functionLimitFor, functionLimitMessage } from "../account/plans.js";

/**
 * Состав будущего релиза: нужен и панели, и публикатору.
 *
 * Панель не должна угадывать по названию проекта, будет ли это статика или статика с API:
 * один и тот же ответ здесь решает, что показать в кнопке и что собрать. Публикатор
 * использует тот же инспектор, поэтому UI и сервер не расходятся в классификации.
 */
export type HostingProjectInspection = {
  kind: "instant-site" | "static-build" | "static-functions" | "unsupported" | "unknown";
  functions: number;
  jobs: number;
  /** Пустая строка для поддерживаемого проекта; иначе безопасная причина для человека. */
  reason: string;
  /** Код ошибки публикатора; в публичный ответ панели не попадает. */
  errorCode?: HostingStateErrorCode;
};

export type HostingProjectView = {
  kind: HostingProjectInspection["kind"];
  label: string;
  functions: number;
  jobs: number;
  canPublish: boolean;
  reason: string;
};

const UNKNOWN_REASON = "Состав проекта проверим при публикации.";

/** Ответ для GET /hosting, если workspace временно недоступен: не раскрываем ошибку путей. */
export function unknownHostingProject(): HostingProjectInspection {
  return { kind: "unknown", functions: 0, jobs: 0, reason: UNKNOWN_REASON };
}

function unsupported(reason: string, errorCode: HostingStateErrorCode = "PROJECT_NOT_STATIC"): HostingProjectInspection {
  return { kind: "unsupported", functions: 0, jobs: 0, reason, errorCode };
}

/**
 * `unknown` означает, что workspace сейчас не читается (например, холодный архив). В этом
 * состоянии панель не предлагает публикацию: публикатор использует тот же инспектор и откажет.
 * Повторное чтение состояния после восстановления вернёт точный состав.
 */
export async function inspectHostingProject(project: Project): Promise<HostingProjectInspection> {
  // Ошибку getSandbox намеренно не глотаем: публикатор должен получить прежнюю причину
  // (холодный архив, чужой узел, миграция workspace), а не ложное «проект не статический».
  const root = (await getSandbox(project.id, project.userId)).root;

  try {
    const shape = await detectProject(root);
    if (shape.kind !== "instant-site" && shape.kind !== "static-build") {
      return unsupported("Хостинг принимает статику и статику с serverless-функциями: " + shape.reason);
    }

    let manifest: Awaited<ReturnType<typeof readFunctionManifest>> = null;
    try {
      manifest = await readFunctionManifest(root);
    } catch (error) {
      return unsupported(
        error instanceof FunctionManifestError
          ? error.message
          : "Не удалось прочитать nestdev.functions.json.",
        "FUNCTIONS_MANIFEST_REQUIRED",
      );
    }
    if (manifest) {
      return {
        kind: "static-functions",
        functions: manifest.functions.length,
        jobs: manifest.jobs.length,
        reason: "",
      };
    }

    // Манифеста нет, но проект выглядит серверным или functions-проектом. Молча
    // опубликовать только статику значило бы потерять API, поэтому нужен явный контракт.
    const profile = await readDeploymentProfile(root);
    if (profile.projectType.backend === "server") {
      return unsupported(
        "Серверный проект (SSR/постоянный сервер) нельзя опубликовать на production-хостинге: " +
          "SSR-рантайм здесь пока не поддерживается. Доступны статика и serverless-функции; " +
          "контейнерный preview — отдельный режим разработки.",
      );
    }
    if (profile.projectType.backend === "functions") {
      return unsupported(
        "В проекте найдены функции. Добавьте nestdev.functions.json с маршрутами и обработчиками или удалите каталог функций.",
        "FUNCTIONS_MANIFEST_REQUIRED",
      );
    }
    return { kind: shape.kind, functions: 0, jobs: 0, reason: "" };
  } catch {
    return unknownHostingProject();
  }
}

function labelFor(kind: HostingProjectInspection["kind"]): string {
  if (kind === "static-functions") return "Статика + функции";
  if (kind === "instant-site") return "Готовая статика";
  if (kind === "static-build") return "Статика";
  if (kind === "unsupported") return "Проект не поддерживается";
  return "Состав проверим при публикации";
}

/** Тарифные ограничения поверх состава проекта; используется в GET /hosting. */
export function hostingProjectView(inspection: HostingProjectInspection, plan: PlanId): HostingProjectView {
  // `unknown` тоже не разрешаем: публикатор не сможет прочитать проект и всё равно
  // откажет. Пусть лучше кнопка будет выключена до следующего обновления состояния.
  let canPublish = inspection.kind !== "unsupported" && inspection.kind !== "unknown";
  let reason = inspection.reason;

  if (inspection.kind === "static-functions" && !planAllows(plan, "serverlessFunctions")) {
    canPublish = false;
    reason = planFeatureMessage(plan, "serverlessFunctions");
  }
  if (inspection.jobs > 0 && !planAllows(plan, "backgroundJobs")) {
    canPublish = false;
    reason = planFeatureMessage(plan, "backgroundJobs");
  }
  if (inspection.kind === "static-functions" && planAllows(plan, "serverlessFunctions") &&
    inspection.functions > functionLimitFor(plan)) {
    canPublish = false;
    reason = functionLimitMessage(plan, inspection.functions);
  }

  return {
    kind: inspection.kind,
    label: labelFor(inspection.kind),
    functions: inspection.functions,
    jobs: inspection.jobs,
    canPublish,
    reason,
  };
}
