import { useCallback,useEffect,useRef,useState } from "react";
import { Bug, KeyRound, Play, Search, UploadCloud, X } from "lucide-react";
import { BrandMark } from "../../components/BrandLogo";
import { openImportedProject } from "../../lib/project-api";
import { queueAgentStart } from "../../lib/agent-start";
import { ConnectorCard,type ConnectorStatus } from "../integrations/ConnectorCard";

type Repository = { id:number; name:string; full_name:string; private:boolean; default_branch:string; owner:{login:string} };
type GitHubStatus = { connected?:boolean; githubLogin?:string|null; configured?:boolean; callbackUrl?:string; error?:string };

/** The surface that started the flow, so a full-page return reopens the same place. */
export type ConnectorSurface = "home" | "workspace";

/**
 * Что сделать с импортированным репозиторием. Импорт не бросает агента сразу в правки: выбранный
 * вариант становится задачей планировщика, а разработка начинается только после подтверждения плана.
 */
type RepoIntent="analysis"|"run"|"errors"|"custom";
const repoIntents:Array<{id:RepoIntent;label:string;description:string;icon:typeof Search}>=[
  {id:"analysis",label:"Только анализ",description:"Изучить стек, архитектуру, качество кода и риски — без изменений",icon:Search},
  {id:"run",label:"Запустить проект",description:"Разобраться с зависимостями и окружением и подготовить запуск",icon:Play},
  {id:"errors",label:"Выявить ошибки",description:"Проверить сборку, типы, тесты и найти проблемы с исправлениями",icon:Bug},
];

function repoKickoff(repository:Repository,intent:RepoIntent,custom:string){
  const task=intent==="custom"
    ?"Что сделать с проектом: "+custom.trim()
    :intent==="analysis"
      ?"Сделай только анализ: определи стек, структуру, точки входа, качество кода, зависимости, риски и что стоит улучшить. Ничего не меняй."
      :intent==="run"
        ?"Подготовь проект к запуску: разберись с пакетным менеджером, зависимостями, переменными окружения и командой запуска. Проверь, чего не хватает, и предложи точный порядок действий."
        :"Найди ошибки: проверь сборку, типы, тесты, конфигурацию, обработку ошибок и потенциальные проблемы. Для каждой проблемы укажи причину и предлагаемое исправление.";
  return `Импортирован репозиторий GitHub: ${repository.full_name} (ветка ${repository.default_branch}).\n\n${task}\n\nСначала работай в режиме планировщика и не меняй файлы. Изучи проект, задай через question.ask не больше двух уточняющих вопросов, если без них нельзя выбрать правильный путь. Затем собери полный пошаговый план через plan.update и перечисли, что пользователю нужно подтвердить перед началом работы.`;
}

const notices: Record<string,string> = {
  connected: "GitHub подключён. Репозитории можно импортировать.",
  denied: "Доступ не подтверждён — подключение можно начать заново.",
  not_configured: "GitHub OAuth не настроен на сервере (GITHUB_CLIENT_ID и GITHUB_CLIENT_SECRET). Подключите аккаунт личным токеном — поле ниже работает всегда.",
  state_expired: "Ссылка авторизации устарела. Начните подключение заново.",
  token_error: "GitHub не выдал токен доступа. Попробуйте подключиться снова.",
  profile_error: "Не удалось получить профиль GitHub.",
  error: "Не удалось завершить подключение GitHub.",
};

const returnFlag = "webnestdev.githubReturn";
const noticeFlag = "webnestdev.githubNotice";
/**
 * Name of the authorization window. It survives the round trip to GitHub, which
 * is how AuthGate recognises its own window and only reports the result back.
 */
const connectorWindowName = "webnestdev-github";

