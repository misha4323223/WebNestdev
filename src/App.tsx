import { AuthGate } from "./features/auth/AuthGate";

export function App(){
  return <div className="app"><AuthGate/></div>;
}
export default App;
