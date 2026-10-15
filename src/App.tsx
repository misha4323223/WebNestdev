import { useEffect } from "react";
import { AuthGate } from "./features/auth/AuthGate";
import { loadCachedPreferences } from "./lib/preferences";

export function App(){
  useEffect(()=>{ loadCachedPreferences(); },[]);
  return <div className="app"><AuthGate/></div>;
}
export default App;
