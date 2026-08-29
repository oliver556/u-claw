# U-Claw Portable Update And Launcher Acceptance

Scope: `u-claw-app-dev` only. Archived `u-claw-app` and `product` stay read-only.

## Portable Update Rule

Update may replace only:

- `app/`
- `U-Claw Launcher.app`
- `U-Claw Launcher.exe`
- `Mac-Start-App.command`
- `Windows-Start-App.bat`
- `UCLAW-PACKAGE-NOTES.txt`

Update must not overwrite, delete, or recreate existing `data/`.

New USB disk initializes `data/` only when `<USB>/U-Claw/data` does not exist.

Existing USB disk must preserve:

- chats
- skills
- memory
- license
- logs
- generated image/video/audio/file artifacts
- `data/.openclaw/openclaw.json`

Packaging script prints:

- `data initialized <path>` for new disk.
- `data preserved <path>` for existing disk.

## Win/Mac Launcher Behavior

Startup:

- User opens native launcher first.
- Native progress window stays hidden during normal fast launch.
- Native progress window appears only during copy, extract, sync, or long wait.
- Electron main window stays hidden until Gateway ready/App ready.
- After Gateway ready/App ready, Electron opens directly to main UI.
- No Electron blank window before extraction or loading.
- Clean same-machine restart reuses app cache.
- `<USB>/U-Claw/data` is the preserved USB data master.
- Runtime uses a per-USB computer data cache for speed.
- Electron Control UI profile uses local per-USB/per-platform storage outside `<USB>/U-Claw/data`, so device identity is never shared between macOS and Windows.
- Startup syncs USB `data/` to the per-USB runtime cache only when the cache is missing, dirty, or not marked current.
- Clean same-machine restart skips USB-to-runtime data sync and opens from the runtime cache.
- Running app syncs runtime cache back to USB periodically and during shutdown.
- Runtime sync never writes runtime-only `data/.openclaw/openclaw.json` or `openclaw.json.last-good` back to USB master data.
- Two USB disks use different cache IDs, so their data does not merge.
- Generated image/video/audio/file artifacts may be produced in local cache first, but must be copied back to USB `data/` and referenced by a portable artifact identity before the result is considered preserved.
- Generated artifact preview accepts both runtime cache media and USB media roots. If an older transcript contains another machine's absolute cache path under `.openclaw/media`, the backend remaps it to the same relative media path under the current runtime/USB media root before serving.
- Packaging/deploy must remove macOS AppleDouble metadata files such as `._U-Claw Launcher.exe`, because Windows can expose them as confusing fake entry files.

Shutdown:

- Closing main window shows confirmation first.
- After confirmation, app shows shutdown progress.
- Shutdown progress comes from app shutdown page, not launcher popup.
- Launcher stays hidden during shutdown, then stops gateway, stops video adapter, stops config server, records clean markers, and exits.
- Launcher monitors `Shutdown complete`.
- If user opens launcher again during shutdown, launcher records one relaunch request and does not start a second instance.
- After shutdown, queued relaunch starts once.

## Acceptance Checklist

Build and syntax:

- `node -c src/main.js`
- `node -c scripts/package-portable.js`
- `bash -n scripts/Mac-Start-App.command`
- Windows launcher builds as GUI exe: `PE32+ executable (GUI) x86-64`
- Mac launcher builds universal and passes `codesign --verify --deep --strict`

USB deployment:

- Formal build command ran at least once without `--skip-build`.
- `/Volumes/UCLAW-00` prints `data preserved`.
- `/Volumes/U_CLAW_1` prints `data preserved`.
- Both USB disks have correct entry files:
  - `<USB>/U-Claw/U-Claw Launcher.exe`
  - `<USB>/U-Claw/U-Claw Launcher.app/Contents/MacOS/U-Claw Launcher`
- Both Windows zip hashes match.
- Existing `<USB>/U-Claw/data/.openclaw/openclaw.json` hash is unchanged by deployment.
- No `._*.exe`, `._*.bat`, or `._*.command` AppleDouble metadata files remain beside Windows-visible entry files.

Mac runtime:

- Double-click/open `<USB>/U-Claw/U-Claw Launcher.app`.
- No Terminal window.
- No Electron blank window before ready.
- App enters main UI after Gateway ready/App ready.
- Closing asks confirmation.
- Confirmed close shows shutdown progress.
- Logs contain `Shutdown complete`.
- No remaining U-Claw launcher, Electron, `Mac-Start-App.command`, or `openclaw.mjs gateway run` process from this launch.
- Immediate reopen after close does not create double process, double popup, or stuck loading.
- Existing generated image/video/audio/file artifacts from another computer still render after moving the USB disk, as long as the file exists under `<USB>/U-Claw/data/.openclaw/media`.

Windows runtime:

- Double-click `<USB>\U-Claw\U-Claw Launcher.exe`.
- No console window.
- No Electron blank window before ready.
- Native progress appears during first copy/extract/sync.
- App enters main UI after Gateway ready/App ready.
- Closing asks confirmation.
- Confirmed close shows shutdown progress in app, with no launcher popup.
- Immediate reopen after close does not create double process, double popup, or stuck loading.

## Logs To Return

Windows:

```text
<USB>\U-Claw\data\logs\U-Claw-Launcher.log
<USB>\U-Claw\data\logs\Windows-Start-App.log
%LOCALAPPDATA%\U-Claw\launcher-logs\U-Claw-Launcher.log
%LOCALAPPDATA%\U-Claw\launcher-logs\Windows-Start-App.log
<USB>\U-Claw\data\logs\main.log
<USB>\U-Claw\data\logs\gateway.log
```

macOS:

```text
<USB>/U-Claw/data/logs/U-Claw-Launcher.log
<USB>/U-Claw/data/logs/Mac-Start-App.log
<USB>/U-Claw/data/logs/main.log
<USB>/U-Claw/data/logs/gateway.log
~/Library/Caches/U-Claw/launcher-logs/U-Claw-Launcher.log
~/Library/Caches/U-Claw/launcher-logs/Mac-Start-App.log
```
