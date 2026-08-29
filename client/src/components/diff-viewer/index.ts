/* diff-viewer — unified-diff viewer with optional inline GitHub comments, plus
   the Smart Diff (reviewer-ordered) variant.
   Public surface: the two viewer components + the DiffCommentApi contract. */
export { DiffViewer } from "./DiffViewer";
export { SmartDiffViewer, OrderToggle, type DiffOrder } from "./SmartDiffViewer";
export { findingsByPath } from "./findings";
export type { DiffCommentApi } from "./comments";
