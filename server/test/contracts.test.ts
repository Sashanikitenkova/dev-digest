import { describe, it, expect } from 'vitest';
import {
  Review,
  Finding,
  Intent,
  BlastRadius,
  Risks,
  PrHistory,
  SmartDiff,
  Conformance,
  Onboarding,
  EvalRun,
  MemoryItem,
  RunTrace,
  Settings,
  Repo,
  PrDetail,
  PrBrief,
  Risk,
  PrRiskBriefRecord,
  RiskBriefReference,
} from '@devdigest/shared';

/**
 * Contract tests — parse/round-trip the fixtures from data.jsx/data2.jsx
 * so feature agents can rely on the schemas matching the prototype data.
 */
describe('AI contracts parse fixtures', () => {
  it('Review + Finding (data.jsx VERDICT/FINDINGS)', () => {
    const review = Review.parse({
      verdict: 'request_changes',
      summary: 'Two blockers before merge.',
      score: 61,
      findings: [
        {
          id: 'f1',
          severity: 'CRITICAL',
          category: 'security',
          title: 'Hardcoded Stripe secret key in commit',
          file: 'src/config.ts',
          start_line: 12,
          end_line: 12,
          rationale: 'Line 12 contains a literal `sk_live_` Stripe key.',
          suggestion: 'Move to env and rotate.',
          confidence: 0.98,
          kind: 'secret_leak',
        },
      ],
    });
    expect(review.findings).toHaveLength(1);
    expect(review.score).toBe(61);
  });

  it('lethal-trifecta Finding variant', () => {
    const f = Finding.parse({
      id: 'f2',
      severity: 'CRITICAL',
      category: 'security',
      title: 'Lethal trifecta',
      file: 'src/api/public/webhooks.ts',
      start_line: 61,
      end_line: 74,
      rationale: 'all three legs present',
      confidence: 0.79,
      kind: 'lethal_trifecta',
      trifecta_components: ['private_data_access', 'untrusted_input', 'exfil_path'],
      evidence: [{ component: 'untrusted_input', file: 'src/api/public/webhooks.ts', line: 61 }],
    });
    expect(f.trifecta_components).toContain('exfil_path');
  });

  it('Intent / BlastRadius / Risks / PrHistory', () => {
    expect(() =>
      Intent.parse({ intent: 'x', in_scope: ['a'], out_of_scope: ['b'] }),
    ).not.toThrow();
    expect(() =>
      BlastRadius.parse({
        index: { status: 'full', files_indexed: 12, last_indexed_sha: 'abc123' },
        changed_symbols: [{ name: 'rateLimit', file: 'a.ts', kind: 'function' }],
        downstream: [
          {
            symbol: 'rateLimit',
            callers: [{ name: 'publicRouter', file: 'b.ts', line: 23 }],
            endpoints_affected: [{ endpoint: 'GET /x', depth: 1 }],
            crons_affected: [{ endpoint: 'c', depth: 2 }],
          },
        ],
        summary: 's',
      }),
    ).not.toThrow();
    expect(() =>
      Risks.parse({
        risks: [{ kind: 'security', title: 't', explanation: 'e', severity: 'high', file_refs: [] }],
      }),
    ).not.toThrow();
    expect(() =>
      PrHistory.parse({
        history: [
          {
            pr_number: 401,
            title: 't',
            merged_at: '2026-03-18',
            author: 'a',
            files_overlap: [],
            notes: 'n',
          },
        ],
      }),
    ).not.toThrow();
  });

  it('SmartDiff (data.jsx DIFF)', () => {
    const d = SmartDiff.parse({
      groups: [
        {
          role: 'core',
          files: [{ path: 'a.ts', additions: 84, deletions: 0, finding_lines: [28, 52] }],
        },
      ],
      split_suggestion: { too_big: false, total_lines: 285, proposed_splits: [] },
    });
    expect(d.groups[0]!.role).toBe('core');
  });

  it('Conformance / Onboarding / EvalRun / MemoryItem', () => {
    expect(() =>
      Conformance.parse({
        spec_id: 's1',
        spec_title: 'Spec',
        items: [{ requirement: 'r', status: 'implemented' }],
        completeness_pct: 80,
      }),
    ).not.toThrow();
    expect(() =>
      Onboarding.parse({
        sections: [{ kind: 'architecture', title: 'T', body: 'b', links: [] }],
      }),
    ).not.toThrow();
    expect(() =>
      EvalRun.parse({
        recall: 0.82,
        precision: 0.91,
        citation_accuracy: 0.95,
        traces_passed: 17,
        traces_total: 20,
        duration_ms: 12000,
        cost_usd: 0.23,
        per_trace: [{ name: 't01', pass: true, expected: 'x', actual: 'x' }],
      }),
    ).not.toThrow();
    expect(() =>
      MemoryItem.parse({
        content: 'c',
        scope: 'team',
        kind: 'decision',
        confidence: 0.92,
        sources: [{ pr: 401, context: 'ctx' }],
      }),
    ).not.toThrow();
  });

  it('RunTrace (data2.jsx TRACE single-document)', () => {
    const trace = RunTrace.parse({
      config: { agent: 'Security Reviewer', version: 'v7', model: 'gpt-4.1', pr: 482, source: 'local' },
      stats: { duration_ms: 8200, tokens_in: 14820, tokens_out: 1240, cost_usd: 0.06, findings: 3, grounding: '3/3 passed' },
      prompt_assembly: { system: 's', user: 'u' },
      tool_calls: [{ tool: 'read_file', args: "'src/config.ts'", meta: '1,240 bytes', ms: 120 }],
      raw_output: '{}',
      memory_pulled: [{ pr: 288, text: 'verified via stripe-signature' }],
      specs_read: ['specs/security-baseline.md'],
      log: [{ t: '00.00', kind: 'info', msg: 'started' }],
    });
    expect(trace.tool_calls).toHaveLength(1);
  });

  // SPEC-01: this EXACT pre-existing literal must keep parsing unchanged — it
  // has no `specs_detail`/`specs_tokens` key at all, matching every trace
  // persisted before SPEC-01 shipped. `run_traces.trace` is a frozen jsonb
  // snapshot (server/INSIGHTS.md, 2026-06-24), so a historical trace can never
  // be re-derived to gain the new keys — the schema must keep accepting their
  // absence forever.
  it('RunTrace — a pre-SPEC-01 trace with no specs_detail/specs_tokens still parses', () => {
    const trace = RunTrace.parse({
      config: { agent: 'Security Reviewer', version: 'v7', model: 'gpt-4.1', pr: 482, source: 'local' },
      stats: { duration_ms: 8200, tokens_in: 14820, tokens_out: 1240, cost_usd: 0.06, findings: 3, grounding: '3/3 passed' },
      prompt_assembly: { system: 's', user: 'u' },
      tool_calls: [],
      raw_output: '{}',
      memory_pulled: [],
      specs_read: ['specs/security-baseline.md'],
      log: [{ t: '00.00', kind: 'info', msg: 'started' }],
    });
    expect(trace.specs_detail ?? null).toBeNull();
    expect(trace.specs_tokens ?? null).toBeNull();
  });

  // SPEC-01: a new-shape trace exercising specs_detail (the used/missing
  // ledger) and specs_tokens (the block's total token size) — AC-23/AC-24.
  it('RunTrace — specs_detail/specs_tokens (SPEC-01 ledger)', () => {
    const trace = RunTrace.parse({
      config: { agent: 'Context Reviewer', version: '1', model: 'gpt-4.1', pr: 482, source: 'local' },
      stats: { duration_ms: 4000, tokens_in: 5000, tokens_out: 300, cost_usd: 0.02, findings: 0, grounding: '0/0 passed' },
      prompt_assembly: { system: 's', user: 'u', specs: '### docs/architecture.md\n<untrusted source="spec:docs/architecture.md">…</untrusted>' },
      tool_calls: [],
      raw_output: '{}',
      memory_pulled: [],
      specs_read: ['docs/architecture.md'],
      specs_detail: [
        { path: 'docs/architecture.md', status: 'used', reason: null, tokens: 42 },
        { path: 'docs/vanished.md', status: 'missing', reason: 'not_in_clone', tokens: 0 },
      ],
      specs_tokens: 42,
      log: [],
    });
    expect(trace.specs_detail).toHaveLength(2);
    expect(trace.specs_detail?.[0]?.status).toBe('used');
    expect(trace.specs_detail?.[1]?.status).toBe('missing');
    expect(trace.specs_detail?.[1]?.reason).toBe('not_in_clone');
    expect(trace.specs_tokens).toBe(42);
  });
});

