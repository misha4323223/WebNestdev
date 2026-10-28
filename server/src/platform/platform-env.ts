import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "../storage/secret-crypto.js";
import { parseAuthorizedKeyJson, parseServiceAccountKey } from "../yandex/yandex-api.js";

/**
 * Platform keys — the credentials of the service itself (GitHub OAuth, Yandex Cloud, SMS, the
 * default AI model), as opposed to a project's own secrets. They are entered in the admin panel
 * instead of being set on the VM by hand, stored encrypted (the same AES-GCM store as every other
 * credential, see docs/SECRET_ENCRYPTION.md) and read through `getPlatformEnv`, which falls back to
 * the process environment: a value written in the panel wins, a deploy-time env var still works, and
 * a deployment that never opens the panel behaves exactly as before.
 */
export type PlatformEnvKind = "secret" | "json-key" | "value" | "url" | "path" | "flag";
export type PlatformEnvGroup = "github" | "gitlab" | "gitverse" | "yandex" | "sms" | "ai" | "search" | "billing" | "plans" | "mail" | "support";

export type PlatformEnvEntry = {
  name: string;
  group: PlatformEnvGroup;
  label: string;
  hint: string;
  kind: PlatformEnvKind;
};

/**
 * What the panel can actually change. A key belongs here only when the server reads it through
 * `getPlatformEnv`, so the list is a promise: everything shown takes effect without a restart.
 */
