import { useEffect, useState } from "react";
import { ArrowLeft, KeyRound, Plug, SlidersHorizontal, Sparkles } from "lucide-react";
import { SettingsPanel } from "./SettingsPanel";
import { AccountSettingsPanel } from "./AccountSettingsPanel";
import { IntegrationsPanel } from "./IntegrationsPanel";
import { ProjectSecretsPanel } from "./ProjectSecretsPanel";

export function SettingsHub({ projectId, projectName, onClose, canUseOwnProvider = false }: { projectId: string; projectName: string; onClose?: () => void; canUseOwnProvider?: boolean }) {
  const [tab, setTab] = useState<"account" | "secrets" | "provider" | "integrations">("account");
  // Set when the app returns from the GitHub authorization page, or when the composer
  // asks for the model tab. Read in an effect because state initializers run twice
  // under StrictMode.
  useEffect(() => {
    // OAuth-возврат в рабочую область просит конкретную вкладку отдельным ключом:
    // `openIntegrations` принадлежит главной и к моменту монтирования хаба уже съеден ею.
    const requestedTab = localStorage.getItem("webnestdev.openSettingsTab");
    if (requestedTab === "account" || requestedTab === "secrets" || requestedTab === "provider" || requestedTab === "integrations") {
      localStorage.removeItem("webnestdev.openSettingsTab");
      setTab(requestedTab === "provider" && !canUseOwnProvider ? "account" : requestedTab);
      return;
    }
    if (localStorage.getItem("webnestdev.openSecretsTab")) {
      localStorage.removeItem("webnestdev.openSecretsTab");
      setTab("secrets");
      return;
    }
    if (localStorage.getItem("webnestdev.openProviderTab")) {
      localStorage.removeItem("webnestdev.openProviderTab");
      if (canUseOwnProvider) setTab("provider");
      return;
    }
    if (!localStorage.getItem("webnestdev.openIntegrations")) return;
    localStorage.removeItem("webnestdev.openIntegrations");
    setTab("integrations");
  }, [canUseOwnProvider]);
  const tabs = [
    { id: "account" as const, label: "Аккаунт и тариф", icon: SlidersHorizontal },
    { id: "secrets" as const, label: "Секреты проекта", icon: KeyRound },
    ...(canUseOwnProvider ? [{ id: "provider" as const, label: "AI-провайдер", icon: Sparkles }] : []),
    { id: "integrations" as const, label: "Интеграции", icon: Plug },
  ];
  const activeTab = tab === "provider" && !canUseOwnProvider ? "account" : tab;
  return <div className="settings-hub">
    {/* Боковая колонка в настройках скрыта — значит, нужен явный путь обратно к работе. */}
    <div className="settings-hub-bar">
      <nav className="settings-hub-tabs" aria-label="Разделы настроек">
        {tabs.map(item => { const Icon = item.icon; return <button key={item.id} className={activeTab === item.id ? "active" : ""} onClick={() => setTab(item.id)}><Icon size={14}/> {item.label}</button>; })}
      </nav>
      {onClose && <button className="settings-hub-back" onClick={onClose} title="Вернуться к работе над проектом">
        <ArrowLeft size={13}/> <span>К работе</span>
      </button>}
    </div>
    {activeTab === "account" && <AccountSettingsPanel projectId={projectId} projectName={projectName}/>}
    {activeTab === "secrets" && <ProjectSecretsPanel projectId={projectId} projectName={projectName}/>}
    {activeTab === "provider" && <SettingsPanel projectId={projectId} projectName={projectName} onClose={() => setTab("account")}/>}
    {activeTab === "integrations" && <IntegrationsPanel/>}
  </div>;
}
