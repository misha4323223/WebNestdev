import type { SVGProps } from "react";

export function WebNestLogo({size=32,className}:{size?:number;className?:string}){
  return <svg className={className} width={size} height={size} viewBox="0 0 64 64" fill="none" aria-label="WebNestdev logo" role="img">
    <defs>
      <linearGradient id="nest-blue" x1="9" y1="10" x2="55" y2="55" gradientUnits="userSpaceOnUse">
        <stop stopColor="#66717f"/><stop offset=".55" stopColor="#252c36"/><stop offset="1" stopColor="#11151b"/>
      </linearGradient>
    </defs>
    <g stroke="url(#nest-blue)" strokeWidth="3.2" strokeLinecap="round">
      <path d="M10 25C16 12 31 7 44 12C51 15 55 20 56 26"/>
      <path d="M8 34C11 20 24 13 38 15C50 17 56 26 55 36"/>
      <path d="M11 42C10 30 19 20 31 19C45 18 54 27 53 40"/>
      <path d="M17 50C11 40 15 28 26 24C38 20 51 27 54 39"/>
      <path d="M27 55C17 51 15 41 21 33C28 24 42 25 50 34"/>
      <path d="M38 55C27 57 20 50 22 41C24 31 35 27 45 32"/>
      <path d="M49 48C43 56 32 57 26 51C20 45 23 35 31 31"/>
    </g>
    <g stroke="#151a21" strokeWidth="5.5" strokeLinecap="round" opacity=".96">
      <path d="M9 37C18 46 31 49 45 44"/>
      <path d="M18 18C28 24 39 25 50 19"/>
    </g>
    <g stroke="#f2f4f6" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M28 29L22 34L28 39"/>
      <path d="M36 29L42 34L36 39"/>
      <path d="M34 27L30 41"/>
    </g>
  </svg>;
}
