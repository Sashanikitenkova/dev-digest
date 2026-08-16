import { beforeEach, describe, expect, it } from 'vitest';
import { DevDigestToolError } from '../src/errors.js';
import { resetResolverCache, resolveAgent, resolvePull, resolveRepo } from '../src/resolve.js';
import { agent, pull, repo, stubContext } from './stub-api.js';

/**
 * APPLICATION ring — resolution against the stub port. No `fetch` anywhere.
 *
 * The cache is process-lifetime state, so every test starts from a clean one.
 */
beforeEach(() => resetResolverCache());

const REPO_ID = '22222222-2222-4222-8222-222222222222';
const AGENT_ID = '11111111-1111-4111-8111-111111111111';

describe('resolveRepo', () => {
  it('matches full_name exactly', async () => {
    const ctx = stubContext({ repos: [repo()] });
    await expect(resolveRepo(ctx, 'acme/payments-api')).resolves.toEqual({
      id: REPO_ID,
      fullName: 'acme/payments-api',
    });
  });

  it('matches case-insensitively and returns the canonical name', async () => {
    const ctx = stubContext({ repos: [repo()] });
    const resolved = await resolveRepo(ctx, 'ACME/Payments-API');
    expect(resolved.fullName).toBe('acme/payments-api');
  });

  it('tolerates surrounding whitespace', async () => {
    const ctx = stubContext({ repos: [repo()] });
    await expect(resolveRepo(ctx, '  acme/payments-api ')).resolves.toMatchObject({ id: REPO_ID });
  });

  it('fails forward, naming the repositories that do exist', async () => {
    const ctx = stubContext({ repos: [repo()] });
    await expect(resolveRepo(ctx, 'acme/nope')).rejects.toThrow(DevDigestToolError);
    await expect(resolveRepo(ctx, 'acme/nope')).rejects.toThrow(
      /is not imported into DevDigest.*acme\/payments-api/s,
    );
  });

  it('memoizes a hit for the process lifetime', async () => {
    const ctx = stubContext({ repos: [repo()] });
    await resolveRepo(ctx, 'acme/payments-api');
    await resolveRepo(ctx, 'acme/payments-api');
    expect(ctx.api.calls.listRepos).toBe(1);
  });

  it('never caches a miss — a repo can be imported mid-session', async () => {
    const ctx = stubContext({ repos: [repo()] });
    await expect(resolveRepo(ctx, 'acme/nope')).rejects.toThrow();
    await expect(resolveRepo(ctx, 'acme/nope')).rejects.toThrow();
    expect(ctx.api.calls.listRepos).toBe(2);
  });
});

describe('resolvePull', () => {
  const resolved = { id: REPO_ID, fullName: 'acme/payments-api' };

  it('matches on the PR number', async () => {
    const ctx = stubContext({ pulls: { [REPO_ID]: [pull({ number: 1 }), pull({ number: 482 })] } });
    await expect(resolvePull(ctx, resolved, 482)).resolves.toBe(
      '33333333-3333-4333-8333-333333333333',
    );
  });

  it('fails forward when the PR was never imported', async () => {
    const ctx = stubContext({ pulls: { [REPO_ID]: [] } });
    await expect(resolvePull(ctx, resolved, 482)).rejects.toThrow(/GITHUB_TOKEN/);
  });

  it('guards the nullish PrMeta.id rather than splicing undefined into a path', async () => {
    const ctx = stubContext({ pulls: { [REPO_ID]: [pull({ id: null })] } });
    await expect(resolvePull(ctx, resolved, 482)).rejects.toThrow(/has no stored id yet/);
  });

  it('is NOT cached — PRs are imported continuously', async () => {
    const ctx = stubContext({ pulls: { [REPO_ID]: [pull()] } });
    await resolvePull(ctx, resolved, 482);
    await resolvePull(ctx, resolved, 482);
    expect(ctx.api.calls.listPulls).toBe(2);
  });
});

describe('resolveAgent', () => {
  it('matches an exact id first', async () => {
    const ctx = stubContext({ agents: [agent()] });
    await expect(resolveAgent(ctx, AGENT_ID)).resolves.toEqual({
      id: AGENT_ID,
      name: 'Security Reviewer',
    });
  });

  it('matches a name case-insensitively', async () => {
    const ctx = stubContext({ agents: [agent()] });
    await expect(resolveAgent(ctx, 'security reviewer')).resolves.toMatchObject({ id: AGENT_ID });
  });

  it('matches a unique case-insensitive prefix', async () => {
    const ctx = stubContext({
      agents: [agent(), agent({ id: 'other', name: 'API Contract Reviewer' })],
    });
    await expect(resolveAgent(ctx, 'sec')).resolves.toMatchObject({ name: 'Security Reviewer' });
  });

  it('prefers an exact name over a prefix that also matches', async () => {
    const ctx = stubContext({
      agents: [agent({ id: 'exact', name: 'Sec' }), agent({ id: 'long', name: 'Security' })],
    });
    await expect(resolveAgent(ctx, 'Sec')).resolves.toMatchObject({ id: 'exact' });
  });

  it('fails forward to list_agents on a miss', async () => {
    const ctx = stubContext({ agents: [agent()] });
    await expect(resolveAgent(ctx, 'Nope')).rejects.toThrow(
      /^agent not found — call list_agents/,
    );
  });

  it('refuses to guess when two agents share a name', async () => {
    const ctx = stubContext({
      agents: [agent({ id: 'a' }), agent({ id: 'b' })],
    });
    await expect(resolveAgent(ctx, 'Security Reviewer')).rejects.toThrow(/is ambiguous/);
  });

  it('refuses to guess when a prefix matches two agents', async () => {
    const ctx = stubContext({
      agents: [agent({ id: 'a', name: 'Review One' }), agent({ id: 'b', name: 'Review Two' })],
    });
    await expect(resolveAgent(ctx, 'Review')).rejects.toThrow(
      /ambiguous.*Review One, Review Two/s,
    );
  });

  it('memoizes a hit', async () => {
    const ctx = stubContext({ agents: [agent()] });
    await resolveAgent(ctx, 'Security Reviewer');
    await resolveAgent(ctx, 'security reviewer');
    expect(ctx.api.calls.listAgents).toBe(1);
  });

  it('never caches a miss', async () => {
    const ctx = stubContext({ agents: [agent()] });
    await expect(resolveAgent(ctx, 'Nope')).rejects.toThrow();
    await expect(resolveAgent(ctx, 'Nope')).rejects.toThrow();
    expect(ctx.api.calls.listAgents).toBe(2);
  });
});

describe('resetResolverCache', () => {
  it('is the seam that keeps these tests independent', async () => {
    const ctx = stubContext({ repos: [repo()] });
    await resolveRepo(ctx, 'acme/payments-api');
    resetResolverCache();
    await resolveRepo(ctx, 'acme/payments-api');
    expect(ctx.api.calls.listRepos).toBe(2);
  });
});
