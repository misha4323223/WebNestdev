# WebNestDev AI Reverse Proxy

Бесплатный/почти бесплатный зарубежный reverse-proxy для AI-роутеров (bynara, agnes-ai и других), чтобы запросы ушли с не-российского IP.

## Переменные окружения

| Переменная | Обязательно | Пример |
|---|---:|---|
| `PROXY_TOKEN` | рекомендуется | случайный токен доступа к прокси |
| `DEFAULT_TARGET` | если не шлётся заголовок | `https://router.bynara.id` |
| `ALLOWED_TARGETS` | рекомендуется | `https://router.bynara.id,https://apihub.agnes-ai.com` |

## Использование

`POST /v1/chat/completions` к URL прокси с заголовками:

- `X-AI-Proxy-Target: https://router.bynara.id` (или используй `DEFAULT_TARGET`)
- `X-Proxy-Token: <токен>` (если включён)
- обычные заголовки провайдера, включая `Authorization`

Пример:

```bash
curl https://wn-ai-proxy.onrender.com/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'X-AI-Proxy-Target: https://router.bynara.id' \
  -H 'X-Proxy-Token: TOKEN' \
  -H 'Authorization: Bearer API_KEY' \
  -d '{"model":"agnes-2.5-flash","messages":[{"role":"user","content":"hi"}]}'
```

`/health` возвращает текущие разрешённые цели.
