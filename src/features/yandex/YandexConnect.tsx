import { useCallback,useEffect,useRef,useState } from "react";
import { Cloud, KeyRound, ShieldCheck, TriangleAlert } from "lucide-react";
import { ConnectorCard, type ConnectorStatus } from "../integrations/ConnectorCard";
import type { ConnectorSurface } from "../github/GitHubConnect";

type YandexStatus = {
  connected?:boolean;
  kind?:string|null;
  account?:string|null;
  folderId?:string|null;
  cloudId?:string|null;
  allowWrites?:boolean;
  configured?:boolean;
  callbackUrl?:string;
  error?:string;
};

const notices: Record<string,string> = {
  connected: "Yandex Cloud подключён. Агент может читать ресурсы этого аккаунта.",
  denied: "Доступ в Yandex не подтверждён — подключение можно начать заново.",
  not_configured: "OAuth Яндекс ID не настроен на сервере (YANDEX_CLIENT_ID и YANDEX_CLIENT_SECRET). Подключите аккаунт ключом — форма ниже работает всегда.",
  state_expired: "Ссылка авторизации устарела. Начните подключение заново.",
  token_error: "Яндекс не выдал токен доступа. Попробуйте подключиться ещё раз.",
  cloud_error: "Токен Яндекс ID получен, но Yandex Cloud его не принял. Создайте сервисный аккаунт с ролями и вставьте его authorized key ниже.",
  error: "Не удалось завершить подключение Yandex Cloud.",
};

/** Kind of credential the user pasted, shown next to the linked account. */
const kindLabels: Record<string,string> = {
  key: "сервисный аккаунт · authorized key",
  iam: "IAM-токен",
  oauth: "OAuth-токен Яндекс ID",
};

const returnFlag = "webnestdev.yandexReturn";
const noticeFlag = "webnestdev.yandexNotice";
/** Same pattern as the GitHub card: the authorization window reports by closing. */
const connectorWindowName = "webnestdev-yandex";