export const PLATFORM_ENV_CATALOG: PlatformEnvEntry[] = [
  { name: "GITHUB_CLIENT_ID", group: "github", label: "Client ID", hint: "GitHub → Settings → Developer settings → OAuth Apps → ваше приложение. Client ID виден открыто.", kind: "value" },
  { name: "GITHUB_CLIENT_SECRET", group: "github", label: "Client Secret", hint: "Там же: «Generate a new client secret». Старый после этого перестаёт работать.", kind: "secret" },
  { name: "GITHUB_CALLBACK_URL", group: "github", label: "Callback URL", hint: "Необязательно: пустое поле — адрес берётся из домена панели (https://<домен>/api/github/callback).", kind: "url" },
  { name: "GITHUB_FRONTEND_URL", group: "github", label: "Адрес возврата", hint: "Необязательно: куда вернуть браузер после авторизации (по умолчанию — корень панели).", kind: "url" },

  { name: "GITLAB_CLIENT_ID", group: "gitlab", label: "Application ID", hint: "GitLab → аватар → Edit profile → Access → Applications → ваше приложение. Прямая ссылка: https://gitlab.com/-/user_settings/applications.", kind: "value" },
  { name: "GITLAB_CLIENT_SECRET", group: "gitlab", label: "Secret", hint: "Там же, в приложении. GitLab показывает Secret один раз — скопируйте сразу.", kind: "secret" },
  { name: "GITLAB_BASE_URL", group: "gitlab", label: "Адрес GitLab", hint: "Необязательно: https://gitlab.com по умолчанию. Для своего сервера укажите его адрес, например https://git.company.ru.", kind: "url" },
  { name: "GITLAB_CALLBACK_URL", group: "gitlab", label: "Callback URL", hint: "Необязательно: пустое поле — адрес берётся из домена панели (https://<домен>/api/gitlab/callback).", kind: "url" },
  { name: "GITLAB_FRONTEND_URL", group: "gitlab", label: "Адрес возврата", hint: "Необязательно: куда вернуть браузер после авторизации (по умолчанию — корень панели).", kind: "url" },

  { name: "GITVERSE_CLIENT_ID", group: "gitverse", label: "Client ID", hint: "GitVerse → Настройки профиля → Приложения → ваше приложение. OAuth в GitVerse работает только с PKCE — сервер делает это сам.", kind: "value" },
  { name: "GITVERSE_CLIENT_SECRET", group: "gitverse", label: "Client secret", hint: "Там же. GitVerse показывает секрет один раз — скопируйте сразу.", kind: "secret" },

  { name: "YANDEX_CLIENT_ID", group: "yandex", label: "Yandex ID Client ID", hint: "Приложение в oauth.yandex.ru. Нужен для входа через Яндекс; ключ сервисного аккаунта работает и без него.", kind: "value" },
  { name: "YANDEX_CLIENT_SECRET", group: "yandex", label: "Yandex ID Client secret", hint: "Там же, в настройках приложения Yandex ID.", kind: "secret" },
  { name: "YANDEX_CALLBACK_URL", group: "yandex", label: "Redirect URI", hint: "Необязательно: по умолчанию https://<домен>/api/yandex/callback. Должен совпадать с Redirect URI в приложении Yandex ID.", kind: "url" },
  { name: "YANDEX_FRONTEND_URL", group: "yandex", label: "Адрес возврата", hint: "Необязательно: куда вернуть браузер после входа (по умолчанию — корень панели).", kind: "url" },
  { name: "YANDEX_OAUTH_SCOPE", group: "yandex", label: "OAuth scope", hint: "Необязательно и только для подключения Yandex Cloud. Вход через Яндекс ID не отправляет scope: он получает права, отмеченные в приложении («Доступ к данным»).", kind: "value" },
  { name: "YANDEX_CLOUD_ID", group: "yandex", label: "Cloud ID", hint: "b1g… из консоли Yandex Cloud — идентификатор облака.", kind: "value" },
  { name: "YANDEX_FOLDER_ID", group: "yandex", label: "Folder ID", hint: "b1g… каталога, в котором создан сервисный аккаунт Notification Service.", kind: "value" },
  { name: "YANDEX_SA_KEY", group: "yandex", label: "Ключ сервисного аккаунта (JSON)", hint: "Вставьте файл authorized key целиком. Многострочный JSON и скопированная одной строкой форма с \\n принимаются одинаково.", kind: "json-key" },
  { name: "YANDEX_SA_KEY_FILE", group: "yandex", label: "Путь к файлу ключа", hint: "Альтернатива вставке: путь внутри контейнера, например /var/lib/webnestdev/secrets/yandex-sa-key.json.", kind: "path" },
  { name: "YANDEX_NOTIFY_IAM_TOKEN", group: "yandex", label: "Готовый IAM-токен", hint: "Живёт около 12 часов: SMS идут, пока он свежий, потом перестают. Ключ сервисного аккаунта надёжнее и побеждает токен.", kind: "secret" },
  { name: "YANDEX_SMS_SENDER", group: "yandex", label: "Имя отправителя sms", hint: "Необязательно: по умолчанию общее имя cns.shared; своё имя работает после регистрации отправителя.", kind: "value" },
  { name: "YANDEX_NOTIFY_ENDPOINT", group: "yandex", label: "Endpoint CNS", hint: "Необязательно: https://notifications.yandexcloud.net/", kind: "url" },

  { name: "SMS_PROVIDER", group: "sms", label: "Провайдер SMS", hint: "Необязательно: yandex, smsru, smsc, exolve или smsaero. Пусто — берётся первый, у которого есть ключ.", kind: "value" },
  { name: "SMS_SENDER", group: "sms", label: "Имя отправителя", hint: "Необязательно: имя, зарегистрированное у провайдера.", kind: "value" },
  { name: "SMS_RU_API_ID", group: "sms", label: "SMS.RU API ID", hint: "Ключ из личного кабинета sms.ru.", kind: "secret" },
  { name: "SMSC_LOGIN", group: "sms", label: "SMSC логин", hint: "Логин из личного кабинета smsc.ru.", kind: "value" },
  { name: "SMSC_PASSWORD", group: "sms", label: "SMSC пароль", hint: "Пароль или API-ключ smsc.ru; работает только вместе с логином.", kind: "secret" },
  { name: "EXOLVE_API_KEY", group: "sms", label: "Exolve API-ключ", hint: "Ключ MTS Exolve.", kind: "secret" },
  { name: "SMSAERO_EMAIL", group: "sms", label: "SMS Aero email", hint: "Логин аккаунта SMS Aero.", kind: "value" },
  { name: "SMSAERO_API_KEY", group: "sms", label: "SMS Aero API-ключ", hint: "Ключ из личного кабинета SMS Aero.", kind: "secret" },
  { name: "WEBNESTDEV_SMS_TEST_MODE", group: "sms", label: "Тестовый режим", hint: "1 — коды пишутся в лог сервера и не отправляются. Пусто или 0 — обычная отправка.", kind: "flag" },

  { name: "WEB_SEARCH_PROVIDER", group: "search", label: "Провайдер поиска", hint: "Необязательно: auto (по тарифу), duckduckgo или yandex. По умолчанию бесплатный тариф ищет через DuckDuckGo, платные — через Yandex Search API.", kind: "value" },
  { name: "YANDEX_SEARCH_API_KEY", group: "search", label: "Yandex Search API-ключ", hint: "API-ключ сервисного аккаунта со scope yc.search-api.execute. Нужен для поиска на платных тарифах.", kind: "secret" },
  { name: "YANDEX_SEARCH_FOLDER_ID", group: "search", label: "Каталог Search API", hint: "b1g… каталога, где сервисному аккаунту выдана роль search-api.webSearch.user. Пустое значение — берётся YANDEX_FOLDER_ID.", kind: "value" },
  { name: "TAVILY_API_KEY", group: "search", label: "Tavily API-ключ", hint: "Резервный провайдер платных тарифов: включается, если Yandex Search API не настроен или отказал. Бесплатно 1 000 кредитов в месяц.", kind: "secret" },

  { name: "ROBOKASSA_LOGIN", group: "billing", label: "Логин магазина", hint: "Логин магазина из личного кабинета Робокассы (MerchantLogin), а не e-mail.", kind: "value" },
  { name: "ROBOKASSA_PASSWORD_1", group: "billing", label: "Пароль №1", hint: "Личный кабинет → Технические настройки → пароль №1. Им подписывается создание платежа.", kind: "secret" },
  { name: "ROBOKASSA_PASSWORD_2", group: "billing", label: "Пароль №2", hint: "Там же. Им подписывается уведомление ResultURL — без него оплата не засчитается.", kind: "secret" },
  { name: "ROBOKASSA_HASH", group: "billing", label: "Алгоритм подписи", hint: "Должен совпадать с настройкой магазина: md5 (по умолчанию), sha256 и т. п.", kind: "value" },
  { name: "ROBOKASSA_TEST_MODE", group: "billing", label: "Тестовый режим", hint: "1 — платёж идёт с IsTest=1 и тестовыми паролями магазина: деньги не списываются.", kind: "flag" },
  { name: "ROBOKASSA_RECURRING", group: "billing", label: "Периодические платежи", hint: "1 — только после одобрения услуги «Периодические платежи» в Робокассе: включает автопродление.", kind: "flag" },
  { name: "ROBOKASSA_RECEIPT", group: "billing", label: "Receipt JSON", hint: "1 — передавать состав чека в параметре Receipt. При НПД с «Робочеками СМЗ» не включайте: чеки в ФНС и «Мой налог» формирует сама Робокасса.", kind: "flag" },
  { name: "ROBOKASSA_PRICE_PRO", group: "billing", label: "Цена тарифа «Плюс», ₽/мес", hint: "Необязательно: по умолчанию 990. Меняется без выкатки; если цена задана в разделе «Тарифы и скидки», она важнее.", kind: "value" },
  { name: "ROBOKASSA_PRICE_TEAM", group: "billing", label: "Цена тарифа «Премиум», ₽/мес", hint: "Необязательно: по умолчанию 2 990. Если цена задана в разделе «Тарифы и скидки», она важнее.", kind: "value" },
  { name: "BILLING_NOTICE_DAYS", group: "billing", label: "Дней до письма о списании", hint: "Необязательно: за сколько дней до автопродления отправлять письмо-предупреждение. По умолчанию 3. Без отправленного письма списание не выполняется вовсе.", kind: "value" },

  // Витрина тарифов: название, описание, базовая цена и скидка. Редактируется в отдельном
  // разделе «Тарифы и скидки», а не в форме ключей; здесь ключ нужен только хранилищу.
  { name: "PLAN_SETTINGS", group: "plans", label: "Настройки витрины тарифов", hint: "Названия, описания, базовые цены и скидки тарифов. Редактируются в разделе «Тарифы и скидки».", kind: "value" },

  // Почта платформы: письма покупателям об оплате, предупреждения о списании и письма поддержки.
  // Основной путь — Yandex Cloud Postbox: логин и пароль это API-ключ сервисного аккаунта, а
  // отправка идёт от подтверждённого домена. Пошаговая настройка (роль postbox.sender, область
  // yc.postbox.send, DKIM/SPF/DMARC, квоты) — docs/MAIL.md.
  { name: "MAIL_SMTP_HOST", group: "mail", label: "SMTP-сервер", hint: "Yandex Cloud Postbox: postbox.cloud.yandex.net. Подходит любой SMTP с шифрованием сразу (порт 465).", kind: "value" },
  { name: "MAIL_SMTP_PORT", group: "mail", label: "Порт SMTP", hint: "Необязательно: по умолчанию 465 (TLS сразу). У Postbox есть и 587, но платформа использует только 465.", kind: "value" },
  { name: "MAIL_SMTP_USER", group: "mail", label: "Логин SMTP", hint: "Postbox: идентификатор API-ключа сервисного аккаунта (роль postbox.sender, область yc.postbox.send), а не адрес ящика.", kind: "value" },
  { name: "MAIL_SMTP_PASSWORD", group: "mail", label: "Пароль SMTP", hint: "Postbox: секретная часть того же API-ключа. Обычная почта — пароль приложения, а не пароль от ящика.", kind: "secret" },
  { name: "MAIL_FROM", group: "mail", label: "Адрес отправителя", hint: "Например noreply@nestdev.ru. Домен должен быть подтверждён в Postbox (DKIM), иначе письма отклоняются.", kind: "value" },
  { name: "MAIL_FROM_NAME", group: "mail", label: "Имя отправителя", hint: "Необязательно: как подписывать письма, например NestDev.", kind: "value" },

  // Рассылка по сегментам идёт не по SMTP, а по REST API Postbox v2: у очереди свои требования —
  // один получатель на письмо, идентификатор отправки в ответе, возможность остановиться на
  // середине. Эти ключи нужны только для рассылки; письма об оплате и поддержке работают по SMTP
  // выше. Настройка — docs/MAIL.md.
  { name: "POSTBOX_SENDER", group: "mail", label: "Почта: адрес отправителя", hint: "Подтверждённый в Postbox адрес, например noreply@nestdev.ru. Им представляются письма платформы и рассылка; домен должен быть подтверждён по DKIM.", kind: "value" },
  { name: "POSTBOX_FROM_NAME", group: "mail", label: "Рассылка: имя отправителя", hint: "Необязательно: как подписывать рассылку, например NestDev.", kind: "value" },
  { name: "PLATFORM_URL", group: "mail", label: "Адрес платформы", hint: "Например https://nestdev.ru. Нужен для абсолютной ссылки отписки: относительная ссылка в письме не работает.", kind: "url" },
  { name: "POSTBOX_ENDPOINT", group: "mail", label: "Рассылка: endpoint", hint: "Необязательно: по умолчанию https://postbox.cloud.yandex.net. Меняется только если Yandex сменил адрес.", kind: "url" },
  { name: "POSTBOX_IAM_TOKEN", group: "mail", label: "Рассылка: IAM-токен", hint: "Готовый токен сервисного аккаунта с ролью postbox.sender. Живёт около 12 часов: подходит для проверки, для постоянной работы — ключ сервисного аккаунта.", kind: "secret" },
  { name: "POSTBOX_STATIC_KEY_ID", group: "mail", label: "Рассылка: статический ключ, Key ID", hint: "Идентификатор статического ключа доступа (это не API-ключ сервисного аккаунта). Вместе с секретом ниже подписывает REST-запросы рассылки по SigV4. Без отдельного ключа сервисного аккаунта достаточно POSTBOX_IAM_TOKEN.", kind: "value" },
  { name: "POSTBOX_STATIC_SECRET", group: "mail", label: "Рассылка: статический ключ, секрет", hint: "Секретная часть статического ключа доступа. С Key ID выше подписывает запросы рассылки к Postbox.", kind: "secret" },
  { name: "POSTBOX_KEY_ID", group: "mail", label: "Почта: логин SMTP", hint: "Идентификатор API-ключа сервисного аккаунта — это логин SMTP Postbox (пара к POSTBOX_SECRET). Этой парой уходят письма платформы: обращения, оплата, ответы поддержки. Для REST-рассылки нужен отдельный ключ выше.", kind: "value" },
  { name: "POSTBOX_SECRET", group: "mail", label: "Почта: пароль SMTP", hint: "Секретная часть того же API-ключа. Это пароль SMTP, а не подпись REST-запросов: подписать им SendEmail нельзя, Postbox ответит 403.", kind: "secret" },
  { name: "POSTBOX_SA_KEY", group: "mail", label: "Рассылка: ключ сервисного аккаунта (JSON)", hint: "Можно не задавать, если уже заполнен YANDEX_SA_KEY: сервер возьмёт тот же ключ, если у роли есть postbox.sender. Свой ключ надёжнее — роль рассылки отделяется от роли SMS.", kind: "json-key" },
  { name: "POSTBOX_SA_KEY_FILE", group: "mail", label: "Рассылка: путь к файлу ключа", hint: "Альтернатива вставке: путь внутри контейнера, например /var/lib/webnestdev/secrets/postbox-sa-key.json.", kind: "path" },
  { name: "POSTBOX_DAILY_LIMIT", group: "mail", label: "Рассылка: писем в сутки", hint: "Необязательно: по умолчанию 200 — начальная квота Postbox. После повышения квоты в консоли укажите новое значение: очередь считает предел по своей таблице и останавливается сама.", kind: "value" },
  { name: "POSTBOX_RATE_PER_SECOND", group: "mail", label: "Рассылка: писем в секунду", hint: "Необязательно: по умолчанию 1 — начальная скорость Postbox. Больше ставить только после повышения квоты, иначе Postbox начнёт отвечать отказами.", kind: "value" },
  { name: "POSTBOX_DKIM_SELECTORS", group: "mail", label: "Рассылка: селекторы DKIM", hint: "Необязательно: через запятую, например selector1,selector2. Точные имена видны на странице адреса в Postbox. Нужны, чтобы админка говорила «домен подтверждён» по настоящим DNS-записям, а не по факту заполненного адреса.", kind: "value" },
  { name: "POSTBOX_PRICE_PER_1000", group: "mail", label: "Рассылка: цена за 1000 писем, ₽", hint: "Необязательно: цена Postbox в вашем тарифе. Без неё предпросмотр покажет получателей и отписки, но не стоимость.", kind: "value" },

  { name: "PLATFORM_AI_BASE_URL", group: "ai", label: "AI Base URL", hint: "OpenAI-совместимый адрес модели платформы — то, чем пользуются проекты без своего провайдера.", kind: "url" },
  { name: "PLATFORM_AI_MODEL", group: "ai", label: "AI модель", hint: "Идентификатор модели для этого адреса.", kind: "value" },
  { name: "PLATFORM_AI_API_KEY", group: "ai", label: "AI ключ", hint: "Ключ провайдера модели платформы. Проекты со своим ключом его не используют.", kind: "secret" },
  { name: "PLATFORM_AI_FREE_BASE_URL", group: "ai", label: "Free AI Base URL", hint: "Бесплатная модель тарифа «Старт», OpenAI-совместимый адрес. Пусто — бесплатный тариф работает на модели платформы выше. Для Cloudflare Workers AI: https://api.cloudflare.com/client/v4/accounts/<Account ID>/ai/v1", kind: "url" },
  { name: "PLATFORM_AI_FREE_MODEL", group: "ai", label: "Free AI модель", hint: "Идентификатор бесплатной модели, например agnes-2.5-flash или @cf/openai/gpt-oss-120b у Cloudflare.", kind: "value" },
  { name: "PLATFORM_AI_FREE_PROVIDER", group: "ai", label: "Free AI провайдер", hint: "Необязательно: как называть бесплатную модель в логах и подсказках. По умолчанию Agnes AI; для Cloudflare Workers AI так и напишите.", kind: "value" },
  { name: "PLATFORM_AI_FREE_KEY_1", group: "ai", label: "Free AI ключ 1", hint: "Первый ключ бесплатной модели; при отказе запуск переходит к следующему, затем к модели платформы.", kind: "secret" },
  { name: "PLATFORM_AI_FREE_KEY_2", group: "ai", label: "Free AI ключ 2", hint: "Второй ключ бесплатной модели из другого аккаунта — резерв первого.", kind: "secret" },
  { name: "PLATFORM_AI_FREE_KEY_3", group: "ai", label: "Free AI ключ 3", hint: "Третий ключ бесплатной модели из другого аккаунта — последний резерв перед моделью платформы.", kind: "secret" },
  // Генерация изображений для проектов: инструмент image.generate. Это не модель агента, а
  // отдельный сервис картинок, поэтому и имена свои — включение не трогает ни один PLATFORM_AI_*.
  { name: "PLATFORM_IMAGE_BASE_URL", group: "ai", label: "Картинки: Base URL", hint: "Адрес сервиса генерации изображений. Cloudflare Workers AI: https://api.cloudflare.com/client/v4/accounts/<Account ID>/ai/run — модель дописывается к адресу. OpenAI-совместимый сервис: адрес с /v1, к нему допишется /images/generations.", kind: "url" },
  { name: "PLATFORM_IMAGE_MODEL", group: "ai", label: "Картинки: модель", hint: "Например @cf/black-forest-labs/flux-1-schnell (быстрая, до 8 шагов) или @cf/stabilityai/stable-diffusion-xl-base-1.0 (принимает размер и негативный промпт).", kind: "value" },
  { name: "PLATFORM_IMAGE_PROVIDER", group: "ai", label: "Картинки: провайдер", hint: "Необязательно: имя сервиса в логах и подсказках. По умолчанию Cloudflare Workers AI.", kind: "value" },
  { name: "PLATFORM_IMAGE_KEY_1", group: "ai", label: "Картинки: ключ 1", hint: "API-токен сервиса картинок (у Cloudflare — право Workers AI: Read). При отказе доступа или лимите запрос идёт к следующему ключу.", kind: "secret" },
  { name: "PLATFORM_IMAGE_KEY_2", group: "ai", label: "Картинки: ключ 2", hint: "Второй ключ из другого аккаунта — резерв первого.", kind: "secret" },
  { name: "PLATFORM_IMAGE_KEY_3", group: "ai", label: "Картинки: ключ 3", hint: "Третий ключ — последний резерв, дальше инструмент отвечает отказом.", kind: "secret" },

  // Поддержка: обращения из кнопки «Поддержка» сохраняются на сервере, читаются в админке
  // платформы и — по ключу API — во внешней админке (десктопное и мобильное приложение).
  // Почта необязательна: с SMTP обычной почты (Яндекс, Mail.ru, Gmail) сервер входит в твой ящик
  // и шлёт письмо на него же, без отдельного сервиса. Без почтовых ключей обращения остаются
  // на сервере и в API.
  { name: "SUPPORT_API_KEY", group: "support", label: "Ключ API для админки", hint: "Ключ только для чтения: внешнее приложение забирает обращения запросом GET /api/support/tickets с заголовком Authorization: Bearer <ключ> или X-Support-Key: <ключ>. Скриншот — GET /api/support/tickets/<id>/screenshot. Создать обращение по ключу нельзя. Не короче 16 символов; пробелы и невидимые символы убираются при сохранении.", kind: "secret" },
  { name: "SUPPORT_EMAIL_TO", group: "support", label: "Куда присылать обращения", hint: "Адрес ящика поддержки, например support@example.ru. На него придет письмо с обращением.", kind: "value" },
  { name: "SUPPORT_REPLY_TO", group: "support", label: "Куда отвечает человек", hint: "Необязательно: адрес в Reply-To писем-ответов, по умолчанию support@nestdev.ru. На него уйдёт ответ, если человек нажмёт «Ответить» в письме поддержки.", kind: "value" },
  { name: "SUPPORT_EMAIL_FROM", group: "support", label: "Адрес отправителя", hint: "Необязательно: по умолчанию совпадает с логином SMTP. У Яндекса и Mail.ru это должен быть тот же ящик. Не нужен, если настроена почта платформы выше.", kind: "value" },
  { name: "SUPPORT_SMTP_HOST", group: "support", label: "SMTP-сервер", hint: "Необязательно, если настроена почта платформы («Почта (Yandex Cloud Postbox)»): она важнее. Свой вариант — smtp.yandex.ru, smtp.mail.ru или smtp.gmail.com.", kind: "value" },
  { name: "SUPPORT_SMTP_PORT", group: "support", label: "Порт SMTP", hint: "Необязательно: по умолчанию 465 (шифрование сразу). Порт 587 с STARTTLS не поддерживается.", kind: "value" },
  { name: "SUPPORT_SMTP_USER", group: "support", label: "Логин SMTP", hint: "Обычно полный адрес ящика.", kind: "value" },
  { name: "SUPPORT_SMTP_PASSWORD", group: "support", label: "Пароль SMTP", hint: "Пароль приложения, а не пароль от почты: Яндекс — «Безопасность» → «Пароли приложений», Mail.ru — «Пароли для внешних приложений», Gmail — «Пароли приложений» (нужна 2FA).", kind: "secret" },
];

