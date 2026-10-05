import { homedir } from "node:os";

import type {
  ProviderRealtimeSession,
  ProviderRealtimeSessionEvent,
} from "../contracts.ts";
import { serverVersion } from "../environment.ts";
import { killCliTree, spawnCli } from "../procs.ts";

const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;

const CODEX_REALTIME_VOICES = new Set([
  "alloy", "arbor", "ash", "ballad", "breeze", "cedar", "coral", "cove",
  "echo", "ember", "juniper", "maple", "marin", "sage", "shimmer", "sol",
  "spruce", "vale", "verse",
]);

export function codexRealtimeVoice(value: string | undefined): string | undefined {
  const voice = value?.trim().toLowerCase();
  return voice && CODEX_REALTIME_VOICES.has(voice) ? voice : undefined;
}

interface StartCodexRealtimeInput {
  cli: string;
  args: string[];
  env: Record<string, string | undefined>;
  threadId: string;
  sdp: string;
  voice?: string;
  cwd?: string;
  timeoutMs?: number;
}

interface Pending {
  resolve(value: any): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

class CodexRealtimeRpcError extends Error {
  code: unknown;
  constructor(error: { code?: unknown; message?: unknown }) {
    super(typeof error.message === "string" ? error.message : "Codex realtime request failed");
    this.code = error.code;
  }
}

const eventMessage = (value: unknown): string | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const message = (value as { message?: unknown }).message;
  return typeof message === "string" && message.trim() ? message.trim().slice(0, 300) : undefined;
};

/** Start Codex's native thread-scoped realtime transport over a dedicated
 * app-server process. Audio remains browser<->OpenAI WebRTC; this process
 * keeps the native Codex thread and realtime control plane alive. */
