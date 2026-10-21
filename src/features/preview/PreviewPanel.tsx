import { Check, Copy, ExternalLink, Monitor, RefreshCw, ScrollText, Smartphone, Square, Tablet, Terminal, X } from "lucide-react";
import { useCallback,useEffect,useRef,useState } from "react";
import { getPreviewLogs,getPreviewStatus,requestPreviewTicket,startPreview,stopPreview,touchPreview } from "../../lib/project-api";
import type { PreviewState } from "../../lib/types";

type Face="preview"|"logs";
/**
 * Устройство, под которое проверяется вёрстка. Кадр рисуется в настоящей ширине устройства
 * (телефон 390, планшет 834) и уменьшается масштабом — тогда медиазапросы приложения видят
 * ровно ту ширину, как на настоящем экране, а не ширину колонки предпросмотра.
 */
type Device="desktop"|"tablet"|"phone";
const DEVICES:Record<Device,{label:string;width:number;height:number}> = {
  desktop:{label:"Десктоп",width:1280,height:800},
  tablet:{label:"Планшет",width:834,height:1112},
  phone:{label:"Телефон",width:390,height:844},
};
const deviceKey="webnestdev.previewDevice";

/**
 * Адрес живого превью. Слэш в конце обязателен: без него относительные ссылки приложения
 * ("style.css", "app.js") разрешаются на уровень выше — в платформенный 404 с JSON, и браузер
 * отказывается применять стили и скрипты ("MIME type application/json"). Сервер так же
 * перенаправляет вход без слэша на этот адрес.
 */
function previewUrl(projectId:string){return "/api/projects/"+encodeURIComponent(projectId)+"/preview/open/";}

/**
 * Адрес для кадра и для кнопки «Открыть». Когда на сервере настроен публичный домен предпросмотра,
 * приложение открывается по своему адресу (`<проект>.preview.домен`): там оно стоит в корне, поэтому
 * его абсолютные ссылки и живая перезагрузка работают так же, как при обычном запуске, и ссылку
 * можно отдать другому человеку. Путь в панели остаётся запасным.
 */
function previewAddress(projectId:string,publicTicket:string){return publicTicket||previewUrl(projectId);}

