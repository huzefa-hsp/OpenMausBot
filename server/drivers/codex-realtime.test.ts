import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { codexRealtimeVoice, startCodexRealtimeSession } from "./codex-realtime.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-codex-app-server.ts");

describe("Codex realtime transport", () => {
  it("normalizes only voices supported by Codex realtime", () => {
    expect(codexRealtimeVoice(" Sol ")).toBe("sol");
    expect(codexRealtimeVoice("marin")).toBe("marin");
    expect(codexRealtimeVoice("not-a-voice")).toBeUndefined();
  });

  it("negotiates WebRTC on an existing native thread and stops cleanly", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const scratch = mkdtempSync(join(tmpdir(), "omb-codex-realtime-"));
    const dump = join(scratch, "calls.json");
    const session = await startCodexRealtimeSession({
      cli: FAKE_CLI,
      args: [],
      env: { ...process.env, FAKE_CODEX_DUMP: dump, FAKE_CODEX_MODE: "resume" },
      threadId: "native-thread-7",
      sdp: "offer-sdp",
      voice: " Sol ",
      cwd: scratch,
      timeoutMs: 5_000,
    });

    expect(session.sessionId).toBe("fake-realtime-1");
    expect(session.sdp).toBe("fake-realtime-answer");

    await session.stop();

    const seen = JSON.parse(readFileSync(dump, "utf8")) as {
      calls: Array<{ method: string; params: Record<string, unknown> }>;
    };
    expect(seen.calls.map((call) => call.method)).toContain("initialize");
    expect(seen.calls.find((call) => call.method === "thread/resume")?.params).toMatchObject({
      threadId: "native-thread-7",
    });
    const start = seen.calls.find((call) => call.method === "thread/realtime/start");
    expect(start?.params).toMatchObject({
      threadId: "native-thread-7",
      outputModality: "audio",
      voice: "sol",
      transport: { type: "webrtc", sdp: "offer-sdp" },
    });
    expect(seen.calls.some((call) => call.method === "thread/realtime/stop")).toBe(true);
  });
});