export async function startCodexRealtimeSession(input: StartCodexRealtimeInput): Promise<ProviderRealtimeSession> {
  if (!input.threadId.trim()) throw new Error("Codex realtime needs an existing native thread.");
  if (!input.sdp.trim()) throw new Error("Codex realtime needs a WebRTC offer.");

  const child = spawnCli(input.cli, ["app-server", ...input.args], {
    cwd: input.cwd ?? homedir(),
    env: input.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let nextId = 1;
  let stdoutBuffer = "";
  let recentStderr = "";
  let stopping = false;
  let processEnded = false;
  let realtimeSessionId: string | null = null;
  const pending = new Map<number, Pending>();
  const listeners = new Set<(event: ProviderRealtimeSessionEvent) => void>();

  let resolveSdp!: (sdp: string) => void;
  let rejectSdp!: (error: Error) => void;
  const sdpAnswer = new Promise<string>((resolve, reject) => {
    resolveSdp = resolve;
    rejectSdp = reject;
  });
  // Resume/start can fail before this promise becomes the awaited result.
  // Attach a no-op observer now so that early process failure is never an
  // unhandled rejection; awaiting sdpAnswer later still receives the error.
  void sdpAnswer.catch(() => {});
  const sdpTimer = setTimeout(
    () => rejectSdp(new Error("Codex realtime did not return a WebRTC answer in time.")),
    input.timeoutMs ?? START_TIMEOUT_MS,
  );
  sdpTimer.unref?.();

  const emit = (event: ProviderRealtimeSessionEvent) => {
    for (const listener of Array.from(listeners)) {
      try { listener(event); } catch { /* a UI listener cannot kill the transport */ }
    }
  };

  const rejectPending = (error: Error) => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  };

  const send = (message: unknown) => {
    if (processEnded || !child.stdin.writable) throw new Error("Codex realtime process is not writable.");
    child.stdin.write(JSON.stringify(message) + "\n");
  };

  const request = (method: string, params: unknown, timeoutMs = START_TIMEOUT_MS) =>
    new Promise<any>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`Codex ${method} timed out.`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      try {
        send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });

  let stoppingPromise: Promise<void> | null = null;
  const terminate = async () => {
    if (processEnded) return;
    await killCliTree(child);
  };

  const stop = () => stoppingPromise ??= (async () => {
    stopping = true;
    clearTimeout(sdpTimer);
    if (!processEnded) {
      try {
        await request("thread/realtime/stop", { threadId: input.threadId }, STOP_TIMEOUT_MS);
      } catch {
        // A closed or old server may not answer. Process termination is the fallback.
      }
    }
    await terminate();
  })();

  const onNotification = (method: string, params: Record<string, unknown>) => {
    if (params.threadId !== undefined && params.threadId !== input.threadId) return;
    switch (method) {
      case "thread/realtime/started":
        if (typeof params.realtimeSessionId === "string" && params.realtimeSessionId) {
          realtimeSessionId = params.realtimeSessionId;
        }
        emit({ type: "activity" });
        break;
      case "thread/realtime/sdp":
        if (typeof params.sdp === "string" && params.sdp.trim()) {
          clearTimeout(sdpTimer);
          resolveSdp(params.sdp);
        }
        break;
      case "thread/realtime/transcript/delta":
      case "thread/realtime/transcript/done":
      case "thread/realtime/itemAdded":
      case "thread/realtime/item/started":
      case "thread/realtime/item/transcript/delta":
      case "thread/realtime/item/completed":
      case "thread/realtime/outputAudio/delta":
        emit({ type: "activity" });
        break;
      case "thread/realtime/error": {
        const message = eventMessage(params) ?? "Codex realtime reported an error.";
        rejectSdp(new Error(message));
        emit({ type: "error", message });
        break;
      }
      case "thread/realtime/closed":
        emit({ type: "closed", message: typeof params.reason === "string" ? params.reason : undefined });
        stopping = true;
        void terminate();
        break;
      default:
        break;
    }
  };

  const onLine = (line: string) => {
    if (!line.trim()) return;
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message.id === "number" && (message.result !== undefined || message.error !== undefined)) {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error) item.reject(new CodexRealtimeRpcError(message.error));
      else item.resolve(message.result);
      return;
    }
    if (typeof message.method === "string") {
      onNotification(message.method, message.params && typeof message.params === "object" ? message.params : {});
    }
  };

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    for (;;) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      onLine(line);
    }
  });
  child.stderr.on("data", (chunk) => {
    recentStderr = (recentStderr + chunk.toString("utf8")).slice(-800);
  });
  child.on("error", (error) => {
    clearTimeout(sdpTimer);
    rejectSdp(error);
    rejectPending(error);
  });
  child.on("exit", (code, signal) => {
    processEnded = true;
    clearTimeout(sdpTimer);
    const detail = recentStderr.trim();
    const error = new Error(
      `Codex realtime process exited ${code ?? "null"}${signal ? ` (${signal})` : ""}${detail ? `: ${detail.slice(-300)}` : ""}`,
    );
    rejectSdp(error);
    rejectPending(error);
    if (!stopping) emit({ type: "error", message: error.message });
  });

  try {
    await request("initialize", {
      clientInfo: { name: "openmausbot", title: "OpenMausBot", version: serverVersion() },
      capabilities: { experimentalApi: true },
    });
    send({ jsonrpc: "2.0", method: "initialized", params: {} });

    // A realtime call uses its own app-server process, so load the persisted
    // native conversation before attaching the realtime transport.
    await request("thread/resume", { threadId: input.threadId });

    const voice = codexRealtimeVoice(input.voice);
    const answerWait = sdpAnswer;
    await request("thread/realtime/start", {
      threadId: input.threadId,
      outputModality: "audio",
      transport: { type: "webrtc", sdp: input.sdp },
      ...(voice ? { voice } : {}),
    }, input.timeoutMs ?? START_TIMEOUT_MS);
    const sdp = await answerWait;

    return {
      sessionId: realtimeSessionId ?? input.threadId,
      sdp,
      stop,
      onEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  } catch (error) {
    clearTimeout(sdpTimer);
    stopping = true;
    await terminate();
    throw error;
  }
}
