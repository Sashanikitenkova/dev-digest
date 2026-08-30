/**
 * Shared contract types re-exported from @devdigest/shared (single source of
 * truth). F2 imports these rather than redefining them.
 *
 * F1 (@devdigest/shared) currently exports all the platform/findings/brief/
 * knowledge/trace contracts we need for the scaffolding screens, so there are
 * NO local placeholders required at this time. If a feature agent's contract is
 * not yet exported, add a placeholder below marked
 * `// TODO: reconcile with @devdigest/shared`.
 */
export type {
  Settings,
  SettingsUpdate,
  ConnTestProvider,
  ConnTestResult,
  SecretsStatus,
  FeatureModelId,
  FeatureModelChoice,
  FeatureModelDef,
  Provider,
  ModelInfo,
  Repo,
  RepoInput,
  PrMeta,
  PrDetail,
  PrFile,
  PrCommit,
  PrReviewComment,
  PrStatus,
  SpecFile,
  SpecFileContent,
  ContextListing,
  IndexStatus,
} from "@devdigest/shared";

export type { Review, Finding, Severity, Verdict } from "@devdigest/shared";
export type { PrBrief, SmartDiff } from "@devdigest/shared";
export type {
  Intent,
  IntentSource,
  IntentSourceKind,
  IntentSourceStatus,
  IntentConfidence,
  PrIntentRecord,
} from "@devdigest/shared";

/* The Why + Risk brief. TYPES ONLY, like everything else in this file: the
   contracts are Zod objects, and importing one as a VALUE would pull the whole
   `@devdigest/shared` barrel (and zod) into the browser bundle. */
export type {
  PrRiskBriefRecord,
  RiskBriefLevel,
  RiskBriefRiskItem,
  RiskBriefFocusItem,
  RiskBriefReference,
  RiskBriefCounts,
  RiskBriefInputEntry,
} from "@devdigest/shared";

/** UI-only view model for a PR list row (derives display fields from PrMeta). */
export interface PrRowView {
  number: number;
  title: string;
  author: string;
  size: "S" | "M" | "L";
  sizeLines: string;
  score: number;
  findings: { CRITICAL: number; WARNING: number; SUGGESTION: number };
  status: "needs_review" | "reviewed" | "stale";
  updated: string;
}
