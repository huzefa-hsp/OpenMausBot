// Run with: node scripts/smoke-app-permissions.mjs
// Linux CI needs xvfb-run. Uses a fake microphone and captures only its own
// disposable page, never the user's microphone, camera, desktop, or app data.
import electron from "electron";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { appPermissionHandlers } from "../electron/app-permissions.mjs";
import screenPreview from "../electron/screen-preview.cjs";

// Chromium can write cache files after app.quit. The Node parent owns cleanup
// so the disposable profile is removed only after the Electron child exits.
if (!process.versions.electron) {
  const data = mkdtempSync(join(tmpdir(), "omb-permission-smoke-"));
  const evidence = mkdtempSync(join(tmpdir(), "omb-permission-evidence-"));
  let code = 1;
  try {
    const result = spawnSync(electron, [fileURLToPath(import.meta.url), data, evidence], { stdio: "inherit", timeout: 40_000 });
    if (result.error) throw result.error;
    code = result.status ?? 1;
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
  process.exit(code);
}

const { app, BrowserWindow, ipcMain, session } = electron;
const data = process.argv[2];
const evidence = process.argv[3];
assert.ok(data, "Run this smoke with Node so its parent owns the temporary profile");
app.setPath("userData", data);
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
const timeout = setTimeout(() => { console.error("Permission smoke timed out"); app.exit(1); }, 30_000);

async function run() {
  const servers = [0, 1, 2, 3].map(() => createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end("<!doctype html><title>Isolated permission smoke</title><p>Only this test page is captured.</p>");
  }));
  let win;
  try {
    await Promise.all(servers.map(server => new Promise(resolve => server.listen(0, "127.0.0.1", resolve))));
    // `cloudOrigin` plays the person's verified Cloud; `foreignOrigin` any other server.
    const [origin, foreignOrigin, cloudOrigin, remoteOrigin] = servers.map(server => `http://127.0.0.1:${server.address().port}`);
    await app.whenReady();
    const guard = screenPreview.createDisplayMediaGuard();
    // perm:status's `pageMic`, asked over real IPC as the app's preload asks it:
    // a blocked Live call says "the app refused this page" only where it did.
    const preload = join(data, "page-mic-preload.cjs");
    writeFileSync(preload, `require("electron").contextBridge.exposeInMainWorld("smoke", { pageMic: () => require("electron").ipcRenderer.invoke("smoke:page-mic") });`);
    const pageMic = () => win.webContents.executeJavaScript("window.smoke.pageMic()", true);
    win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload } });
    // Use the production permission handlers, not a blanket fake UI grant.
    let selectedRemote = null;
    const permissions = appPermissionHandlers({ rendererOrigin: () => origin, mainContents: () => win?.webContents ?? null,
      cloudHomeOrigin: () => cloudOrigin, remoteWorkspaceOrigin: () => selectedRemote });
    session.defaultSession.setPermissionCheckHandler(permissions.check);
    session.defaultSession.setPermissionRequestHandler(permissions.request);
    ipcMain.handle("smoke:page-mic", event => permissions.pageMicrophone(event));
    const displayDecisions = [];
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      const allowed = guard.consume(request, origin);
      displayDecisions.push(allowed);
      // Electron can capture this fixture's WebContents without screen access.
      screenPreview.invokeDisplayMediaCallback(callback, allowed ? { video: request.frame } : {});
    });
    const capture = expression => win.webContents.executeJavaScript(`
      (${expression}).then(stream => {
        const tracks = stream.getTracks().map(track => track.kind);
        stream.getTracks().forEach(track => track.stop());
        return { tracks };
      }).catch(error => ({ error: error.name }))`, true);
    const microphone = "navigator.mediaDevices.getUserMedia({audio:true})";
    const camera = "navigator.mediaDevices.getUserMedia({video:true})";
    const display = "navigator.mediaDevices.getDisplayMedia({video:true,audio:false})";
    await win.loadURL(origin);
    assert.equal(await pageMic(), "allowed", "this computer's page is told the app allows it");
    assert.deepEqual(await capture(microphone), { tracks: ["audio"] });
    assert.deepEqual(await capture(camera), { error: "NotAllowedError" });
    assert.ok((await capture(display)).error, "screen capture needs an intent");
    assert.equal(guard.begin(win.webContents.mainFrame), true);
    assert.deepEqual(await capture(display), { tracks: ["video"] });
    assert.ok((await capture(display)).error, "screen intent is one-shot");
    assert.deepEqual(displayDecisions, [false, true, false]);
    await win.loadURL(foreignOrigin);
    assert.equal(await pageMic(), "refused", "another server's page is told the app refused it");
    assert.deepEqual(await capture(microphone), { error: "NotAllowedError" });
    assert.equal(guard.begin(win.webContents.mainFrame), true);
    assert.ok((await capture(display)).error, "another origin must not capture");
    assert.deepEqual(displayDecisions, [false, true, false], "foreign capture must not reach source selection");
    // The verified Cloud open in this window: the microphone, and nothing more.
    await win.loadURL(cloudOrigin);
    assert.equal(await pageMic(), "allowed", "the verified Cloud's page is told the app allows it");
    assert.deepEqual(await capture(microphone), { tracks: ["audio"] });
    assert.deepEqual(await capture(camera), { error: "NotAllowedError" });
    assert.equal(guard.begin(win.webContents.mainFrame), true);
    assert.ok((await capture(display)).error, "the Cloud must not capture the screen");
    assert.deepEqual(displayDecisions, [false, true, false], "the Cloud's capture must not reach source selection");
    await win.loadURL(remoteOrigin);
    assert.equal(await pageMic(), "refused", "a remote page is not trusted before selection");
    assert.deepEqual(await capture(microphone), { error: "NotAllowedError" });
    selectedRemote = remoteOrigin;
    assert.equal(await pageMic(), "allowed", "selected remote workspace may request audio");
    assert.deepEqual(await capture(microphone), { tracks: ["audio"] });
    assert.deepEqual(await capture(camera), { error: "NotAllowedError" });
    assert.equal(guard.begin(win.webContents.mainFrame), true);
    assert.ok((await capture(display)).error, "remote workspace never gets the screen");
    assert.deepEqual(displayDecisions, [false, true, false], "remote capture never reaches source selection");
    selectedRemote = null;
    assert.equal(await pageMic(), "refused", "forgetting the workspace revokes eligibility");
    assert.deepEqual(await capture(microphone), { error: "NotAllowedError" });
    const result = { electron: process.versions.electron, sandbox: true, fakeMicrophone: true,
      microphone: "allowed", camera: "denied", display: "intent-bound", foreignOrigin: "denied",
      cloudHome: "microphone only", selectedRemote: "microphone only", deselectedRemote: "denied" };
    if (evidence) {
      writeFileSync(join(evidence, "result.json"), JSON.stringify(result, null, 2));
      await win.webContents.executeJavaScript(`document.body.textContent=${JSON.stringify(JSON.stringify(result, null, 2))};
        document.body.style.cssText='background:#101820;color:#f5f5f5;font:18px monospace;white-space:pre-wrap;padding:24px';
        document.title='Remote microphone regression: passed';`);
      writeFileSync(join(evidence, "permissions.png"), (await win.webContents.capturePage()).toPNG());
    }
    console.log(JSON.stringify({ ...result, evidence }));
  } finally {
    clearTimeout(timeout);
    win?.destroy();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  }
}

// Do not top-level-await app readiness: Electron finishes loading this module
// before emitting ready. Keep fixture startup errors visible and bounded.
void run().then(() => app.quit(), error => { console.error(error); app.exit(1); });
