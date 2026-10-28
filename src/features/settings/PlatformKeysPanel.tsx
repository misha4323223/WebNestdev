import { useEffect, useRef, useState } from "react";
import { Check, Eye, EyeOff, KeyRound, Loader2, ShieldAlert, Upload } from "lucide-react";
import { apiJson } from "../../lib/api";

/**
 * Ключи сервера: доступ к самому сервису (GitHub OAuth, Yandex Cloud, SMS, модель платформы).
 * Это не проект и не секрет проекта, поэтому панель закрыта администратором, а значения сервер
 * никогда не отдаёт: в списке стоят формы вроде «sk-…f3a2» и «строк: 23» — видно, что ключ есть
 * и тот ли это файл, но не сам ключ.
 */
type PlatformKeySource = "panel" | "environment" | "none";
type PlatformKey = {
  name: string;
  group: "github" | "gitlab" | "gitverse" | "yandex" | "sms" | "ai" | "search" | "billing" | "plans" | "mail" | "support";
  label: string;
  hint: string;
  kind: "secret" | "json-key" | "value" | "url" | "path" | "flag";
  source: PlatformKeySource;
  value?: string;
  updatedAt?: string;
};
type KeysResponse = { admin: boolean; adminsConfigured: boolean; guide?: string; keys?: PlatformKey[] };
type SaveResponse = { saved: string[]; cleared: string[]; skipped: Array<{ name: string; message: string }>; status: PlatformKey[] };

const GROUP_TITLES: Record<PlatformKey["group"], { title: string; note: string }> = {
  github: { title: "GitHub OAuth", note: "Вход через GitHub и импорт репозиториев. Callback: <адрес панели>/api/github/callback. В GitHub Secrets имя не может начинаться с GITHUB_ — там используйте GH_OAUTH_CLIENT_ID и GH_OAUTH_CLIENT_SECRET, а сюда вставьте значения напрямую." },
  gitlab: { title: "GitLab OAuth", note: "Импорт репозиториев из gitlab.com или своего GitLab. Callback: <адрес панели>/api/gitlab/callback. Приложение создаётся в аватаре → Edit profile → Access → Applications (прямая ссылка: https://gitlab.com/-/user_settings/applications) с правами read_api, read_repository и write_repository; личный токен работает и без OAuth-приложения." },
  gitverse: { title: "GitVerse OAuth", note: "Импорт и отправка коммитов в GitVerse. Callback: <адрес панели>/api/gitverse/callback. Приложение создаётся в Настройках профиля → Приложения, права read:user, read:repository и write:repository; GitVerse требует PKCE — сервер добавляет code_challenge сам. Личный токен тоже работает." },
  yandex: { title: "Yandex Cloud", note: "SMS входа по номеру и подключение облака. Ключ сервисного аккаунта принимается JSON-файлом целиком." },
  sms: { title: "SMS-провайдеры", note: "Достаточно одного провайдера: сервер выберет первый, у которого есть ключ." },
  ai: { title: "Модель платформы", note: "Модель по умолчанию для проектов без своего провайдера." },
  search: { title: "Веб-поиск агента", note: "Тариф «Старт» ищет через DuckDuckGo без ключей. На платных тарифах основным провайдером работает Yandex Search API (ключ сервисного аккаунта со scope yc.search-api.execute и каталог с ролью search-api.webSearch.user), а Tavily — резервным." },
  support: { title: "Поддержка", note: "Обращения из кнопки «Поддержка» сохраняются на сервере и читаются админкой платформы. Ключ API открывает их только на чтение для внешнего приложения (десктопного или мобильного): GET /api/support/tickets с заголовком Authorization: Bearer <ключ>. Почта необязательна: подойдёт SMTP обычной почты (smtp.yandex.ru, smtp.mail.ru, smtp.gmail.com — порт 465 и пароль приложения), ответ уходит автору обращения по Reply-To." },
  billing: { title: "Оплата (Robokassa)", note: "Логин магазина и пароли №1 и №2 из «Технических настроек» Робокассы. ResultURL: <адрес панели>/api/billing/robokassa/result, SuccessURL: /api/billing/robokassa/success, FailURL: /api/billing/robokassa/fail. Цены можно менять здесь без выкатки." },
  plans: { title: "Тарифы", note: "Названия, описания, цены и скидки настраиваются в соседнем разделе «Тарифы и скидки»." },
  mail: { title: "Почта (Yandex Cloud Postbox)", note: "Письма об оплате, предупреждения о списании и обращения поддержки. Postbox: сервисный аккаунт с ролью postbox.sender и API-ключ с областью yc.postbox.send — его идентификатор и секрет и есть логин и пароль SMTP. Адрес отправителя — с домена, подтверждённого в Postbox (DKIM). Пошаговая настройка: docs/MAIL.md." },
};

