import { useEffect, useState } from "react";
import { KeyRound, Plug, Server, SlidersHorizontal, Sparkles } from "lucide-react";
import { SettingsPanel } from "./SettingsPanel";
import { AccountSettingsPanel } from "./AccountSettingsPanel";
import { IntegrationsPanel } from "./IntegrationsPanel";
import { PlatformKeysPanel } from "./PlatformKeysPanel";
import { ProjectSecretsPanel } from "./ProjectSecretsPanel";

export function SettingsHub({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [tab, setTab] = useState<"account" | "secrets" | "provider" | "integrations" | "platform">("account");
  // Set when the app returns from the GitHub authorization page, or when the composer
  // asks for the model tab. Read in an effect because state initializers run twice
  // under StrictMode.
  useEffect(() => {
    if (localStorage.getItem("webnestdev.openSecretsTab")) {
      localStorage.removeItem("webnestdev.openSecretsTab");
      setTab("secrets");
      return;
    }
    if (localStorage.getItem("webnestdev.openProviderTab")) {
      localStorage.removeItem("webnestdev.openProviderTab");
      setTab("provider");
      return;
    }
    if (!localStorage.getItem("webnestdev.openIntegrations")) return;
    localStorage.removeItem("webnestdev.openIntegrations");
    setTab("integrations");
  }, []);
  const tabs = [
    { id: "account" as const, label: "Аккаунт и тариф", icon: SlidersHorizontal },
    { id: "secrets" as const, label: "Секреты проекта", icon: KeyRound },
    { id: "provider" as const, label: "AI-провайдер", icon: Sparkles },
    { id: "integrations" as const, label: "Интеграции", icon: Plug },
    { id: "platform" as const, label: "Ключи сервера", icon: Server },
  ];
  return <div className="settings-hub">
    <nav className="settings-hub-tabs">
      {tabs.map(item => { const Icon = item.icon; return <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}><Icon size={14}/> {item.label}</button>; })}
    </nav>
    {tab === "account" && <AccountSettingsPanel/>}
    {tab === "secrets" && <ProjectSecretsPanel projectId={projectId} projectName={projectName}/>}
    {tab === "provider" && <SettingsPanel projectId={projectId} projectName={projectName} onClose={() => setTab("account")}/>}
    {tab === "integrations" && <IntegrationsPanel/>}
    {tab === "platform" && <PlatformKeysPanel/>}
  </div>;
}