describe('platform DTOs', () => {
  it('Settings defaults + passthrough', () => {
    const s = Settings.parse({ extra_key: 'x' });
    expect(s.theme).toBe('dark');
    expect((s as Record<string, unknown>).extra_key).toBe('x');
  });

  it('Repo + PrDetail', () => {
    expect(() =>
      Repo.parse({
        id: 'r1',
        workspace_id: 'w1',
        owner: 'acme',
        name: 'payments-api',
        full_name: 'acme/payments-api',
        default_branch: 'main',
        clone_path: null,
        last_polled_at: null,
        created_by: null,
      }),
    ).not.toThrow();
    expect(() =>
      PrDetail.parse({
        number: 482,
        title: 't',
        author: 'a',
        branch: 'b',
        base: 'main',
        head_sha: 'sha',
        additions: 1,
        deletions: 0,
        files_count: 1,
        status: 'open',
        files: [],
        commits: [],
      }),
    ).not.toThrow();
  });
});

/**
 * SPEC-02's contracts, exercised through the SHARED schema rather than through
 * the service's own `validateItems`.
 *
 * `validateItems` is the runtime allowlist gate and has its own suite; these
 * assertions cover the half nothing else reaches — the `superRefine` rules that
 * travel with the contract into the client, where no allowlist exists.
 */