export function YandexConnect({surface="home"}:{surface?:ConnectorSurface}){
  const [status,setStatus]=useState<ConnectorStatus>("loading");
  const [info,setInfo]=useState<YandexStatus|null>(null);
  const [busy,setBusy]=useState(false);
  // Поле для ключа видно сразу в настройках рабочей области: подключение ключом — основной способ,
  // и его не должно быть нужно искать за кнопкой. На домашней панели карточка остаётся короткой.
  const [keyOpen,setKeyOpen]=useState(surface==="workspace");
  const [hintOpen,setHintOpen]=useState(false);
  const [secret,setSecret]=useState("");
  const [saving,setSaving]=useState(false);
  const [notice,setNotice]=useState<string|null>(null);
  const [error,setError]=useState<string|null>(null);
  // Адрес возврата показывается рядом с кнопкой: Яндекс сверяет redirect_uri с полем
  // Callback URL посимвольно, и при расхождении отвечает «redirect_uri does not match».
  const [copied,setCopied]=useState(false);
  const watchRef=useRef<number|null>(null);

  const stopWatching=useCallback(()=>{
    if(watchRef.current!==null){window.clearInterval(watchRef.current);watchRef.current=null;}
    setBusy(false);
  },[]);

  const loadStatus=useCallback(async(quiet=false):Promise<ConnectorStatus>=>{
    try{
      const data=await fetch("/api/yandex/status?origin="+encodeURIComponent(window.location.origin)).then(response=>response.json()) as YandexStatus;
      if(data.error)throw new Error(data.error);
      const next:ConnectorStatus=data.connected?"connected":data.configured===false?"disconnected":"disconnected";
      setStatus(next);
      setInfo(data);
      return next;
    }catch(e){
      if(!quiet)setError(e instanceof Error?e.message:"Не удалось получить состояние Yandex Cloud");
      return "disconnected";
    }
  },[]);

  useEffect(()=>{
    // The full-page OAuth return stores its result in localStorage; it is read in an
    // effect because a state initializer runs twice under StrictMode.
    const pending=localStorage.getItem(noticeFlag);
    if(pending){localStorage.removeItem(noticeFlag);setNotice(pending);}
    void loadStatus();
    return stopWatching;
  },[loadStatus,stopWatching]);

  useEffect(()=>{
    function onMessage(event:MessageEvent){
      if(event.origin!==window.location.origin)return;
      const data=event.data as {type?:string;status?:string}|null;
      if(!data||data.type!=="webnestdev.yandex")return;
      stopWatching();
      setNotice(data.status??"connected");
      void loadStatus(true);
    }
    window.addEventListener("message",onMessage);
    return ()=>window.removeEventListener("message",onMessage);
  },[loadStatus,stopWatching]);

  async function copyRedirect(value:string){
    try{
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(()=>setCopied(false),1600);
    }catch{setCopied(false)}
  }

  function connect(){
    setError(null);setNotice(null);
    if(info?.configured===false){
      setNotice("not_configured");
      setKeyOpen(true);
      return;
    }
    const url="/api/yandex/connect?origin="+encodeURIComponent(window.location.origin);
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
      await fetch("/api/yandex/disconnect",{method:"POST"});
      setSecret("");setNotice(null);setKeyOpen(false);
      await loadStatus(true);
    }catch(e){setError(e instanceof Error?e.message:"Не удалось отключить Yandex Cloud")}
    finally{setBusy(false)}
  }

  async function saveSecret(){
    const value=secret.trim();
    if(!value)return;
    setSaving(true);setError(null);setNotice(null);
    try{
      const response=await fetch("/api/yandex/secret",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({secret:value,allowWrites:info?.allowWrites??false})});
      const data=await response.json() as YandexStatus;
      if(!response.ok)throw new Error(data.error??"Yandex Cloud отклонил ключ");
      setSecret("");setKeyOpen(false);
      setNotice("connected");
      await loadStatus(true);
    }catch(e){setError(e instanceof Error?e.message:"Не удалось сохранить ключ")}
    finally{setSaving(false)}
  }

  async function setWrites(allowWrites:boolean){
    setBusy(true);setError(null);
    try{
      const response=await fetch("/api/yandex/writes",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({allowWrites})});
      const data=await response.json() as YandexStatus;
      if(!response.ok)throw new Error(data.error??"Не удалось изменить разрешение");
      setInfo(current=>current?{...current,allowWrites}:current);
    }catch(e){setError(e instanceof Error?e.message:"Не удалось изменить разрешение")}
    finally{setBusy(false)}
  }

  const connected=status==="connected";
  const account=info?.account??null;

  return <ConnectorCard
    name="Yandex Cloud"
    icon={<Cloud size={18}/>}
    status={status}
    account={account}
    busy={busy}
    busyLabel="Ждём Яндекс…"
    onConnect={connect}
    onDisconnect={()=>void disconnect()}
    onRefresh={()=>void loadStatus()}
    note={<>
      {notice&&<div className={"connector-notice"+(notice==="connected"?" ok":"")}>{notices[notice]??notices.error}</div>}
      {error&&<div className="connector-notice">{error}</div>}
      {connected&&info?.kind&&<span className="connector-meta-line">{kindLabels[info.kind]??info.kind}{info.folderId?" · каталог "+info.folderId:""}</span>}
    </>}
  >
    <div className="connector-body">
      <p className="connector-text">
        {connected
          ? "Агент читает облака, каталоги, виртуальные машины, диски, бакеты и функции этого аккаунта."
          : "Подключите аккаунт Яндекс ID кнопкой или вставьте сервисный ключ — после этого агент сможет читать ресурсы аккаунта."}
      </p>

      {!connected&&info?.configured&&info.callbackUrl&&<div className="connector-redirect">
        <span>Redirect URI для приложения на oauth.yandex.ru должен быть ровно такой:</span>
        <code>{info.callbackUrl}</code>
        <button className="ghost-button" onClick={()=>void copyRedirect(info.callbackUrl!)}>{copied?"Скопировано":"Скопировать"}</button>
      </div>}

      {connected&&<label className="connector-write">
        <span>
          <strong>Разрешить агенту изменять ресурсы</strong>
          <small>{info?.allowWrites
            ? "Включено: агент создаёт, меняет и удаляет ресурсы по вашей команде."
            : "Выключено: агент только читает. Включите, чтобы он создавал, менял и удалял ресурсы по вашей команде."}</small>
        </span>
        <span className="switch"><input type="checkbox" checked={Boolean(info?.allowWrites)} disabled={busy} onChange={event=>void setWrites(event.target.checked)}/><span className="switch-track"><span className="switch-thumb"/></span></span>
      </label>}

      <div className="connector-actions-row">
        <button className="ghost-button" onClick={()=>setKeyOpen(open=>!open)}>{connected?"Заменить ключ":keyOpen?"Скрыть поле ключа":"Подключить ключом"}</button>
        <button className="ghost-button" onClick={()=>setHintOpen(open=>!open)}>{hintOpen?"Скрыть инструкцию":"Где взять ключи"}</button>
      </div>

      {keyOpen&&<div className="connector-key">
        <label>
          <span><KeyRound size={12}/> Ключ доступа Yandex Cloud</span>
          <textarea rows={4} value={secret} onChange={event=>setSecret(event.target.value)} placeholder='{"id":"...","service_account_id":"...","private_key":"-----BEGIN PRIVATE KEY-----..."} или IAM-токен t1.… или OAuth-токен y0_…'/>
        </label>
        <div className="connector-actions-row">
          <button className="connector-action connector-connect" onClick={()=>void saveSecret()} disabled={!secret.trim()||saving}>{saving?"Проверяем ключ…":"Сохранить ключ"}</button>
          <span className="connector-meta-line">Ключ шифруется на сервере и используется только от вашего имени.</span>
        </div>
      </div>}

      {hintOpen&&<div className="connector-hint">
        <strong><ShieldCheck size={13}/> Как подключить аккаунт</strong>
        <p><em>Кнопкой «Подключить»</em> — откроется страница Яндекс ID. Работает, если на сервере заданы <code>YANDEX_CLIENT_ID</code> и <code>YANDEX_CLIENT_SECRET</code> (приложение создаётся на <code>oauth.yandex.ru/client/new</code>).</p>
        <p><em>Redirect URI</em> — в приложении на oauth.yandex.ru поле Callback URL должно совпадать с адресом выше посимвольно: та же схема (https), тот же домен и путь <code>/api/yandex/callback</code>. При расхождении Яндекс останавливает вход страницей «redirect_uri does not match the Callback URL defined for the client» — ключи при этом верные, править нужно адрес.</p>
        <p><em>Ключом сервисного аккаунта (рекомендуется)</em> — в консоли Yandex Cloud: «Сервисные аккаунты» → создать аккаунт → выдать роли <code>viewer</code> на облако и нужные роли на каталог → «Создать новый ключ» → «Создать авторизованный ключ» → скачается JSON. Вставьте этот JSON целиком.</p>
        <p><em>IAM-токеном</em> — команда <code>yc iam create-token</code> или кнопка «Получить IAM-токен» в консоли. Токен живёт 12 часов.</p>
        <p className="connector-warning"><TriangleAlert size={12}/> Изменения ресурсов выполняются только при включённом переключателе выше: агент спрашивает разрешение, а сервер отклоняет запросы на запись без него.</p>
      </div>}
    </div>
  </ConnectorCard>;
}
