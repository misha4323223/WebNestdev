import { useState } from "react";
import { CreditCard, SlidersHorizontal, Sparkles } from "lucide-react";
import { SettingsPanel } from "./SettingsPanel";
import { AccountSettingsPanel } from "./AccountSettingsPanel";

export function SettingsHub({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [tab, setTab] = useState<"account" | "provider">("account");
  return <div className="settings-hub">
    <nav className="settings-hub-tabs">
      <button className={tab === "account" ? "active" : ""} onClick={() => setTab("account")}><SlidersHorizontal size={14}/> Аккаунт и тариф</button>
      <button className={tab === "provider" ? "active" : ""} onClick={() => setTab("provider")}><Sparkles size={14}/> AI-провайдер</button>
    </nav>
    {tab === "account" ? <AccountSettingsPanel/> : <SettingsPanel projectId={projectId} projectName={projectName} onClose={() => setTab("account")}/>}
  </div>;
}
