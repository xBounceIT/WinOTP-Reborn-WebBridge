import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { decodeQr, readQrImage, sendQr } from "../src/popup/scan.ts";
import { captureBlob } from "../src/shared/page-scan.ts";
import { MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS } from "../src/popup/image-bounds.ts";
import type { NativeGateway } from "../src/popup/state.ts";
import type { ErrorCode, NativeRequest, NativeResponse } from "../src/shared/protocol.ts";
import { NativeTransportError } from "../src/shared/transport.ts";

// Synthetic QR matrices generated with qrcode-generator 2.0.4. No real account data.
const matrices = JSON.parse(
  readFileSync(new URL("./fixtures/qr.json", import.meta.url), "utf8"),
) as Record<"auth" | "url", string[]>;
const samplePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=",
  "base64",
);
const select = async () => ({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 });

function pixels(rows: string[], inverted = false): ImageData {
  const scale = 5;
  const width = (rows.length + 8) * scale;
  const data = new Uint8ClampedArray(width * width * 4);
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      const dark = rows[Math.floor(y / scale) - 4]?.[Math.floor(x / scale) - 4] === "1";
      const color = dark !== inverted ? 0 : 255;
      data.set([color, color, color, 255], (y * width + x) * 4);
    }
  }
  return { data, width, height: width, colorSpace: "srgb" };
}

test("decodes real normal and inverted authenticator QRs without interpreting secrets", () => {
  for (const inverted of [false, true]) {
    assert.equal(
      decodeQr(pixels(matrices.auth, inverted)),
      "otpauth://totp/Example:test?secret=JBSWY3DPEHPK3PXP&issuer=Example",
    );
  }
  assert.throws(() => decodeQr(pixels(matrices.url)), /not a supported/);
  assert.throws(() => decodeQr(pixels(["0"])), /No QR code/);
  assert.throws(
    () => decodeQr({ width: MAX_IMAGE_PIXELS + 1, height: 1 } as ImageData),
    /too large/,
  );
  assert.throws(() => decodeQr({ width: 0, height: 0 } as ImageData), /too large/);
});

test("decodes a QR with transparent black background pixels as displayed on white", () => {
  const image = pixels(matrices.auth);
  for (let offset = 0; offset < image.data.length; offset += 4) {
    if (image.data[offset] === 255) image.data.set([0, 0, 0, 0], offset);
  }
  assert.match(decodeQr(image), /^otpauth:\/\/totp\/Example/);
});

function setGlobal(name: string, value: unknown): () => void {
  const old = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, value });
  return () => {
    if (old) Object.defineProperty(globalThis, name, old);
    else Reflect.deleteProperty(globalThis, name);
  };
}

