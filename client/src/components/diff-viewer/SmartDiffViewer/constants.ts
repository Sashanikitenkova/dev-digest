import type { SmartDiffRole } from "@devdigest/shared";

/** Reading order: business logic first, generated output last. */
export const ROLE_ORDER: readonly SmartDiffRole[] = ["core", "wiring", "boilerplate"];

/**
 * Per-group presentation. `collapsed` is the group's INITIAL state — boilerplate
 * starts shut because the whole point of the feature is that nobody should have
 * to scroll past a lockfile to reach the logic.
 */
export const ROLE_META: Record<
  SmartDiffRole,
  { labelKey: string; blurbKey: string; color: string; collapsed: boolean }
> = {
  core: {
    labelKey: "smartDiff.coreLabel",
    blurbKey: "smartDiff.coreBlurb",
    color: "var(--accent)",
    collapsed: false,
  },
  wiring: {
    labelKey: "smartDiff.wiringLabel",
    blurbKey: "smartDiff.wiringBlurb",
    color: "var(--warn)",
    collapsed: false,
  },
  boilerplate: {
    labelKey: "smartDiff.boilerplateLabel",
    blurbKey: "smartDiff.boilerplateBlurb",
    color: "var(--text-muted)",
    collapsed: true,
  },
};
