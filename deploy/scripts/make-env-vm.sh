#!/bin/bash
#
# Готовит .env на ВМ: ключ шифрования, каталог данных, каталог песочниц, пароль базы,
# адреса фронтенда. Ключи SMS-провайдера здесь не создаются, но переносятся из прошлого
# .env — см. CARRY_PATTERN ниже: потерянные ключи выглядели как «SMS перестали приходить».
set -e
cd ~/webnestdev/src

# The encryption key must survive a redeploy: it decrypts connected integrations and
# provider tokens, and a freshly generated key makes everything encrypted earlier
# unreadable. Reuse the one already written when it has the expected shape.
if [ -f .env ] && grep -q '^WEBNESTDEV_ENCRYPTION_KEY=[a-f0-9]\{64\}$' .env; then
  ENCKEY=$(grep '^WEBNESTDEV_ENCRYPTION_KEY=' .env | head -1 | cut -d= -f2)
  echo "ENV-KEY-REUSED"
else
  ENCKEY=$(openssl rand -hex 32)
  echo "ENV-KEY-CREATED"
fi

# Соль журнала секретов не должна меняться между выкатками: иначе один и тот же IP
# выглядит как разные источники. Отдельная от ключа шифрования — по рекомендации
# docs/SECRET_ENCRYPTION.md.
if [ -f .env ] && grep -q '^WEBNESTDEV_AUDIT_SALT=.\+' .env; then
  AUDITSALT=$(grep '^WEBNESTDEV_AUDIT_SALT=' .env | head -1 | cut -d= -f2-)
  echo "AUDIT-SALT-REUSED"
else
  AUDITSALT=$(openssl rand -hex 32)
  echo "AUDIT-SALT-CREATED"
fi

# Accounts, projects and conversations live here. The path is outside the source tree on
# purpose: a redeploy replaces the code directory, and data kept inside it disappears.
DATA_DIR="$HOME/webnestdev/data"
mkdir -p "$DATA_DIR"

# Каталог песочниц и предпросмотра. Docker запускает контейнеры проектов с -v <путь>,
# и путь разбирается на хосте, поэтому он должен совпадать с тем, что смонтирован внутрь
# серверного контейнера (см. docker-compose.yml). Именованный том здесь не годится.
# Путь совпадает с значением по умолчанию в docker-compose.yml: если он здесь и там
# разойдётся, контейнеры и сервер начнут смотреть в разные каталоги.
SANDBOX_DIR="/var/lib/webnestdev/sandboxes"
if ! mkdir -p "$SANDBOX_DIR" 2>/dev/null; then
  echo "каталог $SANDBOX_DIR недоступен для записи. Выполните один раз:" >&2
  echo "  sudo mkdir -p $SANDBOX_DIR && sudo chmod 0775 $SANDBOX_DIR" >&2
  exit 1
fi
chmod 0775 "$SANDBOX_DIR" 2>/dev/null || true

# docker-compose.yml requires POSTGRES_PASSWORD: the postgres service and the server's
# DATABASE_URL are both built from it, and without it `docker compose up` refuses to start.
# It is reused when present — postgres only reads it while creating the data volume, so a
# fresh password on an existing volume breaks the connection.
if [ -f .env ] && grep -q '^POSTGRES_PASSWORD=.\+' .env; then
  PGPASS=$(grep '^POSTGRES_PASSWORD=' .env | head -1 | cut -d= -f2-)
  echo "PGPASS-REUSED"
else
  PGPASS=$(openssl rand -hex 16)
  echo "PGPASS-CREATED"
fi

# Каталог для файлов-секретов: ключ сервисного аккаунта Yandex Cloud — это JSON с переносами
# строк, и в .env (одна строка на переменную) он легко обрезается. Файл читается по тому же
# пути внутри контейнера (см. docker-compose.yml).
SECRETS_DIR="${WEBNESTDEV_SECRETS_DIR:-/var/lib/webnestdev/secrets}"
mkdir -p "$SECRETS_DIR" 2>/dev/null || true
chmod 700 "$SECRETS_DIR" 2>/dev/null || true

