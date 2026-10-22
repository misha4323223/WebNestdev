import { useCallback,useEffect,useState } from "react";
import { KeyRound } from "lucide-react";
import { BrandMark } from "../../components/BrandLogo";
import { ConnectorCard,type ConnectorStatus } from "../integrations/ConnectorCard";

type YandexStatus = {
  connected?:boolean;
  kind?:string|null;
  account?:string|null;
  folderId?:string|null;
  cloudId?:string|null;
  allowWrites?:boolean;
  error?:string;
};

/**
 * Куда ведёт кнопка подключения. Яндекс больше не принимает OAuth-токены Яндекс ID для Cloud
 * (с 1 июня 2026), поэтому «войти и разрешить», как в GitHub, для Cloud невозможно: доступ даёт
 * только ключ сервисного аккаунта. Значит кнопка делает полезное — открывает консоль, где этот
 * ключ создаётся, и сразу показывает форму для него.
 */
const CONSOLE_URL="https://console.yandex.cloud/";
const CONSOLE_HINT="https://yandex.cloud/ru/docs/iam/operations/iam-token/create-for-sa";

const notices: Record<string,string> = {
  connected: "Yandex Cloud подключён. Агент может читать ресурсы этого аккаунта.",
};

/** Kind of credential the user pasted, shown next to the linked account. */
const kindLabels: Record<string,string> = {
  key: "сервисный аккаунт",
  iam: "IAM-токен",
  oauth: "OAuth-токен Яндекс ID",
};

const noticeFlag = "webnestdev.yandexNotice";

/**
 * The Yandex Cloud card stays folded until it is needed: one button in the header, everything
 * else behind it. Pressing it opens the console in a new tab and unfolds the key field — the only
 * path that still grants Cloud access. Пошаговых подсказок в карточке нет: путь к ключу
 * объясняет сама консоль по кнопке «Открыть консоль».
 */
export function YandexConnect(){
  const [status,setStatus]=useState<ConnectorStatus>("loading");
  const [info,setInfo]=useState<YandexStatus|null>(null);
  const [busy,setBusy]=useState(false);
  const [open,setOpen]=useState(false);
  const [secret,setSecret]=useState("");
  const [saving,setSaving]=useState(false);
  const [notice,setNotice]=useState<string|null>(null);
  const [error,setError]=useState<string|null>(null);

  const loadStatus=useCallback(async(quiet=false):Promise<ConnectorStatus>=>{
    try{
      const data=await fetch("/api/yandex/status").then(response=>response.json()) as YandexStatus;
      if(data.error)throw new Error(data.error);
      const next:ConnectorStatus=data.connected?"connected":"disconnected";
      setStatus(next);
      setInfo(data);
      return next;
    }catch(e){
      if(!quiet)setError(e instanceof Error?e.message:"Не удалось получить состояние Yandex Cloud");
      return "disconnected";
    }
  },[]);

  useEffect(()=>{
    // A full-page return from the server stores its result in localStorage; it is read in an
    // effect because a state initializer runs twice under StrictMode.
    const pending=localStorage.getItem(noticeFlag);
    if(pending){localStorage.removeItem(noticeFlag);setNotice(notices[pending]?pending:"connected");}
    void loadStatus();
  },[loadStatus]);

  function openConsole(){
    window.open(CONSOLE_URL,"_blank","noopener,noreferrer");
  }

  function connect(){
    setError(null);setNotice(null);
    openConsole();
    setOpen(true);
  }

  async function disconnect(){
    setBusy(true);setError(null);
    try{
      const response=await fetch("/api/yandex/disconnect",{method:"POST"});
      if(!response.ok){
        const data=await response.json().catch(()=>({})) as YandexStatus;
        throw new Error(data.error??"Yandex Cloud не подтвердил отключение");
      }
      setSecret("");setNotice(null);setOpen(false);
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
      setSecret("");setOpen(false);
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
    icon={<BrandMark brand="yandex-cloud" size={18}/>}
    status={status}
    account={account}
    busy={busy}
    busyLabel="Сохраняем…"
    onConnect={connect}
    onDisconnect={()=>void disconnect()}
    onRefresh={()=>void loadStatus()}
    note={<>
      {notice&&<div className="connector-notice ok">{notices[notice]??notices.connected}</div>}
      {error&&<div className="connector-notice">{error}</div>}
      {connected&&info?.kind&&<span className="connector-meta-line">{kindLabels[info.kind]??info.kind}{info.folderId?" · каталог "+info.folderId:""}</span>}
    </>}
  >
    <div className="connector-body">
      {connected&&<label className="connector-write">
        <strong>Разрешить агенту изменять ресурсы</strong>
        <span className="switch"><input type="checkbox" checked={Boolean(info?.allowWrites)} disabled={busy} onChange={event=>void setWrites(event.target.checked)}/><span className="switch-track"><span className="switch-thumb"/></span></span>
      </label>}

      {connected&&<div className="connector-actions-row">
        <button className="ghost-button" onClick={()=>setOpen(value=>!value)}>{open?"Скрыть поле ключа":"Заменить ключ"}</button>
        <button className="ghost-button" onClick={openConsole}>Открыть консоль</button>
      </div>}

      {open&&<div className="connector-key">
        <label>
          <span><KeyRound size={12}/> Ключ сервисного аккаунта</span>
          <textarea rows={4} value={secret} onChange={event=>setSecret(event.target.value)} placeholder='{"id":"…","service_account_id":"…","private_key":"-----BEGIN PRIVATE KEY-----…"}'/>
        </label>

        <div className="connector-actions-row">
          <button className="connector-action connector-connect" onClick={()=>void saveSecret()} disabled={!secret.trim()||saving}>{saving?"Проверяем ключ…":"Сохранить ключ"}</button>
          {!connected&&<button className="ghost-button" onClick={openConsole}>Открыть консоль</button>}
        </div>

        <p className="connector-fineprint">Ключ шифруется на сервере и используется только от вашего имени. <a href={CONSOLE_HINT} target="_blank" rel="noreferrer">Инструкция Яндекса</a></p>
      </div>}
    </div>
  </ConnectorCard>;
}
