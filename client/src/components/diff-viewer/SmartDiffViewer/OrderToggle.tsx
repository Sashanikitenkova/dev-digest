/* OrderToggle — "Smart order | Original order" segmented control for the Files
   changed tab. Local to this folder: @devdigest/ui has no segmented primitive
   and vendored UI is do-not-touch. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { sd } from "./styles";

export type DiffOrder = "smart" | "original";

export function OrderToggle({
  order,
  onChange,
}: {
  order: DiffOrder;
  onChange: (order: DiffOrder) => void;
}) {
  const t = useTranslations("prReview");
  const options: { key: DiffOrder; label: string }[] = [
    { key: "smart", label: t("smartDiff.smartOrder") },
    { key: "original", label: t("smartDiff.originalOrder") },
  ];
  return (
    <div style={sd.toggle} role="group" aria-label={t("smartDiff.orderLabel")}>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          aria-pressed={order === o.key}
          onClick={() => onChange(o.key)}
          style={sd.toggleBtn(order === o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
