import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Finding, UnifiedDiff } from '@devdigest/shared';
import { assemblePrompt } from '../prompt.js';
import { OpenRouterProvider } from '../llm/openrouter.js';

const SUMMARY_MODEL = 'anthropic/claude-3.5-haiku';

const SummaryPayload = z.object({
  headline: z.string(),
  findings: z.array(z.custom<Finding>()),
});

export interface SummarizeInput {
  /** Agent system prompt (trusted). */
  systemPrompt: string;
  /** The PR's unified diff (already parsed; hunks carry new-side line numbers). */
  diff: UnifiedDiff;
  /** Absolute paths of the skill files this agent has enabled. */
  skillPaths?: string[];
  /** Task framing line, e.g. "Summarise PR #482 …". */
  task?: string;
}

export interface SummarizeOutcome {
  headline: string;
  findings: Finding[];
  model: string;
}

/**
 * Second-pass summariser.
 *
 * The review pass answers "what is wrong here"; this pass answers "what should
 * a reader know first". It re-reads the same diff and returns a single headline
 * plus the findings worth surfacing above the fold on the PR page.
 */
export async function summarizeReview(input: SummarizeInput): Promise<SummarizeOutcome> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY is not configured');
  const llm = new OpenRouterProvider(key, { timeoutMs: 60_000 });

  const skills: string[] = [];
  for (const path of input.skillPaths ?? []) {
    skills.push(await readFile(path, 'utf8'));
  }

  const prompt = assemblePrompt({
    systemPrompt: input.systemPrompt,
    diff: input.diff,
    skills,
    task: input.task,
  });

  const result = await llm.completeStructured({
    model: SUMMARY_MODEL,
    system: prompt.system,
    user: prompt.user,
    schema: SummaryPayload,
  });

  return {
    headline: result.data.headline,
    findings: result.data.findings,
    model: SUMMARY_MODEL,
  };
}
