import { useCallback,useEffect,useState } from "react";
import { Database, KeyRound, ShieldCheck, TriangleAlert } from "lucide-react";
import { ConnectorCard,type ConnectorStatus } from "../integrations/ConnectorCard";

type DatabaseStatus = {
  connected?:boolean;
  provider?:string;
  scheme?:string;
  engine?:string;
  host?:string;
  port?:number;
  database?:string;
  username?:string;
  ssl?:boolean;
  maskedUrl?:string;
  updatedAt?:string;
  error?:string;
};

type ProviderId="yandex-postgresql"|"yandex-ydb"|"vk-cloud"|"selectel"|"timeweb"|"cloud-ru"|"custom";

type Provider = {
  id:ProviderId;
  name:string;
  /** Short label for the provider chips, where the full name would repeat. */
  short:string;
  engine:"PostgreSQL"|"MySQL"|"MongoDB"|"YDB";
  scheme:"postgres"|"mysql"|"mongodb"|"grpcs";
  summary:string;
  steps:string[];
  consoleUrl:string;
  consoleLabel:string;
};

/**
 * Russian providers first: the product recommends them, and every one of them shows a
 * normal connection string in its console, which is all this card needs.
 */
const providers:Provider[]=[
  {
    id:"yandex-postgresql",name:"Yandex Cloud · Managed PostgreSQL",short:"Yandex · PostgreSQL",engine:"PostgreSQL",scheme:"postgres",
    summary:"Кластер PostgreSQL, управляемый Яндексом: бэкапы, реплики и обновления — на стороне облака.",
    steps:[
      "Откройте консоль console.yandex.cloud, выберите каталог и раздел «Managed PostgreSQL».",
      "«Создать кластер»: класс хоста, зона, сеть и пароль пользователя (по умолчанию user1). Дождитесь статуса «Работает».",
      "В блоке «Подключение» скопируйте строку вида postgresql://user1:пароль@<хост>:6432/<база> и вставьте её ниже.",
      "Если база должна быть доступна снаружи — включите публичный доступ хосту и добавьте адрес рабочей области в группу безопасности.",
    ],
    consoleUrl:"https://console.yandex.cloud",consoleLabel:"Открыть консоль Yandex Cloud",
  },
  {
    id:"yandex-ydb",name:"Yandex Cloud · Serverless YDB",short:"Yandex · YDB",engine:"YDB",scheme:"grpcs",
    summary:"Бессерверная база Yandex: платите за запросы, отдельный сервер поднимать не нужно.",
    steps:[
      "В консоли console.yandex.cloud откройте «YDB» → «Создать базу данных» и выберите тип Serverless.",
      "После создания нажмите «Подключиться» и скопируйте эндпоинт вида grpcs://ydb.serverless.yandexcloud.net:2135/ru-central1/<идентификатор>.",
      "Вставьте эту строку ниже: агент запишет её и в DATABASE_URL, и в YDB_CONNECTION_STRING.",
    ],
    consoleUrl:"https://console.yandex.cloud",consoleLabel:"Открыть консоль Yandex Cloud",
  },
  {
    id:"vk-cloud",name:"VK Cloud",short:"VK Cloud",engine:"PostgreSQL",scheme:"postgres",
    summary:"Облако VK (бывший Mail.ru Cloud Solutions): базы в российских дата-центрах.",
    steps:[
      "Откройте mcs.mail.ru и создайте проект, если его ещё нет.",
      "«Базы данных» → «Создать базу» → PostgreSQL (или MySQL), укажите имя базы и пароль.",
      "Скопируйте строку подключения из карточки базы и вставьте её ниже.",
    ],
    consoleUrl:"https://mcs.mail.ru",consoleLabel:"Открыть VK Cloud",
  },
  {
    id:"selectel",name:"Selectel · Managed Databases",short:"Selectel",engine:"PostgreSQL",scheme:"postgres",
    summary:"Облачные базы Selectel с выделенными кластерами и бэкапами.",
    steps:[
      "Войдите в my.selectel.ru и откройте «Облачные базы данных».",
      "Создайте кластер PostgreSQL, задайте пользователя и имя базы.",
      "В разделе «Подключение» скопируйте строку подключения и вставьте её ниже.",
    ],
    consoleUrl:"https://my.selectel.ru",consoleLabel:"Открыть Selectel",
  },
  {
    id:"timeweb",name:"Timeweb Cloud · Базы данных",short:"Timeweb Cloud",engine:"PostgreSQL",scheme:"postgres",
    summary:"Простые управляемые базы Timeweb Cloud: быстрый старт, почасовая оплата.",
    steps:[
      "В панели timeweb.cloud откройте «Базы данных» → «Создать базу».",
      "Выберите PostgreSQL, зону и пароль, дождитесь создания.",
      "Скопируйте строку подключения из карточки базы и вставьте её ниже.",
    ],
    consoleUrl:"https://timeweb.cloud/my",consoleLabel:"Открыть Timeweb Cloud",
  },
  {
    id:"cloud-ru",name:"Cloud.ru · Managed PostgreSQL",short:"Cloud.ru",engine:"PostgreSQL",scheme:"postgres",
    summary:"Облако Cloud.ru (Сбер): Managed PostgreSQL в российских зонах.",
    steps:[
      "Войдите в console.cloud.ru и выберите проект.",
      "«Базы данных» → «PostgreSQL» → «Создать»: укажите класс, зону, пароль и имя базы.",
      "После создания скопируйте строку подключения и вставьте её ниже.",
    ],
    consoleUrl:"https://console.cloud.ru",consoleLabel:"Открыть Cloud.ru",
  },
  {
    id:"custom",name:"Свой сервер или другой провайдер",short:"Свой сервер",engine:"PostgreSQL",scheme:"postgres",
    summary:"Собственный сервер, VPS с PostgreSQL/MySQL/MongoDB/Redis или любой другой хостинг.",
    steps:[
      "Создайте базу на своём сервере (например, PostgreSQL в Docker: docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=… postgres).",
      "Возьмите строку подключения: postgresql://пользователь:пароль@хост:5432/база.",
      "Если база закрыта файрволом, разрешите входящие подключения с адреса рабочей области.",
    ],
    consoleUrl:"",consoleLabel:"",
  },
];

