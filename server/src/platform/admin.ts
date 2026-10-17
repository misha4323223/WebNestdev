/**
 * Who may edit platform keys. This is deliberately *not* a stored value and not something the panel
 * can change: a keys editor that can grant itself access is not a lock. The list lives in the
 * deployment environment and is read on every check, so a deployment that has not configured it keeps
 * the panel closed instead of opening platform credentials to the first registered account.
 */
export const ADMIN_EMAILS_ENV = "WEBNESTDEV_ADMIN_EMAILS";
export const ADMIN_IDS_ENV = "WEBNESTDEV_ADMIN_USER_IDS";

function listed(name: string) {
  return (process.env[name] ?? "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
}

export function platformAdminsConfigured() {
  return listed(ADMIN_EMAILS_ENV).length > 0 || listed(ADMIN_IDS_ENV).length > 0;
}

export function isPlatformAdmin(user: { id: string; email: string }) {
  const emails = listed(ADMIN_EMAILS_ENV);
  const ids = listed(ADMIN_IDS_ENV);
  if (!emails.length && !ids.length) return false;
  return emails.includes(user.email.trim().toLowerCase()) || ids.includes(user.id.trim().toLowerCase());
}

/** Что показать в панели, когда админов ещё нет: имя переменной и как её задать. */
export function platformAdminGuide() {
  return (
    "Редактор ключей открыт только администратору платформы. Добавьте свой адрес в переменную окружения " +
    ADMIN_EMAILS_ENV + " (список через запятую) в .env развёртывания и перезапустите сервис, либо перечислите " +
    "идентификаторы аккаунтов в " + ADMIN_IDS_ENV + ". Значение читается только из окружения — через панель его " +
    "выдать нельзя, иначе доступ к ключам платформы можно было бы расширить изнутри панели."
  );
}
