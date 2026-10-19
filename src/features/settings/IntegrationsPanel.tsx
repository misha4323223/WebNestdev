import { Plug } from "lucide-react";
import { IntegrationsList } from "../integrations/IntegrationsList";

export function IntegrationsPanel() {
  return <section className="settings-panel integrations-panel">
    <div className="panel-title">
      <div><span className="eyebrow">ИНТЕГРАЦИИ</span><strong>Подключения</strong></div>
      <span className="integrations-mark"><Plug size={18}/></span>
    </div>
    <div className="settings-body">
      <p className="account-muted">Подключите сервисы к рабочей области. Рядом с каждым видно состояние подключения.</p>
      <IntegrationsList surface="workspace"/>
    </div>
  </section>;
}
