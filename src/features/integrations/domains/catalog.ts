/**
 * Регистраторы доменов. Описание повторяет серверный каталог (`server/src/domains/providers.ts`):
 * поля и шаги должны совпадать, иначе форма отправит не то, что сервер ждёт.
 *
 * Доступ выдаётся в кабинете регистратора, а не по кнопке OAuth, поэтому у каждой карточки
 * есть ссылка на кабинет и шаги, где создать пароль для API или токен.
 */

export type DomainRegistrarId = "regru" | "beget" | "timeweb";

export type RegistrarField = {
  key: string;
  label: string;
  placeholder: string;
  secret?: boolean;
  multiline?: boolean;
};

export type DomainRegistrarInfo = {
  id: DomainRegistrarId;
  name: string;
  consoleUrl: string;
  docsUrl: string;
  tagline: string;
  fields: RegistrarField[];
  steps: string[];
  color: string;
  mark: string;
};

export const DOMAIN_REGISTRARS: DomainRegistrarInfo[] = [
  {
    id: "regru",
    name: "REG.RU",
    consoleUrl: "https://www.reg.ru/user/account/",
    docsUrl: "https://help.reg.ru/support/partneram/reg-api/kakiye-ogranicheniya-yest-pri-rabote-s-reg-api",
    tagline: "Крупнейший регистратор .ru",
    fields: [
      { key: "username", label: "Логин REG.RU", placeholder: "логин личного кабинета" },
      { key: "password", label: "Пароль или API-пароль", placeholder: "пароль из личного кабинета", secret: true },
    ],
    steps: [
      "Кабинет REG.RU → «Безопасность» → ограничения доступа: включите API и добавьте IP сервера.",
      "Задайте альтернативный пароль для API (основной тоже подходит).",
      "Вставьте логин и пароль — проверим чтением доменов.",
    ],
    color: "#1f6feb",
    mark: "R",
  },
  {
    id: "beget",
    name: "Beget",
    consoleUrl: "https://cp.beget.com/",
    docsUrl: "https://beget.com/ru/kb/api/obshhij-princzip-raboty-s-api",
    tagline: "Домены и хостинг",
    fields: [
      { key: "login", label: "Логин Beget", placeholder: "логин аккаунта" },
      { key: "passwd", label: "API-пароль", placeholder: "отдельный пароль для API", secret: true },
    ],
    steps: [
      "Панель Beget → раздел «API»: включите доступ и задайте API-пароль.",
      "Скопируйте логин аккаунта и этот пароль.",
      "Вставьте их сюда — проверим чтением доменов.",
    ],
    color: "#f5a623",
    mark: "B",
  },
  {
    id: "timeweb",
    name: "Timeweb Cloud",
    consoleUrl: "https://timeweb.cloud/",
    docsUrl: "https://timeweb.cloud/tools/api-docs",
    tagline: "Домены, серверы и базы",
    fields: [
      { key: "token", label: "API-токен", placeholder: "токен из раздела «API и Terraform»", secret: true },
    ],
    steps: [
      "Личный кабинет Timeweb Cloud → «API и Terraform».",
      "Создайте токен и скопируйте его.",
      "Вставьте токен — проверим чтением доменов.",
    ],
    color: "#0b6bff",
    mark: "T",
  },
];
