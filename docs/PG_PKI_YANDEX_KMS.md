# PostgreSQL PKI через Yandex KMS

**Статус на 22.11.2026, 10:04 UTC:** код и workflow готовы в рабочем дереве; в production
миграция **ещё не выполнена**. Пока `node-1` использует прежний файловый CA и
`webnestdev-pg-tls-rotate.timer`. Этот документ — порядок перехода и дальнейшей ротации.

Цель: убрать `ca.key` с `node-1`. Приватный ключ корневого CA хранится в асимметричном ключе
Yandex KMS, а подпись CSR выполняет отдельный подписант. На нодах остаются только публичный
`ca.crt` и обычные листовые ключи.

## 1. Что сделано в репозитории

| Файл | Назначение |
| --- | --- |
| `deploy/pki-kms/pki_kms.py` | выпуск root CA и листьев через KMS; строгая политика SAN/срока |
| `deploy/pki-kms/run.sh` | миграция/ротация: CSR с node-1 → подпись на runner → установка |
| `deploy/pki-kms/requirements.txt` | `asn1crypto`, `cryptography` |
| `deploy/pki-kms/test_pki_kms.py` | тесты политики выпуска и JWT/KMS-запросов без сети |
| `deploy/ha/pg_pki.sh` | режимы `kms-csr`, `kms-install-ca`, `kms-stage-cert`, `kms-stage-trust`, `kms-activate`, `kms-retire-old-ca`, `kms-retire-key` |
| `.github/workflows/pki-kms.yml` | ручной workflow `verify` / `rotate` / `migrate` |
| `.github/workflows/pki-backup.yml` | после удаления `ca.key` backup корректно пропускается |
| `.github/workflows/ci.yml` | синтаксис и тесты KMS-подписанта |

Ключевое свойство: **node-1 не получает прав KMS и service account key**. Она создаёт
`next-server.key`/`next-server.csr`, а подписант возвращает только `next-server.crt`.
`ca.key` после успешной миграции удаляется; `ca.srl` тоже.

## 2. Границы решения

- **Это не HSM.** В Yandex KMS HSM доступен только для симметричного AES-256. Асимметричный
  ключ подписи — программный ключ KMS: приватный ключ не экспортируется и не лежит на ноде,
  но это не аппаратный модуль. Если требование именно «HSM для CA», нужен отдельный
  B2B-провайдер (например, Cloud.ru Advanced или КриптоПро HSM); для самозанятого это
  отдельный договор и бюджет.
- **Зависимость от Yandex Cloud.** Потеря доступа к аккаунту/ключу означает потерю
  возможности выпускать новые листья. Действующие листья живут 90 дней. Включите
  `deletionProtection`, защитите аккаунт и настройте аудит.
- **Ключ CA не экспортируется.** Off-site backup в виде файла, как для старого CA, здесь
  невозможен. Восстановление после потери KMS-ключа — только новый root CA и перевыпуск
  листьев.
- **Нет CRL/OCSP.** Как и в прежней PKI, отзыв отдельного листа не поддерживается; при
  компрометации листа выпускается новый, при компрометации CA — новый root.
- **GitHub Actions — доверенный подписант.** Service account key лежит в GitHub Secret и
  доступен runner'у на время job. Защитите environment `production` обязательными
  reviewers, ограничьте права репозитория и ротируйте ключ SA. Для более строгой модели
  запускайте `pki_kms.py` на отдельной машине администратора, а не в Actions.

## 3. Что нужно сделать один раз (пошагово)

### Шаг 1. Создать сервисный аккаунт и ключ KMS

В консоли Yandex Cloud (или через `yc`):

1. Identity and Access → Service accounts → Create:
   - имя: `pg-pki-kms`;
   - роли на folder: `kms.admin` **только на время создания ключа** (потом снять).
2. KMS → Asymmetric signature keys → Create:
   - имя: `webnestdev-pg-root-ca`;
   - алгоритм: **ECDSA NIST P-256 SHA-256** (`ECDSA_NIST_P256_SHA_256`);
   - deletion protection: **включить**;
   - сохранить **ID ключа** — это не секрет.
3. На этот ключ выдать сервисному аккаунту `pg-pki-kms`:
   - `kms.asymmetricSignatureKeys.signer`;
   - `kms.asymmetricSignatureKeys.publicKeyViewer`.
   - `kms.viewer` нужен только если вы вручную запускаете `pki_kms.py show-key`; workflow
     его не требует.
4. Снять с `pg-pki-kms` роль `kms.admin`, если она выдавалась на folder.

Проверка, что роли не перепутаны: подписанту нужны **sign + publicKeyViewer**, а не
`kms.admin` и не право создавать/удалять ключи.

### Шаг 2. Создать service account key JSON

Service accounts → `pg-pki-kms` → Keys → Create new key → **JSON**. Файл скачивается один раз.

В GitHub:

