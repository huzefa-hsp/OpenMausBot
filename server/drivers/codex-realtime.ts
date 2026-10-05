import type { ProviderRealtimeSession, ProviderRealtimeSessionEvent } from "../contracts.ts";

const VOICES = new Set([
  "alloy", "arbor", "ash", "ballad", "breeze", "cedar", "coral", "cove", "echo",
  "ember", "juniper", "maple", "marin", "sage", "shimmer", "sol", "spruce", "vale", "verse",
]);
export function codexRealtimeVoice(value: string | undefined): string | undefined {
  const voice = value?.trim().toLowerCase();
  return voice && VOICES.has(voice) ? voice : undefined;
}

/** Never echo backend HTTP bodies, SDP, tokens, or stderr into the call UI. */
export function codexRealtimeError(): Error {
  return new Error("Codex Live could not connect. Check the selected Codex account and its voice availability, then retry.");
}

type Rpc = (method: string, params: unknown, timeoutMs?: number) => Promise<unknown>;
export interface CodexRealtimeBridgeInput {
  threadId: string;
  sdp: string;
  voice?: string;
  request: Rpc;
  stop(): Promise<void>;
  onEnded(reason: string): void;
  timeoutMs?: number;
}

/** Realtime shares the normal Codex driver's process, permission broker, MCP
 * mounts, working directory, and runtime event stream. It must not spawn an
 * unscoped second agent or dispatch a handoff twice: Codex routes it natively. */
export function createCodexRealtimeBridge(input: CodexRealtimeBridgeInput) {
  let sessionId = input.threadId;
  let ended = false;
  let startCalled = false;
  let resolveAnswer!: (sdp: string) => void;
  let rejectAnswer!: (error: Error) => void;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const answer = new Promise<string>((resolve, reject) => { resolveAnswer = resolve; rejectAnswer = reject; });
  void answer.catch(() => {});
  const listeners = new Set<(event: ProviderRealtimeSessionEvent) => void>();
  const buffered: ProviderRealtimeSessionEvent[] = [];
  const segments = new Set<string>();
  let terminal: ProviderRealtimeSessionEvent | null = null;
  let stopPromise: Promise<void> | undefined;

  const emit = (event: ProviderRealtimeSessionEvent) => {
    if (!listeners.size) {
      if (event.type === "closed" || event.type === "error") terminal = event;
      else if (event.type !== "activity") {
        buffered.push(event);
        if (buffered.length > 64) buffered.shift();
      }
      return;
    }
    for (const listener of Array.from(listeners)) {
      try { listener(event); } catch { /* subscribers cannot kill the provider */ }
    }
  };
  const close = (reason = "close_requested", error?: Error) => {
    if (ended) return;
    ended = true;
    rejectAnswer(error ?? new Error("The Codex Live session ended before connecting."));
    resolveClosed();
    emit(error ? { type: "error", message: error.message } : { type: "closed", message: reason });
    input.onEnded(reason);
  };
  const notify = (method: string, params: Record<string, unknown>): boolean => {
    if (!method.startsWith("thread/realtime/")) return false;
    if (params.threadId !== input.threadId || ended) return true;
    switch (method) {
      case "thread/realtime/started":
        if (typeof params.realtimeSessionId === "string" && params.realtimeSessionId) sessionId = params.realtimeSessionId;
        break;
      case "thread/realtime/sdp":
        if (typeof params.sdp === "string" && params.sdp.trim() && params.sdp.length <= 128 * 1024) resolveAnswer(params.sdp);
        else close("error", codexRealtimeError());
        break;
      case "thread/realtime/error":
        close("error", codexRealtimeError());
        break;
      case "thread/realtime/closed":
        close(typeof params.reason === "string" ? params.reason : "remote-hangup");
        break;
      case "thread/realtime/item/completed": {
        const item = params.item as { id?: unknown; type?: unknown; role?: unknown; text?: unknown } | undefined;
        if (item?.type === "transcriptSegment" && typeof item.id === "string" && !segments.has(item.id)
          && (item.role === "user" || item.role === "assistant") && typeof item.text === "string" && item.text.trim()) {
          segments.add(item.id);
          if (segments.size > 512) segments.delete(segments.values().next().value!);
          emit({ type: "transcript", role: item.role, text: item.text.slice(0, 32_000), segmentId: item.id });
        }
        emit({ type: "activity" });
        break;
      }
      case "thread/realtime/itemAdded":
      case "thread/realtime/transcript/delta":
      case "thread/realtime/outputAudio/delta":
        emit({ type: "activity" });
        break;
    }
    return true;
  };

  return {
    notify,
    closed,
    close,
    working(value: boolean) { if (!ended) emit({ type: value ? "working" : "idle" }); },
    async start(): Promise<ProviderRealtimeSession> {
      if (startCalled) throw new Error("This Codex Live session was already started.");
      startCalled = true;
      if (ended || !input.threadId || !input.sdp.trim()) throw new Error("The Codex Live session cannot start.");
      const timeoutMs = input.timeoutMs ?? 30_000;
      const timer = setTimeout(() => close("error", new Error("Codex Live did not connect in time.")), timeoutMs);
      timer.unref?.();
      try {
        const voice = codexRealtimeVoice(input.voice);
        // CLI 0.160 defaults WebRTC to V1; that request is rejected by AVAS.
        // V3 is negotiated through the public experimental app-server schema.
        const start = input.request("thread/realtime/start", {
          threadId: input.threadId,
          version: "v3",
          outputModality: "audio",
          codexResponseHandoffMode: "commentary",
          includeStartupContext: true,
          flushTranscriptTailOnSessionEnd: true,
          transport: { type: "webrtc", sdp: input.sdp },
          ...(voice ? { voice } : {}),
        }, timeoutMs);
        const [, sdp] = await Promise.all([start, answer]);
        if (ended) throw new Error("The Codex Live session ended while connecting.");
        return {
          sessionId, sdp,
          stop: () => stopPromise ??= input.stop(),
          speak: async (text) => {
            if (ended || !text.trim()) return;
            await input.request("thread/realtime/appendSpeech", { threadId: input.threadId, text: text.slice(0, 8000) }, 10_000);
          },
          onEvent(listener) {
            listeners.add(listener);
            for (const event of buffered.splice(0)) listener(event);
            if (terminal) listener(terminal);
            return () => { listeners.delete(listener); };
          },
        };
      } catch {
        close("error", codexRealtimeError());
        throw codexRealtimeError();
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
