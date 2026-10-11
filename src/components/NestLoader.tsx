import { type CSSProperties } from "react";

type NestLoaderProps = {
  size?: number;
  className?: string;
  label?: string;
};

type Twig = { kind: "twig"; d: string; dx: string; dy: string; r: string; delay: string };
type Egg = { kind: "egg"; cx: number; cy: number; rx: number; ry: number; dx: string; dy: string; r: string; delay: string };

/**
 * A woven nest: the twigs of the bowl weave themselves together, two eggs settle
 * in the middle and the front rim closes over them. Then it comes apart again,
 * so the icon visibly assembles and disassembles.
 *
 * Pieces are listed in painting order: back rim, bowl, weave, eggs, front rim.
 */
const pieces: Array<Twig | Egg> = [
  // Back rim of the bowl (behind the eggs).
  { kind: "twig", d: "M11 30C21 25 43 25 53 30", dx: "0px", dy: "-13px", r: "0deg", delay: "0s" },
  // Bowl and its woven twigs. The centre stays open so the eggs are readable.
  { kind: "twig", d: "M13 33C13 44 21 50 32 50C43 50 51 44 51 33", dx: "0px", dy: "13px", r: "0deg", delay: ".06s" },
  { kind: "twig", d: "M12 32C10.5 39 13 45 18 49", dx: "-16px", dy: "2px", r: "-10deg", delay: ".12s" },
  { kind: "twig", d: "M52 32C53.5 39 51 45 46 49", dx: "16px", dy: "2px", r: "10deg", delay: ".18s" },
  { kind: "twig", d: "M17 38C25 44 39 44 47 38", dx: "-13px", dy: "8px", r: "-12deg", delay: ".24s" },
  { kind: "twig", d: "M21 32C23 38 26 42 30 45", dx: "-11px", dy: "-6px", r: "-14deg", delay: ".30s" },
  { kind: "twig", d: "M43 32C41 38 38 42 34 45", dx: "11px", dy: "-6px", r: "14deg", delay: ".36s" },
  // Eggs resting inside the bowl.
  { kind: "egg", cx: 26.4, cy: 26.4, rx: 4.9, ry: 6.1, dx: "-7px", dy: "-15px", r: "-7deg", delay: ".46s" },
  { kind: "egg", cx: 37.6, cy: 26, rx: 4.7, ry: 5.9, dx: "7px", dy: "-15px", r: "7deg", delay: ".52s" },
  // Front rim, woven last so it closes over the eggs.
  { kind: "twig", d: "M11 30C18 36 46 36 53 30", dx: "0px", dy: "9px", r: "0deg", delay: ".58s" },
];

export function NestLoader({ size = 42, className = "", label }: NestLoaderProps) {
  const renderPiece = (piece: Twig | Egg, key: string) => {
    const style = {
      "--dx": piece.dx,
      "--dy": piece.dy,
      "--r": piece.r,
      "--nest-delay": piece.delay,
    } as CSSProperties;
    return piece.kind === "twig"
      ? <path key={key} className="nest-loader__piece" d={piece.d} style={style} />
      : <ellipse key={key} className="nest-loader__piece nest-loader__egg" cx={piece.cx} cy={piece.cy} rx={piece.rx} ry={piece.ry} style={style} />;
  };
  return (
    <span
      className={`nest-loader ${className}`}
      role={label ? "status" : undefined}
      aria-label={label}
      style={{ "--nest-size": `${size}px` } as CSSProperties}
    >
      <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
        <g className="nest-loader__body">
          {pieces.map((piece, index) => renderPiece(piece, `piece-${index}`))}
        </g>
      </svg>
    </span>
  );
}
