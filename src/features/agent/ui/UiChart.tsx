import type { UiChartBlock } from "../../../lib/ui-blocks";

const COLORS = ["#cab898", "#8fb4c4", "#a99bc0", "#c49b8a"];
const WIDTH = 340;
const HEIGHT = 170;
const PAD = { left: 10, right: 10, top: 12, bottom: 34 };

export function UiChart({ block }: { block: UiChartBlock }) {
  const values = block.series.flatMap(series => series.values);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = max - min || 1;
  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const xAt = (index: number) => block.labels.length === 1
    ? PAD.left + plotW / 2
    : PAD.left + index * plotW / (block.labels.length - 1);
  const yAt = (value: number) => PAD.top + (1 - (value - min) / span) * plotH;
  const zeroY = yAt(0);
  const kind = block.kind ?? "bar";
  const barGroup = plotW / Math.max(1, block.labels.length);
  const barWidth = Math.max(2, barGroup * 0.72 / block.series.length);
  return <section className="ui-block ui-chart" aria-label={block.title}>
    <header className="ui-block-head">
      <strong>{block.title}</strong>
      {block.description && <p>{block.description}</p>}
    </header>
    <svg viewBox={"0 0 " + WIDTH + " " + HEIGHT} role="img" aria-label={block.title}>
      <title>{block.title}</title>
      <line x1={PAD.left} x2={WIDTH - PAD.right} y1={zeroY} y2={zeroY} className="ui-chart-axis"/>
      {kind === "bar"
        ? block.labels.map((label, labelIndex) => block.series.map((series, seriesIndex) => {
          const value = series.values[labelIndex] ?? 0;
          const x = PAD.left + labelIndex * barGroup + (barGroup - barWidth * block.series.length) / 2 + seriesIndex * barWidth;
          const y = yAt(value);
          const top = Math.min(y, zeroY);
          const height = Math.max(1, Math.abs(zeroY - y));
          return <rect key={label + series.label + seriesIndex} x={x} y={top} width={Math.max(1, barWidth - 2)} height={height} rx={2} fill={series.color ?? COLORS[seriesIndex % COLORS.length]}/>;
        }))
        : block.series.map((series, seriesIndex) => {
          const points = series.values.map((value, index) => xAt(index) + "," + yAt(value)).join(" ");
          return <g key={series.label + seriesIndex}>
            <polyline points={points} fill="none" stroke={series.color ?? COLORS[seriesIndex % COLORS.length]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"/>
            {series.values.map((value, index) => <circle key={index} cx={xAt(index)} cy={yAt(value)} r={2.5} fill={series.color ?? COLORS[seriesIndex % COLORS.length]}><title>{block.labels[index] + ": " + value + (block.valueSuffix ?? "")}</title></circle>)}
          </g>;
        })}
      {block.labels.map((label, index) => {
        const x = kind === "bar" ? PAD.left + index * barGroup + barGroup / 2 : xAt(index);
        return <text key={label + index} x={x} y={HEIGHT - 12} textAnchor="middle" className="ui-chart-label">{label.length > 12 ? label.slice(0, 11) + "…" : label}</text>;
      })}
    </svg>
    <div className="ui-chart-legend">
      {block.series.map((series, index) => <span key={series.label + index}>
        <i style={{ background: series.color ?? COLORS[index % COLORS.length] }}/>
        {series.label}
      </span>)}
      {block.valueSuffix && <em>Значения: {block.valueSuffix}</em>}
    </div>
  </section>;
}
