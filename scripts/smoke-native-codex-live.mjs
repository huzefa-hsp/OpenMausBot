#!/usr/bin/env node
/** Explicit opt-in live verification. Uses a disposable OMB home and browser,
 * synthetic microphone audio, and the specified existing native Codex login.
 * Never connects to or changes the person's running OMB server. */
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, openSync, closeSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomInt } from "node:crypto";
import { completionPatch } from "../src/lib/onboarding.ts";
import { withTourFinished } from "../src/lib/guided-tour.ts";
import { verificationServerEnvironment } from "./control-omb.ts";
import { killCliTree } from "../server/procs.ts";

const args = process.argv.slice(2);
const option = (key) => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; };
const codexHome = option("--live-codex-home");
const codexCli = option("--codex-cli");
if (!codexHome || !codexCli || !args.includes("--live")) {
  throw new Error("Live subscription usage requires --live --live-codex-home ABSOLUTE_PATH --codex-cli ABSOLUTE_PATH");
}
if (resolve(codexHome) !== codexHome || resolve(codexCli) !== codexCli) throw new Error("Use absolute native login/CLI paths.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagedRoot = option("--packaged-root");
const runtimeRoot = packagedRoot ? resolve(packagedRoot) : root;
const mobile = args.includes("--mobile");
const scratch = mkdtempSync(join(tmpdir(), "omb-live-voice-verification-"));
for (const name of ["tmp", "workspace", "evidence"]) mkdirSync(join(scratch, name));
const evidenceDir = join(scratch, "evidence");
const evidence = { startedAt: new Date().toISOString(), scratch, runtime: packagedRoot ? "packaged" : "source", viewport: mobile ? "mobile" : "desktop", checks: {}, result: "incomplete" };
let server, chrome, ws, api, callId;
let cdp;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  let last;
  do { try { last = await fn(); if (last) return last; } catch (e) { last = e.message; } await pause(200); } while (Date.now() < end);
  throw new Error(`${label} timed out${typeof last === "string" ? `: ${last.slice(0, 250)}` : ""}`);
}
async function freePorts() {
  for (let i = 0; i < 20; i++) {
    const a = createServer(), b = createServer();
    try {
      a.listen(0, "127.0.0.1"); await once(a, "listening"); const port = a.address().port;
      b.listen(port + 1, "127.0.0.1"); await once(b, "listening"); return port;
    } catch {} finally { a.close(); b.close(); }
  }
  throw new Error("Could not reserve isolated fixture ports.");
}
async function screenshot(name) {
  if (!cdp) return;
  const shot = await cdp("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(evidenceDir, name), Buffer.from(shot.data, "base64"));
}
let evaluate;
const allMessages = (snapshot, id) => snapshot.bots.find((b) => b.id === id)?.messages ?? [];
const hasAnswer = (messages, code) => messages.some((m) => m.role === "bot" && m.kind === "text" && String(m.text).toUpperCase().includes(code));
try {
  const port = await freePorts();
  const origin = `http://127.0.0.1:${port}`;
  evidence.origin = origin;
  const config = { profile: { name: "Isolated voice verification" },
    onboarding: { ...completionPatch().onboarding, reelSeen: true, hintsSeen: [...withTourFinished(undefined), "spot.composer", "spot.model", "spot.approval", "spot.connector"] },
    instances: {
    "codex-voice-fixture": { driver: "codex", displayName: "Native Codex verification", config: { cli: codexCli }, environment: { CODEX_HOME: codexHome } },
  }, live: { voice: "sol", idleMinutes: 5 } };
  writeFileSync(join(scratch, "config.json"), JSON.stringify(config), { mode: 0o600 });
  const env = verificationServerEnvironment(process.env, scratch, port);
  env.PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;
  env.OMB_STATIC_DIR = join(runtimeRoot, "dist");
  const log = openSync(join(evidenceDir, "server.log"), "a", 0o600);
  server = spawn(process.execPath, packagedRoot ? [join(runtimeRoot, "dist-server/index.js")] : ["--experimental-strip-types", join(root, "server/index.ts")], { cwd: runtimeRoot, env, detached: true, stdio: ["ignore", log, log] });
  closeSync(log);
  api = async (method, path, body) => {
    const response = await fetch(origin + path, { method, headers: { "content-type": "application/json", origin },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(100_000) });
    const result = await response.json();
    if (!response.ok) throw new Error(`${method} ${path} (${response.status}): ${JSON.stringify(result).slice(0, 350)}`);
    return result;
  };
  await until(async () => { if (server.exitCode !== null) throw new Error("Fixture server exited"); return await api("GET", "/api/config"); }, 40_000, "fixture server");
  const created = await api("POST", "/api/bots", {
    name: "Native Voice QA", title: "Isolated voice test", description: "For this voice verification the test code is ORANGE SEVEN. Reply briefly. Only inspect files in your current test workspace when explicitly asked. Never contact other agents or external services.",
    modelSelection: { instanceId: "codex-voice-fixture", model: "gpt-6.1-sol" }, approvalMode: "ask",
    cwd: join(scratch, "workspace"), toolScope: { allow: ["native:*"] }, mcpServers: [],
  });
  const bot = created.bot ?? created;
  if (!bot.id) throw new Error("No verification bot was created.");
  evidence.botId = bot.id;
  evidence.threadId = bot.threadId;
  evidence.checks.noApiKey = !(await api("GET", "/api/config")).live?.configured;
  const chromeHome = join(scratch, "chrome"); mkdirSync(chromeHome);
  chrome = spawn("/usr/bin/google-chrome", ["--headless=new", `--user-data-dir=${chromeHome}`,
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--no-first-run", "about:blank"],
    { env: { HOME: scratch, PATH: env.PATH }, detached: true, stdio: ["ignore", "ignore", "ignore"] });
  await until(() => existsSync(join(chromeHome, "DevToolsActivePort")), 10_000, "sandboxed Chrome");
  const debugPort = readFileSync(join(chromeHome, "DevToolsActivePort"), "utf8").split("\n")[0];
  const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  ws = new WebSocket(pages.find((p) => p.type === "page").webSocketDebuggerUrl);
  await once(ws, "open");
  let sequence = 0; const pending = new Map();
  ws.addEventListener("message", (event) => { const m = JSON.parse(event.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); clearTimeout(p.timer); if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result); } });
  cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, 15_000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  evaluate = async (expression) => { const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
  await cdp("Page.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: mobile ? 390 : 1280, height: mobile ? 844 : 900, deviceScaleFactor: 1, mobile });
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `
    localStorage.setItem('openmausbot.callMode.v1','live');
    window.__voicePeers=[];window.__voiceEvents=[];window.__liveRequests=[];
    const fetchOriginal=window.fetch;
    window.fetch=async(...args)=>{const path=String(args[0]);
      if(path.includes('/api/live/session'))window.__voiceStartRequested=true;
      const r=await fetchOriginal(...args);
      if(path==='/api/instances')r.clone().json().then(d=>window.__fixtureInstances=d.instances).catch(()=>{});
      if(path.includes('/api/live/')){
        r.clone().json().then(d=>window.__liveRequests.push({path,status:r.status,error:d.error,callStatus:d.call?.status})).catch(()=>{});
      }return r;};
    const NativePeer=window.RTCPeerConnection;
    window.RTCPeerConnection=class extends NativePeer {
      constructor(...args){super(...args);window.__voicePeers.push(this);}
      createDataChannel(...args){const channel=super.createDataChannel(...args);channel.addEventListener('message',e=>{
        try{const m=JSON.parse(e.data);if(JSON.stringify(m).length<16000){window.__voiceEvents.push(m);if(window.__voiceEvents.length>500)window.__voiceEvents.shift();}}catch{}
      });return channel;}
    };` });
  await cdp("Page.navigate", { url: origin });
  await until(() => evaluate("document.readyState==='complete' && !!navigator.mediaDevices && document.body.innerText.includes('Native Voice QA')"), 40_000, "OMB interface");
  const clickButton = async (predicate, label) => {
    const point = await until(() => evaluate(`(()=>{for(const b of document.querySelectorAll('button')){if(!(${predicate})||b.disabled)continue;const r=b.getBoundingClientRect();if(r.width<1||r.height<1)continue;const x=r.x+r.width/2,y=r.y+r.height/2;const hit=document.elementFromPoint(x,y);if(hit===b||b.contains(hit))return {x,y};}return false;})()`), 15_000, label);
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
    return true;
  };
  evidence.checks.noOnboardingOverlay = await evaluate("![...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='Skip tour')");
  if (!evidence.checks.noOnboardingOverlay) throw new Error("Fixture onboarding was not completed.");
  await until(() => evaluate("window.__fixtureInstances?.some(i=>i.instanceId==='codex-voice-fixture'&&i.driverKind==='codex')"), 60_000, "native provider catalogue in UI");
  await evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
  console.log("Fixture ready; starting the native call.");
  await screenshot("01-before-call.png");
  const clicked = await clickButton("/call.*Native Voice QA|Native Voice QA.*call/i.test(b.getAttribute('aria-label')||'')", "native call button");
  evidence.checks.uiStart = clicked;
  await until(() => evaluate("window.__voiceStartRequested===true"), 15_000, "UI voice-start request");
  console.log("UI sent native voice-start request.");
  await until(async () => { const current = (await api("GET", "/api/live/call")).call; if (current) callId = current.callId;
    return current?.status === "live" && await evaluate("window.__voicePeers.some(p=>p.connectionState==='connected')"); }, 100_000, "OMB native WebRTC");
  evidence.checks.webrtcConnected = true;
  console.log("Native OMB WebRTC connected.");
  const say = async (text, name) => {
    const wav = join(scratch, `${name}.wav`);
    execFileSync("/usr/bin/ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `flite=text=${text}:voice=slt`, "-ar", "48000", "-ac", "1", wav]);
    const encoded = readFileSync(wav).toString("base64");
    return evaluate(`(async()=>{const pc=window.__voicePeers.find(p=>p.connectionState==='connected');
      const ac=new AudioContext();await ac.resume();(window.__audioContexts??=[]).push(ac);
      const bytes=Uint8Array.from(atob(${JSON.stringify(encoded)}),c=>c.charCodeAt(0));
      const source=ac.createBufferSource();source.buffer=await ac.decodeAudioData(bytes.buffer);
      const destination=ac.createMediaStreamDestination();source.connect(destination);
      // Keep the synthetic microphone clock alive after the spoken sample.
      // A stopped BufferSource alone can stop WebAudio capture frames entirely.
      const keepAlive=ac.createOscillator();const quiet=ac.createGain();quiet.gain.value=0.00001;
      keepAlive.connect(quiet).connect(destination);keepAlive.start();
      await pc.getSenders().find(s=>s.track?.kind==='audio').replaceTrack(destination.stream.getAudioTracks()[0]);source.start();return source.buffer.duration;})()`);
  };
  await say("Hello. Please say the test code from this conversation.", "input-context");
  await until(async () => hasAnswer(allMessages(await api("GET", "/api/bots?messages=100"), bot.id), "ORANGE SEVEN"), 60_000, "native context answer");
  evidence.checks.contextAnswer = true;
  const spoken = (word) => evaluate(`window.__voiceEvents.some(e=>/output_transcript/.test(e.type||'')&&JSON.stringify(e).toUpperCase().includes(${JSON.stringify(word)}))`);
  await until(() => spoken("ORANGE"), 20_000, "spoken backend answer");
  evidence.checks.spokenAnswer = true;
  console.log("Same-thread answer returned as speech.");
  await screenshot("02-live-answer.png");
  const stored = JSON.parse(readFileSync(join(scratch, "bots.json"), "utf8"));
  const storedBot = stored.find((b) => b.id === bot.id);
  const task = storedBot.tasks.find((t) => t.threadId === bot.threadId);
  const cwd = task.cwd ?? storedBot.cwd;
  if (!cwd || !resolve(cwd).startsWith(scratch + sep)) throw new Error("Test workspace was not isolated.");
  const fileCode = `COBALT ${randomInt(100, 999)}`;
  writeFileSync(join(cwd, "code.txt"), fileCode + "\n");
  evidence.expectedFileCode = fileCode;
  evidence.nativeThread = task.resumeCursors["codex-voice-fixture"];
  await say("Please read the file code dot T X T in your current working directory. Tell me the exact code in that file.", "input-file");
  await until(async () => hasAnswer(allMessages(await api("GET", "/api/bots?messages=100"), bot.id), fileCode), 60_000, "spoken file-read task");
  await until(() => spoken("COBALT"), 20_000, "spoken file result");
  evidence.checks.spokenToolTask = true;
  console.log("Spoken file task completed.");
  const beforeEnd = await api("GET", "/api/bots?messages=100");
  evidence.messages = allMessages(beforeEnd, bot.id).map(({ id, role, kind, text, via }) => ({ id, role, kind, text, via }));
  evidence.rtp = await evaluate(`(async()=>[...(await window.__voicePeers.find(p=>p.connectionState==='connected').getStats()).values()]
    .filter(x=>x.type==='inbound-rtp'||x.type==='outbound-rtp').map(x=>({type:x.type,kind:x.kind,bytesSent:x.bytesSent,bytesReceived:x.bytesReceived,totalAudioEnergy:x.totalAudioEnergy,packetsReceived:x.packetsReceived})))()`);
  evidence.checks.returnedAudio = evidence.rtp.some((s) => s.type === "inbound-rtp" && s.bytesReceived > 1000 && s.totalAudioEnergy > 0);
  evidence.voiceEvents = await evaluate("window.__voiceEvents.filter(e=>/output_transcript|delegation/.test(e.type||'')).slice(-50)");
  await screenshot("03-tool-result.png");
  const ended = await api("POST", "/api/live/call/end", { callId });
  evidence.endState = ended.call;
  evidence.checks.normalHangup = ended.call?.status === "ended" && ended.call?.endReason === "hung-up";
  await until(async () => !(await api("GET", "/api/live/call")).call && !(await api("GET", "/api/bots?messages=100")).bots.find(b=>b.id===bot.id)?.busy, 12_000, "call cleanup");
  evidence.checks.hangup = true;
  const count = allMessages(await api("GET", "/api/bots?messages=100"), bot.id).length;
  await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "What was the exact code you just read from code.txt? Reply only with it; do not use tools." });
  await until(async () => hasAnswer(allMessages(await api("GET", "/api/bots?messages=100"), bot.id).slice(count), fileCode), 60_000, "text continuity after voice");
  const final = JSON.parse(readFileSync(join(scratch, "bots.json"), "utf8")).find(b=>b.id===bot.id).tasks.find(t=>t.threadId===bot.threadId);
  evidence.checks.sameNativeThread = final.resumeCursors["codex-voice-fixture"] === evidence.nativeThread;
  evidence.checks.textAfterVoice = true;
  console.log("Text continuity after hang-up verified.");
  await screenshot("04-text-continuity.png");
  if (Object.values(evidence.checks).some((value) => value !== true)) throw new Error("A verification check did not pass.");
  evidence.result = "passed";
} catch (error) {
  evidence.result = "failed";
  evidence.error = String(error.message).slice(0, 1000);
  try { evidence.visible = (await evaluate("document.body.innerText")).slice(-4500); } catch {}
  try { evidence.browserState = await evaluate("({requests:window.__liveRequests,peers:window.__voicePeers?.map(p=>p.connectionState),events:window.__voiceEvents?.slice(-50)})"); } catch {}
  try { await screenshot("failure.png"); } catch {}
} finally {
  try { if (callId && api) await api("POST", "/api/live/call/end", { callId }); } catch {}
  ws?.close();
  if (chrome) await killCliTree(chrome);
  if (server) await killCliTree(server);
  evidence.finishedAt = new Date().toISOString();
  writeFileSync(join(evidenceDir, "result.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ result: evidence.result, checks: evidence.checks, error: evidence.error, evidenceDir }, null, 2));
  process.exitCode = evidence.result === "passed" ? 0 : 1;
}
