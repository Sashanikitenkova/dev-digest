import type {
  MemoryPulled,
  PromptAssembly,
  RunLogLine,
  RunStats,
  RunTrace,
  SpecRead,
  ToolCall,
} from '@devdigest/shared';
import { RunTrace as RunTraceSchema } from '@devdigest/shared';

/**
 * A5 — shared run-trace builder. A2's single-agent reviewer and A5's
 * multi-agent / built-in-detector runs all assemble the SAME single-document
 * RunTrace through this helper, so the enriched shape (full stats +
 * prompt_assembly + tool_calls + memory_pulled + specs_read + raw_output +
 * full log) is consistent and Zod-validated before it is persisted as ONE
 * document in `run_traces`.
 */
export interface BuildTraceInput {
  config: {
    agent: string;
    version?: string | null;
    provider?: string | null;
    model: string;
    pr?: number | null;
    source?: 'local' | 'ci';
  };
  stats: RunStats;
  promptAssembly: PromptAssembly;
  toolCalls: ToolCall[];
  rawOutput: string;
  memoryPulled: MemoryPulled[];
  /** Paths of the project-context documents that were USED (SPEC-01). */
  specsRead: string[];
  /**
   * The full read ledger, misses included. Optional so the pre-SPEC-01 callers
   * of this builder keep compiling; omitted → the key is null in the trace and
   * the drawer falls back to `specsRead` alone.
   *
   * NOTE: the studio review path does NOT come through here — `ReviewRunExecutor`
   * hand-builds its RunTrace literals. This keeps the A5 / CI builder in step
   * with the contract; it is not what wires the studio trace.
   */
  specsDetail?: SpecRead[];
  /** Approximate total tokens contributed by the used documents. */
  specsTokens?: number;
  log: RunLogLine[];
}

export function buildRunTrace(input: BuildTraceInput): RunTrace {
  const trace: RunTrace = {
    config: {
      agent: input.config.agent,
      version: input.config.version ?? null,
      provider: input.config.provider ?? null,
      model: input.config.model,
      pr: input.config.pr ?? null,
      source: input.config.source ?? 'local',
    },
    stats: input.stats,
    prompt_assembly: input.promptAssembly,
    tool_calls: input.toolCalls,
    raw_output: input.rawOutput,
    memory_pulled: input.memoryPulled,
    specs_read: input.specsRead,
    specs_detail: input.specsDetail ?? null,
    specs_tokens: input.specsTokens ?? null,
    log: input.log,
  };
  // Validate so a malformed trace fails loudly at write-time, not read-time.
  return RunTraceSchema.parse(trace);
}

/** An empty prompt-assembly for detectors that don't call an LLM. */
export function emptyPromptAssembly(system: string, user: string): PromptAssembly {
  return { system, skills: null, memory: null, specs: null, user };
}
