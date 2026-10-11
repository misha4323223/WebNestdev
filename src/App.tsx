import { useEffect } from "react";
import { AuthGate } from "./features/auth/AuthGate";
import { loadPreferences } from "./lib/preferences";

export function App(){
  useEffect(()=>{ void loadPreferences(); },[]);
  return <div className="app"><AuthGate/></div>;
}
export default App;