/** Names the deployment owns: they are read before the app starts or by compose, so the panel cannot apply them. */
const DEPLOY_ONLY = new Set([
  "NODE_ENV", "PORT", "WEBNESTDEV_STORAGE", "WEBNESTDEV_DATA_DIR", "DATABASE_URL", "POSTGRES_PASSWORD",
  "WEBNESTDEV_ENCRYPTION_KEY", "WEBNESTDEV_SECRETS_DIR", "SANDBOX_DIR", "WEBNESTDEV_SANDBOX_DIR",
  "WEBNESTDEV_ALLOWED_ORIGINS", "WEBNESTDEV_SITE_DOMAIN", "PREVIEW_PUBLIC_DOMAIN", "PREVIEW_TICKET_TTL_MS",
  "ACME_EMAIL", "WEBNESTDEV_IMAGE", "WEBNESTDEV_DEMO_USER", "WEBNESTDEV_DEMO_PHONE_ENABLED", "WEBNESTDEV_DEMO_PHONE",
  "WEBNESTDEV_ADMIN_EMAILS", "WEBNESTDEV_ADMIN_USER_IDS", "WEBNESTDEV_COOKIE_SECURE",
  "WEBNESTDEV_BROWSER_EXECUTABLE", "PLAYWRIGHT_BROWSERS_PATH", "AI_PROVIDER", "AI_BASE_URL", "AI_MODEL", "AI_API_KEY",
]);