test("reads bounded captures, decodes only the selected crop, and clears buffers", async () => {
  for (const blob of [
    new Blob([], { type: "image/png" }),
    new Blob(["svg"], { type: "image/svg+xml" }),
    new Blob([new Uint8Array(MAX_IMAGE_BYTES + 1)], { type: "image/png" }),
  ]) {
    await assert.rejects(readQrImage(blob, select), /too large or unsupported/);
  }
  let image = pixels(matrices.auth);
  let closed = 0;
  let drawn: unknown[] = [];
  let mode = "ok";
  const canvas = {
    width: 0,
    height: 0,
    getContext() {
      return mode === "no-context"
        ? null
        : {
            drawImage(...args: unknown[]) {
              drawn = args;
            },
            getImageData() {
              return image;
            },
          };
    },
  };
  const restoreDocument = setGlobal("document", { createElement: () => canvas });
  const restoreBitmap = setGlobal("createImageBitmap", async () => {
    if (mode === "invalid") throw new Error("decoder internal detail");
    return {
      width: mode === "large" ? MAX_IMAGE_PIXELS + 1 : image.width,
      height: image.height,
      close() {
        closed++;
      },
    };
  });
  const blob = new Blob([samplePng], { type: "image/png" });
  try {
    const unreadable = new Blob([samplePng], { type: "image/png" });
    unreadable.arrayBuffer = async () => {
      throw new Error("private read failure");
    };
    await assert.rejects(readQrImage(unreadable, select), /Could not read the page capture/);
    assert.match((await readQrImage(blob, select))!, /^otpauth:\/\//);
    assert.ok(image.data.every((byte) => byte === 0));
    assert.equal(canvas.width, 0);
    assert.equal(canvas.height, 0);
    assert.equal(closed, 1);
    assert.deepEqual(drawn.slice(1), [56, 56, 113, 113, 0, 0, 113, 113]);
    await assert.rejects(
      readQrImage(blob, async () => ({ x: 0, y: 0, width: 0, height: 0 })),
      /select an area/,
    );
    assert.equal(await readQrImage(blob, async () => undefined), undefined);
    assert.equal(closed, 3);
    mode = "invalid";
    await assert.rejects(readQrImage(blob, select), /Could not read/);
    mode = "large";
    await assert.rejects(readQrImage(blob, select), /too large/);
    mode = "no-context";
    await assert.rejects(readQrImage(blob, select), /unavailable/);
    mode = "ok";
    image = pixels(matrices.url);
    await assert.rejects(readQrImage(blob, select), /not a supported/);
    assert.ok(image.data.every((byte) => byte === 0));
    assert.equal(closed, 6);
  } finally {
    restoreDocument();
    restoreBitmap();
  }
});

test("accepts only bounded browser-generated inline captures", async () => {
  const blob = captureBlob("data:image/png;base64,AQID");
  assert.equal(blob.type, "image/png");
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), new Uint8Array([1, 2, 3]));
  for (const url of [undefined, "https://example.test/image.png", "data:image/jpeg;base64,AQID"]) {
    assert.throws(() => captureBlob(url), /Could not capture/);
  }
  for (const url of [
    "data:image/png;base64,!!!",
    "data:image/png;base64," + "A".repeat(MAX_IMAGE_BYTES * 2),
  ]) {
    assert.throws(() => captureBlob(url), /too large or unreadable/);
  }
});

test("hands off exactly one opaque QR request and reports safe desktop failures", async () => {
  const requests: NativeRequest[] = [];
  let code: ErrorCode | undefined;
  const gateway: NativeGateway = {
    async request<T>(request: NativeRequest): Promise<NativeResponse<T>> {
      requests.push(request);
      return code
        ? {
            version: 1,
            requestId: request.requestId,
            ok: false,
            error: { code, message: "private desktop details" },
          }
        : { version: 1, requestId: request.requestId, ok: true, result: { accepted: true } as T };
    },
  };
  await sendQr(gateway, "otpauth://test");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.method, "importQr");
  for (const [error, message] of [
    ["APP_LOCKED", "Unlock WinOTP"],
    ["APP_NOT_RUNNING", "Open WinOTP"],
    ["INVALID_REQUEST", "Update WinOTP"],
    ["UNSUPPORTED_PROTOCOL", "Update WinOTP"],
    ["INTERNAL_ERROR", "could not accept"],
  ] as const) {
    code = error;
    await assert.rejects(sendQr(gateway, "otpauth://test"), new RegExp(message));
  }
  assert.equal(requests.length, 6);
  code = "NATIVE_HOST_ERROR";
  await assert.rejects(
    sendQr(gateway, "otpauth://test"),
    (error: unknown) => error instanceof NativeTransportError && error.reason === "NATIVE_ERROR",
  );
  assert.equal(requests.length, 7);
});

test("uncertain import delivery preserves transport reasons without retrying automatically", async () => {
  let calls = 0;
  for (const reason of [
    "TIMEOUT",
    "NATIVE_ERROR",
    "INVALID_RESPONSE",
    "HOST_UNAVAILABLE",
    "UNSUPPORTED_PROTOCOL",
  ] as const) {
    const failure = new NativeTransportError(reason);
    const gateway: NativeGateway = {
      async request() {
        calls++;
        throw failure;
      },
    };
    await assert.rejects(sendQr(gateway, "otpauth://test"), (error: unknown) => error === failure);
  }
  assert.equal(calls, 5);
});
