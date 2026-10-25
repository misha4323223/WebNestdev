// Окно вопроса агента: модальный диалог в том же техно-стиле, что и запрос ключа.
import { useEffect, useMemo, useState } from "react";
import { Check, CornerDownLeft, HelpCircle, Sparkles, X } from "lucide-react";

/**
 * Вопрос агента, который ждёт решения пользователя. Это модальное окно поверх рабочей области:
 * агент уже остановился на этом шаге, поэтому вопрос не должен уезжать вместе с перепиской или
 * зависеть от того, какая вкладка открыта. Варианты готовые, но всегда можно написать свой:
 * у задачи редко бывает ровно два ответа.
 */
export type AgentQuestion={
  requestId:string;
  question:string;
  options:Array<{label:string;description?:string;imageUrl?:string}>;
  multiSelect:boolean;
  maxSelections?:number;
  allowCustom:boolean;
};

export function QuestionSheet({prompt,busy,error,onAnswer,onSkip}:{
  prompt:AgentQuestion;
  busy:boolean;
  error:string;
  onAnswer:(answer:{selected:string[];custom?:string})=>void;
  onSkip:()=>void;
}){
  const [selected,setSelected]=useState<string[]>([]);
  const [custom,setCustom]=useState("");
  const limit=prompt.multiSelect?Math.max(1,Math.min(prompt.maxSelections??prompt.options.length,prompt.options.length)):1;
  const atLimit=prompt.multiSelect&&selected.length>=limit;

  function toggle(label:string){
    if(prompt.multiSelect){
      setSelected(current=>{
        if(current.includes(label))return current.filter(item=>item!==label);
        // Лимит проверяется и здесь, и на сервере: кнопка блокируется, но клавиатурный выбор
        // или устаревшее окно не должны отправить больше вариантов, чем разрешено.
        if(current.length>=limit)return current;
        return [...current,label];
      });
      return;
    }
    // Один вариант — и свой ответ тоже: выбранным остаётся ровно один.
    setCustom("");
    setSelected(current=>current.includes(label)?[]:[label]);
  }

  const ready=useMemo(()=>Boolean(selected.length||custom.trim()),[selected,custom]);

  function submit(){
    if(!ready||busy)return;
    const value=custom.trim();
    onAnswer({selected,...(value?{custom:value}:{})});
  }

  // Escape — это «пропустить»: агент выберет вариант сам и продолжит, а не будет ждать.
  useEffect(()=>{
    function onKeyDown(event:KeyboardEvent){
      if(event.key!=="Escape"||busy)return;
      event.preventDefault();
      onSkip();
    }
    window.addEventListener("keydown",onKeyDown);
    return()=>window.removeEventListener("keydown",onKeyDown);
  },[busy,onSkip]);

  return <div className="modal-backdrop tech-backdrop" role="presentation">
    <section
      className="modal tech-modal question-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="agent-question-title"
      aria-describedby="agent-question-text"
    >
      <header className="modal-head">
        <div className="tech-modal-title">
          <span className="tech-modal-icon" aria-hidden="true"><HelpCircle size={15}/></span>
          <div className="tech-modal-heading">
            <span className="eyebrow">ВОПРОС АГЕНТА</span>
            <h2 id="agent-question-title">Уточняю детали</h2>
          </div>
        </div>
        <button type="button" className="icon-button" onClick={onSkip} disabled={busy} title="Пропустить — агент выберет сам" aria-label="Пропустить вопрос"><X size={16}/></button>
      </header>

      <div className="modal-body">
        <p className="question-text" id="agent-question-text">{prompt.question}</p>

        <div className={"question-options"+(prompt.multiSelect?" multi":"")} role="group" aria-label={prompt.question}>
          {prompt.options.map(option=>{
            const active=selected.includes(option.label);
            return <button
              type="button"
              key={option.label}
              className={"question-option"+(active?" selected":"")}
              role={prompt.multiSelect?"checkbox":"radio"}
              aria-checked={active}
              onClick={()=>toggle(option.label)}
              disabled={busy||(!active&&atLimit)}
            >
              <span className="question-mark" aria-hidden="true">{active?<Check size={12}/>:null}</span>
              <span className="question-option-body">
                {option.imageUrl&&<img className="question-option-image" src={option.imageUrl} alt="" loading="lazy"/>}
                <strong>{option.label}</strong>
                {option.description&&<small>{option.description}</small>}
              </span>
            </button>;
          })}
        </div>

        {prompt.multiSelect&&limit<prompt.options.length&&<p className="question-limit">Можно выбрать до {limit} вариантов.</p>}

        {prompt.allowCustom&&<label className="question-custom">
          <span>Свой вариант</span>
          <input
            type="text"
            value={custom}
            maxLength={2000}
            disabled={busy}
            onChange={event=>{
              const value=event.target.value;
              setCustom(value);
              // Свой текст для вопроса с одним ответом заменяет выбранный вариант, а не дополняет его.
              if(value.trim()&&!prompt.multiSelect)setSelected([]);
            }}
            onKeyDown={event=>{if(event.key==="Enter"){event.preventDefault();submit()}}}
            placeholder="Свой ответ"
            aria-label="Свой ответ"
          />
        </label>}

        {error&&<div className="connector-notice">{error}</div>}

        <p className="question-meta"><Sparkles size={12}/><span>Агент продолжит с этого шага.</span></p>
      </div>

      <footer className="modal-foot">
        <button type="button" className="ghost-button" onClick={onSkip} disabled={busy}>Пропустить</button>
        <button type="button" className="send-button" onClick={submit} disabled={busy||!ready}>
          {busy?"Отправляем…":"Ответить"}
          {!busy&&ready?<CornerDownLeft size={13}/>:null}
        </button>
      </footer>
    </section>
  </div>;
}