export type PlatformEnvSource = "panel" | "environment" | "none";
export type PlatformEnvStatus = {
  name: string;
  group: PlatformEnvGroup;
  label: string;
  hint: string;
  kind: PlatformEnvKind;
  source: PlatformEnvSource;
  /** Masked shape of the stored value ("sk-…f3a2", "строк: 23") or the plain value for non-secrets. */
  value?: string;
  updatedAt?: string;
};

type StoredEntry = { value: string; preview: string; updatedAt: string };
type StoreFile = { version: 1; values: Record<string, StoredEntry> };

const GROUP_LABEL: Record<PlatformEnvGroup, string> = { github: "GitHub", gitlab: "GitLab", gitverse: "GitVerse", yandex: "Yandex Cloud", sms: "SMS-провайдеры", ai: "AI-провайдер платформы", search: "Веб-поиск агента", billing: "Оплата (Robokassa)", plans: "Тарифы", mail: "Почта (Yandex Cloud Postbox)", support: "Поддержка" };

export function platformEnvGroupLabel(group: PlatformEnvGroup) {
  return GROUP_LABEL[group];
}

let overrides = new Map<string, StoredEntry>();
let loaded = false;
// Отпечаток файла, который сейчас разобран в `overrides`. Нужен, чтобы процесс замечал
// изменения, записанные другим процессом (несколько реплик, перезапуск рядом с живым).
let storeStamp: string | null = null;
let loadInFlight: Promise<void> | null = null;

