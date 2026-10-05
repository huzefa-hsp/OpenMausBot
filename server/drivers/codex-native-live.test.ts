import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexDriver } from "./codex.ts";
import type { NativeRealtimeRequest, ProviderInstance, ProviderRealtimeSession, RuntimeEvent } from "../contracts.ts";

const cli = fileURLToPath(new URL("../testing/fake-codex-app-server.ts", import.meta.url));
const instances: ProviderInstance[] = [];
afterEach(async () => { await Promise.all(instances.splice(0).map((instance) => instance.dispose())); });

async function fixture(extra: Record<string, string> = {}) {
  chmodSync(cli, 0o755);
  const scratch = mkdtempSync(join(tmpdir(), "omb-native-live-test-"));
  const home = join(scratch, ".codex");
  mkdirSync(home);
  writeFileSync(join(home, "config.toml"), '[mcp_servers.ambient]\nurl="https://example.test/never-connect"\n');
  const dump = join(scratch, "calls.json");
  const instance = await CodexDriver.create({
    instanceId: "native-fixture", displayName: "Native fixture", enabled: true,
    config: { cli, fullAuto: false },
    environment: { HOME: scratch, CODEX_HOME: home, FAKE_CODEX_MODE: "resume",
      FAKE_CODEX_MCP_OVERRIDES: "1", FAKE_CODEX_DUMP: dump, ...extra },
  });
  instances.push(instance);
  const events: RuntimeEvent[] = [];
  instance.adapter.onEvent((event) => events.push(event));
  const abort = new AbortController();
  let resolve!: (session: ProviderRealtimeSession) => void;
  let reject!: (error: Error) => void;
  const ready = new Promise<ProviderRealtimeSession>((yes, no) => { resolve = yes; reject = no; });
  void ready.catch(() => {});
  const nativeRealtime: NativeRealtimeRequest = {
    instanceId: instance.instanceId, sdp: "offer", voice: "sol", signal: abort.signal,
    ready: resolve, failed: reject,
  };
  const launch = () => instance.adapter.sendTurn({
    threadId: "omb-thread", botId: "omb-bot", text: "Start a Live call.", cwd: scratch,
    model: "gpt-fake-default", approvalMode: "ask", toolScope: { allow: ["native:*"] },
    resumeCursor: "native-thread", nativeRealtime,
  });
  const read = () => JSON.parse(readFileSync(dump, "utf8"));
  return { instance, events, abort, ready, launch, read, scratch };
}

describe("native voice uses the ordinary Codex driver", () => {
  it("retains the chosen thread, scoped MCP, cwd, and Ask policy", async () => {
    const t = await fixture();
    await t.launch();
    const session = await t.ready;
    expect(session.sdp).toBe("fake-realtime-answer");
    const seen = t.read();
    expect(seen.argv).toContain("mcp_servers.ambient.enabled=false");
    expect(seen.calls.find((call: { method: string }) => call.method === "thread/resume").params).toMatchObject({
      threadId: "native-thread", approvalPolicy: "on-request",
    });
    expect(seen.calls.find((call: { method: string }) => call.method === "thread/realtime/start").params).toMatchObject({
      threadId: "native-thread", version: "v3", codexResponseHandoffMode: "commentary",
    });
    expect(seen.calls.some((call: { method: string }) => call.method === "turn/start")).toBe(false);
    await expect(t.instance.adapter.sendTurn({ threadId: "omb-thread", text: "must not race" })).rejects.toThrow();
    await session.stop();
    await vi.waitFor(() => expect(t.instance.adapter.hasSession?.("omb-thread")).toBe(false));
  });

  it("keeps two native backing turns alive and counts their usage once at hang-up", async () => {
    const t = await fixture({ FAKE_CODEX_REALTIME_SCRIPT: "two-turns" });
    await t.launch();
    const session = await t.ready;
    await vi.waitFor(() => expect(t.events.filter((event) => event.type === "item.completed" && event.itemType === "assistant_text")).toHaveLength(2));
    expect(t.events.some((event) => event.type === "turn.completed")).toBe(false);
    expect(t.events.every((event) => event.threadId === "omb-thread")).toBe(true);
    await session.stop();
    await vi.waitFor(() => expect(t.events.filter((event) => event.type === "turn.completed")).toHaveLength(1));
    expect(t.events.find((event) => event.type === "turn.completed")).toMatchObject({ usage: { input: 14, output: 6, cachedInput: 8 } });
  });

  it("routes native permission requests through the existing broker and honors denial", async () => {
    const t = await fixture({ FAKE_CODEX_REALTIME_SCRIPT: "approval" });
    await t.launch();
    const session = await t.ready;
    await vi.waitFor(() => expect(t.events.some((event) => event.type === "request.opened")).toBe(true));
    const ask = t.events.find((event) => event.type === "request.opened")!;
    expect(t.read().decision).toBeNull();
    await t.instance.adapter.respondToRequest("omb-thread", ask.requestId!, { behavior: "deny" });
    await vi.waitFor(() => expect(t.events.some((event) => event.type === "request.resolved" && event.behavior === "deny")).toBe(true));
    await session.stop();
    expect(t.read().decision).toMatchObject({ decision: "denied" });
  });

  it("reports a clean hang-up when the child exits without a closed notification", async () => {
    const t = await fixture({ FAKE_CODEX_REALTIME_STOP_WITHOUT_EVENT: "1" });
    await t.launch();
    const session = await t.ready;
    const seen: string[] = [];
    session.onEvent((event) => seen.push(event.type));
    await session.stop();
    await vi.waitFor(() => expect(t.instance.adapter.hasSession?.("omb-thread")).toBe(false));
    expect(seen).toContain("closed");
    expect(seen).not.toContain("error");
    expect(t.events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    expect(t.events.find((event) => event.type === "turn.completed")).toMatchObject({ ok: true });
  });

  it("refuses a cancelled call before dispatching a native thread", async () => {
    const t = await fixture();
    t.abort.abort();
    await expect(t.launch()).rejects.toThrow("cancelled");
  });

  it("rejects setup errors without leaking their payload and releases the turn", async () => {
    const t = await fixture({ FAKE_CODEX_REALTIME_ERROR: "1" });
    await t.launch();
    await expect(t.ready).rejects.toThrow("Codex Live could not connect");
    await vi.waitFor(() => expect(t.instance.adapter.hasSession?.("omb-thread")).toBe(false));
    expect(JSON.stringify(t.events)).not.toContain("synthetic-secret");
  });
});
