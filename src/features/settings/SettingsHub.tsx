import { useEffect, useState } from "react";
import { ArrowLeft, KeyRound, Plug, Server, SlidersHorizontal, Sparkles } from "lucide-react";
import { apiJson } from "../../lib/api";
import { SettingsPanel } from "./SettingsPanel";
import { AccountSettingsPanel } from "./AccountSettingsPanel";
import { IntegrationsPanel } from "./IntegrationsPanel";
import { PlatformKeysPanel } from "./PlatformKeysPanel";
import { ProjectSecretsPanel } from "./ProjectSecretsPanel";

export function SettingsHub({ projectId, projectName, onClose }: { projectId: string; projectName: string; onClose?: () => void }) {
  const [tab, setTab] = useState<"account" | "secrets" | "provider" | "integrations" | "platform">("account");
  // Ключи сервера — внутренний инструмент платформы. Обычный пользователь не должен видеть
  // даже вкладку: сервер отвечает только флагом admin, поэтому и запрос здесь лёгкий.
  const [platformAdmin, setPlatformAdmin] = useState(false);
  useEffect(() => {
    let alive = true;
    void apiJson<{ admin?: boolean }>("/api/platform/keys")
      .then(data => { if (alive) setPlatformAdmin(data.admin === true); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  // Set when the app returns from the GitHub authorization page, or when the composer
  // asks for the model tab. Read in an effect because state initializers run twice
  // under StrictMode.
  useEffect(() => {
    // OAuth-возврат в рабочую область просит конкретную вкладку отдельным ключом:
    // `openIntegrations` принадлежит главной и к моменту монтирования хаба уже съеден ею.
    const requestedTab = localStorage.getItem("webnestdev.openSettingsTab");
    if (requestedTab === "account" || requestedTab === "secrets" || requestedTab === "provider" || requestedTab === "integrations" || requestedTab === "platform") {
      localStorage.removeItem("webnestdev.openSettingsTab");
      setTab(requestedTab);
      return;
    }
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
    ...(platformAdmin ? [{ id: "platform" as const, label: "Ключи сервера", icon: Server }] : []),
  ];
  const activeTab = tab === "platform" && !platformAdmin ? "account" : tab;
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
    {activeTab === "account" && <AccountSettingsPanel/>}
    {activeTab === "secrets" && <ProjectSecretsPanel projectId={projectId} projectName={projectName}/>}
    {activeTab === "provider" && <SettingsPanel projectId={projectId} projectName={projectName} onClose={() => setTab("account")}/>}
    {activeTab === "integrations" && <IntegrationsPanel/>}
    {activeTab === "platform" && platformAdmin && <PlatformKeysPanel/>}
  </div>;
}
