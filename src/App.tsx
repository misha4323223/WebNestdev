import { useEffect } from "react";
import { AuthGate } from "./features/auth/AuthGate";
import { CookieConsent } from "./features/legal/CookieConsent";
import { watchForNewBuild } from "./lib/app-build";
import { loadCachedPreferences } from "./lib/preferences";

export function App(){
  useEffect(()=>{
    loadCachedPreferences();
    // Вкладка, открытая до выкатки, перезагрузится сама, когда сервер начнёт отдавать другую сборку:
    // иначе она остаётся на документе и ассетах прошлой версии (см. lib/app-build.ts).
    return watchForNewBuild();
  },[]);
  return <div className="app"><AuthGate/><CookieConsent/></div>;
}
export default App;
