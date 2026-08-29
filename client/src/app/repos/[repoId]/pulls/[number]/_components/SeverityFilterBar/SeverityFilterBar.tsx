"use client";

import React from "react";
import { Icon } from "@devdigest/ui";
import type { CSSProperties } from "react";

const SEVERITIES = [
  { key: "CRITICAL", label: "Critical", icon: "AlertOctagon", color: "var(--crit)", bg: "var(--crit-bg)" },
  { key: "WARNING", label: "Warning", icon: "AlertTriangle", color: "var(--warn)", bg: "var(--warn-bg)" },
  { key: "SUGGESTION", label: "Suggestion", icon: "Lightbulb", color: "var(--sugg)", bg: "var(--sugg-bg)" },
] as const;

interface SeverityFilterBarProps {
  counts: { CRITICAL: number; WARNING: number; SUGGESTION: number };
  active: string | null;
  onToggle: (sev: string | null) => void;
}

export function SeverityFilterBar({ counts, active, onToggle }: SeverityFilterBarProps) {
  const visible = SEVERITIES.filter((s) => counts[s.key] > 0);
  if (visible.length === 0) return null;

  return (
    <div style={s.bar} role="group" aria-label="Filter by severity">
      {visible.map((sev) => {
        const isActive = active === sev.key;
        const IconComp = Icon[sev.icon as keyof typeof Icon] as React.FC<{ size: number; style?: CSSProperties }>;
        return (
          <button
            key={sev.key}
            aria-pressed={isActive}
            data-active={isActive ? "true" : undefined}
            onClick={() => onToggle(isActive ? null : sev.key)}
            style={s.pill(sev.color, sev.bg, isActive)}
          >
            <IconComp size={13} style={{ flexShrink: 0 }} />
            <span style={s.count}>{counts[sev.key]}</span>
            <span style={s.label}>{sev.label}</span>
          </button>
        );
      })}
    </div>
  );
}

const s = {
  bar: {
    display: "flex",
    gap: 8,
    flexWrap: "wrap",
    marginBottom: 12,
  } satisfies CSSProperties,

  pill: (color: string, bg: string, active: boolean): CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    padding: "4px 10px",
    borderRadius: 20,
    border: `1px solid ${active ? color : "var(--border)"}`,
    background: active ? bg : "transparent",
    color: active ? color : "var(--text-muted)",
    fontSize: 12,
    fontWeight: 500,
    cursor: "pointer",
    transition: "background .12s, color .12s, border-color .12s",
  }),

  count: {
    fontWeight: 700,
    fontVariantNumeric: "tabular-nums",
  } satisfies CSSProperties,

  label: {
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    fontSize: 11,
  } satisfies CSSProperties,
};