/**
 * The database the project keeps its data in. The card does not require a specific
 * service: it takes the connection string any provider shows, stores it encrypted, and
 * the agent then writes it into the project's environment.
 */
export function DatabaseConnect(){
  const [status,setStatus]=useState<ConnectorStatus>("loading");
  const [info,setInfo]=useState<DatabaseStatus|null>(null);
  const [busy,setBusy]=useState(false);
  const [formOpen,setFormOpen]=useState(false);
  const [hintOpen,setHintOpen]=useState(false);
  const [fieldsOpen,setFieldsOpen]=useState(false);
  const [provider,setProvider]=useState<ProviderId>("yandex-postgresql");
  const [url,setUrl]=useState("");
  const [fields,setFields]=useState({scheme:"postgres",host:"",port:"",database:"",username:"",password:""});
  const [ssl,setSsl]=useState(true);
  const [notice,setNotice]=useState<string|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [check,setCheck]=useState<string|null>(null);

  const loadStatus=useCallback(async(quiet=false):Promise<ConnectorStatus>=>{
    try{
      const response=await fetch("/api/database/status",{credentials:"include"});
      const data=await response.json() as DatabaseStatus;
      if(!response.ok)throw new Error(data.error??"Не удалось получить состояние базы данных");
      setInfo(data);
      const next:ConnectorStatus=data.connected?"connected":"disconnected";
      setStatus(next);
      return next;
    }catch(e){
      if(!quiet)setError(e instanceof Error?e.message:"Не удалось получить состояние базы данных");
      setStatus("disconnected");
      return "disconnected";
    }
  },[]);

  useEffect(()=>{void loadStatus()},[loadStatus]);

  function openForm(nextProvider?:ProviderId){
    const active=nextProvider??provider;
    setProvider(active);
    setNotice(null);setError(null);
    setFormOpen(true);
  }

  async function save(){
    const body=fieldsOpen
      ? {provider,scheme:fields.scheme,host:fields.host.trim(),port:fields.port.trim()||undefined,database:fields.database.trim(),username:fields.username.trim(),password:fields.password,ssl}
      : {provider,url:url.trim()};
    setBusy(true);setError(null);setNotice(null);setCheck(null);
    try{
      const response=await fetch("/api/database/connection",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"include",body:JSON.stringify(body)});
      const data=await response.json() as DatabaseStatus;
      if(!response.ok)throw new Error(data.error??"Не удалось сохранить подключение");
      setUrl("");setFields({scheme:"postgres",host:"",port:"",database:"",username:"",password:""});
      setFormOpen(false);
      setNotice("Строка подключения сохранена в шифрованном виде. Скажите агенту в чате, что база подключена — он запишет её в проект.");
      await loadStatus(true);
    }catch(e){setError(e instanceof Error?e.message:"Не удалось сохранить подключение")}
    finally{setBusy(false)}
  }

  async function disconnect(){
    setBusy(true);setError(null);setNotice(null);setCheck(null);
    try{
      await fetch("/api/database/disconnect",{method:"POST",credentials:"include"});
      setFormOpen(false);setHintOpen(false);
      await loadStatus(true);
    }catch(e){setError(e instanceof Error?e.message:"Не удалось отключить базу данных")}
    finally{setBusy(false)}
  }

  /** A TCP probe: it answers "can the workspace reach this address", nothing more. */
  async function checkConnection(){
    setBusy(true);setError(null);setCheck(null);
    try{
      const response=await fetch("/api/database/check",{method:"POST",credentials:"include"});
      const data=await response.json() as {ok?:boolean;latencyMs?:number;host?:string;port?:number;error?:string};
      if(!response.ok){setError(data.error??"Проверка не удалась");return}
      setCheck(data.ok
        ? "Адрес отвечает: "+data.host+":"+data.port+" · "+data.latencyMs+" мс. Это проверка доступности, а не логина."
        : "Адрес не отвечает: "+(data.error??"нет соединения")+". Проверьте публичный доступ и группу безопасности.");
    }catch(e){setError(e instanceof Error?e.message:"Проверка не удалась")}
    finally{setBusy(false)}
  }

  const connected=status==="connected";
  const active=providers.find(item=>item.id===provider)??providers[0];
  const activeProvider=providers.find(item=>item.id===info?.provider)??null;
  // The engine name is enough when the provider's label already carries it (YDB).
  const engineLabel=info?.engine??info?.scheme??"";
  const metaLine=[engineLabel,activeProvider&&!activeProvider.short.includes(engineLabel)?activeProvider.short:null,info?.ssl?"TLS":null,info?.maskedUrl||null].filter(Boolean).join(" · ");

  return <ConnectorCard
    name="База данных"
    icon={<Database size={18}/>}
    status={status}
    busy={busy}
    busyLabel="Сохраняем…"
    onConnect={()=>openForm()}
    onDisconnect={()=>void disconnect()}
    onRefresh={()=>void loadStatus()}
    note={<>
      {notice&&<div className="connector-notice ok">{notice}</div>}
      {error&&<div className="connector-notice">{error}</div>}
      {check&&<div className="connector-notice ok">{check}</div>}
      {connected&&<span className="connector-meta-line">{metaLine}</span>}
    </>}
  >
    <div className="connector-body">
      <p className="connector-text">
        {connected
          ? "Данные проекта хранятся в этой базе. Агент запишет строку подключения в файл окружения проекта по вашей просьбе."
          : "Чтобы проект сохранял данные между сессиями, подключите базу. Подойдёт любая — рекомендуем российские: Yandex Cloud, VK Cloud, Selectel, Timeweb Cloud, Cloud.ru."}
      </p>

      {/* Not connected: the header button opens this same form, so the row stays short. */}
      <div className="connector-actions-row">
        {connected&&<>
          <button className="ghost-button" onClick={()=>void checkConnection()} disabled={busy}>Проверить связь</button>
          <button className="ghost-button" onClick={()=>openForm()}>Заменить</button>
        </>}
        <button className="ghost-button" onClick={()=>setHintOpen(open=>!open)}>{hintOpen?"Скрыть инструкцию":"Где взять базу"}</button>
      </div>

      {hintOpen&&<div className="connector-hint">
        <strong><ShieldCheck size={13}/> Как создать базу на российском сервисе</strong>
        <div className="connector-actions-row">
          {providers.map(item=><button key={item.id} className={"ghost-button connector-toggle"+(item.id===provider?" active":"")} onClick={()=>{setProvider(item.id);setFields(current=>({...current,scheme:item.scheme}));setNotice(null);setError(null)}}>{item.short}</button>)}
        </div>
        <p><em>{active.name}</em> — {active.summary}</p>
        {active.steps.map(step=><p key={step}>{step}</p>)}
        {active.consoleUrl&&<p><a className="connector-link" href={active.consoleUrl} target="_blank" rel="noreferrer">{active.consoleLabel}</a></p>}
        <p className="connector-warning"><TriangleAlert size={12}/> Ни один пароль не нужно присылать в чат: вставьте строку подключения в форму ниже — она шифруется на сервере и используется только от вашего имени.</p>
      </div>}

      {formOpen&&<div className="connector-key">
        <label>
          <span><Database size={12}/> Провайдер</span>
          <select value={provider} onChange={event=>{const next=event.target.value as ProviderId;setProvider(next);const item=providers.find(entry=>entry.id===next);if(item)setFields(current=>({...current,scheme:item.scheme}))}}>
            {providers.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>

        {!fieldsOpen&&<label>
          <span><KeyRound size={12}/> Строка подключения</span>
          <textarea rows={3} value={url} onChange={event=>setUrl(event.target.value)} placeholder="postgresql://user1:пароль@хост:6432/база?sslmode=require"/>
        </label>}

        {fieldsOpen&&<div className="connector-grid">
          <label><span>Тип базы</span>
            <select value={fields.scheme} onChange={event=>setFields({...fields,scheme:event.target.value})}>
              <option value="postgres">PostgreSQL</option>
              <option value="mysql">MySQL / MariaDB</option>
              <option value="mongodb">MongoDB</option>
              <option value="redis">Redis</option>
              <option value="grpcs">Yandex YDB</option>
            </select>
          </label>
          <label><span>Хост</span><input value={fields.host} onChange={event=>setFields({...fields,host:event.target.value})} placeholder="rc1a-abc.mdb.yandexcloud.net"/></label>
          <label><span>Порт</span><input value={fields.port} onChange={event=>setFields({...fields,port:event.target.value})} placeholder="6432" inputMode="numeric"/></label>
          <label><span>База</span><input value={fields.database} onChange={event=>setFields({...fields,database:event.target.value})} placeholder="store"/></label>
          <label><span>Пользователь</span><input value={fields.username} onChange={event=>setFields({...fields,username:event.target.value})} placeholder="user1"/></label>
          <label><span>Пароль</span><input type="password" autoComplete="new-password" value={fields.password} onChange={event=>setFields({...fields,password:event.target.value})}/></label>
        </div>}

        <div className="connector-actions-row">
          <button className="connector-action connector-connect" onClick={()=>void save()} disabled={busy||(!fieldsOpen&&!url.trim())}>{busy?"Сохраняем…":"Сохранить подключение"}</button>
          <button className="ghost-button" onClick={()=>setFieldsOpen(open=>!open)}>{fieldsOpen?"Вставить строкой":"Вставить полями"}</button>
          <label className="connector-ssl"><input type="checkbox" checked={ssl} onChange={event=>setSsl(event.target.checked)}/> TLS/SSL</label>
          <button className="ghost-button" onClick={()=>{setFormOpen(false);setError(null)}}>Отмена</button>
        </div>
        <span className="connector-meta-line">Строка подключения шифруется на сервере и никогда не возвращается в браузер и не попадает в ответы агента.</span>
      </div>}
    </div>
  </ConnectorCard>;
}
