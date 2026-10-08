import type { CSSProperties } from "react";

type NestLoaderProps = {
  size?: number;
  className?: string;
  label?: string;
};

const pieces = [
  { dx: "-11px", dy: "-10px", r: "-18deg", d: "M14 27 C18 15 28 10 40 12" },
  { dx: "0px", dy: "-14px", r: "7deg", d: "M22 36 C24 22 34 14 47 15" },
  { dx: "11px", dy: "-9px", r: "20deg", d: "M28 43 C38 31 48 29 58 35" },
  { dx: "14px", dy: "1px", r: "34deg", d: "M31 47 C43 42 53 47 58 58" },
  { dx: "10px", dy: "11px", r: "20deg", d: "M28 45 C38 55 48 59 57 55" },
  { dx: "0px", dy: "14px", r: "-6deg", d: "M42 44 C39 56 29 62 17 59" },
  { dx: "-11px", dy: "10px", r: "-24deg", d: "M37 40 C27 51 18 54 10 47" },
  { dx: "-14px", dy: "0px", r: "-38deg", d: "M35 34 C23 37 14 32 10 21" },
  { dx: "-7px", dy: "-6px", r: "9deg", d: "M20 24 C28 20 38 21 46 28" },
  { dx: "7px", dy: "6px", r: "-14deg", d: "M18 35 C28 43 40 45 50 40" },
];

export function NestLoader({ size = 42, className = "", label }: NestLoaderProps) {
  return (
    <span
      className={`nest-loader ${className}`}
      role={label ? "status" : undefined}
      aria-label={label}
      style={{ "--nest-size": `${size}px` } as CSSProperties}
    >
      <svg viewBox="0 0 68 68" width={size} height={size} aria-hidden="true">
        <defs>
          <linearGradient id="nest-stroke" x1="8" y1="8" x2="60" y2="60">
            <stop offset="0" stopColor="currentColor" stopOpacity=".98" />
            <stop offset=".52" stopColor="currentColor" stopOpacity=".72" />
            <stop offset="1" stopColor="currentColor" stopOpacity=".28" />
          </linearGradient>
          <filter id="nest-glow" x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="1.6" />
          </filter>
        </defs>

        <g className="nest-loader__glow" filter="url(#nest-glow)">
          {pieces.map((piece, index) => (
            <path
              key={`glow-${index}`}
              className="nest-loader__piece"
              d={piece.d}
              pathLength="1"
              style={{
                "--i": index,
                "--dx": piece.dx,
                "--dy": piece.dy,
                "--r": piece.r,
              } as CSSProperties}
            />
          ))}
        </g>

        <g className="nest-loader__body">
          {pieces.map((piece, index) => (
            <path
              key={index}
              className="nest-loader__piece"
              d={piece.d}
              pathLength="1"
              style={{
                "--i": index,
                "--dx": piece.dx,
                "--dy": piece.dy,
                "--r": piece.r,
              } as CSSProperties}
            />
          ))}
        </g>

        <circle className="nest-loader__core" cx="34" cy="36" r="5.5" />
        <circle className="nest-loader__core nest-loader__core--inner" cx="34" cy="36" r="2" />
      </svg>
    </span>
  );
}
