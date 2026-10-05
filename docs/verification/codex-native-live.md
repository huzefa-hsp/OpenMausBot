# Native Codex Live verification

## Implementation

Codex-backed one-to-one Live calls use the selected Codex CLI account and its native experimental `thread/realtime` protocol. Other engines retain the existing GPT-Live API-key path. Native failure does not silently fall back to API billing.

Voice uses the ordinary OMB turn-admission and Codex-driver process, including the selected working directory, native conversation, tool scope, permission broker, account lifecycle, and message/usage events. It does not spawn a second unscoped agent. A new conversation can start with a call; a preliminary text turn is not required. An already-running ordinary turn must finish before a call starts. Typed input during a call cannot race native voice handoffs.

The verified CLI is 0.160.0. Realtime V3, audio output, commentary handoff mode, and WebRTC SDP are negotiated explicitly. Spoken user text is recorded without dispatching it a second time; backing Codex answers use the ordinary transcript pipeline. Native payloads are omitted from transport logs and errors are sanitized. Web captions accept V3 transcript items without also counting their duplicate turn deltas.

## Automated checks — 2026-10-05

The final selected regression run passed **388/388 tests**, including native protocol/lifecycle, ordinary Codex turns, permission denial, live-call routes, controller lifecycle, call-button behavior, and media/captions. A dedicated regression covers normal Stop when the child exits before delivering its realtime closed notification. The release build and server bundle succeeded. Targeted lint reported zero warnings and zero errors.

A real source-build test and a real packaged-build test used the existing signed-in native Codex account, a disposable OMB workspace, sandboxed headless Chrome, synthetic microphone audio, and no OpenAI API key. The packaged run used a 390 × 844 mobile viewport and passed all 12 assertions:

1. No GPT-Live API key was configured; fixture onboarding was completed.
2. The actual OMB call button sent a voice-start request and WebRTC connected.
3. Spoken input received the conversation-specific answer in the same OMB chat and in returned speech.
4. A spoken file-read request recovered a newly generated code from an isolated file and spoke the result.
5. Inbound RTP contained audio bytes and nonzero audio energy.
6. Hang-up returned `ended` / `hung-up`, released the call, and a later text turn retained the same native conversation and file-code context.

Full original evidence remains on the test host, not in the user's live data:

- Source audio run: `/var/tmp/agents/omb-live-voice-verification-URW31r/evidence/`
- Packaged mobile-layout run: `/var/tmp/agents/omb-live-voice-verification-zlOftp/evidence/`
- Final test report: `/tmp/omb-native-release-tests.json`
- Packaged run log: `/tmp/omb-packaged-mobile-smoke.log`

Each live run stores a result JSON, server log, and before-call / live-answer / tool-result / text-continuity screenshots. No real user microphone was recorded.

## Reproduce safely

Build the renderer and server first with `pnpm build` and `pnpm build:server`. This opt-in smoke test consumes the selected Codex subscription and creates a disposable native test thread. Supply absolute paths for the already-authenticated Codex home and CLI:

```sh
node --experimental-strip-types scripts/smoke-native-codex-live.mjs \
  --live --live-codex-home /absolute/codex-home \
  --codex-cli /absolute/codex \
  --packaged-root /absolute/release-root --mobile
```

Omit `--packaged-root` to test the source server or `--mobile` for the desktop viewport. The fixture uses its own home/data, random loopback ports, and synthetic speech. Do not substitute the user's live OMB origin or data directory. The runner stops its own browser and server in cleanup.

## Device limits

A phone-sized Chrome viewport is not an iPhone hardware/Safari test. Physical Mac and iPhone microphone, speaker, headset routing, and native-app lifecycle were not exercised. The Mac was offline in Remote Desktop Commander. The existing iOS app shares the live SDP API and does not require a local API key before starting, but its older native caption parser does not recognize the V3 transcript-item names; native iOS live captions are not part of this release. Audio and the ordinary persisted chat transcript are separate from that caption strip.

The remote Mac renderer loads the server origin, so refreshing a Mac client connected to the upgraded host receives the updated web interface. Physical-device acceptance remains a user-device check; no native iOS binary was rebuilt or installed.
