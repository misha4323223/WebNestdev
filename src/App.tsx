import { lazy, Suspense, useEffect } from "react";
import { AuthGate } from "./features/auth/AuthGate";
import { CookieConsent } from "./features/legal/CookieConsent";
import { NestLoader } from "./components/NestLoader";
import { isLegalPath } from "./lib/legal";
import { isBlogPath } from "./features/blog/blog-posts";
import { watchForNewBuild } from "./lib/app-build";
import { loadCachedPreferences } from "./lib/preferences";
import { TooltipLayer } from "./components/Hint";

// Юридические документы нужны только на своих адресах: не тянем их в стартовый чанк
// приложения, но сохраняем обычную прямую ссылку и перезагрузку страницы.
const LegalScreen = lazy(() => import("./features/legal/LegalScreen").then(module => ({ default: module.LegalScreen })));
// Блог — тоже публичный раздел со своими адресами: он грузится отдельным чанком и не тянет
// в стартовый бандл ни список, ни тексты статей.
const BlogScreen = lazy(() => import("./features/blog/BlogScreen").then(module => ({ default: module.BlogScreen })));
// Страница о хостинге тоже открывается без входа и тянется отдельным чанком: в стартовом
// бандле она не нужна ни гостю, ни вошедшему пользователю.

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
  const blog = isBlogPath(window.location.pathname);
  return <div className="app">
    {blog
      ? <Suspense fallback={<div className="app-loading"><NestLoader size={48} label="Загружаем блог"/></div>}><BlogScreen/></Suspense>
      : legal
        ? <Suspense fallback={<div className="app-loading"><NestLoader size={48} label="Загружаем документы"/></div>}><LegalScreen/></Suspense>
        : <AuthGate/>}
    <CookieConsent/><TooltipLayer/>
  </div>;
}
export default App;
