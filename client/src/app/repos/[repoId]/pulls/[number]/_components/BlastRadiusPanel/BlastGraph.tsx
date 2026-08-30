/* BLAST GRAPH — the same facts as the tree, laid out as a node-link diagram.

   Hand-rolled SVG rather than a graph library: the layout is not a general
   graph problem. It is always exactly three ordered columns (changed symbol →
   callers → endpoints), so the "layout algorithm" is two divisions, and a
   dependency would cost more bytes than the whole component.

   Nothing here derives an edge. Every line drawn corresponds to a relation the
   server already asserted from the index. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import type { DownstreamImpact } from "@devdigest/shared";
import { g } from "./styles";

const NODE_W = 148;
const NODE_H = 26;
const ROW_GAP = 12;
const COL_GAP = 90;
/** Past this many rows a column stops being readable, so the tail collapses. */
const MAX_ROWS = 7;

interface Node {
  id: string;
  label: string;
  col: number;
  x: number;
  y: number;
}

/** Evenly distribute `count` rows in a column, centred on the tallest column. */
function yFor(index: number, count: number, tallest: number): number {
  const colHeight = count * NODE_H + (count - 1) * ROW_GAP;
  const fullHeight = tallest * NODE_H + (tallest - 1) * ROW_GAP;
  return (fullHeight - colHeight) / 2 + index * (NODE_H + ROW_GAP);
}

/** `more` formats the collapsed tail's label — passed in so this stays pure. */
function truncate(list: string[], more: (count: number) => string): string[] {
  if (list.length <= MAX_ROWS) return list;
  return [...list.slice(0, MAX_ROWS - 1), more(list.length - MAX_ROWS + 1)];
}

export function BlastGraph({ downstream }: { downstream: DownstreamImpact[] }) {
  const t = useTranslations("blast");

  const more = React.useCallback(
    (count: number) => t("graph.more", { count }),
    [t],
  );

  const { nodes, edges, width, height } = React.useMemo(() => {
    const symbols = downstream.map((d) => `${d.symbol}()`);
    // A caller file can call two changed symbols; it is one node either way.
    const callers = truncate(
      [...new Set(downstream.flatMap((d) => d.callers.map((c) => c.name)))],
      more,
    );
    // Only DIRECT impact is graphed. A 2-hop endpoint is true but reaches the
    // node through a module the graph does not draw, so an edge to it would
    // imply a relationship the picture cannot actually show.
    const endpoints = truncate(
      [
        ...new Set(
          downstream.flatMap((d) =>
            [...d.endpoints_affected, ...d.crons_affected]
              .filter((e) => e.depth <= 1)
              .map((e) => e.endpoint),
          ),
        ),
      ],
      more,
    );

    const cols = [symbols, callers, endpoints];
    const tallest = Math.max(...cols.map((c) => c.length), 1);

    const nodes: Node[] = [];
    cols.forEach((col, ci) => {
      col.forEach((label, ri) => {
        nodes.push({
          id: `${ci}:${label}`,
          label,
          col: ci,
          x: ci * (NODE_W + COL_GAP),
          y: yFor(ri, col.length, tallest),
        });
      });
    });

    const byId = new Map(nodes.map((n) => [n.id, n]));
    const edges: [Node, Node][] = [];
    for (const d of downstream) {
      const from = byId.get(`0:${d.symbol}()`);
      if (!from) continue;
      for (const c of d.callers) {
        const mid = byId.get(`1:${c.name}`);
        if (!mid) continue; // collapsed into "+N more"
        edges.push([from, mid]);
        for (const e of [...d.endpoints_affected, ...d.crons_affected]) {
          const to = byId.get(`2:${e.endpoint}`);
          if (to) edges.push([mid, to]);
        }
      }
    }

    return {
      nodes,
      edges,
      width: cols.length * NODE_W + (cols.length - 1) * COL_GAP,
      height: tallest * NODE_H + (tallest - 1) * ROW_GAP,
    };
  }, [downstream, more]);

  if (nodes.length === 0) return <p style={g.empty}>{t("graph.empty")}</p>;

  return (
    <div style={g.scroll}>
      <svg
        role="img"
        aria-label={t("graph.ariaLabel")}
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        style={g.svg}
      >
        {edges.map(([a, b], i) => {
          const x1 = a.x + NODE_W;
          const y1 = a.y + NODE_H / 2;
          const y2 = b.y + NODE_H / 2;
          const dx = (b.x - x1) / 2;
          return (
            <path
              key={i}
              d={`M ${x1} ${y1} C ${x1 + dx} ${y1}, ${b.x - dx} ${y2}, ${b.x} ${y2}`}
              fill="none"
              stroke="var(--border)"
              strokeWidth={1}
            />
          );
        })}
        {nodes.map((n) => (
          <g key={n.id}>
            <rect
              x={n.x}
              y={n.y}
              width={NODE_W}
              height={NODE_H}
              rx={5}
              fill="var(--bg-elevated)"
              stroke={n.col === 1 ? "var(--border)" : "var(--accent-text, #6ea8fe)"}
            />
            <text
              x={n.x + NODE_W / 2}
              y={n.y + NODE_H / 2}
              textAnchor="middle"
              dominantBaseline="central"
              style={g.nodeText}
            >
              {n.label.length > 20 ? `${n.label.slice(0, 19)}…` : n.label}
            </text>
          </g>
        ))}
      </svg>

      <div style={g.legend}>
        <span style={g.legendItem}>
          <span style={g.dot("var(--accent-text, #6ea8fe)")} />
          {t("graph.legend.symbol")}
        </span>
        <span style={g.legendItem}>
          <span style={g.dot("var(--border)")} />
          {t("graph.legend.callers")}
        </span>
        <span style={g.legendItem}>
          <span style={g.dot("var(--accent-text, #6ea8fe)")} />
          {t("graph.legend.endpoints")}
        </span>
      </div>
    </div>
  );
}