describe('SPEC-02 risk-brief contracts', () => {
  const record = {
    pr_id: '7f1f2f3a-0000-4000-8000-00000000ab12',
    what: 'Adds a token-bucket rate limiter to the public API routes.',
    why: 'Unauthenticated clients were abusing the public endpoints.',
    risk_level: 'high',
    risks: [
      {
        severity: 'high',
        summary: 'A live key is committed in plaintext.',
        reference: { file: 'src/config.ts', line: 11, symbol: null, endpoint: null },
      },
    ],
    review_focus: [
      {
        summary: 'Check the limiter returns Retry-After.',
        reference: { file: 'src/limiter.ts', line: null, symbol: 'consume', endpoint: null },
      },
    ],
    inputs: [{ section: 'blast_radius', status: 'unavailable', reason: 'repo not indexed' }],
    counts: { risks_proposed: 2, risks_kept: 1, focus_proposed: 1, focus_kept: 1 },
    head_sha: 'a'.repeat(40),
    provider: 'openrouter',
    model: 'deepseek/deepseek-v4-pro',
    tokens_in: 1414,
    tokens_out: 2408,
    cost_usd: 0.00882168,
    generated_at: '2026-08-29T08:40:01.680Z',
  };

  it('PrRiskBriefRecord parses a full record, provenance included (AC-19, AC-7)', () => {
    const parsed = PrRiskBriefRecord.parse(record);
    expect(parsed.risk_level).toBe('high');
    expect(parsed.review_focus).toHaveLength(1);
    // The three fields the plan's own record type originally omitted.
    expect(parsed.tokens_in).toBe(1414);
    expect(parsed.tokens_out).toBe(2408);
    expect(parsed.cost_usd).toBeCloseTo(0.00882168);
  });

  it('does not reuse PrBrief or Risk for the new shape (AC-21)', () => {
    // Both names predate this feature and mean something else. If a later edit
    // collapses them, this fails rather than silently changing what the older
    // `pr_brief.json` docblock promises.
    expect(PrBrief).not.toBe(PrRiskBriefRecord);
    expect(Risk).not.toBe(RiskBriefReference);
    expect(PrBrief.safeParse(record).success).toBe(false);
  });

  it('requires at least one non-null, non-empty field (AC-20, EC-22)', () => {
    expect(RiskBriefReference.safeParse({ file: 'src/a.ts' }).success).toBe(true);
    expect(RiskBriefReference.safeParse({ symbol: 'consume' }).success).toBe(true);
    expect(RiskBriefReference.safeParse({ endpoint: 'GET /workspace' }).success).toBe(true);

    for (const degenerate of [{}, { file: null }, { file: '' }, { file: null, symbol: null }]) {
      const res = RiskBriefReference.safeParse(degenerate);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error.issues.some((i) => /carries no field/.test(i.message))).toBe(true);
      }
    }
  });

  it('rejects a line with no file (AC-20a)', () => {
    const res = RiskBriefReference.safeParse({ line: 42 });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => /line without a file/.test(i.message))).toBe(true);
    }
  });

  it('rejects a non-positive line even alongside a valid file (AC-20b)', () => {
    // A valid field must never rescue an invalid one.
    const res = RiskBriefReference.safeParse({ file: 'src/a.ts', line: 0 });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => /positive integer/.test(i.message))).toBe(true);
    }
  });
});
