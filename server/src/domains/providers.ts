/**
 * Каталог регистраторов доменов, которые подключаются из кабинета пользователя.
 *
 * OAuth-подобного «войди и разреши» у регистраторов нет: доступ выдаётся паролем или
 * токеном в настройках кабинета. Поэтому карточка повторяет облачную — шаги, ссылка на
 * страницу, где выдаётся доступ, и поля, которые проверяются до сохранения.
 *
 * Регистрация и оплата здесь не выполняются: платформа только читает список доменов.
 */

export type DomainRegistrarId = "regru" | "beget" | "timeweb";

export type RegistrarField = {
  key: string;
  label: string;
  placeholder: string;
  /** Значение скрывается в интерфейсе, но приходит на сервер как есть. */
  secret?: boolean;
};

export type DomainRegistrar = {
  id: DomainRegistrarId;
  name: string;
  /** Одна строка под названием. */
  tagline: string;
  /**
   * Страница, где включается API и выдаётся пароль/токен — ссылка «Где взять ключ» ведёт ровно
   * туда, а не на главную регистратора. Шаги называют те разделы, которые кабинет показывает
   * сейчас: придуманного раздела пользователь ищет и не находит.
   */
  keyUrl: string;
  docsUrl: string;
  fields: RegistrarField[];
  steps: string[];
  color: string;
  mark: string;
};

export const DOMAIN_REGISTRARS: DomainRegistrar[] = [
  {
    id: "regru",
    name: "REG.RU",
    tagline: "Крупнейший регистратор .ru",
    keyUrl: "https://help.reg.ru/support/partneram/reg-api/kakiye-ogranicheniya-yest-pri-rabote-s-reg-api",
    docsUrl: "https://help.reg.ru/support/partneram/reg-api/chto-takoye-reg-api-i-kto-mozhet-ispolzovat-reg-api",
    fields: [
      { key: "username", label: "Логин REG.RU", placeholder: "логин личного кабинета" },
      { key: "password", label: "Пароль или API-пароль", placeholder: "пароль из личного кабинета", secret: true },
    ],
    steps: [
      "Личный кабинет REG.RU → «Настройки API» → «Диапазоны IP-адресов» → «Добавить IP»: без этого REG.RU отклоняет запросы с сервера.",
      "Пароль — основной или альтернативный пароль API из настроек аккаунта.",
      "Вставьте логин и пароль — проверим чтением списка доменов.",
    ],
    color: "#1f6feb",
    mark: "R",
  },
  {
    id: "beget",
    name: "Beget",
    tagline: "Домены и хостинг",
    keyUrl: "https://beget.com/ru/kb/manual/nastrojki-akkaunta",
    docsUrl: "https://beget.com/ru/kb/api/obshhij-princzip-raboty-s-api",
    fields: [
      { key: "login", label: "Логин Beget", placeholder: "логин аккаунта" },
      { key: "passwd", label: "API-пароль", placeholder: "отдельный пароль для API", secret: true },
    ],
    steps: [
      "Панель Beget → «Настройки аккаунта» → «Ограничение доступа» → «Beget API»: установите новый пароль для API.",
      "Скопируйте логин аккаунта и этот пароль.",
      "Вставьте их сюда — проверим чтением списка доменов.",
    ],
    color: "#f5a623",
    mark: "B",
  },
  {
    id: "timeweb",
    name: "Timeweb Cloud",
    tagline: "Домены, серверы и базы",
    keyUrl: "https://timeweb.cloud/docs/account-management/token",
    docsUrl: "https://timeweb.cloud/tools/api-docs",
    fields: [
      { key: "token", label: "API-токен", placeholder: "токен из раздела «API и Terraform»", secret: true },
    ],
    steps: [
      "Кабинет Timeweb Cloud → вкладка «API и Terraform» → «Добавить токен».",
      "«Выпустить» — токен показывается один раз.",
      "Вставьте токен — проверим чтением списка доменов.",
    ],
    color: "#0b6bff",
    mark: "T",
  },
];

export function findDomainRegistrar(id: string): DomainRegistrar | undefined {
  return DOMAIN_REGISTRARS.find(registrar => registrar.id === id);
}

/** Проверяет, что присланные поля — ровно те, что просит регистратор, и непустые. */
export function readRegistrarFields(registrar: DomainRegistrar, input: unknown): Record<string, string> {
  if (typeof input !== "object" || input === null) throw new Error("Ожидался объект с полями доступа");
  const values = input as Record<string, unknown>;
  const fields: Record<string, string> = {};
  for (const field of registrar.fields) {
    const value = typeof values[field.key] === "string" ? (values[field.key] as string).trim() : "";
    if (!value) throw new Error("Заполните поле «" + field.label + "»");
    if (value.length > 8000) throw new Error("Поле «" + field.label + "» слишком длинное");
    fields[field.key] = value;
  }
  return fields;
}