# Ключи SMS-провайдера и адреса фронтенда этот скрипт не придумывает — их вводят руками, и
# раньше при повторном запуске они исчезали: .env пересобирался целиком, вход по номеру
# молча уходил в тестовый режим (код в логах вместо SMS), а адреса фронтенда подменялись
# на localhost, с которым сервер в production отказывается стартовать. Теперь переносятся.
# Домены и адрес для Let's Encrypt тоже переносятся: иначе повторный запуск скрипта, который
# собирает .env целиком, выключил бы публичные адреса предпросмотра (PREVIEW_PUBLIC_DOMAIN) и
# оставил реверс-прокси без имени сайта — а это уже не «пересоздать .env», а «сайт не открывается».
# GITHUB_*, PLATFORM_AI_* и ключи веб-поиска — те же значения, которые можно ввести в панели: если
# их задали в .env (руками или через secrets в выкатке), пересборка файла не должна их терять.
# ROBOKASSA_* и BILLING_* переносятся отдельно: иначе повторный деплой молча выключил бы оплату.
# MAIL_* и POSTBOX_* — по той же причине: без них не уходят письма об оплате и предупреждения
# о списании, а автопродление отказывается включаться.
# Админы панели переносятся обязательно: без WEBNESTDEV_ADMIN_EMAILS редактор ключей закрыт, и
# потеря строки выглядела бы как «панель ключей сломалась».
CARRY_PATTERN='^(SMS_PROVIDER|SMS_SENDER|YANDEX_[A-Z0-9_]+|SMS_RU_API_ID|SMSC_[A-Z]+|EXOLVE_API_KEY|SMSAERO_[A-Z]+|WEBNESTDEV_SMS_TEST_MODE|WEBNESTDEV_DEMO_PHONE[A-Z_]*|WEBNESTDEV_PUBLIC_DEMO|WEBNESTDEV_ALLOWED_ORIGINS|WEBNESTDEV_SITE_DOMAIN|PREVIEW_PUBLIC_DOMAIN|PREVIEW_TICKET_TTL_MS|ACME_EMAIL|GITHUB_[A-Z_]+|GITLAB_[A-Z_]+|GITVERSE_[A-Z_]+|PLATFORM_AI_[A-Z0-9_]+|PLATFORM_IMAGE_[A-Z0-9_]+|PLATFORM_S3_[A-Z0-9_]+|PLATFORM_INFRA_[A-Z0-9_]+|PROJECT_ARCHIVE_[A-Z0-9_]+|WEBNESTDEV_ADMIN_[A-Z_]+|ADMIN_[A-Z_]+|TAVILY_API_KEY|WEB_SEARCH_PROVIDER|ROBOKASSA_[A-Z0-9_]+|BILLING_[A-Z0-9_]+|ALERT_[A-Z0-9_]+|MAIL_[A-Z0-9_]+|POSTBOX_[A-Z0-9_]+|SUPPORT_[A-Z0-9_]+)='
CARRY="$(grep -E "$CARRY_PATTERN" .env 2>/dev/null || true)"
if [ -n "$CARRY" ]; then echo "SMS-ENV-REUSED"; fi
# Адреса фронтенда: из прошлого .env или из PUBLIC_ORIGIN. localhost здесь нельзя — в production
# сервер проверяет список и падает, если в нём есть localhost.
if printf '%s\n' "$CARRY" | grep -q '^WEBNESTDEV_ALLOWED_ORIGINS='; then
  ORIGINS=""
else
  ORIGINS="${PUBLIC_ORIGIN:-http://$(hostname -I 2>/dev/null | awk '{print $1}'):8787}"
  if [ -z "$ORIGINS" ] || [ "$ORIGINS" = "http://:8787" ]; then
    echo "не удалось определить адрес фронтенда: запустите PUBLIC_ORIGIN=https://ваш-домен $0" >&2
    exit 1
  fi
fi

# Домены для реверс-прокси выводятся из того же адреса: https://nestdev.ru → панель на nestdev.ru,
# предпросмотры проектов — на <проект>.preview.nestdev.ru. Публичные адреса включаются только
# тогда, когда домен известен: если панель открывают по IP, поддоменов у неё нет, и дверь
# предпросмотра должна остаться выключенной, а не подняться с чужим именем.
ORIGIN_HOST=""
case "${PUBLIC_ORIGIN:-}" in
  http://*|https://*) ORIGIN_HOST=$(printf '%s' "$PUBLIC_ORIGIN" | sed -E 's#^[a-z][a-z0-9+.-]*://##; s#/.*$##; s#:[0-9]+$##') ;;
esac
if printf '%s' "$ORIGIN_HOST" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then ORIGIN_HOST=""; fi
SITE_DOMAIN=""
if ! printf '%s\n' "$CARRY" | grep -q '^WEBNESTDEV_SITE_DOMAIN='; then SITE_DOMAIN="$ORIGIN_HOST"; fi
PREVIEW_DOMAIN=""
if ! printf '%s\n' "$CARRY" | grep -q '^PREVIEW_PUBLIC_DOMAIN=' && [ -n "$ORIGIN_HOST" ]; then PREVIEW_DOMAIN="preview.$ORIGIN_HOST"; fi
ACME=""
if ! printf '%s\n' "$CARRY" | grep -q '^ACME_EMAIL='; then ACME="nestdev@mail.ru"; fi

