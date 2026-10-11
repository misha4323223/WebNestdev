import { useState } from "react";

/**
 * Product mark. It renders the repository logo asset (public/brand/nestdev-mark.png,
 * built from docs/7277-removebg-preview.png) and falls back to the drawn woven-nest
 * mark if that file is missing, so an unbuilt asset never shows a broken image.
 *
 * The artwork is dark on a transparent background, so small surfaces place it on a light
 * plate (see .brand-mark and .rail-brand-mark in styles.css). On the dark home hero the
 * light variant is used instead, so no plate is needed there.
 */
export function WebNestLogo({size=32,className,tone="brand"}:{size?:number;className?:string;tone?:"brand"|"light"}){
  const [missing,setMissing]=useState(false);
  if(missing)return <svg className={className} width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <path d="M11 30C21 25 43 25 53 30" stroke="currentColor" strokeWidth="2.9" strokeLinecap="round" opacity=".5"/>
    <g stroke="currentColor" strokeWidth="2.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 33C13 44 21 50 32 50C43 50 51 44 51 33"/>
      <path d="M12 32C10.5 39 13 45 18 49"/>
      <path d="M52 32C53.5 39 51 45 46 49"/>
      <path d="M17 38C25 44 39 44 47 38"/>
      <path d="M21 32C23 38 26 42 30 45"/>
      <path d="M43 32C41 38 38 42 34 45"/>
    </g>
    <g fill="currentColor" fillOpacity=".16" stroke="currentColor" strokeWidth="2.9" strokeLinecap="round">
      <ellipse cx="26.4" cy="26.4" rx="4.9" ry="6.1"/>
      <ellipse cx="37.6" cy="26" rx="4.7" ry="5.9"/>
    </g>
    <path d="M11 30C18 36 46 36 53 30" stroke="currentColor" strokeWidth="2.9" strokeLinecap="round"/>
  </svg>;
  const src=tone==="light"?"/brand/nestdev-mark-light.png":"/brand/nestdev-mark.png";
  return <img className={className} src={src} width={size} height={size} alt="" draggable={false} onError={()=>setMissing(true)}/>;
}
