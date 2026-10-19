/**
 * Регистраторы доменов. Описание повторяет серверный каталог (`server/src/domains/providers.ts`):
 * поля и шаги должны совпадать, иначе форма отправит не то, что сервер ждёт.
 *
 * Доступ выдаётся в кабинете регистратора, а не по кнопке OAuth, поэтому у каждой карточки
 * есть ссылка `keyUrl` — на страницу, где включается API и выдаётся пароль или токен, — и шаги
 * с теми названиями разделов, которые кабинет показывает сейчас. Раздел, которого в кабинете
 * нет, — это баг: пользователь ищет вкладку и не находит.
 */

import type { BrandId } from "../../../components/BrandLogo";

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
  /** Страница выдачи пароля/токена для API — ссылка «Где взять ключ» ведёт ровно туда. */
  keyUrl: string;
  docsUrl: string;
  tagline: string;
  fields: RegistrarField[];
  steps: string[];
  /** Официальный логотип регистратора. */
  logo: BrandId;
};

export const DOMAIN_REGISTRARS: DomainRegistrarInfo[] = [
  {
    id: "regru",
    logo: "regru",
    name: "REG.RU",
    keyUrl: "https://help.reg.ru/support/partneram/reg-api/kakiye-ogranicheniya-yest-pri-rabote-s-reg-api",
    docsUrl: "https://help.reg.ru/support/partneram/reg-api/chto-takoye-reg-api-i-kto-mozhet-ispolzovat-reg-api",
    tagline: "Крупнейший регистратор .ru",
    fields: [
      { key: "username", label: "Логин REG.RU", placeholder: "логин личного кабинета" },
      { key: "password", label: "Пароль или API-пароль", placeholder: "пароль из личного кабинета", secret: true },
    ],
    steps: [
      "Кабинет REG.RU → «Настройки API» → «Диапазоны IP-адресов» → «Добавить IP»: без этого REG.RU отклоняет запросы с сервера.",
      "Пароль — основной или альтернативный пароль API из настроек аккаунта.",
      "Вставьте логин и пароль — проверим чтением доменов.",
    ],
  },
  {
    id: "beget",
    logo: "beget",
    name: "Beget",
    keyUrl: "https://beget.com/ru/kb/manual/nastrojki-akkaunta",
    docsUrl: "https://beget.com/ru/kb/api/obshhij-princzip-raboty-s-api",
    tagline: "Домены и хостинг",
    fields: [
      { key: "login", label: "Логин Beget", placeholder: "логин аккаунта" },
      { key: "passwd", label: "API-пароль", placeholder: "отдельный пароль для API", secret: true },
    ],
    steps: [
      "Панель Beget → «Настройки аккаунта» → «Ограничение доступа» → «Beget API»: установите новый пароль для API.",
      "Скопируйте логин аккаунта и этот пароль.",
      "Вставьте их сюда — проверим чтением доменов.",
    ],
  },
  {
    id: "timeweb",
    logo: "timeweb",
    name: "Timeweb Cloud",
    keyUrl: "https://timeweb.cloud/docs/account-management/token",
    docsUrl: "https://timeweb.cloud/tools/api-docs",
    tagline: "Домены, серверы и базы",
    fields: [
      { key: "token", label: "API-токен", placeholder: "токен из раздела «API и Terraform»", secret: true },
    ],
    steps: [
      "Кабинет Timeweb Cloud → вкладка «API и Terraform» → «Добавить токен».",
      "«Выпустить» — токен показывается один раз, сохраните его.",
      "Вставьте токен — проверим чтением доменов.",
    ],
  },
];
