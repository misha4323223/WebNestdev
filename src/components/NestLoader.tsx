import { useId, type CSSProperties } from "react";

type NestLoaderProps = {
  size?: number;
  className?: string;
  label?: string;
};

const strands = [
  { d: "M14 29 C21 17 34 15 44 16 C56 16 68 20 74 29 C66 38 22 39 14 29Z", dx: -10, dy: -9, r: -16 },
  { d: "M17 27 C28 32 59 34 71 27", dx: 0, dy: -13, r: 7 },
  { d: "M17 31 C28 37 59 38 71 31", dx: 11, dy: -8, r: 18 },
  { d: "M20 36 C31 42 56 43 68 36", dx: 14, dy: 0, r: 28 },
  { d: "M24 42 C34 47 53 48 64 42", dx: 10, dy: 10, r: 18 },
  { d: "M31 48 C38 52 50 52 57 48", dx: 0, dy: 13, r: -6 },
  { d: "M20 22 C25 29 28 39 35 48", dx: -12, dy: 9, r: -22 },
  { d: "M28 18 C33 29 37 41 42 52", dx: -13, dy: 1, r: -14 },
  { d: "M39 17 C42 28 46 41 49 52", dx: -6, dy: -8, r: 8 },
  { d: "M51 19 C53 29 56 39 59 46", dx: 7, dy: -7, r: 14 },
  { d: "M63 23 C61 30 63 36 67 40", dx: 12, dy: 3, r: 25 },
  { d: "M24 25 C34 22 53 23 64 28", dx: -7, dy: -5, r: -8 },
];

export function NestLoader({ size = 42, className = "", label }: NestLoaderProps) {
  const id = useId().replace(/:/g, "");
  return (
    <span
      className={`nest-loader ${className}`}
      role={label ? "status" : undefined}
      aria-label={label}
      style={{ "--nest-size": `${size}px` } as CSSProperties}
    >
      <svg viewBox="0 0 88 68" width={size} height={size} aria-hidden="true">
        <defs>
          <linearGradient id={`${id}-twig`} x1="14" y1="18" x2="72" y2="53" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#ead6ad" />
            <stop offset=".34" stopColor="#b99060" />
            <stop offset=".68" stopColor="#dfc18e" />
            <stop offset="1" stopColor="#8a6442" />
          </linearGradient>
          <linearGradient id={`${id}-egg`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#fff4d8" />
            <stop offset="1" stopColor="#c8b28b" />
          </linearGradient>
        </defs>

        <ellipse className="nest-loader__shadow" cx="44" cy="54" rx="22" ry="3.4" />

        <g className="nest-loader__eggs">
          <ellipse cx="40.5" cy="28.2" rx="4.1" ry="5.5" transform="rotate(-15 40.5 28.2)" fill={`url(#${id}-egg)`} />
          <ellipse cx="48.3" cy="29.1" rx="3.8" ry="5.1" transform="rotate(13 48.3 29.1)" fill={`url(#${id}-egg)`} />
        </g>

        <g className="nest-loader__strands">
          {strands.map((strand, index) => (
            <path
              key={index}
              className="nest-loader__strand"
              d={strand.d}
              pathLength="1"
              stroke={`url(#${id}-twig)`}
              style={{
                "--dx": `${strand.dx}px`,
                "--dy": `${strand.dy}px`,
                "--r": `${strand.r}deg`,
                "--delay": `${index * -0.075}s`,
              } as CSSProperties}
            />
          ))}
        </g>
      </svg>
    </span>
  );
}
