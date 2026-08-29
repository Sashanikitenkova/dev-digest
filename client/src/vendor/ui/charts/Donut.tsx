/* Donut — ring chart with a legend, on Recharts.

   `valuePrefix`/`decimals` default to the cost shape ("$12.00") this was first
   written for. Counts pass decimals={0} and an empty prefix — a findings tally
   rendered as "52.00" reads as money that isn't there. Defaults are unchanged,
   so every existing caller behaves exactly as before. */
import React from "react";
import { PieChart, Pie, Cell } from "recharts";

export interface DonutSegment {
  label: string;
  value: number;
  color: string;
}

export function Donut({
  segments,
  size = 130,
  stroke = 22,
  valuePrefix = "$",
  decimals = 2,
}: {
  segments: DonutSegment[];
  size?: number;
  stroke?: number;
  valuePrefix?: string;
  decimals?: number;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
      <PieChart width={size} height={size}>
        <Pie
          data={segments}
          dataKey="value"
          nameKey="label"
          cx="50%"
          cy="50%"
          innerRadius={(size - stroke) / 2 - stroke / 2}
          outerRadius={(size - stroke) / 2 + stroke / 2}
          startAngle={90}
          endAngle={-270}
          isAnimationActive={false}
          stroke="none"
        >
          {segments.map((s, i) => (
            <Cell key={i} fill={s.color} />
          ))}
        </Pie>
      </PieChart>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {segments.map((s, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
            <span style={{ width: 9, height: 9, borderRadius: 2, background: s.color }} />
            <span style={{ color: "var(--text-secondary)", flex: 1 }}>{s.label}</span>
            <span className="mono tnum" style={{ color: "var(--text-primary)", fontWeight: 600 }}>
              {valuePrefix}
              {s.value.toFixed(decimals)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