{
  printf 'NODE_ENV=production\n'
  # WEBNESTDEV_STORAGE now accepts exactly two values: json and postgres. The old `ydb`
  # value is not a backend any more — the server used to fall back to json files without
  # saying so, which is why stored conversations looked lost.
  printf 'WEBNESTDEV_STORAGE=json\n'
  printf 'WEBNESTDEV_DATA_DIR=%s\n' "$DATA_DIR"
  printf 'SANDBOX_DIR=%s\n' "$SANDBOX_DIR"
  printf 'WEBNESTDEV_ENCRYPTION_KEY=%s\n' "$ENCKEY"
  printf 'WEBNESTDEV_AUDIT_SALT=%s\n' "$AUDITSALT"
  # Каталог секретов монтируется в контейнер, поэтому он записан и здесь, и в compose.
  printf 'WEBNESTDEV_SECRETS_DIR=%s\n' "$SECRETS_DIR"
  if [ -n "$ORIGINS" ]; then printf 'WEBNESTDEV_ALLOWED_ORIGINS=%s\n' "$ORIGINS"; fi
  # Имена сайта и публичных предпросмотров: их читает и сервер, и реверс-прокси (см. deploy/Caddyfile).
  if [ -n "$SITE_DOMAIN" ]; then printf 'WEBNESTDEV_SITE_DOMAIN=%s\n' "$SITE_DOMAIN"; fi
  if [ -n "$PREVIEW_DOMAIN" ]; then printf 'PREVIEW_PUBLIC_DOMAIN=%s\n' "$PREVIEW_DOMAIN"; fi
  if [ -n "$ACME" ]; then printf 'ACME_EMAIL=%s\n' "$ACME"; fi
  # Пароль базы: docker-compose.yml без него не поднимется (см. проверку выше).
  printf 'POSTGRES_PASSWORD=%s\n' "$PGPASS"
  # Перенесённые значения (ключи SMS, прошлые адреса фронтенда).
  if [ -n "$CARRY" ]; then printf '%s\n' "$CARRY"; fi
} > .env
chmod 600 .env
echo "LINES=$(wc -l < .env)"
echo "ENCLEN=$(grep -c '^WEBNESTDEV_ENCRYPTION_KEY=[a-f0-9]\{64\}$' .env)"
echo "DATADIR=$(grep '^WEBNESTDEV_DATA_DIR=' .env | cut -d= -f2)"
echo "SANDBOXDIR=$(grep '^SANDBOX_DIR=' .env | cut -d= -f2)"
echo "PGPASS=$(grep -c '^POSTGRES_PASSWORD=.\+' .env)"
echo "SMSKEYS=$(grep -cE "$CARRY_PATTERN" .env)"
echo "SECRETSDIR=$SECRETS_DIR"
echo "SITEDOMAIN=$(grep -c '^WEBNESTDEV_SITE_DOMAIN=' .env)"
echo "PREVIEWDOMAIN=$(grep '^PREVIEW_PUBLIC_DOMAIN=' .env | cut -d= -f2- || true)"
echo "ENV-READY"
echo "Публичные предпросмотры (адреса <проект>.preview.<домен>) работают, если PREVIEW_PUBLIC_DOMAIN задан, а для домена предпросмотра есть подстановочная DNS-запись на этот сервер."
echo "Если каталога секретов нет, создайте его от root: sudo mkdir -p $SECRETS_DIR && sudo chown $USER $SECRETS_DIR"
echo "Ключи GitHub OAuth, Yandex Cloud, SMS и модели платформы можно не править на ВМ: войдите администратором и откройте Настройки → «Ключи сервера». Значения хранятся зашифрованными в $DATA_DIR/platform."
echo "Администратор панели задаётся только здесь: WEBNESTDEV_ADMIN_EMAILS=ваш@адрес (список через запятую) в .env."
echo "Ключ сервисного аккаунта Yandex Cloud положите в $SECRETS_DIR/yandex-sa-key.json (chmod 600) и добавьте в .env:"
echo "  YANDEX_SA_KEY_FILE=$SECRETS_DIR/yandex-sa-key.json"
echo "  YANDEX_CLOUD_ID=<идентификатор облака>"
echo "Готовый IAM-токен (YANDEX_NOTIFY_IAM_TOKEN) не используйте: он живёт около 12 часов, и SMS после этого перестают уходить."
echo "Веб-поиск агента: бесплатный тариф ищет через DuckDuckGo без ключей; платным нужны YANDEX_SEARCH_API_KEY и YANDEX_SEARCH_FOLDER_ID, резерв — TAVILY_API_KEY. Их можно вставить в панели или задать секретами репозитория — выкатка сама допишет их в .env."
