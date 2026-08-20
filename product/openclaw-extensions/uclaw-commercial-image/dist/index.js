import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  createOpenAiCompatibleImageGenerationProvider,
  imageSourceUploadFileName,
} from "openclaw/plugin-sdk/image-generation";

const PROVIDER_ID = "uclaw-commercial";
const MODEL_ID = "gpt-image-2";
const DEFAULT_SIZE = "1024x1024";

function multipartEdit({ req, inputImages, model }) {
  const form = new FormData();
  form.set("model", model);
  form.set("prompt", req.prompt);
  for (const [index, image] of inputImages.entries()) {
    const mimeType = image.mimeType?.trim() || "image/png";
    form.append("image[]", new Blob([new Uint8Array(image.buffer)], { type: mimeType }), imageSourceUploadFileName({
      image,
      index,
      defaultMimeType: "image/png",
      fileNamePrefix: "uclaw-commercial-input",
    }));
  }
  return { kind: "multipart", form };
}

const provider = createOpenAiCompatibleImageGenerationProvider({
  id: PROVIDER_ID,
  label: "U-Claw Commercial Image",
  providerConfigKey: PROVIDER_ID,
  defaultModel: MODEL_ID,
  models: [MODEL_ID],
  capabilities: {
    generate: { maxCount: 4, supportsSize: true },
    edit: { enabled: true, maxCount: 4, maxInputImages: 5, supportsSize: true },
    geometry: { sizes: ["1024x1024", "1536x1024", "1024x1536"] },
    output: { formats: ["png", "jpeg", "webp"], qualities: ["low", "medium", "high", "auto"] },
  },
  defaultBaseUrl: "https://commercial.invalid/model-api/v1",
  useConfiguredRequest: true,
  defaultTimeoutMs: 180_000,
  buildGenerateRequest: ({ req, model, count }) => ({
    kind: "json",
    body: { model, prompt: req.prompt, n: count, size: req.size ?? DEFAULT_SIZE },
  }),
  buildEditRequest: multipartEdit,
  response: { defaultMimeType: "image/png", fileNamePrefix: "uclaw-commercial-image", sniffMimeType: true },
  missingApiKeyError: "U-Claw commercial image credential is unavailable",
  failureLabels: {
    generate: "U-Claw commercial image generation failed",
    edit: "U-Claw commercial image edit failed",
  },
});

export default definePluginEntry({
  id: "uclaw-commercial-image",
  name: "U-Claw Commercial Image",
  description: "OpenClaw image generation provider for U-Claw commercial models.",
  register(api) {
    api.registerImageGenerationProvider(provider);
  },
});
