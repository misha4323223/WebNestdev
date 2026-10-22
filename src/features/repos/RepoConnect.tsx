import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, KeyRound, UploadCloud } from "lucide-react";
import type { BrandId } from "../../components/BrandLogo";
import { openImportedProject } from "../../lib/project-api";
import { queueAgentStart } from "../../lib/agent-start";
import { ConnectorCard, type ConnectorStatus } from "../integrations/ConnectorCard";
import type { ConnectorSurface } from "../github/GitHubConnect";

type RepoProviderId = "gitverse" | "sourcecraft";

type Repository = {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  url: string;
  isPrivate?: boolean;
};

type Status = {
  connected?: boolean;
  login?: string | null;
  configured?: boolean;
  callbackUrl?: string;
  tokenUrl?: string;
  error?: string;
};

/**
 * Настройки карточек. Маршруты у GitVerse и SourceCraft одинаковые (один адаптер на сервере),
 * поэтому карточка одна: различаются имя, ссылка на выдачу токена и наличие OAuth-кнопки.
 */
const PROVIDERS: Record<RepoProviderId, {
  name: string;
  api: string;
  /** Страница, где пользователь создаёт токен: ссылка «Где взять токен». */
  tokenUrl: string;
  oauth: boolean;
  /** Официальный знак хостинга в плитке карточки. */
  logo: BrandId;
}> = {
  gitverse: {
    name: "GitVerse",
    logo: "gitverse",
    api: "/api/gitverse",
    tokenUrl: "https://gitverse.ru/user/settings/tokens",
    oauth: true,
  },
  sourcecraft: {
    name: "SourceCraft",
    logo: "sourcecraft",
    api: "/api/sourcecraft",
    tokenUrl: "https://sourcecraft.dev/portal/docs/en/sourcecraft/security/pat",
    oauth: false,
  },
};

const notices: Record<string, string> = {
  connected: "подключён. Репозитории можно импортировать.",
  denied: "Доступ не подтверждён — подключение можно начать заново.",
  not_configured: "OAuth не настроен на сервере: подключите аккаунт личным токеном — поле ниже работает всегда.",
  state_expired: "Ссылка авторизации устарела. Начните подключение заново.",
  token_error: "Сервис не выдал токен доступа. Попробуйте подключиться снова.",
  error: "Не удалось завершить подключение.",
};

function kickoff(repository: Repository, name: string) {
  return `Импортирован репозиторий ${name}: ${repository.fullName} (ветка ${repository.defaultBranch}).\n\n`
    + "Сделай только анализ: определи стек, структуру, точки входа, качество кода, зависимости, риски и что стоит улучшить. Ничего не меняй.\n\n"
    + "Сначала работай в режиме планировщика: изучи проект, задай через question.ask не больше двух уточняющих вопросов, если без них нельзя выбрать правильный путь. Затем собери полный пошаговый план через plan.update и перечисли, что пользователю нужно подтвердить перед началом работы.";
}

