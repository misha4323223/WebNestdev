# МТС Web Services (МВС, mws.ru)

Доступ к облаку МТС: проекты, виртуальные машины, управляемые базы, объектное хранилище.
Устроено так же, как интеграция Yandex Cloud в этом репозитории: **сервисный аккаунт, а не
логин и пароль**. В консоль агент не заходит, ему нужен авторизованный ключ.

## Что вставить в окружение

| Переменная | Что это |
| --- | --- |
| `MWS_SA_KEY` | Содержимое файла `key.json` авторизованного ключа, целиком, одной строкой. Этого достаточно: проект и сервисный аккаунт выводятся из его `keyId` |
| `MWS_SA_KEY_FILE` | Путь к тому же файлу, если удобнее держать его файлом (на ВМ — `/var/lib/webnestdev/secrets/mws-key.json`, как ключ Yandex) |
| `MWS_IAM_TOKEN` | Готовый IAM-токен. Только для разовой проверки: он живёт ограниченное время, и без ключа доступ перестаёт работать сам по себе |
| `MWS_IAM_HOST` | Хост IAM, по умолчанию `iam.mwsapis.ru`. Меняется только если МВС сменит адрес |

Ключ предпочтительнее готового токена даже когда заданы оба: ключ даёт свежий токен при
каждом обмене, поэтому «доступ вдруг пропал» не повторяется.

## Как это работает

```
key.json  --(JWT ES256, kid = имя ключа)-->  iam.mwsapis.ru
             sub = projects/<проект>/serviceAccounts/<аккаунт>
                -->  GET /iam/v2/tokens/:issueServiceAccountToken?serviceAccount=<аккаунт>
                       -->  { accessToken, expirationTs }  -->  Authorization: Bearer <токен>
```

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

## Чего здесь нет

Интеграция пока не подключена к агенту и к UI: `mws-auth.ts` — это доступ и проверка, а не
карточка интеграции. Карточка (как у Yandex Cloud: сохранение подключения на пользователя,
список ресурсов, переключатель «разрешить изменения») — следующий шаг, и она опирается на
этот модуль.