function storeFile() {
  return path.join(process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev"), "platform", "env.json");
}

function fileStamp(info: { mtimeMs: number; size: number }) {
  return info.mtimeMs.toFixed(3) + ":" + info.size;
}

function catalogEntry(name: string) {
  return PLATFORM_ENV_CATALOG.find(entry => entry.name === name);
}

/**
 * Значение для кода: сначала то, что записано в панели, потом переменная окружения. Разрешение
 * синхронное и из памяти: этими значениями пользуются и синхронные части (выбор SMS-провайдера),
 * поэтому файл читается один раз при старте, а запись обновляет кэш.
 */
export function getPlatformEnv(name: string): string | undefined {
  const stored = overrides.get(name)?.value;
  if (stored !== undefined) return stored;
  return process.env[name];
}

export function platformEnvSetByPanel(name: string) {
  return overrides.has(name);
}

/** Чтение шифрованного хранилища при старте. Ошибка ключа не роняет сервер: значения просто не применяются. */
async function loadPlatformEnvFromDisk() {
  loaded = true;
  overrides = new Map();
  const file = storeFile();
  // Отпечаток снимается до чтения: если файл изменится между stat и readFile, следующий
  // refresh увидит другой отпечаток и перечитает его. Обратный порядок оставил бы в памяти
  // старое содержимое с новым отпечатком, и изменение потерялось бы до следующей записи.
  let stamp: string | null = null;
  try { stamp = fileStamp(await stat(file)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("[platform] не удалось проверить хранилище ключей:", error);
  }
  let raw: string;
  try { raw = await readFile(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("[platform] не удалось прочитать хранилище ключей:", error);
    storeStamp = stamp;
    return;
  }
  storeStamp = stamp;
  let parsed: StoreFile;
  try { parsed = JSON.parse(raw) as StoreFile; }
  catch { console.error("[platform] хранилище ключей повреждено — значения панели не применены"); return; }
  let migrated = false;
  let decryptFailed = false;
  for (const [name, entry] of Object.entries(parsed.values ?? {})) {
    if (!entry?.value) continue;
    const encrypted = isEncryptedSecret(entry.value);
    try {
      overrides.set(name, { value: encrypted ? decryptSecret(entry.value) : entry.value, preview: entry.preview ?? "", updatedAt: entry.updatedAt ?? "" });
      // Старое хранилище писало значения открытым текстом. Оставлять их так до следующей
      // записи нельзя: файл бэкапится, и ротация ключа их уже не увидит.
      if (!encrypted) migrated = true;
    } catch (error) {
      decryptFailed = true;
      console.error("[platform] ключ " + name + " не расшифрован (изменился WEBNESTDEV_ENCRYPTION_KEY?) — используется значение окружения:", error instanceof Error ? error.message : error);
    }
  }
  // Перезапись при хотя бы одной ошибке расшифровки потеряла бы запись, которую не удалось
  // прочитать: файл остаётся как есть, пока ключ не вернут.
  if (migrated && !decryptFailed) {
    try {
      await writeStore(overrides);
      console.log("[platform] открытые значения панели перешифрованы");
    } catch (error) {
      console.error("[platform] не удалось перешифровать значения панели:", error instanceof Error ? error.message : error);
    }
  }
  if (overrides.size) console.log("[platform] ключей из панели: " + overrides.size + " (" + [...overrides.keys()].sort().join(", ") + ")");
}

/** Один разбор файла на процесс: старт и параллельные проверки не читают его наперегонки. */
export async function loadPlatformEnv() {
  if (loadInFlight) return loadInFlight;
  loadInFlight = loadPlatformEnvFromDisk().finally(() => { loadInFlight = null; });
  return loadInFlight;
}

/**
 * Перечитать хранилище, если его изменил другой процесс. `getPlatformEnv` намеренно остаётся
 * синхронным (им пользуются и синхронные части), поэтому обновление памяти — отдельный шаг.
 * Без него ключ, сохранённый в панели на одной реплике, не видел бы запрос, попавший на другую:
 * `savePlatformEnv` обновляет карту только своего процесса.
 */
export async function refreshPlatformEnv() {
  let info: { mtimeMs: number; size: number };
  try { info = await stat(storeFile()); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // Файл исчез (например, пересоздан том): значения панели больше не действуют.
      if (storeStamp !== null || overrides.size) await loadPlatformEnv();
      return;
    }
    console.error("[platform] не удалось проверить хранилище ключей:", error);
    return;
  }
  if (fileStamp(info) === storeStamp) return;
  await loadPlatformEnv();
}

export function platformEnvLoaded() {
  return loaded;
}

async function writeStore(entries: Map<string, StoredEntry>) {
  const file = storeFile();
  await mkdir(path.dirname(file), { recursive: true });
  // На диск значения уходят только шифрованными: файл — такой же секрет, как хранилища
  // подключений, и открытый GITHUB_CLIENT_SECRET в нём был бы утечкой через бэкап.
  const payload: StoreFile = {
    version: 1,
    values: Object.fromEntries([...entries.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, entry]) => [name, { ...entry, value: encryptSecret(entry.value) }])),
  };
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    await rename(temp, file);
    // Свой же файл не должен перечитываться следующим refresh: отпечаток уже известен.
    try { storeStamp = fileStamp(await stat(file)); } catch { storeStamp = null; }
  } catch (error) {
    try { await unlink(temp); } catch {}
    throw error;
  }
}

