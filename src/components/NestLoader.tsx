import { useId, type CSSProperties } from "react";

type NestLoaderProps = {
  size?: number;
  className?: string;
  label?: string;
};

const MARK_SRC = "/brand/nestdev-mark.png";
const VIEW = 128;
const CENTER = 64;
const SHARD_COUNT = 10;

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * Логотип живёт в круглом ассете. Делим его на радиальные сегменты — при сборке
 * каждый прилетает из своего сектора и поворачивается на месте, а при разборке
 * уходит обратно. Так плетёный силуэт не подменяется нарисованным гнездом:
 * это ровно тот же знак, что стоит в шапке и на главной.
 */
const shards = Array.from({ length: SHARD_COUNT }, (_, index) => {
  const step = (Math.PI * 2) / SHARD_COUNT;
  const start = -Math.PI / 2 + index * step;
  const end = start + step;
  const middle = start + step / 2;
  const radius = 110;
  const point = (angle: number) => [
    round(CENTER + Math.cos(angle) * radius),
    round(CENTER + Math.sin(angle) * radius),
  ];
  const [x1, y1] = point(start);
  const [x2, y2] = point(end);
  const distance = 18 + (index % 3) * 4;
  const rotations = [18, -14, 22, -20, 13, -23, 17, -11, 21, -17];
  return {
    path: `M${CENTER} ${CENTER}L${x1} ${y1}A${radius} ${radius} 0 0 1 ${x2} ${y2}Z`,
    dx: `${round(Math.cos(middle) * distance)}px`,
    dy: `${round(Math.sin(middle) * distance)}px`,
    r: `${rotations[index]}deg`,
    delay: `${(index * 0.035).toFixed(3)}s`,
  };
});

/**
 * Знак кода внутри того же квадрата, что и логотип: две угловые скобки и косая
 * черта между ними. После сборки знака логотип расходится, а `</>` прорисовывается
 * штрихами и снова уступает место логотипу.
 */
const codeStrokes = [
  { d: "M48 52 L34 64 L48 76", delay: 0 },
  { d: "M58 80 L70 48", delay: 0.08 },
  { d: "M80 52 L94 64 L80 76", delay: 0.16 },
];

/**
 * Загрузчик NestDev: сначала собирается настоящий фирменный знак из сегментов,
 * затем он расходится и в центре появляется `</>`. Две фигуры живут на одной
 * временной шкале, поэтому на стыке фаз нет мгновенной пустоты — только кроссфейд.
 */
export function NestLoader({ size = 42, className = "", label }: NestLoaderProps) {
  const id = useId().replace(/:/g, "");
  return (
    <span
      className={`nest-loader ${className}`}
      role={label ? "status" : undefined}
      aria-label={label}
      style={{ "--nest-size": `${size}px` } as CSSProperties}
    >
      <svg viewBox={`0 0 ${VIEW} ${VIEW}`} width={size} height={size} aria-hidden="true">
        <defs>
          <linearGradient id={`${id}-mark`} x1="20" y1="18" x2="108" y2="112" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#f3e7cd" />
            <stop offset=".34" stopColor="#c49e6d" />
            <stop offset=".7" stopColor="#dfc18e" />
            <stop offset="1" stopColor="#8a6442" />
          </linearGradient>
          <radialGradient id={`${id}-glow`}>
            <stop offset="0" stopColor="#e8d8b6" stopOpacity=".3" />
            <stop offset=".55" stopColor="#e8d8b6" stopOpacity=".09" />
            <stop offset="1" stopColor="#e8d8b6" stopOpacity="0" />
          </radialGradient>
          <mask
            id={`${id}-mark-mask`}
            maskUnits="userSpaceOnUse"
            x="0"
            y="0"
            width={VIEW}
            height={VIEW}
            style={{ maskType: "alpha" } as CSSProperties}
          >
            <image href={MARK_SRC} x="0" y="0" width={VIEW} height={VIEW} preserveAspectRatio="xMidYMid meet" />
          </mask>
          <g id={`${id}-mark-layer`}>
            <rect width={VIEW} height={VIEW} fill={`url(#${id}-mark)`} mask={`url(#${id}-mark-mask)`} />
          </g>
          {shards.map((shard, index) => (
            <clipPath id={`${id}-shard-${index}`} key={shard.path} clipPathUnits="userSpaceOnUse">
              <path d={shard.path} />
            </clipPath>
          ))}
        </defs>

        <g className="nest-loader__mark">
          {shards.map((shard, index) => (
            <g
              key={shard.path}
              className="nest-loader__piece"
              style={
                {
                  "--dx": shard.dx,
                  "--dy": shard.dy,
                  "--r": shard.r,
                  "--delay": shard.delay,
                } as CSSProperties
              }
            >
              <use href={`#${id}-mark-layer`} clipPath={`url(#${id}-shard-${index})`} />
            </g>
          ))}
        </g>

        <g className="nest-loader__code">
          <circle className="nest-loader__glow" cx={CENTER} cy={CENTER} r="46" fill={`url(#${id}-glow)`} />
          {codeStrokes.map((stroke, index) => (
            <path
              key={index}
              className="nest-loader__code-stroke"
              d={stroke.d}
              pathLength="1"
              stroke={`url(#${id}-mark)`}
              style={{ "--delay": `${stroke.delay}s` } as CSSProperties}
            />
          ))}
        </g>
      </svg>
    </span>
  );
}
