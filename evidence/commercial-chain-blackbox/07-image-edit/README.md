# Image Edit Evidence

Status: blocked locally.

Reason: no real Windows final runtime, commercial deviceToken, existing generated image, and authorized edit quota available in this validation window.

Expected path:

```text
First turn image generation
-> image visible immediately in U-Claw
-> second turn: 修改上一张图片
-> OpenClaw chat.send on same session
-> OpenClaw image_generate edit event
-> uclaw-commercial-image extension multipart edit
-> /model-api/v1/images/edits
-> edited managed media artifact displayed
-> chat.history restores original and edited image projections
```

Known local code state:

- Server proxy route exists for `/model-api/v1/images/edits`.
- Extension builds multipart `image[]`, `model`, and `prompt`.
- True result remains blocked until real service/runtime test.

Required redacted evidence:

- Original image artifact id.
- Edit tool call id/state/result.
- `/model-api/v1/images/edits` request id and HTTP status.
- Edited PNG/JPEG/WebP saved under this directory, if shareable.
- History after app restart showing edited artifact.

Fail if server/protocol rejects multipart edit, OpenClaw cannot provide source image, or U-Claw bypasses OpenClaw tool chain.

