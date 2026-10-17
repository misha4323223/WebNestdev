/**
 * Where the user stands in the app. There is no router — the home screen and the workspace are
 * two panes of one page — so a reload has nothing to restore the place from unless the place is
 * written down. `openWorkspace` in localStorage is a one-shot flag for OAuth imports; this key
 * is the durable one.
 */
export const SCREEN_KEY="webnestdev.screen";
export type AppScreen="workspace"|"home";

export function rememberScreen(screen:AppScreen){
  try{localStorage.setItem(SCREEN_KEY,screen)}catch{}
}

export function rememberedScreen():AppScreen|null{
  try{
    const value=localStorage.getItem(SCREEN_KEY);
    return value==="workspace"||value==="home"?value:null;
  }catch{return null}
}
