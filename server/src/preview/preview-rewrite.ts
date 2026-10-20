/**
 * A preview is proxied under /api/projects/<id>/preview/open/, so a root-absolute URL in
 * the served app (/assets/app.js, /@vite/client, /_next/static/...) asks the NestDev
 * origin instead of the app and the page breaks inside the frame. The rewrite maps exactly
 * those URLs to the proxy prefix: HTML attributes, CSS url()/@import and JavaScript module
 * specifiers. Application routing paths ("/about" in a router config) are left alone on
 * purpose — only specifiers are rewritten, because rewriting every string breaks routers.
 */
export function previewProxyBase(projectId:string){
  return "/api/projects/"+encodeURIComponent(projectId)+"/preview/open/";
}

export function canRewritePreviewBody(contentType:string|undefined){
  const type=(contentType??"").toLowerCase();
  return type.includes("text/html")||type.includes("text/css")||type.includes("javascript")||type.includes("application/json");
}

export function rewritePreviewBody(body:string,base:string,contentType:string|undefined){
  const type=(contentType??"").toLowerCase();
  if(type.includes("text/html"))return rewritePreviewHtml(body,base);
  if(type.includes("text/css"))return rewritePreviewCss(body,base);
  if(type.includes("javascript")||type.includes("application/json"))return rewritePreviewJavaScript(body,base);
  return body;
}

/** `/assets/a.js` -> `<base>assets/a.js`; `//cdn/x` and an already rewritten value stay as they are. */
function rewriteUrl(value:string,base:string){
  if(!value.startsWith("/")||value.startsWith("//")||value.startsWith(base))return value;
  return base+value.slice(1);
}

export function rewritePreviewHtml(html:string,base:string){
  return html.replace(
    /(\s(?:src|href|poster|action|data-src)\s*=\s*)(["'])(\/[^"']*)\2/gi,
    (match,prefix:string,quote:string,value:string)=>prefix+quote+rewriteUrl(value,base)+quote,
  );
}

export function rewritePreviewCss(css:string,base:string){
  const withUrls=css.replace(
    /url\(\s*(["']?)(\/[^"')\s]*)\1\s*\)/gi,
    (match,quote:string,value:string)=>"url("+quote+rewriteUrl(value,base)+quote+")",
  );
  return withUrls.replace(
    /@import\s+(["'])(\/[^"']*)\1/gi,
    (match,quote:string,value:string)=>"@import "+quote+rewriteUrl(value,base)+quote,
  );
}

export function rewritePreviewJavaScript(code:string,base:string){
  return code.replace(
    /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\/[^"']*)\2/g,
    (match,prefix:string,quote:string,value:string)=>prefix+quote+rewriteUrl(value,base)+quote,
  );
}
