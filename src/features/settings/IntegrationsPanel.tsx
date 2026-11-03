import { useEffect, useState } from "react";
import { Plug } from "lucide-react";
import { IntegrationsList } from "../integrations/IntegrationsList";
import { getBilling, type BillingData } from "../../lib/billing-api";
import { activePlanId } from "../../lib/plan-choice";

export function IntegrationsPanel() {
  // Тариф решает, какие категории показывать: список интеграций один для главной и настроек.
  const [billing, setBilling] = useState<BillingData | null>(null);
  useEffect(() => {
    let active = true;
    void getBilling().then(data => { if (active) setBilling(data); }).catch(() => {});
    return () => { active = false; };
  }, []);

  return <section className="settings-panel integrations-panel">
    <div className="panel-title">
      <div><span className="eyebrow">ИНТЕГРАЦИИ</span><strong>Подключения</strong></div>
      <span className="integrations-mark"><Plug size={18}/></span>
    </div>
    <div className="settings-body">
      <p className="account-muted">Подключите сервисы к рабочей области. Рядом с каждым видно состояние подключения.</p>
      <IntegrationsList surface="workspace" planId={activePlanId(billing)}/>
    </div>
  </section>;
}
