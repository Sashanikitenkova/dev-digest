import React from "react";
import { Icon } from "../icons";

/**
 * REAL controlled checkbox (styled).
 *
 * DELIBERATE EDIT to a vendored file — keep it through any resync (same
 * standing as the Conventions entry in `nav.ts`; see client/INSIGHTS.md).
 *
 * The `<label>` wrapper makes this button its LABELED CONTROL, so a click on
 * the button bubbles to the label and the label dispatches a SECOND, synthetic
 * click straight back to it. The handler then runs twice against two different
 * renders of `checked` — `onChange(false)` then `onChange(true)` — and the
 * toggle nets to zero: the box visibly refuses to change. The HTML spec says a
 * label must not do this when the click targets interactive content, but the
 * carve-out is applied inconsistently once the real target is a non-interactive
 * descendant (this button's check icon), so it reproduces on some Chrome builds
 * and not others — which is exactly how it survived a browser-driven test.
 *
 * `preventDefault()` is the fix: label forwarding is the click's DEFAULT
 * ACTION, so cancelling the event suppresses it. Harmless on `type="button"`,
 * which has no default action of its own. Clicking the label TEXT still works —
 * that click targets the label, forwards once, and arrives here as a single
 * event.
 */
export function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange?: (v: boolean) => void;
  label?: React.ReactNode;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        fontSize: 14,
        color: "var(--text-secondary)",
        cursor: "pointer",
      }}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        onClick={(e) => {
          // Cancels the wrapping label's synthetic re-dispatch. Without this
          // the handler runs twice and the toggle nets to zero.
          e.preventDefault();
          e.stopPropagation();
          onChange?.(!checked);
        }}
        style={{
          width: 16,
          height: 16,
          borderRadius: 4,
          border: "1.5px solid " + (checked ? "var(--accent)" : "var(--border-strong)"),
          background: checked ? "var(--accent)" : "transparent",
          display: "grid",
          placeItems: "center",
          padding: 0,
        }}
      >
        {/* `pointerEvents: none` keeps the BUTTON as the click target in both
            states. Decorative either way, and it removes the target variance
            that made the checked box behave differently from the empty one. */}
        {checked && <Icon.Check size={11} style={{ color: "#fff", pointerEvents: "none" }} />}
      </button>
      {label}
    </label>
  );
}
