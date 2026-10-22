import { useCallback,useEffect,useRef,useState } from "react";
import { Bug, KeyRound, Play, Search, UploadCloud, X } from "lucide-react";
import { openImportedProject } from "../../lib/project-api";
import { queueAgentStart } from "../../lib/agent-start";
import { ConnectorCard,type ConnectorStatus } from "../integrations/ConnectorCard";
import type { ConnectorSurface } from "../github/GitHubConnect";

type Repository = {
  id:number;
  name:string;
  path:string;
  path_with_namespace:string;
  web_url:string;
  default_branch:string;
  visibility?:string;
  namespace?:{full_path?:string};
};
type GitLabStatus = {
  connected?:boolean;
  gitlabLogin?:string|null;
  configured?:boolean;
  callbackUrl?:string;
  baseUrl?:string;
  error?:string;
  code?:string;
};

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
  return `Импортирован репозиторий GitLab: ${repository.path_with_namespace} (ветка ${repository.default_branch}).\n\n${task}\n\nСначала работай в режиме планировщика и не меняй файлы. Изучи проект, задай через question.ask не больше двух уточняющих вопросов, если без них нельзя выбрать правильный путь. Затем собери полный пошаговый план через plan.update и перечисли, что пользователю нужно подтвердить перед началом работы.`;
}

const notices:Record<string,string>={
  connected:"GitLab подключён. Репозитории можно импортировать.",
  denied:"Доступ не подтверждён — подключение можно начать заново.",
  not_configured:"GitLab OAuth не настроен на сервере (GITLAB_CLIENT_ID и GITLAB_CLIENT_SECRET). Подключите аккаунт личным токеном — поле ниже работает всегда.",
  state_expired:"Ссылка авторизации устарела. Начните подключение заново.",
  token_error:"GitLab не выдал токен доступа. Попробуйте подключиться снова.",
  profile_error:"Не удалось получить профиль GitLab.",
  error:"Не удалось завершить подключение GitLab.",
};

const returnFlag="webnestdev.gitlabReturn";
const noticeFlag="webnestdev.gitlabNotice";
const connectorWindowName="webnestdev-gitlab";

