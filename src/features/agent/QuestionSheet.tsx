import { useMemo, useState } from "react";
import { Check, HelpCircle, X } from "lucide-react";

/**
 * Вопрос агента, который ждёт решения пользователя. Окно выезжает над полем ввода сообщений —
 * рядом с тем местом, где человек и так отвечает, — и не уходит вместе с длинной перепиской.
 * Варианты готовые, но всегда можно написать свой: у задачи редко бывает ровно два ответа.
 */
export type AgentQuestion={
  requestId:string;
  question:string;
  options:Array<{label:string;description?:string}>;
  multiSelect:boolean;
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

  function toggle(label:string){
    if(prompt.multiSelect){
      setSelected(current=>current.includes(label)?current.filter(item=>item!==label):[...current,label]);
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

  return <section className="question-sheet" role="dialog" aria-modal="false" aria-live="polite" aria-label="Вопрос от агента">
    <div className="question-head">
      <span className="question-badge"><HelpCircle size={13}/> Вопрос от агента</span>
      <button type="button" className="icon-button question-close" onClick={onSkip} disabled={busy} title="Пропустить — агент выберет сам" aria-label="Пропустить вопрос"><X size={14}/></button>
    </div>

    <p className="question-text">{prompt.question}</p>

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
          disabled={busy}
        >
          <span className="question-mark" aria-hidden="true">{active?<Check size={12}/>:null}</span>
          <span className="question-option-body">
            <strong>{option.label}</strong>
            {option.description&&<small>{option.description}</small>}
          </span>
        </button>;
      })}
    </div>

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
        placeholder="Напишите ответ, если ни один вариант не подходит"
        aria-label="Свой ответ"
      />
    </label>}

    {error&&<div className="connector-notice">{error}</div>}

    <div className="question-foot">
      <button type="button" className="ghost-button" onClick={onSkip} disabled={busy}>Пропустить</button>
      <span className="question-hint">{prompt.multiSelect?"Можно выбрать несколько":"Один вариант или свой ответ"}</span>
      <button type="button" className="send-button" onClick={submit} disabled={busy||!ready}>{busy?"Отправляем…":"Ответить"}</button>
    </div>
  </section>;
}
