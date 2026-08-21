# Image Generation Evidence

Status: blocked locally.

Reason: no real Windows final runtime, commercial deviceToken, and authorized image quota available in this validation window.

Expected path:

```text
U-Claw natural language prompt
-> OpenClaw chat.send
-> OpenClaw image_generate tool event
-> uclaw-commercial-image extension
-> /model-api/v1/images/generations
-> managed media artifact displayed in U-Claw
-> chat.history restores same image/artifact projection
```

Required redacted evidence:

- `chat.send` run id and session id, redacted.
- Tool event name/id/state for `image_generate`.
- `/model-api/v1/images/generations` request id and HTTP status.
- Generated PNG/JPEG/WebP saved under this directory, if shareable.
- `chat.history` projection showing same managed media id.
- Secret scan result for log bundle.

Fail if U-Claw directly calls `/images/generations` from renderer/Electron default chat path without OpenClaw tool chain.
