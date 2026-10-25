import { randomBytes } from "node:crypto";
import { closeStorage, initializeStorage } from "../storage/ydb.js";
import { createAdmin, deleteAdminSessions, findAdminByEmail, listAdmins, resetAdminTotp, setAdminPassword } from "../admin/admin-store.js";

/**
 * Управление администраторами платформы с сервера.
 *
 * Отдельного «первого администратора» через API нет сознательно: аккаунт, который может завести
 * себя сам, — это открытая дверь. Создание требует доступа к машине (или к контейнеру сервера), то
 * есть тех же прав, что и развёртывание. Зато утёкший пароль больше никого не делает админом.
 *
 * Запуск в разработке:   npm run admin:create -- --email admin@example.com
 * Запуск в production:   docker compose exec webnestdev-server node server/dist/scripts/admin-cli.js create --email admin@example.com
 *                        (в образе нет tsx — только собранный dist)
 */

const USAGE = [
  "Управление администраторами платформы.",
  "",
  "  create --email <адрес>       создать администратора и выдать пароль (показывается один раз)",
  "  password --email <адрес>     выдать новый пароль, сохранив TOTP, и отозвать все входы",
  "  reset-2fa --email <адрес>    сбросить TOTP и recovery-коды, отозвать все входы",
  "  list                         показать администраторов и состояние второго фактора",
  "",
  "Пароль и коды никогда не сохраняются в открытом виде: пароль — scrypt, коды — sha256.",
].join("\n");

function option(name: string): string {
  const index = process.argv.indexOf("--" + name);
  return index >= 0 ? (process.argv[index + 1] ?? "").trim() : "";
}

/** Пароль без похожих символов и без экранирования в shell: его вводят руками в админ-приложении. */
function generatePassword() {
  return randomBytes(18).toString("base64url");
}

async function main(): Promise<number> {
  const command = (process.argv[2] ?? "").trim();
  const email = option("email").toLowerCase();

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return 0;
  }
  if (!["create", "password", "reset-2fa", "list"].includes(command)) {
    console.error("Неизвестная команда: " + command + "\n\n" + USAGE);
    return 2;
  }
  if (command !== "list" && !email) {
    console.error("Нужен --email администратора.\n\n" + USAGE);
    return 2;
  }

  // В режиме postgres таблицы создаются здесь же: CLI запускают на живой базе, и полагаться на то,
  // что сервер уже стартовал после выкатки, нельзя.
  await initializeStorage();
  try {
    if (command === "create") {
      const password = generatePassword();
      const admin = await createAdmin(email, password);
      console.log("Администратор создан.");
      console.log("  email:  " + admin.email);
      console.log("  пароль: " + password);
      console.log("");
      console.log("Пароль показан один раз — сохраните его в менеджере паролей.");
      console.log("При первом входе админ-приложение попросит подключить TOTP и выдаст коды восстановления.");
      return 0;
    }

    if (command === "password") {
      const admin = await findAdminByEmail(email);
      if (!admin) {
        console.error("Администратор не найден: " + email);
        return 1;
      }
      const password = generatePassword();
      await setAdminPassword(admin.id, password);
      // Старые входы закрываются: смена пароля — это в том числе реакция на утечку.
      const revoked = await deleteAdminSessions(admin.id);
      console.log("Новый пароль для " + admin.email + ":");
      console.log("  пароль: " + password);
      console.log("  отозвано сессий: " + revoked);
      console.log("");
      console.log("Пароль показан один раз. Второй фактор сохранён: при входе понадобится обычный код TOTP.");
      return 0;
    }

    if (command === "reset-2fa") {
      const admin = await findAdminByEmail(email);
      if (!admin) {
        console.error("Администратор не найден: " + email);
        return 1;
      }
      // Сброс закрывает и все открытые входы: иначе старая сессия пережила бы смену фактора.
      await resetAdminTotp(admin.id);
      const revoked = await deleteAdminSessions(admin.id);
      console.log("Второй фактор сброшен: " + admin.email);
      console.log("  отозвано сессий: " + revoked);
      console.log("Следующий вход снова начнётся с подключения TOTP.");
      return 0;
    }

    const admins = await listAdmins();
    if (!admins.length) {
      console.log("Администраторов пока нет. Создайте первого: admin:create -- --email <адрес>");
      return 0;
    }
    for (const admin of admins) {
      console.log(
        admin.email +
          "  TOTP: " + (admin.totpEnabledAt ? "подключён" : "не подключён") +
          "  кодов восстановления: " + admin.recoveryHashes.length +
          "  создан: " + admin.createdAt,
      );
    }
    return 0;
  } finally {
    await closeStorage();
  }
}

process.exitCode = await main();
