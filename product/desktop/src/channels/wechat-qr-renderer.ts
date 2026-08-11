import { createRequire } from "node:module";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

type QrCodeInstance = {
  addData(value: string): void;
  make(): void;
  getModuleCount(): number;
  isDark(row: number, column: number): boolean;
};

type QrCodeConstructor = new (typeNumber: number, errorCorrectLevel: number) => QrCodeInstance;
const MAX_DATA_URL_LENGTH = 16_384;

const require = createRequire(import.meta.url);

function loadQrCode(runtimeRoot: string, pluginDir: string): { QRCode: QrCodeConstructor; level: number } {
  const roots = [
    join(runtimeRoot, "node_modules", "qrcode-terminal", "vendor", "QRCode"),
    join(runtimeRoot, "node_modules", "openclaw", "node_modules", "qrcode-terminal", "vendor", "QRCode"),
    join(runtimeRoot, "openclaw", "node_modules", "qrcode-terminal", "vendor", "QRCode"),
    join(pluginDir, "node_modules", "qrcode-terminal", "vendor", "QRCode"),
  ];
  for (const root of roots) {
    try {
      const QRCode = require(join(root, "index.js")) as QrCodeConstructor;
      const levels = require(join(root, "QRErrorCorrectLevel.js")) as { L?: number };
      if (typeof QRCode === "function" && typeof levels.L === "number") return { QRCode, level: levels.L };
    } catch {
      // Try the next controlled runtime location.
    }
  }
  throw new Error("OpenClaw QR renderer is unavailable");
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const value of buffer) crc = CRC_TABLE[(crc ^ value) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function encodePng(buffer: Buffer, width: number, height: number): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const offset = row * (stride + 1);
    raw[offset] = 0;
    buffer.copy(raw, offset + 1, row * stride, row * stride + stride);
  }
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    signature,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function createOpenClawQrRenderer(runtimeRoot: string, pluginDir: string): (value: string) => Promise<string> {
  return async (value) => {
    if (value.length === 0 || value.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new Error("OpenClaw QR payload is invalid");
    }
    const { QRCode, level } = loadQrCode(runtimeRoot, pluginDir);
    const qr = new QRCode(-1, level);
    qr.addData(value);
    qr.make();
    const margin = 4;
    const modules = qr.getModuleCount();
    for (const scale of [6, 4, 3, 2, 1]) {
      const size = (modules + margin * 2) * scale;
      const pixels = Buffer.alloc(size * size * 4, 255);
      for (let row = 0; row < modules; row += 1) {
        for (let column = 0; column < modules; column += 1) {
          if (!qr.isDark(row, column)) continue;
          for (let y = 0; y < scale; y += 1) {
            for (let x = 0; x < scale; x += 1) {
              const offset = (((row + margin) * scale + y) * size + ((column + margin) * scale + x)) * 4;
              pixels[offset] = 0;
              pixels[offset + 1] = 0;
              pixels[offset + 2] = 0;
            }
          }
        }
      }
      const dataUrl = `data:image/png;base64,${encodePng(pixels, size, size).toString("base64")}`;
      if (dataUrl.length <= MAX_DATA_URL_LENGTH) return dataUrl;
    }
    throw new Error("OpenClaw QR image exceeds the IPC limit");
  };
}
