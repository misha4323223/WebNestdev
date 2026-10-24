import { useEffect } from "react";
import { AuthGate } from "./features/auth/AuthGate";
import { CookieConsent } from "./features/legal/CookieConsent";
import { LegalScreen } from "./features/legal/LegalScreen";
import { isLegalPath } from "./lib/legal";
import { watchForNewBuild } from "./lib/app-build";
import { loadCachedPreferences } from "./lib/preferences";
import { TooltipLayer } from "./components/Hint";

export function App(){
  useEffect(()=>{
    loadCachedPreferences();
    // Вкладка, открытая до выкатки, перезагрузится сама, когда сервер начнёт отдавать другую сборку:
    // иначе она остаётся на документе и ассетах прошлой версии (см. lib/app-build.ts).
    return watchForNewBuild();
  },[]);
  // Юридические страницы открываются без входа: их читают до регистрации и до оплаты, а
  // платёжному сервису нужна прямая ссылка, не зависящая от сессии.
  const legal = isLegalPath(window.location.pathname);
  return <div className="app">{legal ? <LegalScreen/> : <AuthGate/>}<CookieConsent/><TooltipLayer/></div>;
}
export default App;
