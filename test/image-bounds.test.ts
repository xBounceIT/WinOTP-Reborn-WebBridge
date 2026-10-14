import assert from "node:assert/strict";
import test from "node:test";
import { validateImageHeader, MAX_IMAGE_PIXELS } from "../src/popup/image-bounds.ts";
import { readQrImage } from "../src/popup/scan.ts";

function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12);
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

function jpeg(width: number, height: number, marker = 0xc0): Buffer {
  // APP segment, fill bytes, frame header, then start of scan.
  const header = Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0,
    4,
    0,
    0,
    0xff,
    0xff,
    marker,
    0,
    8,
    8,
    0,
    0,
    0,
    0,
    0,
    0xff,
    0xda,
  ]);
  header.writeUInt16BE(height, 14);
  header.writeUInt16BE(width, 16);
  return header;
}

function chunk(name: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(name);
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload, Buffer.alloc(payload.length % 2)]);
}

function webp(...chunks: Buffer[]): Buffer {
  const header = Buffer.alloc(12);
  header.write("RIFF");
  header.write("WEBP", 8);
  const image = Buffer.concat([header, ...chunks]);
  image.writeUInt32LE(image.length - 8, 4);
  return image;
}

function vp8(width: number, height: number): Buffer {
  const data = Buffer.from([0, 0, 0, 0x9d, 1, 0x2a, 0, 0, 0, 0]);
  data.writeUInt16LE(width, 6);
  data.writeUInt16LE(height, 8);
  return chunk("VP8 ", data);
}

function vp8l(width: number, height: number): Buffer {
  const data = Buffer.alloc(5);
  data[0] = 0x2f;
  data.writeUInt32LE(width - 1 + (height - 1) * 16384, 1);
  return chunk("VP8L", data);
}

function vp8x(width: number, height: number, flags = 0): Buffer {
  const data = Buffer.alloc(10);
  data[0] = flags;
  data.writeUIntLE(width - 1, 4, 3);
  data.writeUIntLE(height - 1, 7, 3);
  return chunk("VP8X", data);
}

test("bounds PNG, baseline/progressive JPEG and all still WebP headers", () => {
  for (const [type, data] of [
    ["image/png", png(4096, 4096)],
    ["image/jpeg", jpeg(4096, 4096)],
    ["image/jpeg", jpeg(100, 100, 0xc1)],
    ["image/jpeg", jpeg(100, 100, 0xc2)],
    ["image/webp", webp(vp8(100, 100))],
    ["image/webp", webp(vp8l(100, 100))],
    ["image/webp", webp(vp8x(100, 100), chunk("ICCP", Buffer.from([0])), vp8l(100, 100))],
  ] as const) {
    validateImageHeader(data, type, MAX_IMAGE_PIXELS);
  }
});

test("rejects decompression bombs before invoking the browser decoder", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap");
  let decoded = 0;
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    value: () => {
      decoded++;
      throw new Error("decoder must not run");
    },
  });
  try {
    for (const [type, data] of [
      ["image/png", png(100000, 100000)],
      ["image/jpeg", jpeg(65535, 65535)],
      ["image/webp", webp(vp8(16383, 16383))],
      ["image/webp", webp(vp8l(16384, 16384))],
      ["image/webp", webp(vp8x(100000, 100000), vp8(100, 100))],
      ["image/webp", webp(vp8x(100, 100), vp8l(16384, 16384))],
    ] as const) {
      await assert.rejects(
        readQrImage(new Blob([new Uint8Array(data)], { type }), async () => undefined),
        /too large\. Try a smaller browser window/,
      );
    }
    await assert.rejects(
      readQrImage(new Blob(["bad header"], { type: "image/png" }), async () => undefined),
      /dimensions\. Reopen the extension/,
    );
    assert.equal(decoded, 0);
  } finally {
    if (original) Object.defineProperty(globalThis, "createImageBitmap", original);
    else Reflect.deleteProperty(globalThis, "createImageBitmap");
  }
});

test("fails closed on truncated, ambiguous and animated image headers", () => {
  for (const [type, data] of [
    ["image/png", png(0, 1)],
    ["image/png", jpeg(10, 10)],
    ["image/jpeg", png(10, 10)],
    ["image/jpeg", Buffer.from([0xff, 0xd8])],
    ["image/jpeg", Buffer.from([0xff, 0xd8, 0])],
    ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1])],
    ["image/jpeg", jpeg(10, 10).subarray(0, 19)],
    ["image/jpeg", Buffer.concat([jpeg(10, 10).subarray(0, 19), jpeg(10, 10).subarray(8)])],
    ["image/jpeg", jpeg(10, 10, 0xc3)],
    ["image/webp", webp(vp8x(10, 10, 2), vp8(10, 10))],
    ["image/webp", webp(chunk("ANIM", Buffer.alloc(6)))],
    ["image/webp", webp(chunk("ANMF", Buffer.alloc(16)))],
    ["image/webp", webp(vp8l(10, 10), vp8l(10, 10))],
    ["image/webp", webp(vp8(10, 10), vp8x(10, 10))],
    ["image/webp", webp(chunk("VP8 ", Buffer.alloc(10)))],
    ["image/webp", webp(chunk("VP8L", Buffer.alloc(5)))],
    ["image/webp", webp(chunk("VP8X", Buffer.alloc(8)))],
    ["image/webp", webp(chunk("ICCP", Buffer.alloc(1)))],
    ["image/gif", png(10, 10)],
  ] as const) {
    assert.throws(() => validateImageHeader(data, type, MAX_IMAGE_PIXELS), /dimensions/);
  }
  for (const [type, data] of [
    ["image/png", png(10, 10)],
    ["image/jpeg", jpeg(10, 10)],
    ["image/webp", webp(vp8(10, 10))],
  ] as const) {
    for (let length = 0; length < data.length; length++) {
      assert.throws(
        () => validateImageHeader(data.subarray(0, length), type, MAX_IMAGE_PIXELS),
        /dimensions/,
      );
    }
  }
  const oversizedChunk = webp(vp8(10, 10));
  oversizedChunk.writeUInt32LE(0xffffffff, 16);
  assert.throws(
    () => validateImageHeader(oversizedChunk, "image/webp", MAX_IMAGE_PIXELS),
    /dimensions/,
  );
});