export function GitHubConnect({surface="home",onImported=openImportedProject}:{surface?:ConnectorSurface;onImported?:(projectId:string,conversationId:string)=>void}){
  const [status,setStatus]=useState<ConnectorStatus>("loading");
  const [login,setLogin]=useState<string|null>(null);
  const [repositories,setRepositories]=useState<Repository[]>([]);
  const [selected,setSelected]=useState<Repository|null>(null);
  const [reposOpen,setReposOpen]=useState(false);
  const [busy,setBusy]=useState(false);
  const [loadingRepos,setLoadingRepos]=useState(false);
  const [importing,setImporting]=useState(false);
  const [intentOpen,setIntentOpen]=useState(false);
  const [intent,setIntent]=useState<RepoIntent>("analysis");
  const [customIntent,setCustomIntent]=useState("");
  const [notice,setNotice]=useState<string|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [callbackUrl,setCallbackUrl]=useState<string|null>(null);
  const [copied,setCopied]=useState(false);
  // Личный токен — второй способ подключения рядом с OAuth: он не требует заводить приложение
  // GitHub на сервере, поэтому поле видно сразу там, где пользователь пришёл подключать сервисы
  // (в настройках рабочей области), а на домашней панели остаётся кнопка.
  const [token,setToken]=useState("");
  const [tokenOpen,setTokenOpen]=useState(surface==="workspace");
  const [savingToken,setSavingToken]=useState(false);
  const [oauthHintOpen,setOauthHintOpen]=useState(false);
  const watchRef=useRef<number|null>(null);

  const stopWatching=useCallback(()=>{
    if(watchRef.current!==null){window.clearInterval(watchRef.current);watchRef.current=null;}
    setBusy(false);
  },[]);

  const loadStatus=useCallback(async(quiet=false):Promise<ConnectorStatus>=>{
    try{
      const data=await fetch("/api/github/status?origin="+encodeURIComponent(window.location.origin)).then(response=>response.json()) as GitHubStatus;
      if(data.error)throw new Error(data.error);
      // A linked account wins over missing OAuth credentials, so the card never
      // hides a working connection behind a server warning.
      const next:ConnectorStatus=data.connected?"connected":data.configured===false?"unavailable":"disconnected";
      setStatus(next);
      setLogin(data.githubLogin??null);
      setCallbackUrl(data.callbackUrl??null);
      return next;
    }catch(e){
      if(!quiet)setError(e instanceof Error?e.message:"Не удалось получить состояние GitHub");
      return "disconnected";
    }
  },[]);

  const loadRepositories=useCallback(async()=>{
    setLoadingRepos(true);setError(null);
    try{
      const data=await fetch("/api/github/repositories").then(response=>response.json()) as { repositories?:Repository[]; error?:string };
      if(data.error)throw new Error(data.error);
      setRepositories(data.repositories??[]);
    }catch(e){setError(e instanceof Error?e.message:"Не удалось загрузить репозитории")}
    finally{setLoadingRepos(false)}
  },[]);

  /**
   * The server derives the callback from the origin the app is open at, so the
   * card shows the exact value for the GitHub form instead of making the user
   * assemble it from the hostname.
   */
  async function copyCallback(){
    const value=callbackUrl??window.location.origin+"/api/github/callback";
    try{await navigator.clipboard.writeText(value);setCopied(true);window.setTimeout(()=>setCopied(false),1600)}
    catch{setError("Скопируйте адрес вручную: "+value)}
  }

  useEffect(()=>{
    // A full-page OAuth return stores its result in localStorage. It is read in an
    // effect because a state initializer runs twice under StrictMode and would drop it.
    const pending=localStorage.getItem(noticeFlag);
    if(pending){localStorage.removeItem(noticeFlag);setNotice(pending);}
    void loadStatus();
    return stopWatching;
  },[loadStatus,stopWatching]);

  useEffect(()=>{
    if(!reposOpen||status!=="connected")return;
    void loadRepositories();
  },[reposOpen,status,loadRepositories]);

  // The authorization window reports the result before it closes, so denied or
  // expired attempts are explained instead of leaving the card unchanged.
  useEffect(()=>{
    function onMessage(event:MessageEvent){
      if(event.origin!==window.location.origin)return;
      const data=event.data as {type?:string;status?:string}|null;
      if(!data||data.type!=="webnestdev.github")return;
      stopWatching();
      setNotice(data.status??"connected");
      void loadStatus(true);
    }
    window.addEventListener("message",onMessage);
    return ()=>window.removeEventListener("message",onMessage);
  },[loadStatus,stopWatching]);

  /**
   * GitHub authorization opens in its own window. The connector watches its own
   * status endpoint until the account appears and then closes that window, so the
   * app itself never navigates away. A blocked popup falls back to a redirect.
   */
  function connect(){
    setError(null);setNotice(null);
    if(status==="unavailable"){setNotice("not_configured");setTokenOpen(true);return;}
    const url="/api/github/connect?origin="+encodeURIComponent(window.location.origin);
    const popup=window.open(url,connectorWindowName,"width=620,height=760,left=140,top=90");
    if(!popup||popup.closed){
      localStorage.setItem(returnFlag,surface);
      window.location.href=url;
      return;
    }
    stopWatching();
    setBusy(true);
    watchRef.current=window.setInterval(()=>{
      if(popup.closed){stopWatching();void loadStatus(true);return;}
      void loadStatus(true).then(next=>{
        if(next!=="connected")return;
        stopWatching();
        setNotice("connected");
        try{popup.close()}catch{}
      });
    },1500);
  }

  async function disconnect(){
    stopWatching();
    setBusy(true);setError(null);
    try{
      const response=await fetch("/api/github/disconnect",{method:"POST"});
      if(!response.ok){
        const data=await response.json().catch(()=>({})) as {error?:string};
        throw new Error(data.error??"GitHub не подтвердил отключение");
      }
      setLogin(null);setRepositories([]);setSelected(null);setReposOpen(false);setNotice(null);
      // Re-read the status so a server without OAuth credentials reports that
      // instead of offering a connect button that cannot work.
      await loadStatus(true);
    }catch(e){setError(e instanceof Error?e.message:"Не удалось отключить GitHub")}
    finally{setBusy(false)}
  }

  /**
   * Сохранение личного токена. Сервер сам проверяет его у GitHub, поэтому ошибка здесь — это уже
   * понятная причина (не принят, истёк, лишние символы), а не «пустой список репозиториев».
   */
  async function saveToken(){
    const value=token.trim();
    if(!value)return;
    setSavingToken(true);setError(null);setNotice(null);
    try{
      const response=await fetch("/api/github/token",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:value})});
      const data=await response.json() as GitHubStatus;
      if(!response.ok)throw new Error(data.error??"GitHub не принял токен");
      setToken("");setTokenOpen(false);setNotice("connected");
      await loadStatus(true);
    }catch(e){setError(e instanceof Error?e.message:"Не удалось сохранить токен")}
    finally{setSavingToken(false)}
  }

  async function importRepository(){
    if(!selected)return;
    if(intent==="custom"&&!customIntent.trim()){setError("Опишите, что сделать с проектом");return}
    setImporting(true);setError(null);
    try{
      const response=await fetch("/api/github/import",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({owner:selected.owner.login,repo:selected.name})});
      const data=await response.json() as { error?:string; project?:{id:string}; conversation?:{id:string} };
      if(!response.ok||!data.project||!data.conversation)throw new Error(data.error??"Не удалось импортировать репозиторий");
      // Импорт открывает рабочую область с уже поставленной задачей планировщику: человек сразу
      // видит уточняющие вопросы и план, а не пустой чат.
      queueAgentStart(data.conversation.id,{prompt:repoKickoff(selected,intent,customIntent),title:"Импорт: "+selected.full_name});
      setIntentOpen(false);
      onImported(data.project.id,data.conversation.id);
    }catch(e){setError(e instanceof Error?e.message:"Ошибка импорта")}
    finally{setImporting(false)}
  }

  const appOrigin=window.location.origin;

  return <>
    <ConnectorCard
    name="GitHub"
    icon={<BrandMark brand="github" variant="light" size={18}/>}
    status={status}
    account={login}
    busy={busy}
    busyLabel="Ждём GitHub…"
    onConnect={connect}
    onDisconnect={()=>void disconnect()}
    onRefresh={()=>void loadStatus()}
    note={<>
      {notice&&<div className={"connector-notice"+(notice==="connected"?" ok":"")}>{notices[notice]??notices.error}</div>}
      {error&&<div className="connector-notice">{error}</div>}
      {/* The setup steps are only useful while the server has no OAuth credentials, so
          they stay behind a button: личный токен работает без них и подключён быстрее. */}
      {status==="unavailable"&&oauthHintOpen&&<div className="connector-hint">
        <strong>Своё OAuth-приложение GitHub — 5 минут</strong>
        <p>1. Откройте GitHub → Settings → Developer settings → OAuth Apps → «New OAuth App». Если в меню настроек нет Developer settings, откройте форму по прямой ссылке: <code>github.com/settings/applications/new</code>.</p>
        <p>2. <em>Application name</em> — любое понятное имя, например <code>WebNestDev</code>. <em>Homepage URL</em> — адрес приложения: <code>{appOrigin}</code>.</p>
        <p>3. В <em>Redirect URIs</em> добавьте текущий адрес приложения с <code>/api/github/callback</code> — вот он:</p>
        <div className="connector-copy"><code>{callbackUrl??appOrigin+"/api/github/callback"}</code><button className="ghost-button connector-toggle" onClick={()=>void copyCallback()}>{copied?"Скопировано":"Скопировать"}</button></div>
        <p>Адресов можно добавить до 10, поэтому тем же способом годится и <code>http://localhost:5173/api/github/callback</code> для локального запуска. Если в окружении задан <code>GITHUB_CALLBACK_URL</code>, нужен именно он. Галочки <em>Allow wildcard matching</em>, <em>Enable Device Flow</em> и <em>Expire user access tokens</em> оставьте выключенными.</p>
        <p>4. Нажмите «Register application»: на странице приложения виден <em>Client ID</em>, а кнопка «Generate a new client secret» выдаёт <em>Client secret</em>. Секрет показывается один раз — скопируйте сразу.</p>
        <p>5. Вставьте значения в переменные окружения сервера <code>GITHUB_CLIENT_ID</code> и <code>GITHUB_CLIENT_SECRET</code> и перезапустите сервер. В Freebuff это раздел Settings → Environment.</p>
        <p className="connector-warning">Секрет — это пароль приложения: не вставляйте его в чат и не коммитьте в репозиторий. Если он потерян, сгенерируйте новый.</p>
      </div>}
    </>}
  >
    {status!=="connected"&&<div className="connector-body">
      <p className="connector-text">Два способа подключения: окно авторизации GitHub (нужны <code>GITHUB_CLIENT_ID</code> и <code>GITHUB_CLIENT_SECRET</code> на сервере) или личный токен — он работает сразу и без настройки сервера.</p>
      <div className="connector-actions-row">
        <button className="ghost-button connector-toggle" onClick={()=>setTokenOpen(open=>!open)}>{tokenOpen?"Скрыть поле токена":"Ввести токен"}</button>
        <a className="connector-link" href="https://github.com/settings/tokens/new?scopes=repo,read:user&description=WebNestDev" target="_blank" rel="noreferrer">Создать токен на GitHub</a>
        {status==="unavailable"&&<button className="ghost-button" onClick={()=>setOauthHintOpen(open=>!open)}>{oauthHintOpen?"Скрыть инструкцию OAuth":"Настроить OAuth-приложение"}</button>}
      </div>

      {tokenOpen&&<div className="connector-key">
        <label>
          <span><KeyRound size={12}/> Личный токен GitHub</span>
          <input type="password" autoComplete="new-password" value={token} onChange={event=>setToken(event.target.value)} placeholder="ghp_… или github_pat_…"/>
        </label>
        <div className="connector-actions-row">
          <button className="connector-action connector-connect" onClick={()=>void saveToken()} disabled={!token.trim()||savingToken}>{savingToken?"Проверяем токен…":"Сохранить токен"}</button>
          <span className="connector-meta-line">Права: <code>repo</code> (репозитории) и <code>read:user</code> (профиль). Токен шифруется на сервере и больше не показывается.</span>
        </div>
      </div>}
    </div>}

    {status==="connected"&&<div className="connector-body">
      <button className="ghost-button connector-toggle" onClick={()=>setReposOpen(open=>!open)}>{reposOpen?"Скрыть репозитории":"Импортировать репозиторий"}</button>
      {reposOpen&&<>
        <div className="github-repositories">
          {repositories.length
            ? repositories.map(repository=><button key={repository.id} className={"github-repository"+(selected?.id===repository.id?" selected":"")} onClick={()=>setSelected(repository)}>
                <span><strong>{repository.full_name}</strong><small>{repository.private?"Приватный":"Публичный"} · {repository.default_branch}</small></span>
              </button>)
            : <span className="github-login">{loadingRepos?"Загружаем репозитории…":"Репозитории не найдены"}</span>}
        </div>
        <div className="connector-repo-actions">
          <button className="ghost-button" onClick={()=>void loadRepositories()} disabled={loadingRepos}>Обновить</button>
          <button className="connector-action connector-connect" onClick={()=>{setIntent("analysis");setCustomIntent("");setIntentOpen(true)}} disabled={!selected||importing}><UploadCloud size={13}/> {importing?"Импортируем…":"Импортировать"}</button>
        </div>
      </>}
    </div>}
  </ConnectorCard>

    {intentOpen&&selected&&<div className="modal-backdrop" role="presentation" onMouseDown={()=>{if(!importing)setIntentOpen(false)}}>
      <section className="modal repo-intent-modal" role="dialog" aria-modal="true" aria-label="Что сделать с импортированным репозиторием" onMouseDown={event=>event.stopPropagation()}>
        <header className="modal-head">
          <div><span className="eyebrow">ИМПОРТ РЕПОЗИТОРИЯ</span><h2>Что сделать с проектом?</h2></div>
          <button className="icon-button" onClick={()=>setIntentOpen(false)} disabled={importing} aria-label="Закрыть"><X size={16}/></button>
        </header>
        <div className="modal-body">
          <p className="modal-lead">{selected.full_name}. Агент начнёт в режиме планировщика: изучит проект, задаст уточняющие вопросы и покажет план. Разработка стартует только после вашего подтверждения. На бесплатном тарифе импорт ограничен 100 МБ.</p>
          <div className="repo-intent-grid">
            {repoIntents.map(item=>{const Icon=item.icon;return <button key={item.id} type="button" className={"repo-intent-option"+(intent===item.id?" selected":"")} onClick={()=>setIntent(item.id)} disabled={importing}>
              <span className="repo-intent-icon"><Icon size={16}/></span>
              <span><strong>{item.label}</strong><small>{item.description}</small></span>
            </button>})}
            <button type="button" className={"repo-intent-option"+(intent==="custom"?" selected":"")} onClick={()=>setIntent("custom")} disabled={importing}>
              <span className="repo-intent-icon"><UploadCloud size={16}/></span>
              <span><strong>Свой ответ</strong><small>Опишите задачу своими словами</small></span>
            </button>
          </div>
          {intent==="custom"&&<label className="repo-intent-custom">
            <span>Что сделать с проектом</span>
            <textarea value={customIntent} onChange={event=>setCustomIntent(event.target.value)} rows={3} placeholder="Например: переделать главную страницу под новую айдентику и добавить тёмную тему" disabled={importing}/>
          </label>}
          {error&&<div className="connector-notice">{error}</div>}
        </div>
        <footer className="modal-foot">
          <button className="ghost-button" onClick={()=>setIntentOpen(false)} disabled={importing}>Отмена</button>
          <button className="send-button" onClick={()=>void importRepository()} disabled={importing||(intent==="custom"&&!customIntent.trim())}><UploadCloud size={13}/> {importing?"Импортируем…":"Импортировать и спланировать"}</button>
        </footer>
      </section>
    </div>}
  </>;
}
