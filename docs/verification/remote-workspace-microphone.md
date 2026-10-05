# Remote workspace microphone — desktop client fix

## Report and cause

On 2026-10-05 a Mac client connected to the self-hosted server displayed
“The app didn't let this page use the microphone.” The native permission
handlers allowed local renderer audio and the verified personal Cloud, but
not the selected self-hosted workspace. `perm:status` returned
`pageMic: refused`; the media permission check returned false.
This denial occurs before native Codex/WebRTC negotiation. Updating the
server renderer does not update the installed desktop main process.

## Change

`electron/main.mjs` now supplies the selected workspace from native state.
`electron/app-permissions.mjs` grants only audio for that exact origin in
the main window's main frame, with the top-level document still at the same
origin. HTTPS or loopback HTTP is required. Credentials in the destination,
subframes, other windows, camera/video, screen capture, clipboard, and
unrelated capabilities are refused. Switching or forgetting the workspace
removes eligibility for new capture requests. The existing personal Cloud
path remains separate for known Cloud entries. OS microphone consent,
sandboxing, context isolation, and the remote-safe preload are unchanged.

## Verification

The original policy reproduced the reported denial with the selected
self-hosted origin. The added regression cases failed before the patch.
After the patch, 50 tests passed across app permissions, viewer permissions,
local-origin restrictions, saved environments, and preload isolation.
Targeted lint found no warnings or errors; `git diff --check` passed.

The real Electron fixture `node scripts/smoke-app-permissions.mjs` now also
checks selected remote audio, camera/screen denial, and deselection. It uses
a fake microphone, disposable profile, and loopback fixture pages only.
On this KVM run Electron aborted before any browser test because its local
SUID sandbox helper was not configured. That fixture is NOT recorded as a
pass. No sandbox was disabled and the helper was left unchanged.

## Installation and outstanding check

These are desktop-client changes, not a KVM server deployment. Use the
normal desktop build/update process. Do not bypass macOS privacy controls,
disable Gatekeeper, or edit a signed application bundle in place.
At this checkpoint the Mac's Remote Desktop Commander connection was
offline and SSH timed out. No Mac application, permissions, or profiles were
changed. Physical Mac microphone and end-to-end voice acceptance remain
pending access to that device and installation of the updated client.