const SOURCE_LABEL: Record<PlatformKeySource, string> = {
  panel: "задан здесь",
  environment: "из .env выкладки",
  none: "не задан",
};

export function PlatformKeysPanel() {
  const [state, setState] = useState<KeysResponse | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [envText, setEnvText] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  // Какие поля показываются открыто: по умолчанию секреты скрыты, но проверить вставленное
  // значение иногда нужно — как в настройках AI-провайдера.
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const fileInput = useRef<HTMLInputElement | null>(null);

  async function load() {
    setLoading(true); setError("");
    try { setState(await apiJson<KeysResponse>("/api/platform/keys")); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  function setDraft(name: string, value: string) {
    setDrafts(current => ({ ...current, [name]: value }));
  }

  function describe(result: SaveResponse) {
    const parts: string[] = [];
    if (result.saved.length) parts.push("Сохранено: " + result.saved.join(", "));
    if (result.cleared.length) parts.push("Возвращено к .env: " + result.cleared.join(", "));
    return parts.join(" · ") || "Изменений нет";
  }

  function report(result: SaveResponse) {
    setState(current => current ? { ...current, keys: result.status } : current);
    // Пропущенные значения остаются в поле: человек видит, что именно не принято, и может
    // исправить это, а не искать заново, что он вставлял.
    setDrafts(current => result.skipped.length
      ? Object.fromEntries(Object.entries(current).filter(([name]) => result.skipped.some(item => item.name === name)))
      : {});
    const skipped = result.skipped.map(item => item.name + " — " + item.message);
    setStatus(describe(result) + (skipped.length ? " · Пропущено: " + skipped.join("; ") : ""));
  }

  async function saveFields() {
    const values = Object.fromEntries(Object.entries(drafts).filter(([, value]) => value !== undefined));
    if (!Object.keys(values).length) { setError("Измените хотя бы одно поле"); return; }
    setBusy(true); setError(""); setStatus("");
    try { report(await apiJson<SaveResponse>("/api/platform/keys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values }) })); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function applyEnv(text: string) {
    if (!text.trim()) { setError("Файл .env пуст"); return; }
    setBusy(true); setError(""); setStatus("");
    try {
      const result = await apiJson<SaveResponse>("/api/platform/keys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ env: text }) });
      report(result); setEnvText("");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function readFile(file: File) {
    if (file.size > 200_000) { setError("Файл больше 200 КБ — это не .env с ключами"); return; }
    const text = await file.text();
    setEnvText(text);
    await applyEnv(text);
  }

  if (loading) return <section className="settings-panel"><div className="settings-body">Загружаем ключи сервера…</div></section>;

  if (!state?.admin) {
    return <section className="settings-panel platform-keys">
      <div className="panel-title"><div><span className="eyebrow">КЛЮЧИ СЕРВЕРА</span><strong>Доступ только администратору</strong></div></div>
      <div className="settings-body">
        <div className="settings-status platform-guide"><ShieldAlert size={15}/><span>{state?.guide ?? "Редактор ключей открыт только администратору платформы."}</span></div>
        <p className="platform-muted">Переменные окружения вашего проекта — в разделе «Секреты проекта». Подключения аккаунта — в «Интеграциях» и «AI-провайдере»; они доступны всегда.</p>
      </div>
    </section>;
  }

  // Почта стоит рядом с поддержкой: адрес отправителя и ключ SMTP — это то, что правят, когда
  // не уходит письмо, и раньше группы не было в списке вовсе, хотя ключи в каталоге есть.
  const groups = ["support", "mail", "billing", "github", "gitlab", "yandex", "sms", "ai", "search"] as const;
  const keys = state.keys ?? [];

  return <section className="settings-panel platform-keys">
    <div className="panel-title"><div><span className="eyebrow">КЛЮЧИ СЕРВЕРА</span><strong>Ключи платформы</strong></div>
      <button className="ghost-button" onClick={() => void load()} disabled={busy}>Обновить</button>
    </div>
    <div className="settings-body">
      <div className="settings-status">
        Значения хранятся зашифрованными на сервере и переживают выкатку. Пустое поле возвращает ключ к значению из .env.
        Многострочный JSON и PEM можно вставлять как есть — переносы строк, отступы и кавычки сервер чинит сам.
      </div>

      <div
        className={"platform-drop" + (dragging ? " dragging" : "")}
        onDragOver={event => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={event => { event.preventDefault(); setDragging(false); const file = event.dataTransfer.files?.[0]; if (file) void readFile(file); }}
      >
        <div><Upload size={15}/><strong>Загрузить .env</strong><span>или перетащите файл сюда — применится сразу, строки с комментариями и export понимаются</span></div>
        <button className="ghost-button" onClick={() => fileInput.current?.click()} disabled={busy}>Выбрать файл</button>
        <input ref={fileInput} type="file" accept=".env,text/plain" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void readFile(file); }}/>
      </div>
      <label>Или вставьте содержимое .env<textarea className="platform-env-text" value={envText} onChange={event => setEnvText(event.target.value)} placeholder={"GITHUB_CLIENT_ID=…\nGITHUB_CLIENT_SECRET=…\nYANDEX_CLOUD_ID=…\nYANDEX_SA_KEY=\"{…}\""} rows={5} spellCheck={false}/></label>
      <div className="model-row"><button className="ghost-button" onClick={() => void applyEnv(envText)} disabled={busy || !envText.trim()}>Применить вставленное</button></div>

      {groups.map(group => {
        const items = keys.filter(entry => entry.group === group);
        if (!items.length) return null;
        const title = GROUP_TITLES[group];
        return <div className="platform-group" key={group}>
          <div className="platform-group-head"><strong>{title.title}</strong><span>{title.note}</span></div>
          {items.map(entry => {
            const multiline = entry.kind === "json-key";
            const secret = entry.kind === "secret" || entry.kind === "json-key";
            return <label className="platform-key" key={entry.name}>
              <span className="platform-key-label">{entry.label}
                <code>{entry.name}</code>
                <span className={"platform-source " + entry.source}>{SOURCE_LABEL[entry.source]}{entry.value ? " · " + entry.value : ""}</span>
              </span>
              {multiline
                ? <textarea className="platform-env-text" rows={4} spellCheck={false} placeholder={entry.source === "panel" ? "Ключ сохранён — вставьте новый, чтобы заменить" : "Вставьте JSON authorized key целиком"} value={drafts[entry.name] ?? ""} onChange={event => setDraft(entry.name, event.target.value)}/>
                : <div className="platform-secret-row">
                    <div className="secret-field">
                      <input
                        type={secret && !revealed[entry.name] ? "password" : "text"}
                        spellCheck={false}
                        autoComplete="off"
                        placeholder={entry.source === "none" ? "не задан" : "сохранён — введите новое значение"}
                        value={drafts[entry.name] ?? ""}
                        onChange={event => setDraft(entry.name, event.target.value)}
                      />
                    </div>
                    {secret && <button type="button" className="ghost-button platform-reveal" title={revealed[entry.name] ? "Скрыть значение" : "Показать значение"} aria-pressed={Boolean(revealed[entry.name])} onClick={() => setRevealed(current => ({ ...current, [entry.name]: !current[entry.name] }))}>{revealed[entry.name] ? <EyeOff size={13}/> : <Eye size={13}/>}</button>}
                  </div>}
              <span className="platform-hint">{entry.hint}</span>
            </label>;
          })}
        </div>;
      })}

      {status && <div className="settings-status platform-result"><Check size={14}/><span>{status}</span></div>}
      {error && <div className="settings-error">{error}</div>}
      <div className="model-row">
        <button className="send-button settings-save" onClick={() => void saveFields()} disabled={busy || !Object.keys(drafts).length}>
          {busy ? <><Loader2 size={13} className="spin"/> Сохраняю…</> : <><KeyRound size={13}/> Сохранить ключи</>}
        </button>
        <span className="platform-counter">{Object.keys(drafts).length ? "Изменено полей: " + Object.keys(drafts).length : "Поля не изменены"}</span>
      </div>
    </div>
  </section>;
}
