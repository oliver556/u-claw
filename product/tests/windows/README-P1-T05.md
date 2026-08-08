# P1-T05 portable data verification

Use two real Windows 11 machines and one physical USB drive. Keep evidence and snapshots on each host, outside the USB release root.

Machine A:

```powershell
$h = '.\product\tests\windows\portable-continuity.ps1'
& $h -Action Capture -ReleaseRoot E:\ -EvidencePath C:\uclaw-evidence\a-capture.json -SnapshotPath C:\uclaw-evidence\a-snapshot.json
& $h -Action DeleteCache -ReleaseRoot E:\ -EvidencePath C:\uclaw-evidence\a-delete.json -SnapshotPath C:\uclaw-evidence\a-snapshot.json
```

Start `E:\U-Claw.exe`, confirm the existing configuration/session/memory/work file, then close U-Claw:

```powershell
& $h -Action VerifyCacheRecovery -ReleaseRoot E:\ -EvidencePath C:\uclaw-evidence\a-recovery.json -SnapshotPath C:\uclaw-evidence\a-snapshot.json
```

Move the same USB to machine B. Its drive letter may differ:

```powershell
& .\product\tests\windows\portable-data-audit.ps1 -ReleaseRoot R:\ -EvidencePath C:\uclaw-evidence\b-baseline.json -BaselinePath C:\uclaw-evidence\b-host-baseline.json -CaptureBaseline
```

Start `R:\U-Claw.exe`. Open and verify the existing configuration, one prior session, memory, and a prior work file; then close U-Claw. Capture host residue and run continuity verification:

```powershell
& .\product\tests\windows\portable-data-audit.ps1 -ReleaseRoot R:\ -EvidencePath C:\uclaw-evidence\b-host-audit.json -BaselinePath C:\uclaw-evidence\b-host-baseline.json
& $h -Action Verify -ReleaseRoot R:\ -EvidencePath C:\uclaw-evidence\b-continuity.json -SnapshotPath C:\uclaw-evidence\b-snapshot.json -PeerSnapshotPath C:\uclaw-evidence\a-snapshot.json -HostAuditEvidencePath C:\uclaw-evidence\b-host-audit.json -ContinuityConfirmed
```

`Verify` passes only when machine hashes differ, both hosts report a removable USB-bus drive, relative-path/file-content hashes match, the operator confirms live app continuity, and the host-residue audit passes. `Capture` intentionally reports `needs-input`. Evidence follows `portable-continuity.schema.json`; it stores hashed machine identity and hashed content inventory, never API keys, tokens, file contents, file names, or absolute user-data paths.

Cache deletion is allowed only for `%LOCALAPPDATA%\U-Claw` with an exact `.uclaw-cache.json` ownership marker. The script rejects drive roots and reparse points. It never deletes unmarked directories.
