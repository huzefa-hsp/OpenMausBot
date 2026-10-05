import { afterEach, describe, expect, it, vi } from "vitest";
import { codexRealtimeVoice, createCodexRealtimeBridge } from "./codex-realtime.ts";
import type { ProviderRealtimeSessionEvent } from "../contracts.ts";

afterEach(() => vi.useRealTimers());
function fixture() {
  const request = vi.fn(async () => ({}));
  const stop = vi.fn(async () => {});
  const onEnded = vi.fn();
  const bridge = createCodexRealtimeBridge({ threadId: "native-7", sdp: "offer", voice: " Sol ", request, stop, onEnded, timeoutMs: 100 });
  const notify = (method: string, params = {}) => bridge.notify(`thread/realtime/${method}`, { threadId: "native-7", ...params });
  return { bridge, request, stop, onEnded, notify };
}
describe("Codex native realtime on the scoped driver", () => {
  it("normalizes known voices", () => {
    expect(codexRealtimeVoice(" Sol ")).toBe("sol");
    expect(codexRealtimeVoice("invented")).toBeUndefined();
  });
  it("explicitly negotiates V3 with the already prepared native thread", async () => {
    const t = fixture();
    const ready = t.bridge.start();
    t.notify("started", { realtimeSessionId: "session-7" });
    t.notify("sdp", { sdp: "answer" });
    const session = await ready;
    expect(t.request).toHaveBeenCalledWith("thread/realtime/start", expect.objectContaining({
      threadId: "native-7", version: "v3", voice: "sol", transport: { type: "webrtc", sdp: "offer" },
    }), 100);
    expect(session).toMatchObject({ sessionId: "session-7", sdp: "answer" });
    await Promise.all([session.stop(), session.stop()]);
    expect(t.stop).toHaveBeenCalledTimes(1);
  });
  it("rejects an early error without exposing provider secrets or hanging", async () => {
    const t = fixture();
    const ready = t.bridge.start();
    t.notify("error", { message: "Bearer PRIVATE-CREDENTIAL; sk-sensitive" });
    await expect(ready).rejects.toThrow("Codex Live could not connect");
    expect(t.onEnded).toHaveBeenCalledTimes(1);
    await t.bridge.closed;
  });
  it("does not lose a terminal event between SDP and listener attachment", async () => {
    const t = fixture();
    const ready = t.bridge.start();
    t.notify("sdp", { sdp: "answer" });
    const session = await ready;
    t.notify("closed", { reason: "expired" });
    const events: ProviderRealtimeSessionEvent[] = [];
    session.onEvent((event) => events.push(event));
    expect(events).toContainEqual({ type: "closed", message: "expired" });
  });
  it("ignores other threads and deduplicates canonical transcript segments", async () => {
    const t = fixture();
    const ready = t.bridge.start();
    t.bridge.notify("thread/realtime/sdp", { threadId: "foreign", sdp: "wrong" });
    t.notify("sdp", { sdp: "answer" });
    const session = await ready;
    const events: ProviderRealtimeSessionEvent[] = [];
    session.onEvent((event) => events.push(event));
    const item = { id: "seg-1", type: "transcriptSegment", role: "user", text: "Hello" };
    t.notify("item/completed", { item });
    t.notify("item/completed", { item });
    t.notify("transcript/done", { role: "user", text: "Hello" });
    expect(events.filter((event) => event.type === "transcript")).toEqual([
      { type: "transcript", role: "user", text: "Hello", segmentId: "seg-1" },
    ]);
    expect(session.sdp).toBe("answer");
  });
  it("has a bounded SDP timeout and clears its timer", async () => {
    vi.useFakeTimers();
    const t = fixture();
    const ready = t.bridge.start();
    const assertion = expect(ready).rejects.toThrow("Codex Live could not connect");
    await vi.advanceTimersByTimeAsync(101);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("reports backend working/idle without synthesizing a second user request", async () => {
    const t = fixture();
    const ready = t.bridge.start();
    t.notify("sdp", { sdp: "answer" });
    const session = await ready;
    const events: ProviderRealtimeSessionEvent[] = [];
    session.onEvent((event) => events.push(event));
    t.bridge.working(true);
    t.bridge.working(false);
    t.notify("itemAdded", { item: { type: "handoff_request", input_transcript: "do it" } });
    expect(events).toEqual([{ type: "working" }, { type: "idle" }, { type: "activity" }]);
    expect(t.request).toHaveBeenCalledTimes(1);
  });
});
