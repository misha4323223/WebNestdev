/**
 * Пороги здоровья платформы — один источник правды для писем и админ-API.
 *
 * Здесь нет чтения файлов и отправки: только сравнение уже собранных чисел. Благодаря этому
 * один и тот же набор правил используют и планировщик алертов, и `/api/admin/infra`, а тесты
 * проверяют границы без Docker, S3 и почты.
 */

export const HEALTH_THRESHOLDS = {
  diskUsedPercent: 75,
  memoryUsedPercent: 85,
  swapUsedPercent: 50,
  archiveErrorsLastHour: 0,
  backupMaxAgeHours: 30,
} as const;

export type HealthCheckId = "disk" | "memory" | "swap" | "archive" | "backup";
export type HealthUnit = "percent" | "count" | "hours";

export type HealthCheck = {
  id: HealthCheckId;
  label: string;
  /** `null` — показатель не измерен; это не «всё хорошо». */
  ok: boolean | null;
  value: number | null;
  limit: number;
  unit: HealthUnit;
  detail?: string;
};

export type HealthStatus = "ok" | "degraded" | "unknown";

export type HealthInput = {
  diskUsedPercent: number | null;
  memoryUsedPercent: number | null;
  swapUsedPercent: number | null;
  /** Swap вообще есть на хосте? Без swap проверка не применима, а не «идеально». */
  swapConfigured: boolean;
  archiveErrorsLastHour: number;
  /** Проверка бэкапа имеет смысл только для Postgres, а не для JSON-хранилища. */
  backupApplicable: boolean;
  backupAgeHours: number | null;
  backupDetail?: string;
};

const round = (value: number) => Math.round(value * 10) / 10;

function percentCheck(
  id: "disk" | "memory" | "swap",
  label: string,
  value: number | null,
  limit: number,
  detail?: string,
): HealthCheck {
  if (value === null) {
    return { id, label, ok: null, value: null, limit, unit: "percent", detail: detail ?? "не измерено" };
  }
  const rounded = round(value);
  return {
    id,
    label,
    ok: rounded < limit,
    value: rounded,
    limit,
    unit: "percent",
    ...(detail ? { detail } : {}),
  };
}

export function buildHealthChecks(input: HealthInput): HealthCheck[] {
  const checks: HealthCheck[] = [
    percentCheck("disk", "Диск", input.diskUsedPercent, HEALTH_THRESHOLDS.diskUsedPercent),
    percentCheck("memory", "Память", input.memoryUsedPercent, HEALTH_THRESHOLDS.memoryUsedPercent),
  ];

  if (!input.swapConfigured) {
    checks.push({
      id: "swap",
      label: "Swap",
      ok: true,
      value: null,
      limit: HEALTH_THRESHOLDS.swapUsedPercent,
      unit: "percent",
      detail: "swap не настроен",
    });
  } else {
    checks.push(percentCheck("swap", "Swap", input.swapUsedPercent, HEALTH_THRESHOLDS.swapUsedPercent));
  }

  const archiveErrors = Math.max(0, Math.trunc(input.archiveErrorsLastHour));
  checks.push({
    id: "archive",
    label: "Архивация проектов",
    ok: archiveErrors <= HEALTH_THRESHOLDS.archiveErrorsLastHour,
    value: archiveErrors,
    limit: HEALTH_THRESHOLDS.archiveErrorsLastHour,
    unit: "count",
    ...(archiveErrors > 0 ? { detail: "ошибки за последний час" } : {}),
  });

  if (!input.backupApplicable) {
    checks.push({
      id: "backup",
      label: "Резервная копия",
      ok: true,
      value: null,
      limit: HEALTH_THRESHOLDS.backupMaxAgeHours,
      unit: "hours",
      detail: "не применимо: JSON-хранилище",
    });
  } else if (input.backupAgeHours === null) {
    checks.push({
      id: "backup",
      label: "Резервная копия",
      ok: false,
      value: null,
      limit: HEALTH_THRESHOLDS.backupMaxAgeHours,
      unit: "hours",
      detail: input.backupDetail ?? "манифест последней копии не найден",
    });
  } else {
    const age = Math.max(0, round(input.backupAgeHours));
    checks.push({
      id: "backup",
      label: "Резервная копия",
      ok: age <= HEALTH_THRESHOLDS.backupMaxAgeHours,
      value: age,
      limit: HEALTH_THRESHOLDS.backupMaxAgeHours,
      unit: "hours",
    });
  }

  return checks;
}

/** Худший статус: ошибка важнее неизвестного значения, неизвестное — важнее «всё хорошо». */
export function healthStatus(checks: HealthCheck[]): HealthStatus {
  if (checks.some(check => check.ok === false)) return "degraded";
  if (checks.some(check => check.ok === null)) return "unknown";
  return "ok";
}
