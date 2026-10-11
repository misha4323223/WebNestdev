import { useCallback,useEffect,useRef,useState } from "react";
import { UploadCloud } from "lucide-react";
import { GitHubMark } from "../../components/GitHubMark";
import { openImportedProject } from "../../lib/project-api";
import { ConnectorCard,type ConnectorStatus } from "../integrations/ConnectorCard";

type Repository = { id:number; name:string; full_name:string; private:boolean; default_branch:string; owner:{login:string} };
type GitHubStatus = { connected?:boolean; githubLogin?:string|null; configured?:boolean; callbackUrl?:string; error?:string };

/** The surface that started the flow, so a full-page return reopens the same place. */
export type ConnectorSurface = "home" | "workspace";

const notices: Record<string,string> = {
  connected: "GitHub подключён. Репозитории можно импортировать.",
  denied: "Доступ не подтверждён — подключение можно начать заново.",
  not_configured: "GitHub OAuth не настроен на сервере: задайте GITHUB_CLIENT_ID и GITHUB_CLIENT_SECRET.",
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
  const [notice,setNotice]=useState<string|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [callbackUrl,setCallbackUrl]=useState<string|null>(null);
  const [copied,setCopied]=useState(false);
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
    if(status==="unavailable"){setNotice("not_configured");return;}
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
      await fetch("/api/github/disconnect",{method:"POST"});
      setLogin(null);setRepositories([]);setSelected(null);setReposOpen(false);setNotice(null);
      // Re-read the status so a server without OAuth credentials reports that
      // instead of offering a connect button that cannot work.
      await loadStatus(true);
    }catch(e){setError(e instanceof Error?e.message:"Не удалось отключить GitHub")}
    finally{setBusy(false)}
  }

  async function importRepository(){
    if(!selected)return;
    setImporting(true);setError(null);
    try{
      const response=await fetch("/api/github/import",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({owner:selected.owner.login,repo:selected.name})});
      const data=await response.json() as { error?:string; project?:{id:string}; conversation?:{id:string} };
      if(!response.ok||!data.project||!data.conversation)throw new Error(data.error??"Не удалось импортировать репозиторий");
      onImported(data.project.id,data.conversation.id);
    }catch(e){setError(e instanceof Error?e.message:"Ошибка импорта")}
    finally{setImporting(false)}
  }

  const appOrigin=window.location.origin;

  return <ConnectorCard
    name="GitHub"
    icon={<GitHubMark size={18}/>}
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
          they appear in that one state. A configured server keeps the card to the
          service name, its status and the buttons. */}
      {status==="unavailable"&&<div className="connector-hint">
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
          <button className="connector-action connector-connect" onClick={()=>void importRepository()} disabled={!selected||importing}><UploadCloud size={13}/> {importing?"Импортируем…":"Импортировать"}</button>
        </div>
      </>}
    </div>}
  </ConnectorCard>;
}