export function GitLabConnect({surface="home",onImported=openImportedProject}:{surface?:ConnectorSurface;onImported?:(projectId:string,conversationId:string)=>void}){
  const [status,setStatus]=useState<ConnectorStatus>("loading");
  const [login,setLogin]=useState<string|null>(null);
  const [baseUrl,setBaseUrl]=useState("https://gitlab.com");
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
  const [token,setToken]=useState("");
  const [tokenBaseUrl,setTokenBaseUrl]=useState("");
  const [savingToken,setSavingToken]=useState(false);
  const [oauthHintOpen,setOauthHintOpen]=useState(false);
  const watchRef=useRef<number|null>(null);

  const stopWatching=useCallback(()=>{
    if(watchRef.current!==null){window.clearInterval(watchRef.current);watchRef.current=null;}
    setBusy(false);
  },[]);

  const loadStatus=useCallback(async(quiet=false):Promise<ConnectorStatus>=>{
    try{
      const data=await fetch("/api/gitlab/status?origin="+encodeURIComponent(window.location.origin)).then(response=>response.json()) as GitLabStatus;
      if(data.error)throw new Error(data.error);
      const next:ConnectorStatus=data.connected?"connected":data.configured===false?"unavailable":"disconnected";
      setStatus(next);
      setLogin(data.gitlabLogin??null);
      setCallbackUrl(data.callbackUrl??null);
      if(data.baseUrl)setBaseUrl(data.baseUrl.replace(/\/+$/,""));
      return next;
    }catch(e){
      if(!quiet)setError(e instanceof Error?e.message:"Не удалось получить состояние GitLab");
      return "disconnected";
    }
  },[]);

  const loadRepositories=useCallback(async()=>{
    setLoadingRepos(true);setError(null);
    try{
      const data=await fetch("/api/gitlab/repositories").then(response=>response.json()) as { repositories?:Repository[]; error?:string };
      if(data.error)throw new Error(data.error);
      setRepositories(data.repositories??[]);
    }catch(e){setError(e instanceof Error?e.message:"Не удалось загрузить репозитории")}
    finally{setLoadingRepos(false)}
  },[]);

  async function copyCallback(){
    const value=callbackUrl??window.location.origin+"/api/gitlab/callback";
    try{await navigator.clipboard.writeText(value);setCopied(true);window.setTimeout(()=>setCopied(false),1600)}
    catch{setError("Скопируйте адрес вручную: "+value)}
  }

  useEffect(()=>{
    const pending=localStorage.getItem(noticeFlag);
    if(pending){localStorage.removeItem(noticeFlag);setNotice(pending);}
    void loadStatus();
    return stopWatching;
  },[loadStatus,stopWatching]);

  useEffect(()=>{
    if(!reposOpen||status!=="connected")return;
    void loadRepositories();
  },[reposOpen,status,loadRepositories]);

  useEffect(()=>{
    function onMessage(event:MessageEvent){
      if(event.origin!==window.location.origin)return;
      const data=event.data as {type?:string;status?:string}|null;
      if(!data||data.type!=="webnestdev.gitlab")return;
      stopWatching();
      setNotice(data.status??"connected");
      void loadStatus(true);
    }
    window.addEventListener("message",onMessage);
    return ()=>window.removeEventListener("message",onMessage);
  },[loadStatus,stopWatching]);

  function connect(){
    setError(null);setNotice(null);
    if(status==="unavailable"){setNotice("not_configured");return;}
    const url="/api/gitlab/connect?origin="+encodeURIComponent(window.location.origin);
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
      const response=await fetch("/api/gitlab/disconnect",{method:"POST"});
      if(!response.ok){
        const data=await response.json().catch(()=>({})) as {error?:string};
        throw new Error(data.error??"GitLab не подтвердил отключение");
      }
      setLogin(null);setRepositories([]);setSelected(null);setReposOpen(false);setNotice(null);
      await loadStatus(true);
    }catch(e){setError(e instanceof Error?e.message:"Не удалось отключить GitLab")}
    finally{setBusy(false)}
  }

  async function saveToken(){
    const value=token.trim();
    if(!value)return;
    setSavingToken(true);setError(null);setNotice(null);
    try{
      const response=await fetch("/api/gitlab/token",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({token:value,...(tokenBaseUrl.trim()?{baseUrl:tokenBaseUrl.trim()}:{})}),
      });
      const data=await response.json() as GitLabStatus;
      if(!response.ok)throw new Error(data.error??"GitLab не принял токен");
      setToken("");setNotice("connected");
      await loadStatus(true);
    }catch(e){setError(e instanceof Error?e.message:"Не удалось сохранить токен")}
    finally{setSavingToken(false)}
  }

  async function importRepository(){
    if(!selected)return;
    if(intent==="custom"&&!customIntent.trim()){setError("Опишите, что сделать с проектом");return}
    setImporting(true);setError(null);
    try{
      const response=await fetch("/api/gitlab/import",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:selected.id})});
      const data=await response.json() as { error?:string; project?:{id:string}; conversation?:{id:string} };
      if(!response.ok||!data.project||!data.conversation)throw new Error(data.error??"Не удалось импортировать репозиторий");
      queueAgentStart(data.conversation.id,{prompt:repoKickoff(selected,intent,customIntent),title:"Импорт: "+selected.path_with_namespace});
      setIntentOpen(false);
      onImported(data.project.id,data.conversation.id);
    }catch(e){setError(e instanceof Error?e.message:"Ошибка импорта")}
    finally{setImporting(false)}
  }

  const appOrigin=window.location.origin;
  // Прямые ссылки важны на телефоне: в мобильном GitLab боковое меню профиля свёрнуто,
  // и найти «Applications» или «Personal access tokens» через навигацию почти невозможно.
  const applicationsLink=baseUrl+"/-/user_settings/applications";

  return <>
    <ConnectorCard
    name="GitLab"
    logo="gitlab"
    status={status}
    account={login}
    busy={busy}
    busyLabel="Ждём GitLab…"
    onConnect={connect}
    onDisconnect={()=>void disconnect()}
    onRefresh={()=>void loadStatus()}
    note={<>
      {notice&&<div className={"connector-notice"+(notice==="connected"?" ok":"")}>{notices[notice]??notices.error}</div>}
      {error&&<div className="connector-notice">{error}</div>}
      {status==="unavailable"&&oauthHintOpen&&<div className="connector-hint">
        <strong>Своё OAuth-приложение GitLab — 5 минут</strong>
        <p>1. Откройте GitLab → аватар → <em>Edit profile</em> → <em>Access → Applications</em> и нажмите «Add new application». Прямая ссылка для телефона: <a className="connector-link" href={applicationsLink} target="_blank" rel="noreferrer" style={{overflowWrap:"anywhere"}}>{applicationsLink}</a></p>
        <p>2. <em>Name</em> — любое понятное имя, например <code>WebNestDev</code>. <em>Redirect URI</em> — текущий адрес приложения с <code>/api/gitlab/callback</code>:</p>
        <div className="connector-copy"><code>{callbackUrl??appOrigin+"/api/gitlab/callback"}</code><button className="ghost-button connector-toggle" onClick={()=>void copyCallback()}>{copied?"Скопировано":"Скопировать"}</button></div>
        <p>3. Снимите галочку <em>Confidential</em> только если GitLab не принимает callback; для серверного приложения она должна оставаться включённой. Отметьте scopes <code>read_api</code>, <code>read_repository</code> и <code>write_repository</code> — последний нужен для отправки коммитов обратно в GitLab.</p>
        <p>4. После сохранения GitLab покажет <em>Application ID</em> и <em>Secret</em>. Secret виден один раз — скопируйте сразу.</p>
        <p>5. Вставьте значения в <code>GITLAB_CLIENT_ID</code> и <code>GITLAB_CLIENT_SECRET</code>, при своём GitLab ещё <code>GITLAB_BASE_URL</code>. В Freebuff это Settings → Environment или панель «Ключи сервера».</p>
        <p className="connector-warning">Секрет — это пароль приложения: не вставляйте его в чат и не коммитьте в репозиторий.</p>
      </div>}
    </>}
  >
    {status!=="connected"&&<div className="connector-body">
      <div className="connector-key">
        <label>
          <span><KeyRound size={12}/> Личный токен GitLab</span>
          <input type="password" autoComplete="new-password" value={token} onChange={event=>setToken(event.target.value)} placeholder="glpat-…"/>
        </label>
        <label>
          <span>Адрес GitLab</span>
          <input value={tokenBaseUrl} onChange={event=>setTokenBaseUrl(event.target.value)} placeholder={baseUrl}/>
        </label>
        <div className="connector-actions-row">
          <button className="connector-action connector-connect" onClick={()=>void saveToken()} disabled={!token.trim()||savingToken}>{savingToken?"Проверяем токен…":"Сохранить токен"}</button>
          {status==="unavailable"&&<button className="ghost-button" onClick={()=>setOauthHintOpen(open=>!open)}>{oauthHintOpen?"Скрыть инструкцию OAuth":"Настроить OAuth-приложение"}</button>}
        </div>
        <p className="connector-fineprint">Права: <code>read_api</code>, <code>read_repository</code> и <code>write_repository</code> для отправки коммитов. Токен шифруется на сервере и больше не показывается.</p>
      </div>
    </div>}

    {status==="connected"&&<div className="connector-body">
      <button className="ghost-button connector-toggle" onClick={()=>setReposOpen(open=>!open)}>{reposOpen?"Скрыть репозитории":"Импортировать репозиторий"}</button>
      {reposOpen&&<>
        <div className="github-repositories">
          {repositories.length
            ? repositories.map(repository=><button key={repository.id} className={"github-repository"+(selected?.id===repository.id?" selected":"")} onClick={()=>setSelected(repository)}>
                <span><strong>{repository.path_with_namespace}</strong><small>{repository.visibility==="private"?"Приватный":"Публичный"} · {repository.default_branch}</small></span>
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
          <p className="modal-lead">{selected.path_with_namespace}. Агент начнёт в режиме планировщика: изучит проект, задаст уточняющие вопросы и покажет план. Разработка стартует только после вашего подтверждения. На бесплатном тарифе импорт ограничен 100 МБ.</p>
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
