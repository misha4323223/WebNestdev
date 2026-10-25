import { useEffect,useId,useLayoutEffect,useRef,useState,type CSSProperties,type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";

/**
 * Маленький знак «?» рядом с подписью: наведение, фокус или тап раскрывают короткое
 * объяснение. Подсказка рисуется порталом в body, поэтому её не обрезает панель
 * с overflow — иначе длинные title исчезали у края узкой колонки.
 */
export function Hint({children,label="Что это"}:{children:ReactNode;label?:string}){
  const [open,setOpen]=useState(false);
  const [style,setStyle]=useState<CSSProperties|undefined>(undefined);
  const triggerRef=useRef<HTMLButtonElement|null>(null);
  const bubbleRef=useRef<HTMLDivElement|null>(null);
  const id=useId();

  useLayoutEffect(()=>{
    if(!open)return;
    const anchor=triggerRef.current?.getBoundingClientRect();
    const bubble=bubbleRef.current?.getBoundingClientRect();
    if(!anchor||!bubble)return;
    const gap=8;
    const below=anchor.top-bubble.height-gap<8;
    const left=Math.min(Math.max(8,anchor.left+anchor.width/2-bubble.width/2),window.innerWidth-bubble.width-8);
    const top=Math.min(Math.max(8,below?anchor.bottom+gap:anchor.top-bubble.height-gap),window.innerHeight-bubble.height-8);
    setStyle({left,top});
  },[open,children]);

  useEffect(()=>{
    if(!open)return;
    const closeOnOutside=(event:PointerEvent)=>{
      const target=event.target as Node|null;
      if(triggerRef.current?.contains(target)||bubbleRef.current?.contains(target))return;
      setOpen(false);
    };
    const closeOnEscape=(event:KeyboardEvent)=>{if(event.key==="Escape")setOpen(false)};
    const closeOnResize=()=>setOpen(false);
    document.addEventListener("pointerdown",closeOnOutside,true);
    window.addEventListener("keydown",closeOnEscape);
    window.addEventListener("resize",closeOnResize);
    return ()=>{
      document.removeEventListener("pointerdown",closeOnOutside,true);
      window.removeEventListener("keydown",closeOnEscape);
      window.removeEventListener("resize",closeOnResize);
    };
  },[open]);

  return <>
    <button
      ref={triggerRef}
      type="button"
      className={"hint-trigger"+(open?" open":"")}
      aria-label={label}
      aria-describedby={open?id:undefined}
      aria-expanded={open}
      onPointerEnter={event=>{if(event.pointerType==="mouse")setOpen(true)}}
      onPointerLeave={event=>{if(event.pointerType==="mouse")setOpen(false)}}
      onFocus={event=>{if(event.currentTarget.matches(":focus-visible"))setOpen(true)}}
      onBlur={()=>setOpen(false)}
      onClick={event=>{event.preventDefault();event.stopPropagation();setOpen(value=>!value)}}
    >
      <Info size={11} aria-hidden="true"/>
    </button>
    {open&&createPortal(
      <div ref={bubbleRef} id={id} role="tooltip" className="tooltip-bubble" style={style??{visibility:"hidden"}}>{children}</div>,
      document.body,
    )}
  </>;
}

/**
 * Единый стиль для всех существующих `title`: вместо системной жёлтой плашки браузера
 * показывается подсказка сайта. Так объяснение получает каждая кнопка и поле, где title
 * уже был, без переписывания сотни обработчиков. Нативный title временно снимается,
 * чтобы браузер не рисовал вторую подсказку, и возвращается при уходе курсора.
 */
export function TooltipLayer(){
  const [tip,setTip]=useState<{text:string;anchor:DOMRect}|null>(null);
  const [style,setStyle]=useState<CSSProperties|undefined>(undefined);
  const bubbleRef=useRef<HTMLDivElement|null>(null);
  const currentRef=useRef<HTMLElement|null>(null);
  const titleRef=useRef("");

  useLayoutEffect(()=>{
    if(!tip)return;
    const bubble=bubbleRef.current?.getBoundingClientRect();
    if(!bubble)return;
    const gap=8;
    const below=tip.anchor.top-bubble.height-gap<8;
    const left=Math.min(Math.max(8,tip.anchor.left+tip.anchor.width/2-bubble.width/2),window.innerWidth-bubble.width-8);
    const top=Math.min(Math.max(8,below?tip.anchor.bottom+gap:tip.anchor.top-bubble.height-gap),window.innerHeight-bubble.height-8);
    setStyle({left,top});
  },[tip]);

  useEffect(()=>{
    function restore(){
      const element=currentRef.current;
      if(element&&!element.hasAttribute("title"))element.setAttribute("title",titleRef.current);
      currentRef.current=null;
      titleRef.current="";
    }
    function clearBubble(){
      setTip(null);
      setStyle(undefined);
    }
    function hide(){
      restore();
      clearBubble();
    }
    function show(element:HTMLElement){
      const text=element.getAttribute("title")?.trim();
      if(!text||text.length<2||element===currentRef.current)return;
      hide();
      titleRef.current=text;
      currentRef.current=element;
      element.removeAttribute("title");
      setTip({text,anchor:element.getBoundingClientRect()});
    }
    function titled(target:EventTarget|null){
      return target instanceof Element?target.closest("[title]") as HTMLElement|null:null;
    }
    const onPointerOver=(event:PointerEvent)=>{
      const target=event.target instanceof Element?event.target:null;
      if(currentRef.current&&target&&currentRef.current.contains(target))return;
      const element=titled(event.target);
      if(element)show(element);
      else if(currentRef.current)hide();
    };
    const onPointerOut=(event:PointerEvent)=>{
      if(!currentRef.current)return;
      const next=event.relatedTarget as Node|null;
      if(next&&currentRef.current.contains(next))return;
      hide();
    };
    const onFocusIn=(event:FocusEvent)=>{
      const target=event.target instanceof Element?event.target:null;
      if(currentRef.current&&target&&currentRef.current.contains(target))return;
      const element=titled(event.target);
      if(element)show(element);
    };
    const onFocusOut=(event:FocusEvent)=>{
      if(!currentRef.current)return;
      const next=event.relatedTarget as Node|null;
      if(next&&currentRef.current.contains(next))return;
      hide();
    };
    const onKeyDown=(event:KeyboardEvent)=>{if(event.key==="Escape")hide()};
    document.addEventListener("pointerover",onPointerOver);
    document.addEventListener("pointerout",onPointerOut);
    document.addEventListener("focusin",onFocusIn);
    document.addEventListener("focusout",onFocusOut);
    // Клик убирает плашку, но title остаётся снятым до ухода курсора: иначе браузер
    // через секунду показал бы свою жёлтую подсказку поверх уже открытого меню.
    document.addEventListener("pointerdown",clearBubble,true);
    window.addEventListener("keydown",onKeyDown);
    window.addEventListener("scroll",hide,true);
    window.addEventListener("resize",hide);
    return ()=>{
      document.removeEventListener("pointerover",onPointerOver);
      document.removeEventListener("pointerout",onPointerOut);
      document.removeEventListener("focusin",onFocusIn);
      document.removeEventListener("focusout",onFocusOut);
      document.removeEventListener("pointerdown",clearBubble,true);
      window.removeEventListener("keydown",onKeyDown);
      window.removeEventListener("scroll",hide,true);
      window.removeEventListener("resize",hide);
      restore();
    };
  },[]);

  if(!tip)return null;
  return createPortal(
    <div ref={bubbleRef} role="tooltip" className="tooltip-bubble" style={style??{visibility:"hidden"}}>{tip.text}</div>,
    document.body,
  );
}
