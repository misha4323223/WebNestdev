import { useState } from "react";

export function SettingsPanel({projectName,onClose}:{projectName:string;onClose:()=>void}){
  const [model,setModel]=useState(()=>localStorage.getItem("webnestdev.model")??"По умолчанию");
  function save(){localStorage.setItem("webnestdev.model",model);onClose()}
  return <section className="settings-panel">
    <div className="panel-title"><div><span className="eyebrow">SETTINGS</span><strong>Настройки проекта</strong></div><button className="ghost-button" onClick={onClose}>Закрыть</button></div>
    <div className="settings-body">
      <label>Проект<span>{projectName}</span></label>
      <label>Модель агента<select value={model} onChange={e=>setModel(e.target.value)}><option>По умолчанию</option><option>OpenAI-compatible</option><option>Ollama</option></select></label>
      <button className="send-button settings-save" onClick={save}>Сохранить</button>
    </div>
  </section>;
}