/**
 * Как показать значение в панели. Секреты и многострочные ключи — только формой: «sk-…f3a2» или
 * «строк: 23». Так видно, что ключ на месте и тот ли это файл, и ни одно значение не уезжает в
 * браузер целиком.
 */
export function previewOf(value: string) {
  const text = value.trim();
  const lines = text.split("\n").length;
  if (lines > 1) return "строк: " + lines;
  if (text.length > 12) return text.slice(0, 4) + "…" + text.slice(-4);
  return text.length ? String(text.length) + " симв." : "";
}

/** Переносы строк приводятся к \n, внешние пробелы и CRLF убираются: «неправильные переносы» — это они. */
export function normalizePastedValue(value: string) {
  return value.replace(/\r\n?/g, "\n").trim();
}

/**
 * Ключ API приходит из буфера обмена вместе с невидимыми символами: переводом строки, пробелом,
 * zero-width разделителем. В заголовке это не часть ключа, поэтому при сохранении и сравнении
 * они убираются — иначе панель говорит «сохранено», а тот же ключ в запросе получает 401.
 */
export function normalizeApiKeyValue(value: string) {
  // Кроме пробелов и переводов строк — мягкий перенос, word joiner, bidi-марки и другие
  // невидимые разделители, которые приезжают вместе с текстом из документа или мессенджера.
  return value.replace(/[\s\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]+/g, "");
}