export function RepoConnect({ provider, surface = "home", onImported = openImportedProject }: {
  provider: RepoProviderId;
  surface?: ConnectorSurface;
  onImported?: (projectId: string, conversationId: string) => void;
}) {
  const config = PROVIDERS[provider];
  const [status, setStatus] = useState<ConnectorStatus>("loading");
  const [login, setLogin] = useState<string | null>(null);
  const [configured, setConfigured] = useState(true);
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [selected, setSelected] = useState<Repository | null>(null);
  const [reposOpen, setReposOpen] = useState(false);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [tokenOpen, setTokenOpen] = useState(surface === "workspace");
  const [savingToken, setSavingToken] = useState(false);
  const watchRef = useRef<number | null>(null);

  const stopWatching = useCallback(() => {
    if (watchRef.current !== null) { window.clearInterval(watchRef.current); watchRef.current = null; }
    setBusy(false);
  }, []);

  const loadStatus = useCallback(async (quiet = false): Promise<ConnectorStatus> => {
    try {
      const response = await fetch(config.api + "/status?origin=" + encodeURIComponent(window.location.origin));
      const data = await response.json() as Status;
      if (!response.ok) {
        // 404 — сервер ещё не знает этот маршрут (старая выкатка). Голое «Not Found» в карточке
        // ничего не объясняло, поэтому показываем причину, а не текст ответа Fastify.
        throw new Error(response.status === 404
          ? "Сервер не поддерживает этот хостинг — нужна выкатка новой версии"
          : data.error ?? config.name + " ответил кодом " + response.status);
      }
      if (data.error) throw new Error(data.error);
      const next: ConnectorStatus = data.connected ? "connected" : data.configured === false ? "unavailable" : "disconnected";
      setStatus(next);
      setLogin(data.login ?? null);
      setConfigured(data.configured !== false);
      return next;
    } catch (e) {
      // Ошибка запроса не должна оставлять карточку в «Проверяем подключение…» навсегда:
      // возвращаем её в обычное состояние с понятным сообщением.
      setStatus("disconnected");
      if (!quiet) setError(e instanceof Error ? e.message : "Не удалось получить состояние " + config.name);
      return "disconnected";
    }
  }, [config.api, config.name]);

  const loadRepositories = useCallback(async () => {
    setLoadingRepos(true); setError(null);
    try {
      const data = await fetch(config.api + "/repositories").then(response => response.json()) as { repositories?: Repository[]; error?: string };
      if (data.error) throw new Error(data.error);
      setRepositories(data.repositories ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось загрузить репозитории");
    } finally { setLoadingRepos(false); }
  }, [config.api]);

  useEffect(() => {
    void loadStatus();
    return stopWatching;
  }, [loadStatus, stopWatching]);

  useEffect(() => {
    if (!reposOpen || status !== "connected") return;
    void loadRepositories();
  }, [reposOpen, status, loadRepositories]);

  function connect() {
    setError(null); setNotice(null);
    if (!config.oauth || !configured) {
      setNotice(config.oauth ? "not_configured" : null);
      setTokenOpen(true);
      return;
    }
    const url = config.api + "/connect?origin=" + encodeURIComponent(window.location.origin);
    const popup = window.open(url, "webnestdev-" + provider, "width=620,height=760,left=140,top=90");
    if (!popup || popup.closed) { window.location.href = url; return; }
    stopWatching();
    setBusy(true);
    watchRef.current = window.setInterval(() => {
      if (popup.closed) { stopWatching(); void loadStatus(true); return; }
      void loadStatus(true).then(next => {
        if (next !== "connected") return;
        stopWatching();
        setNotice("connected");
        try { popup.close(); } catch {}
      });
    }, 1500);
  }

  async function disconnect() {
    stopWatching();
    setBusy(true); setError(null);
    try {
      const response = await fetch(config.api + "/disconnect", { method: "POST" });
      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? config.name + " не подтвердил отключение");
      }
      setLogin(null); setRepositories([]); setSelected(null); setReposOpen(false); setNotice(null);
      await loadStatus(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось отключить " + config.name);
    } finally { setBusy(false); }
  }

  async function saveToken() {
    const value = token.trim();
    if (!value) return;
    setSavingToken(true); setError(null); setNotice(null);
    try {
      const response = await fetch(config.api + "/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: value }),
      });
      const data = await response.json() as Status;
      if (!response.ok) throw new Error(data.error ?? config.name + " не принял токен");
      setToken(""); setTokenOpen(false); setNotice("connected");
      await loadStatus(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить токен");
    } finally { setSavingToken(false); }
  }

  async function importRepository() {
    if (!selected) return;
    setImporting(true); setError(null);
    try {
      const response = await fetch(config.api + "/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selected.id }),
      });
      const data = await response.json() as { error?: string; project?: { id: string }; conversation?: { id: string } };
      if (!response.ok || !data.project || !data.conversation) throw new Error(data.error ?? "Не удалось импортировать репозиторий");
      queueAgentStart(data.conversation.id, { prompt: kickoff(selected, config.name), title: "Импорт: " + selected.fullName });
      onImported(data.project.id, data.conversation.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка импорта");
    } finally { setImporting(false); }
  }

  return <ConnectorCard
    name={config.name}
    logo={config.logo}
    status={status}
    account={login}
    busy={busy}
    busyLabel={"Ждём " + config.name + "…"}
    onConnect={connect}
    onDisconnect={() => void disconnect()}
    onRefresh={() => void loadStatus()}
    note={<>
      {notice && <div className={"connector-notice" + (notice === "connected" ? " ok" : "")}>{config.name + ": " + (notices[notice] ?? notices.error)}</div>}
      {error && <div className="connector-notice">{error}</div>}
    </>}
  >
    <div className="connector-body">
      {status !== "connected" && <>
        <div className="connector-actions-row">
          <button className="ghost-button connector-toggle" onClick={() => setTokenOpen(open => !open)}>{tokenOpen ? "Скрыть поле токена" : "Ввести токен"}</button>
          <a className="ghost-button" href={config.tokenUrl} target="_blank" rel="noreferrer">Где взять токен <ExternalLink size={11}/></a>
        </div>
        {tokenOpen && <div className="connector-key">
          <label>
            <span><KeyRound size={12}/> Личный токен {config.name}</span>
            <input type="password" autoComplete="new-password" value={token} onChange={event => setToken(event.target.value)} placeholder="токен из настроек профиля"/>
          </label>
          <div className="connector-actions-row">
            <button className="connector-action connector-connect" onClick={() => void saveToken()} disabled={!token.trim() || savingToken}>{savingToken ? "Проверяем токен…" : "Сохранить токен"}</button>
          </div>
          <p className="connector-fineprint">Токен проверяется до сохранения, шифруется на сервере и не возвращается в браузер.</p>
        </div>}
      </>}

      {status === "connected" && <>
        <button className="ghost-button connector-toggle" onClick={() => setReposOpen(open => !open)}>{reposOpen ? "Скрыть репозитории" : "Импортировать репозиторий"}</button>
        {reposOpen && <>
          <div className="github-repositories">
            {repositories.length
              ? repositories.map(repository => <button key={repository.id} className={"github-repository" + (selected?.id === repository.id ? " selected" : "")} onClick={() => setSelected(repository)}>
                  <span><strong>{repository.fullName}</strong><small>{repository.isPrivate ? "Приватный" : "Публичный"} · {repository.defaultBranch}</small></span>
                </button>)
              : <span className="github-login">{loadingRepos ? "Загружаем репозитории…" : "Репозитории не найдены"}</span>}
          </div>
          <div className="connector-repo-actions">
            <button className="ghost-button" onClick={() => void loadRepositories()} disabled={loadingRepos}>Обновить</button>
            <button className="connector-action connector-connect" onClick={() => void importRepository()} disabled={!selected || importing}><UploadCloud size={13}/> {importing ? "Импортируем…" : "Импортировать"}</button>
          </div>
        </>}
      </>}
    </div>
  </ConnectorCard>;
}