1. Settings → Secrets and variables → Actions → Secrets → New repository secret:
   - имя: `PKI_KMS_SA_KEY_JSON`;
   - значение: содержимое JSON целиком.
2. Settings → Secrets and variables → Actions → Variables → New repository variable:
   - имя: `YC_KMS_KEY_ID`;
   - значение: ID ключа из шага 1.

Секрет не копировать в репозиторий, не вставлять в чат и не класть на `node-1`.

### Шаг 3. Защитить запуск

1. Settings → Environments → `production` → Required reviewers: добавить себя. Сейчас в
   репозитории у environment `production` нет обязательных reviewers.
2. Убедиться, что секреты `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY` (и при наличии
   `DEPLOY_KNOWN_HOSTS`, `DEPLOY_PORT`) уже работают в `deploy.yml`.
3. Не давать `node-1` право `kms.sign` и не устанавливать туда service account key.

### Шаг 4. Запустить миграцию

Actions → **PostgreSQL PKI via Yandex KMS** → Run workflow:

- `mode`: `migrate`;
- `confirm`: `MIGRATE`;
- `remove_old_key`: `true` (удалить старый `ca.key` после успешной проверки);
- `kms_key_id`: оставить пустым, если задана variable `YC_KMS_KEY_ID`.

Workflow делает по порядку:

1. выпускает новый root CA из публичного ключа KMS (ключ CA не покидает KMS);
2. кладёт новый публичный `ca.crt` на `node-1`;
3. создаёт новые CSR и листовые ключи на `node-1` для обеих нод;
4. подписывает CSR на runner через KMS;
5. проверяет новые листья и готовит их в PKI-каталоге;
6. добавляет **старый + новый** CA в доверие на обеих нодах и перечитывает PostgreSQL/HAProxy;
7. переключает листья `node-1`, затем `node-2`;
8. оставляет в доверии только новый CA;
9. запускает `verify` на обеих нодах;
10. удаляет старый `ca.key`/`ca.srl` и отключает локальный timer авто-ротации.

Если job упал до шага 6, live-сертификаты не менялись. Если упал между 6 и 8, в доверии
могут быть оба CA — это безопасное промежуточное состояние; не запускайте `migrate` повторно
вслепую, сначала посмотрите `status` и лог. Старый `ca.key` при падении не удаляется.

Не запускайте `deploy.yml` одновременно с `migrate`: workflow меняет trust и live-листья.
Новые листья лежат как `next-server.*` и не подменяют `server.*` до `kms-activate`, но
активацию и trust лучше не совмещать с выкаткой.

### Шаг 5. Проверить результат

На `node-1`:

```bash
sudo /opt/webnestdev-ha/pg_pki.sh status
sudo /opt/webnestdev-ha/pg_pki.sh verify
sudo openssl x509 -in /etc/postgresql/17/main/tls/server.crt -noout \
  -subject -issuer -enddate -fingerprint -sha256
sudo test ! -e /etc/webnestdev-ha/pg-pki/ca.key && echo "ca.key: отсутствует — OK"
sudo systemctl is-active webnestdev-pg-tls-rotate.timer 2>/dev/null || echo "локальный timer: отключён"
```

На обеих нодах:

```bash
sudo openssl verify -CAfile /etc/haproxy/pg-ca.crt \
  /etc/postgresql/17/main/tls/server.crt
sudo -u postgres psql -p 5433 -Atc 'show ssl'          # on
grep -c 'BEGIN CERTIFICATE' /etc/haproxy/pg-ca.crt    # 1 после retire
curl -fsS https://nestdev.ru/api/ready
```

Ожидаемо: issuer нового листа — `CN=WebNestDev PostgreSQL Root CA (Yandex KMS)`,
fingerprint'ы нод разные, репликация остаётся `streaming`.

### Шаг 6. Убрать старые зависимости

1. Actions → **PostgreSQL CA backup** → Disable workflow. После удаления `ca.key` он
   штатно пропускается, но расписание больше не нужно.
2. `pki-backup-setup.yml` больше не нужен для нового CA; не запускать.
3. Старый age-архив CA не удалять сразу: он нужен для аварийного отката/аудита, пока новый
   CA не отработал хотя бы один цикл. Хранить его офлайн по правилам `PG_PKI_BACKUP.md`.
4. Ротировать service account key `PKI_KMS_SA_KEY_JSON` и удалить старый ключ в Yandex
   Cloud после первого успешного `rotate`.
5. Раз в 60 дней (или когда до истечения листа осталось < 30 дней) запускать workflow
   `rotate` с `confirm=ROTATE`. Локальный timer для KMS не работает.

## 4. Ротация листьев

Actions → **PostgreSQL PKI via Yandex KMS** → Run workflow:

- `mode`: `rotate`;
- `confirm`: `ROTATE`;
- `remove_old_key`: можно оставить `true`, но на этом шаге `ca.key` уже нет.

