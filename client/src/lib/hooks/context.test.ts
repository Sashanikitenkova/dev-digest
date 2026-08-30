import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/* The attachment writes are OPTIMISTIC, DEBOUNCED and RETRIED, and these tests
   pin the four properties that made the checkbox unreliable:

   1. the cache reflects the click IMMEDIATELY, not when the request resolves;
   2. a BURST of clicks costs one request, not one per click — one PUT per
      checkbox is how the editor earned an HTTP 429, and a refused write rolls
      back, which looks exactly like a box that will not stay ticked;
   3. a transient refusal (429/5xx) is retried rather than discarded;
   4. a write that finally fails rolls back to the set from before the burst
      AND invalidates the key, because a rollback is only a guess about what
      the server holds.

   Several of these need the request controllable mid-flight, so `api.put` is
   mocked with deferred promises rather than resolved ones. `ApiError` is NOT
   mocked — the retry predicate branches on `instanceof`, so the tests have to
   throw the real thing. */

const put = vi.fn();
const get = vi.fn();
vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    api: { put: (...a: unknown[]) => put(...a), get: (...a: unknown[]) => get(...a) },
  };
});

import { ApiError } from "../api";
import { useSetAgentContext, useSetSkillContext } from "./context";

/** A promise plus the handle to settle it later. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);
  return { qc, wrapper };
}

const AGENT_KEY = ["agent-context", "agent-1"];

/** The write is debounced, so the request appears a beat after the click. */
const sent = () => waitFor(() => expect(put).toHaveBeenCalled());

beforeEach(() => {
  put.mockReset();
  get.mockReset();
});