/** Проверка значения до записи: ошибка объясняет, что не так, вместо «сохранено, но не работает». */
export function validatePlatformValue(name: string, value: string): string | null {
  const entry = catalogEntry(name);
  if (!entry) return "Неизвестный ключ: " + name;
  const text = normalizePastedValue(value);
  if (!text) return null;
  if (name === "SUPPORT_API_KEY" && normalizeApiKeyValue(text).length < 16) {
    return "Ключ API для админки должен быть не короче 16 символов (без пробелов и невидимых символов)";
  }
  if (entry.kind === "json-key") {
    try { parseServiceAccountKey(text); }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  }
  if (entry.kind === "url" && !/^https?:\/\/[^\s]+$/i.test(text)) return "Нужен адрес вида https://…";
  if (entry.kind === "path" && text.includes("\n")) return "Путь должен быть одной строкой";
  if (entry.kind === "flag" && !/^(0|1|true|false|yes|no|да|нет)$/i.test(text)) return "Допустимо: 1/0, true/false, yes/no";
  if (name === "WEB_SEARCH_PROVIDER" && !/^(auto|duckduckgo|yandex|tavily)$/i.test(text)) return "Допустимо: auto, duckduckgo, yandex или tavily";
  if (name === "ROBOKASSA_HASH" && !/^(md5|sha1|sha256|sha384|sha512|ripemd160)$/i.test(text)) return "Допустимо: md5, sha1, sha256, sha384, sha512 или ripemd160";
  if ((name === "ROBOKASSA_PRICE_PRO" || name === "ROBOKASSA_PRICE_TEAM") && !(Number(text.replace(",", ".")) > 0)) return "Нужна цена в рублях больше нуля";
  return null;
}

export type SkippedValue = { name: string; message: string };

/**
 * Запись значений из панели или из загруженного .env. Пустая строка удаляет значение панели и
 * возвращает ключ к переменной окружения — это и есть «вернуть как было» без правки .env на ВМ.
 *
 * Плохая строка не отменяет хорошие: загрузка целого .env применяет всё, что понимает, и
 * возвращает список пропущенного с причиной — иначе «загрузил файл, а половина не применилась»
 * выглядело бы как молчаливая потеря ключей.
 */
export async function savePlatformEnv(values: Record<string, string | undefined>) {
  // Панель читает хранилище при старте сервера, а скрипт или тест может вызвать запись первым.
  // Без загруженной карты `next` начался бы с пустой и стёр бы все ключи, которых нет в values.
  // Если карта уже есть, сверяемся с файлом: его мог изменить другой процесс, и запись поверх
  // устаревшей карты удалила бы чужие ключи.
  if (!loaded) await loadPlatformEnv();
  else await refreshPlatformEnv();
  const skipped: SkippedValue[] = [];
  const next = new Map(overrides);
  const saved: string[] = [];
  const cleared: string[] = [];
  for (const [rawName, rawValue] of Object.entries(values)) {
    const name = rawName.trim().toUpperCase();
    const entry = catalogEntry(name);
    if (!entry) { skipped.push({ name, message: DEPLOY_ONLY.has(name) ? "изменяется при выкладке (compose/окружение)" : "неизвестная переменная" }); continue; }
    const value = normalizePastedValue(rawValue ?? "");
    if (!value) {
      if (next.delete(name)) cleared.push(name);
      continue;
    }
    const problem = validatePlatformValue(name, value);
    if (problem) { skipped.push({ name, message: problem }); continue; }
    // Ключ поддержки хранится и показывается уже очищенным: пробелы и невидимые символы
    // не должны попадать ни в файл, ни в превью «nest…0-26».
    const storedValue = name === "SUPPORT_API_KEY"
      ? normalizeApiKeyValue(value)
      : entry.kind === "json-key" ? canonicalKeyJson(value) : value;
    next.set(name, { value: storedValue, preview: previewOf(storedValue), updatedAt: new Date().toISOString() });
    saved.push(name);
  }
  if (saved.length || cleared.length) {
    await writeStore(next);
    overrides = next;
  }
  return { saved, cleared, skipped };
}