Ротация не меняет CA и не трогает доверие: новые листья подписываются тем же KMS-ключом,
устанавливаются на обе ноды, затем выполняется `verify`.

Ручной вариант с отдельной машины администратора:

```bash
export YC_KMS_KEY_ID='<id>'
export YC_SA_KEY_FILE="$HOME/.config/webnestdev/pki-kms-sa.json"
# только публичный CA и CSR; ключ листа остаётся на node-1
python3 deploy/pki-kms/pki_kms.py \
  --kms-key-id "$YC_KMS_KEY_ID" --sa-key-file "$YC_SA_KEY_FILE" \
  sign --ca-cert ca.crt --csr node-1.csr --node node-1 --out node-1.crt --days 90
```

## 5. Проверка подписанта без Yandex

```bash
python3 -m pip install -r deploy/pki-kms/requirements.txt
python3 -m unittest discover -s deploy/pki-kms -p 'test_*.py' -v
```

Тесты используют локальный ECDSA-ключ вместо KMS и проверяют:

- root и leaf проходят `verify`;
- SAN фиксированы для `node-1`/`node-2`;
- CN и SAN из CSR игнорируются;
- срок листа не больше 90 дней;
- CSR с плохой подписью и RSA < 2048 бит отклоняются;
- чужой CA не проходит проверку;
- JWT для IAM собирается и подписывается правильно.

## 6. Диагностика

| Симптом | Что проверить |
| --- | --- |
| `HTTP 401` от KMS | истёк/неверный service account key; `YC_IAM_TOKEN` не задан |
| `HTTP 403` от KMS | у SA нет `kms.asymmetricSignatureKeys.signer`/`publicKeyViewer` на ключ |
| `HTTP 404` без тела на `:sign` или `/publicKey` | запрос ушёл на control plane; обе криптооперации обслуживает только `kms.yandex` |
| `HTTP 404` тела `Key with id ...:getPublicKey not found` | метода `:getPublicKey` нет; публичный ключ — `GET .../{id}/publicKey` на `kms.yandex` |
| `KMS не вернул publicKey` | ключ не асимметричный или не ECDSA P-256 |
| `CA в KMS, но сертификата node-1 нет` | сначала выполните `migrate`, не `setup` |
| `старый ca.key оставлен` | `REMOVE_OLD_KEY=0`; запустите `kms-retire-key` после проверки |
| `local timer` остался активным | `systemctl disable --now webnestdev-pg-tls-rotate.timer` |
| `verify` не проходит после активации | в доверии ещё старый CA; проверьте `kms-stage-trust` и `kms-retire-old-ca` |

Криптооперации KMS живут на двух разных хостах, и это устройство сервиса, а не настройка:

- `https://kms.api.cloud.yandex.net` — control plane: создание и чтение самого ключа
  (`GET .../asymmetricSignatureKeys/{id}`);
- `https://kms.yandex` — data plane: `POST .../{id}:sign` и `GET .../{id}/publicKey`.

Метода `:getPublicKey` на control plane нет: такой путь разбирается как `keyId`, и KMS
отвечает `Key with id <id>:getPublicKey not found`.

Переопределяются через `YC_KMS_ENDPOINT`/`YC_KMS_CRYPTO_ENDPOINT` (или `--kms-endpoint`,
`--kms-crypto-endpoint`).

## 7. Файлы на нодах после миграции

```text
/etc/webnestdev-ha/pg-pki/
├── ca.crt                 # публичный CA из KMS, 644
├── ca-mode                # маркер «CA в KMS»; блокирует локальный auto-rotate
├── old-ca.crt             # публичный старый CA для аудита, 600 (если создан)
├── trust-bundle.crt       # промежуточный bundle; после retire можно удалить вручную
└── nodes/
    ├── node-1/server.crt  # лист node-1
    ├── node-1/server.key  # ключ node-1, 600
    ├── node-2/server.crt
    └── node-2/server.key
```

`ca.key` и `ca.srl` после успешного `kms-retire-key` отсутствуют. Приватный ключ CA есть
только в Yandex KMS.

## 8. Чек-лист

- [ ] Создан service account `pg-pki-kms`.
- [ ] Создан асимметричный KMS-ключ `webnestdev-pg-root-ca` (ECDSA P-256, deletion protection).
- [ ] Выданы только `signer` + `publicKeyViewer`; `kms.admin` снят.
- [ ] `PKI_KMS_SA_KEY_JSON` добавлен в GitHub Secrets, `YC_KMS_KEY_ID` — в Variables.
- [ ] В environment `production` включены Required reviewers.
- [ ] Workflow `migrate` с `confirm=MIGRATE` завершён.
- [ ] На обеих нодах `verify`, `show ssl=on`, репликация `streaming`.
- [ ] `ca.key` отсутствует, локальный timer отключён.
- [ ] Старый backup workflow отключён; старый age-архив сохранён офлайн.
- [ ] Service account key ротирован после первого успешного `rotate`.
