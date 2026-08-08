# P1-T23 Windows acceptance

This suite records machine-readable evidence. It does not replace the real hardware gate.

Required final evidence:

- Windows 10 x64 and Windows 11 x64 on two different machines.
- A non-administrator user with Microsoft Defender and real-time protection enabled.
- The same physical USB flash drive on both machines.
- First launch, second launch cache reuse, physical USB removal, process cleanup, and host residue audit.

`phase1-acceptance.ps1` rejects a directory on a fixed or virtual disk as physical USB evidence. `-AllowSimulatedDrive` exists only for Hosted Runner syntax and blocked-path smoke tests. Such a report remains `blocked` and cannot be merged into passing acceptance evidence.

Run `portable-data-audit.ps1 -CaptureBaseline` before launching. Run the first launch, second launch, exit cleanup, USB-removal observation, and final host audit scripts. The USB-removal script's `EvidencePath` must be on the host disk because the USB drive will be absent when it writes the result. Then create machine A evidence with `phase1-acceptance.ps1`. On machine B, use the same USB, pass machine A JSON via `-PeerEvidencePath`, use `-MachineRole machine-b`, and add `-ContinuityConfirmed` only after the same configuration, session, memory, and work-file probe has been opened successfully.

`phase1-requirements.json` is the canonical 6 + 38 acceptance checklist. Each ID needs a case JSON supplied through `-CaseEvidencePath`; missing IDs become `REQUIREMENT_EVIDENCE_MISSING`. Existing unit, integration, or hosted results are not silently promoted to final Windows evidence.

The final JSON contains OS build, administrator-group membership, token elevation, Defender state, hashed machine/device identity, drive identity, all three release artifact SHA-256 hashes, UTC timestamps, every case result, and explicit blockers. Machine B accepts Machine A only when its five lifecycle cases, all 44 requirement cases, environment gates, and release artifacts are complete; Machine A may remain blocked only by `two-machine-continuity` and `windows-11`.

The host baseline stores only SHA-256 path identities and file metadata. It never records user names, absolute paths, file names, API keys, tokens, sessions, or file contents.