describe("useSetAgentContext — optimistic attachment writes", () => {
  it("writes the submitted set into the cache before the request resolves", async () => {
    const { qc, wrapper } = harness();
    qc.setQueryData(AGENT_KEY, { paths: [] });
    const d = deferred<{ paths: string[] }>();
    put.mockReturnValue(d.promise);

    const { result } = renderHook(() => useSetAgentContext(), { wrapper });
    act(() => {
      result.current.mutate({ agentId: "agent-1", paths: ["specs/api.md"] });
    });

    // The click is in the cache before anything has been sent, let alone
    // resolved — the debounce is about the network, never about the UI.
    expect(qc.getQueryData(AGENT_KEY)).toEqual({ paths: ["specs/api.md"] });

    await sent();
    await act(async () => {
      d.resolve({ paths: ["specs/api.md"] });
      await d.promise;
    });
    expect(qc.getQueryData(AGENT_KEY)).toEqual({ paths: ["specs/api.md"] });
  });

  it("coalesces a burst of clicks into ONE request carrying the final set", async () => {
    // The 429 fix. Ticking four boxes used to be four PUTs against a shared
    // per-IP budget the studio's pollers had already mostly spent.
    const { qc, wrapper } = harness();
    qc.setQueryData(AGENT_KEY, { paths: [] });
    put.mockResolvedValue({ paths: ["a.md", "b.md", "c.md"] });

    const { result } = renderHook(() => useSetAgentContext(), { wrapper });
    act(() => {
      result.current.mutate({ agentId: "agent-1", paths: ["a.md"] });
      result.current.mutate({ agentId: "agent-1", paths: ["a.md", "b.md"] });
      result.current.mutate({ agentId: "agent-1", paths: ["a.md", "b.md", "c.md"] });
    });

    // Every click is visible immediately, all the same.
    expect(qc.getQueryData(AGENT_KEY)).toEqual({ paths: ["a.md", "b.md", "c.md"] });

    await sent();
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith("/agents/agent-1/context", {
      paths: ["a.md", "b.md", "c.md"],
    });
  });

  it("lets the LAST click win even when a stale echo resolves in between", async () => {
    // Two guards in one. The writes are SCOPED, so a second burst does not go
    // on the wire until the first settles — overlapping PUTs used to race a
    // delete-then-insert into a primary-key collision. And the success path
    // deliberately never writes the server's echo back into the cache, so the
    // first request resolving with the older set cannot undo a newer click.
    // The symptom if either breaks is a checkbox flipping back.
    const { qc, wrapper } = harness();
    qc.setQueryData(AGENT_KEY, { paths: [] });
    const first = deferred<{ paths: string[] }>();
    const second = deferred<{ paths: string[] }>();
    put.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { result } = renderHook(() => useSetAgentContext(), { wrapper });
    act(() => {
      result.current.mutate({ agentId: "agent-1", paths: ["a.md"] });
    });
    await sent();

    act(() => {
      result.current.mutate({ agentId: "agent-1", paths: ["a.md", "b.md"] });
    });
    // Queued behind the in-flight write, not racing it.
    await waitFor(() => expect(qc.getQueryData(AGENT_KEY)).toEqual({ paths: ["a.md", "b.md"] }));
    expect(put).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve({ paths: ["a.md"] }); // the stale echo
      await first.promise;
    });
    expect(qc.getQueryData(AGENT_KEY)).toEqual({ paths: ["a.md", "b.md"] });

    await waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    expect(put).toHaveBeenLastCalledWith("/agents/agent-1/context", {
      paths: ["a.md", "b.md"],
    });
    await act(async () => {
      second.resolve({ paths: ["a.md", "b.md"] });
      await second.promise;
    });
    expect(qc.getQueryData(AGENT_KEY)).toEqual({ paths: ["a.md", "b.md"] });
  });

  it("retries a rate-limited write instead of discarding the change", async () => {
    // The reported failure: "Rate limit exceeded, retry in 15 seconds
    // (HTTP 429)", every box unticked. A 429 is the infrastructure being busy,
    // not a wrong request — the user's set must survive it.
    const { qc, wrapper } = harness();
    qc.setQueryData(AGENT_KEY, { paths: [] });
    put
      .mockRejectedValueOnce(
        new ApiError("Rate limit exceeded", 429, "rate_limited", { retryAfter: 0.01 }),
      )
      .mockResolvedValueOnce({ paths: ["specs/api.md"] });

    const { result } = renderHook(() => useSetAgentContext(), { wrapper });
    act(() => {
      result.current.mutate({ agentId: "agent-1", paths: ["specs/api.md"] });
    });

    await waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    // Never rolled back, and never surfaced as an error the author has to read.
    expect(qc.getQueryData(AGENT_KEY)).toEqual({ paths: ["specs/api.md"] });
    await waitFor(() => expect(result.current.isError).toBe(false));
  });

  it("rolls back to the pre-BURST set and re-reads when the write finally fails", async () => {
    const { qc, wrapper } = harness();
    qc.setQueryData(AGENT_KEY, { paths: ["kept.md"] });
    // A 422 is the request itself being wrong: retrying it changes nothing.
    put.mockRejectedValue(new ApiError("nope", 422, "validation_error"));

    const { result } = renderHook(() => useSetAgentContext(), { wrapper });
    act(() => {
      result.current.mutate({ agentId: "agent-1", paths: ["kept.md", "new.md"] });
      result.current.mutate({ agentId: "agent-1", paths: ["kept.md", "new.md", "other.md"] });
    });
    expect(qc.getQueryData(AGENT_KEY)).toEqual({
      paths: ["kept.md", "new.md", "other.md"],
    });

    await sent();
    expect(put).toHaveBeenCalledTimes(1);

    // Back to what was stored before the burst began — NOT to the burst's own
    // first optimistic value, which was never saved either.
    await waitFor(() => expect(qc.getQueryData(AGENT_KEY)).toEqual({ paths: ["kept.md"] }));
    // And the rollback is only a guess, so the truth gets re-read.
    expect(qc.getQueryState(AGENT_KEY)?.isInvalidated).toBe(true);
  });
});

describe("useSetSkillContext — optimistic attachment writes", () => {
  it("writes the submitted set immediately and rolls back on failure", async () => {
    const { qc, wrapper } = harness();
    const key = ["skill-context", "skill-1"];
    qc.setQueryData(key, { paths: [] });
    put.mockRejectedValue(new ApiError("nope", 422, "validation_error"));

    const { result } = renderHook(() => useSetSkillContext(), { wrapper });
    act(() => {
      result.current.mutate({ skillId: "skill-1", paths: ["specs/api.md"] });
    });
    expect(qc.getQueryData(key)).toEqual({ paths: ["specs/api.md"] });

    await sent();
    await waitFor(() => expect(qc.getQueryData(key)).toEqual({ paths: [] }));
  });

  it("sends one PUT for a burst, to the skill endpoint", async () => {
    const { qc, wrapper } = harness();
    qc.setQueryData(["skill-context", "skill-1"], { paths: [] });
    put.mockResolvedValue({ paths: ["a.md", "b.md"] });

    const { result } = renderHook(() => useSetSkillContext(), { wrapper });
    act(() => {
      result.current.mutate({ skillId: "skill-1", paths: ["a.md"] });
      result.current.mutate({ skillId: "skill-1", paths: ["a.md", "b.md"] });
    });

    await sent();
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith("/skills/skill-1/context", { paths: ["a.md", "b.md"] });
  });
});