export function platformEnvStatus(): PlatformEnvStatus[] {
  return PLATFORM_ENV_CATALOG.map(entry => {
    const stored = overrides.get(entry.name);
    if (stored) {
      return {
        name: entry.name, group: entry.group, label: entry.label, hint: entry.hint, kind: entry.kind,
        source: "panel" as const,
        value: entry.kind === "secret" || entry.kind === "json-key" ? stored.preview : stored.value,
        updatedAt: stored.updatedAt,
      };
    }
    const fromEnvironment = process.env[entry.name];
    if (fromEnvironment?.trim()) {
      return {
        name: entry.name, group: entry.group, label: entry.label, hint: entry.hint, kind: entry.kind,
        source: "environment" as const,
        // Значение из окружения показывается формой даже у несекретных ключей: панель честно
        // говорит, что ключ задан при выкладке, а не выдаёт себя за источник значения.
        value: previewOf(fromEnvironment),
      };
    }
    return { name: entry.name, group: entry.group, label: entry.label, hint: entry.hint, kind: entry.kind, source: "none" as const };
  });
}

export type ParsedEnvLine = { name: string; value: string };

/**
 * Разбор .env, который человек получает от провайдера, а не пишет руками: допускаются `export`,
 * комментарии, одинарные и двойные кавычки, экранированные `\n` внутри кавычек и настоящие
 * многострочные значения в кавычках (ключ сервисного аккаунта, PEM).
 */
export function parseEnvFileContent(content: string) {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const values: ParsedEnvLine[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]*)$/);
    if (!match) continue;
    let raw = match[2];
    // Незакрытая кавычка означает, что значение продолжается на следующих строках: так выглядят
    // pretty-printed ключи и PEM, скопированные из файла целиком.
    if (raw[0] === '"' || raw[0] === "'") {
      while (!isClosedQuote(raw) && index + 1 < lines.length) { index += 1; raw += "\n" + lines[index]; }
    }
    values.push({ name: match[1], value: decodeEnvValue(raw) });
  }
  return values;
}

/** Кавычка считается закрытой, когда её парное число, а нечётных обратных слэшей перед ней нет. */
function isClosedQuote(value: string) {
  const quote = value[0];
  const text = value.trimEnd();
  return text.length > 1 && countUnescaped(text, quote) % 2 === 0;
}

function countUnescaped(value: string, char: string) {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === char && !quoteIsEscaped(value, index)) count += 1;
  }
  return count;
}

function decodeEnvValue(raw: string) {
  const trimmed = raw.trim();
  const quoted = unquote(trimmed);
  if (quoted !== undefined) return quoted;
  // Незакавыченное значение: комментарий после него отбрасывается по dotenv.
  return stripComment(trimmed);
}

/**
 * Значение в кавычках. Закрывающая кавычка ищется так же, как .env читает dotenv: у одной
 * строки — первая неэкранированная, у многострочного значения — последняя (внутри pretty-printed
 * JSON таких кавычек много, и первая из них — не конец значения). Всё после неё — комментарий.
 */
function unquote(text: string) {
  const quote = text[0];
  if (quote !== '"' && quote !== "'") return undefined;
  const end = text.includes("\n") ? text.lastIndexOf(quote) : findClosingQuote(text, quote);
  if (end <= 0) return undefined;
  const inner = text.slice(1, end);
  if (quote === "'") return inner;
  return inner.replace(/\\(n|r|t|"|\\)/g, (_, code: string) => (code === "n" ? "\n" : code === "r" ? "\r" : code === "t" ? "\t" : code === '"' ? '"' : "\\"));
}

/** Кавычка закрывает значение, только если перед ней чётное число обратных слэшей. */
function quoteIsEscaped(text: string, index: number) {
  let slashes = 0;
  for (let back = index - 1; back >= 0 && text[back] === "\\"; back -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function findClosingQuote(text: string, quote: string) {
  for (let index = 1; index < text.length; index += 1) {
    if (text[index] === quote && !quoteIsEscaped(text, index)) return index;
  }
  return -1;
}

/** Комментарий — это `#` в начале строки или после пробела, а не внутри значения и не в кавычках. */
function stripComment(value: string) {
  let quote: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === "\\") { index += 1; continue; }
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === "#" && (index === 0 || /\s/.test(value[index - 1]))) return value.slice(0, index).trim();
  }
  return value;
}

/**
 * Ключ сервисного аккаунта сохраняется в каноническом виде: той же формой, которую принимает
 * парсер, но с правильно экранированными переносами. Так «неправильные переносы» чинятся один раз
 * при сохранении, а не превращаются в JSON, который никто не может прочитать.
 */
function canonicalKeyJson(text: string) {
  try { return JSON.stringify(parseAuthorizedKeyJson(text), null, 2); }
  catch { return text; }
}

/** Что делать с именами, которые панель не применяет: так загруженный файл объясняется целиком. */
export function describeUnappliedName(name: string) {
  return DEPLOY_ONLY.has(name) ? "изменяется при выкладке (compose/окружение)" : "неизвестная переменная";
}

export function isDeployOnlyName(name: string) {
  return DEPLOY_ONLY.has(name);
}
