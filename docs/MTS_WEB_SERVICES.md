# МТС Web Services (МВС, mws.ru)

Доступ к облаку МТС: проекты, виртуальные машины, управляемые базы, объектное хранилище.
Устроено так же, как интеграция Yandex Cloud в этом репозитории: **сервисный аккаунт, а не
логин и пароль**. В консоль агент не заходит, ему нужен авторизованный ключ.

## Что вставить в окружение

| Переменная | Что это |
| --- | --- |
| `MWS_SA_KEY_ID` + `MWS_SA_PRIVATE_KEY` | **Рекомендуется.** Значения `keyId` и `privateKey` из `key.json` по отдельности. Они однострочные, поэтому вставляются без подготовки |
| `MWS_SA_KEY` | Весь файл `key.json` одной строкой. Так тоже работает, но файл многострочный: при вставке в однострочное поле от него остаётся один символ «{» — самая частая ошибка |
| `MWS_SA_KEY_FILE` | Путь к тому же файлу, если удобнее держать его файлом (на ВМ — `/var/lib/webnestdev/secrets/mws-key.json`, как ключ Yandex) |
| `MWS_IAM_TOKEN` | Готовый IAM-токен. Только для разовой проверки: он живёт ограниченное время, и без ключа доступ перестаёт работать сам по себе |
| `MWS_IAM_HOST` | Хост IAM, по умолчанию `iam.mwsapis.ru`. Меняется только если МВС сменит адрес |

Ключ предпочтительнее готового токена даже когда заданы оба: ключ даёт свежий токен при
каждом обмене, поэтому «доступ вдруг пропал» не повторяется.

## Как это работает

```
key.json  --(JWT ES256, kid = имя ключа)-->  iam.mwsapis.ru
             sub = projects/<проект>/serviceAccounts/<аккаунт>
             Authorization: <подписанный JWT>   ← без префикса «Bearer »
                -->  GET /iam/v2/tokens/:issueServiceAccountToken?serviceAccount=<аккаунт>
                       -->  { accessToken, expirationTs }  -->  Authorization: Bearer <токен>
```

Два различаия, на которых легко потерять час (оба проверены на живом API):

- **JWT идёт без «Bearer ».** С префиксом шлюз отвечает `401 «Для авторизации используйте
  IAM token»`; так же отправляет его и официальный SDK. «Bearer » — только у выданного
  IAM-токена, в запросах к API.
- **Маршрут содержит сегмент `:`.** Без него — `404 No static resource`.

Схема взята из официальных спецификаций, а не восстановлена по догадкам:

- [mws-cloud-platform/api](https://github.com/mws-cloud-platform/api) — `openapi/iam/openapi.gen.yaml`
  описывает операцию `GET /iam/v2/tokens/:issueServiceAccountToken` (query `serviceAccount`,
  ответ `SuccessTokenV2Response` = `{ accessToken, expirationTs }`), `openapi/rm/openapi.gen.yaml` —
  `GET /rm/v3/projects`;
- [mws-cloud-platform/go-sdk](https://github.com/mws-cloud-platform/go-sdk) — `mws/iam/service_account.go`
  задаёт поля файла ключа (`keyId`, `privateKey`, `publicKey`, `expirationTime`, `algorithm`),
  где `privateKey` — base64 от PKCS8 DER, и вид `keyId`:
  `projects/<проект>/serviceAccounts/<аккаунт>/authorizedKeys/<ключ>`; `mws/iam/authorized_key.go`
  — подпись ES256, `kid` = имя ключа, `sub` = сервисный аккаунт, срок JWT — час.

Двоеточие в маршруте — **отдельный сегмент пути**, а не разделитель схемы: краткая запись
спецификации (`tokens:issueServiceAccountToken`) без него шлюз МВС разбирает как статический
ресурс и отвечает `404 No static resource`. Проверено на живом API `/iam/v2/tokens/:…`:
для несуществующего сервисного аккаунта приходит `403 Subject does not exist`, то есть запрос
доходит до выпуска токена.

В коде это `server/src/mws/mws-auth.ts`. Токен кешируется до истечения (в ответе приходит
`expirationTs`), запросы разрешены только к хостам `*.mwsapis.ru` — токен сервисного аккаунта
не должен уходить на чужой адрес из-за опечатки в хосте.

## Хосты API МВС

Полный список отдаёт `GET https://api.mwsapis.ru/endpoint`. Основные:

| Сервис | Хост |
| --- | --- |
| IAM, Resource Manager | `iam.mwsapis.ru` |
| Compute (ВМ, диски, образы) | `compute.mwsapis.ru` |
| Managed PostgreSQL | `mpostgres.mwsapis.ru` |
| VPC, сетевой балансировщик | `vpc.mwsapis.ru` |
| Object Storage (S3, регион `ru-central1`) | `storage.mwsapis.ru` |

Проект всегда в пути: `/compute/v1/projects/<проект>/virtualMachines`.

Список проектов (`/rm/v3/projects`) требует права `rm.project.list` на организацию: у
сервисного аккаунта его может не быть (`403 User type is not available to list projects`), и это
не мешает работать с проектом из ключа — проверка доступа именно так и решает.

## Проверка доступа

```bash
npm run mws:check --workspace=server
```

Ключ можно проверить до того, как он попадёт в переменные окружения:

```bash
npm run mws:check --workspace=server -- --key-file /путь/key.json
```

Печатает, каким способом настроен доступ и к какому проекту относится ключ (сам ключ и токен
не выводятся), получает IAM-токен, читает список проектов и виртуальные машины проекта из
ключа. Последняя строка — `MWS-ACCESS=ok|no-key|bad-key|rejected|unreachable`, код возврата 0
только при рабочем доступе.

## Что уже есть в проекте МВС

Проверено ключом сервисного аккаунта: `MWS-ACCESS=ok`. Ключ лежит в переменных окружения
(`MWS_SA_KEY_ID` + `MWS_SA_PRIVATE_KEY`, форма `MWS_SA_KEY` тоже принимается) и как файл —
`npm run mws:check --workspace=server -- --key-file /путь/key.json`.

| Что | Значение |
| --- | --- |
| Проект | `project-pimashin2015` |
| Сервисный аккаунт / ключ | `nestdev` / `nestdev` |
| ВМ | `webnestdev` — `base-2-4` (2 vCPU / 4 ГБ), диск 50 ГБ `nbs-pl2`, Ubuntu 24.04 LTS, зона `ru-central1-b`, включена |
| Публичный ingress | NLB `webnestdev-nlb-main` на `178.236.27.102` (`ea-webnestdev`) — на него смотрит A-запись `nestdev.ru`; бэкенды `10.0.0.4` и `10.0.0.5` |
| Management-адрес node-1 | `2.59.83.250` (`ea-webnestdev-admin`) — SSH, в DNS не входит |
| Внутренний адрес | `10.0.0.4` в сети `webnestdev-net` (`internetAccess: true`), подсеть `webnestdev-sub` `10.0.0.0/24` |

Ключ видит только этот проект: право `rm.project.list` на организацию МВС не выдано
(`403 User type is not available to list projects`), поэтому список проектов не читается, а
проект из `keyId` — читается. Ключ показывает **состав и состояние ресурсов**, но не то, что
запущено внутри ВМ: SSH-доступа у сервисного аккаунта нет, поэтому состояние сервисов
(контейнеры, порты, логи) проверяется либо по публичным портам, либо заходом на ВМ.

## Себестоимость в админке

`server/src/account/mts-pricing.ts` считает месячную инфраструктуру для
`/api/admin/stats/costs` и `/api/admin/stats/economics`:

1. читает официальный прайс-лист МВС (`https://mws.ru/docs/cloud-platform/about/general/mws-cloud-platform-pricing.html`)
   и берёт из него ставки vCPU, RAM, сетевых дисков NBS-PL2, дополнительных IOPS сверх
   включённых 1000 и активных внешних IP;
2. читает Compute API проекта (`/compute/v1/projects/<проект>/virtualMachines`) и берёт тип ВМ,
   зону, диски и выданные внешние адреса;
3. складывает `ставка × ресурсы` в рубли и отдаёт разбивку `monthly` / `compute` / `disks` /
   `network` вместе с составом ВМ.

Публичного Billing API у МВС нет: в OpenAPI есть IAM, Compute и другие сервисы, но спецификации
Billing нет, а детализация доступна выгрузкой в консоли или в Object Storage. Поэтому это
**оценка по прайс-листу**, а не фактический счёт. Она консервативная: выключенные ВМ всё равно
входят в сумму, потому что целевой production — две ноды; в ответе есть предупреждение о
выключенных машинах.

Если прайс-лист или Compute API недоступны, используется прежняя ручная
`PLATFORM_INFRA_COST_PER_MONTH`. Дополнительные статьи (S3, SMS, домены) задаются
`PLATFORM_INFRA_EXTRA_PER_MONTH` и прибавляются к расчёту. `MTS_PRICING_URL` позволяет указать
другой адрес официального прайса.

## Обзор облака в админке

`GET /api/admin/cloud/overview` (`server/src/routes/admin-cloud.ts`) отдаёт для экрана «Облако»
машины, диски, внешние адреса и бакеты. Машины, диски и адреса читаются из Compute и VPC API;
бакеты — через S3 `ListBuckets` с ключами `PLATFORM_S3_*`, потому что отдельного REST-метода
списка бакетов у Object Storage нет. Маршрут только читает, требует админский `Bearer` и не
возвращает ключи или IAM-токен. Контракт и пример ответа — в `docs/ADMIN_API.md`, раздел 7.16.

## Чего здесь нет

К агенту и пользовательской панели интеграция пока не подключена: `mws-auth.ts` — это доступ и
проверка, а не карточка интеграции. Админский экран «Облако» уже читает ресурсы через
`/api/admin/cloud/overview`. Карточка для пользователя (как у Yandex Cloud: сохранение
подключения на пользователя, список ресурсов, переключатель «разрешить изменения») — следующий
шаг, и она опирается на этот модуль.