export function PreviewPanel({projectId,reloadToken=0,open=false,onClose,onRunningChange}:{projectId:string;reloadToken?:number;open?:boolean;onClose?:()=>void;onRunningChange?:(running:boolean)=>void}){
  const [preview,setPreview]=useState<PreviewState>({running:false});
  const [face,setFace]=useState<Face>("preview");
  const [logs,setLogs]=useState("");
  const [error,setError]=useState("");
  const [logsError,setLogsError]=useState("");
  const [loadingLogs,setLoadingLogs]=useState(false);
  // Выбор устройства переживает закрытие панели: обычно его ставят один раз под проверку вёрстки.
  const [device,setDevice]=useState<Device>(()=>{try{const stored=localStorage.getItem(deviceKey);return stored==="tablet"||stored==="phone"?stored:"desktop"}catch{return "desktop"}});
  const canvasRef=useRef<HTMLDivElement|null>(null);
  const [canvas,setCanvas]=useState({width:0,height:0});

  useEffect(()=>{try{localStorage.setItem(deviceKey,device)}catch{}},[device]);

  // Кадр в ширине устройства больше колонки предпросмотра, поэтому он уменьшается масштабом.
  // Размер холста меряется, а не берётся из окна: панель на телефоне занимает почти весь экран,
  // на десктопе это узкая колонка справа, и масштаб у них разный.
  useEffect(()=>{
    const element=canvasRef.current;
    if(!element)return;
    const observer=new ResizeObserver(entries=>{
      const box=entries[0]?.contentRect;
      if(box)setCanvas({width:box.width,height:box.height});
    });
    observer.observe(element);
    return ()=>observer.disconnect();
  },[face,preview.running,device]);

  const spec=DEVICES[device];
  // ResizeObserver отдаёт content-box, то есть холст без внутренних отступов, поэтому масштаб
  // считается прямо по нему. Кадр только уменьшается (не больше 1) и всегда целиком помещается
  // в холст: раньше он сохранял неумасштабированный размер в раскладке, вылезал за край и
  // обрезался — отсюда «телефон где-то внизу и сбоку».
  const fit=canvas.width>0&&canvas.height>0?Math.min(1,canvas.width/spec.width,canvas.height/spec.height):0;
  const deviceStyle={width:spec.width,height:spec.height,transform:"scale("+fit+")"};
  // Обёртка занимает ровно видимый размер кадра, поэтому центрирование и обрезка считаются по
  // нему, а не по его неумасштабированному макету.
  const fitStyle={width:Math.max(1,Math.round(spec.width*fit)),height:Math.max(1,Math.round(spec.height*fit))};

  // Номер загрузки кадра: каждый свежий статус (открытие проекта, конец прогона агента, кнопка
  // «Обновить») грузит кадр заново. Раньше он загружался один раз и оставался тем, что прокси успел
  // отдать пустым во время старта: логи говорили «запущено», а в панели так и висела белая страница.
  const [frameToken,setFrameToken]=useState(0);
  // Ссылка с билетом на публичный адрес. Билет выпускается на этот проект и на время: по адресу
  // предпросмотра cookie сессии панели не отправляется (она выставляется для домена панели).
  const [publicLink,setPublicLink]=useState("");
  // Адрес показывается рядом с кнопкой копирования: ссылку отдают другому человеку, поэтому
  // копировать её должно быть можно в один тап, а не выделять текст мышью.
  const [copied,setCopied]=useState(false);
  async function copyPublicLink(){
    const url=new URL(previewAddress(projectId,publicLink),window.location.origin).href;
    try{
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(()=>setCopied(false),1600);
    }catch{setError("Скопируйте адрес вручную: "+url)}
  }
  const refresh=async()=>{
    setError("");
    try{
      const next=await getPreviewStatus(projectId);
      setPreview(next);
      // Приложение могло подняться уже после того, как кадр загрузился: со новым статусом он берётся заново.
      if(next.running)setFrameToken(value=>value+1);
    }catch(e){setError(e instanceof Error?e.message:"Не удалось получить статус preview")}
  };
  // Refreshed when the project changes and after every agent run: a preview the agent
  // started through preview.start shows up here without the user pressing anything.
  useEffect(()=>{void refresh()},[projectId,reloadToken]);

  // Билет просится на каждый показ заново: он короткоживущий, а открытый кадр должен работать
  // даже тогда, когда вкладка простояла дольше его срока. Отказ — не ошибка панели: приложение
  // остаётся доступным по пути в панели, поэтому кадр просто берётся оттуда.
  useEffect(()=>{
    if(!preview.running||!preview.publicUrl){setPublicLink("");return}
    let cancelled=false;
    requestPreviewTicket(projectId)
      .then(result=>{if(!cancelled)setPublicLink(result.url)})
      .catch(()=>{if(!cancelled)setPublicLink("")});
    return ()=>{cancelled=true};
  },[projectId,preview.running,preview.publicUrl,reloadToken,frameToken]);

  const loadLogs=useCallback(async()=>{
    setLoadingLogs(true);setLogsError("");
    try{setLogs((await getPreviewLogs(projectId)).logs)}
    catch(e){setLogsError(e instanceof Error?e.message:"Не удалось получить логи")}
    finally{setLoadingLogs(false)}
  },[projectId]);

  // An open, visible panel keeps the preview alive: the server stops a preview nobody has
  // used for PREVIEW_IDLE_MS (five minutes by default), and a closed tab simply stops
  // sending the heartbeat, so the container is freed.
  useEffect(()=>{
    if(!preview.running)return;
    const beat=()=>{
      if(document.visibilityState!=="visible")return;
      void touchPreview(projectId).catch(()=>undefined);
    };
    beat();
    const timer=window.setInterval(beat,60000);
    return ()=>window.clearInterval(timer);
  },[preview.running,projectId]);

  // Logs refresh while the back face is visible, so the dev server output stays current.
  useEffect(()=>{
    if(face!=="logs")return;
    void loadLogs();
    const timer=setInterval(()=>void loadLogs(),4000);
    return ()=>clearInterval(timer);
  },[face,loadLogs]);

  // On a phone the panel is a drawer, and every other overlay here closes on Escape.
  useEffect(()=>{
    if(!open)return;
    const onKey=(event:KeyboardEvent)=>{if(event.key==="Escape")onClose?.()};
    window.addEventListener("keydown",onKey);
    return ()=>window.removeEventListener("keydown",onKey);
  },[open,onClose]);

  // Whether the preview is live is shown on the top-bar button that opens this drawer.
  useEffect(()=>{onRunningChange?.(Boolean(preview.running))},[preview.running,onRunningChange]);

  async function start(){
    setError("");
    try{setPreview(await startPreview(projectId))}
    catch(e){setError(e instanceof Error?e.message:"Не удалось запустить preview")}
  }
  async function stop(){
    setError("");
    try{await stopPreview(projectId);setPreview({running:false})}
    catch(e){setError(e instanceof Error?e.message:"Не удалось остановить preview")}
  }

  return <>
  {/* Затемнение и панель — одна выезжающая поверх рабочей области пара: на широком экране
      и то, и другое скрыто, панель остаётся обычной колонкой справа. */}
  <div className={"preview-backdrop"+(open?" open":"")} onClick={onClose} aria-hidden="true"/>
  <aside id="preview-panel" className={"preview"+(open?" open":"")}>
    <div className="preview-grabber" aria-hidden="true"><span/></div>
    {/* Заголовок и действия стоят двумя строками: в узкой шторке подпись «Рабочая область»
        раньше сжималась в ноль и кнопки наезжали на неё. Первая строка — что открыто и крестик,
        вторая — вкладки и управление предпросмотром. */}
    <div className="preview-head">
      <div className="preview-title">
        <span className="eyebrow">ПРЕДПРОСМОТР</span>
        <strong>{face==="preview"?"Рабочая область":"Логи запуска"}</strong>
      </div>
      <button className="icon-button preview-close" onClick={onClose} title="Скрыть панель" aria-label="Скрыть панель"><X size={15}/></button>
      <div className="preview-actions">
        <div className="preview-flip" role="tablist" aria-label="Переключить превью и логи">
          <button role="tab" aria-selected={face==="preview"} className={face==="preview"?"active":""} onClick={()=>setFace("preview")}><Monitor size={13}/> Превью</button>
          <button role="tab" aria-selected={face==="logs"} className={face==="logs"?"active":""} onClick={()=>setFace("logs")}><ScrollText size={13}/> Логи</button>
        </div>
        {face==="preview"
          ? <>
              {preview.running?<button className="icon-button" onClick={()=>void stop()} title="Остановить"><Square size={14}/></button>:<button className="icon-button" onClick={()=>void start()} title="Запустить"><Terminal size={14}/></button>}
              <button className="icon-button" onClick={()=>void refresh()} title="Обновить"><RefreshCw size={14}/></button>
              {preview.running&&<a className="icon-button" href={previewAddress(projectId,publicLink)} target="_blank" rel="noreferrer" title="Открыть"><ExternalLink size={14}/></a>}
            </>
          : <button className="icon-button" onClick={()=>void loadLogs()} disabled={loadingLogs} title="Обновить логи"><RefreshCw size={14}/></button>}
      </div>
    </div>
    {error&&<div className="preview-error">{error}</div>}
    {/* Подсказка нужна и тому, кто ждёт запуска (ready===false), и тому, у кого страница белая при
        живом приложении (settled===false), и тому, у кого приложение отдаётся через docker exec
        (viaExec): это разные причины и разные исправления. */}
    {!error&&preview.running&&(preview.ready===false||preview.settled===false||preview.viaExec)&&<div className="preview-hint">{preview.hint??"Приложение ещё запускается…"}</div>}
    {/* Публичный адрес показывается, а не прячется в подсказке кнопки: это адрес, который видят
        другие, и по нему приложение работает без переписывания ссылок. */}
    {!error&&preview.running&&preview.publicUrl&&<div className="preview-share">
      <span className="preview-share-label">Публичный адрес</span>
      <a className="preview-share-link" href={previewAddress(projectId,publicLink)} target="_blank" rel="noreferrer">
        <ExternalLink size={11}/>
        <span>{preview.publicUrl.replace(/^https?:\/\//,"")}</span>
      </a>
      <button className="preview-share-copy" onClick={()=>void copyPublicLink()} title={copied?"Скопировано":"Скопировать адрес"} aria-label="Скопировать адрес">
        {copied?<Check size={12}/>:<Copy size={12}/>}
      </button>
    </div>}
    {/* Панель устройств: ширина кадра — настоящая ширина устройства, поэтому медиазапросы
        приложения срабатывают так же, как на телефоне и планшете, а не по ширине колонки. */}
    {face==="preview"&&<div className="preview-devices" role="group" aria-label="Устройство предпросмотра">
      <div className="preview-devices-group">
        {(["desktop","tablet","phone"] as Device[]).map(id=>{
          const Icon=id==="desktop"?Monitor:id==="tablet"?Tablet:Smartphone;
          return <button key={id} className={"preview-device-btn"+(device===id?" active":"")} onClick={()=>setDevice(id)} aria-pressed={device===id} title={DEVICES[id].label} aria-label={DEVICES[id].label}><Icon size={14}/></button>;
        })}
      </div>
      <span className="preview-devices-size">{spec.label} · {spec.width} px{fit>0&&fit<1?" · "+Math.round(fit*100)+"%":""}</span>
    </div>}
    <div className="preview-body">
      <div className={"preview-stage"+(face==="logs"?" flipped":"")}>
        <div className="preview-face preview-front">
          {preview.running
            ? <div className="preview-canvas" ref={canvasRef}>
                {/* Кадр рисуется в настоящей ширине устройства, поэтому медиазапросы приложения
                    срабатывают как на телефоне, планшете и десктопе. Обёртка равна видимому
                    размеру, а сам кадр уменьшается масштабом из левого верхнего угла. */}
                {fit>0&&<div className="preview-device-fit" style={fitStyle}>
                  <div className={"preview-device "+device} style={deviceStyle}>
                    <iframe key={reloadToken+"-"+frameToken+publicLink+"-"+device} className="preview-frame" title="Живой предпросмотр" src={previewAddress(projectId,publicLink)}/>
                  </div>
                </div>}
              </div>
            : <div className="preview-empty"><div className="preview-icon"><Terminal size={20}/></div><strong>Предпросмотр проекта</strong><span>Запустите preview после создания файлов проекта — и проверьте его сразу под телефон и планшет.</span><button className="ghost-button" onClick={()=>void start()}>Запустить preview</button></div>}
        </div>
        <div className="preview-face preview-back">
          <div className="preview-logs-head">
            <span className={preview.running?"preview-logs-live":"preview-logs-idle"}>{preview.running?"Предпросмотр запущен":"Предпросмотр остановлен"}</span>
            <small>{loadingLogs?"обновляем…":"обновление каждые 4 секунды"}</small>
          </div>
          {logsError&&<div className="preview-error preview-logs-error">{logsError}</div>}
          <pre className="preview-logs">{logs||(preview.running?"Пока нет вывода. Логи появятся, когда приложение что-нибудь напишет.":"Запустите предпросмотр, чтобы увидеть логи запуска.")}</pre>
          {!preview.running&&<div className="preview-logs-actions"><button className="ghost-button" onClick={()=>void start()}>Запустить preview</button></div>}
        </div>
      </div>
    </div>
  </aside>
  </>;
}
