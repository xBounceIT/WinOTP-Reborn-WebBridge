import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  capturePage,
  decodeQr,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PIXELS,
  readQrImage,
  sendQr,
} from "../src/popup/scan.ts";
import type { NativeGateway } from "../src/popup/state.ts";
import type { ErrorCode, NativeRequest, NativeResponse } from "../src/shared/protocol.ts";
import { NativeTransportError } from "../src/shared/transport.ts";

// Synthetic QR matrices generated with qrcode-generator 2.0.4. No real account data.
const matrices = JSON.parse(
  readFileSync(new URL("./fixtures/qr.json", import.meta.url), "utf8"),
) as Record<"auth" | "url", string[]>;
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

test("image scan UI waits for acknowledgement, prevents duplicate submissions, and permits retry", async () => {
  let markup = "";
  let change: (() => void) | undefined;
  let retry: (() => void) | undefined;
  let reply: ((response: unknown) => void) | undefined;
  let pending: NativeRequest | undefined;
  let imports = 0;
  const fileInput = {
    value: "",
    files: [] as Blob[],
    addEventListener(_event: string, listener: () => void) {
      change = listener;
    },
  };
  const root = {
    get innerHTML() {
      return markup;
    },
    set innerHTML(value: string) {
      markup = value;
    },
    querySelector(selector: string) {
      if (selector === "[data-action='retry']" && markup.includes('data-action="retry"')) {
        return {
          addEventListener(_event: string, listener: () => void) {
            retry = listener;
          },
        };
      }
      return selector === "[data-qr-file]" && markup.includes("data-qr-file") ? fileInput : null;
    },
    querySelectorAll() {
      return [];
    },
  };
  const restore = [
    setGlobal("location", { search: "?scan=image" }),
    setGlobal("window", { clearInterval() {} }),
    setGlobal("document", {
      querySelector: () => root,
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ drawImage() {}, getImageData: () => pixels(matrices.auth) }),
      }),
    }),
    setGlobal("createImageBitmap", async () => ({
      width: pixels(matrices.auth).width,
      height: pixels(matrices.auth).height,
      close() {},
    })),
    setGlobal("chrome", {
      runtime: {
        sendMessage(request: NativeRequest, callback: (response: unknown) => void) {
          if (request.method === "importQr") {
            imports++;
            pending = request;
            reply = callback;
            return;
          }
          const result =
            request.method === "ping"
              ? { protocolVersion: 1, bridgeVersion: "1.0.0" }
              : request.method === "getStatus"
                ? { state: "unlocked", appVersion: "1.0.0" }
                : {
                    accounts: [
                      { id: "test-account", issuer: "Private issuer", name: "Private account" },
                    ],
                  };
          callback({
            kind: "native-response",
            response: { version: 1, requestId: request.requestId, ok: true, result },
          });
        },
      },
    }),
  ];
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  try {
    await import("../src/popup/main.ts");
    await tick();
    assert.match(markup, /Choose QR image/);
    assert.match(markup, /Private account/);
    assert.doesNotMatch(markup, /data-scan-page/);
    change?.(); // Cancelling file selection does not send anything.
    assert.equal(imports, 0);
    fileInput.files = [new Blob(["image"], { type: "image/png" })];
    change?.();
    change?.();
    await tick();
    assert.equal(imports, 1);
    assert.equal(fileInput.value, "");
    assert.match(markup, /Sending to WinOTP/);
    assert.match(markup, /disabled/);
    assert.doesNotMatch(markup, /QR sent|secret=|JBSWY/);
    reply?.({
      kind: "native-response",
      response: { version: 1, requestId: pending?.requestId, ok: true, result: { accepted: true } },
    });
    await tick();
    assert.match(markup, /QR sent/);
    assert.doesNotMatch(markup, /disabled|secret=|JBSWY/);
    change?.();
    await tick();
    assert.equal(imports, 2);
    reply?.({
      kind: "native-response",
      response: {
        version: 1,
        requestId: pending?.requestId,
        ok: false,
        error: { code: "APP_LOCKED", message: "private" },
      },
    });
    await tick();
    assert.match(markup, /Unlock WinOTP/);
    assert.match(markup, /connection--locked/);
    assert.doesNotMatch(
      markup,
      /QR sent|disabled|private|Private account|Private issuer|data-qr-file/,
    );
    change?.(); // A detached file input must not bypass the locked state.
    await tick();
    assert.equal(imports, 2);
    retry?.();
    await tick();
    assert.match(markup, /Private account/);
    assert.doesNotMatch(markup, /Unlock WinOTP/);
    change?.();
    await tick();
    assert.equal(imports, 3);
    reply?.({
      kind: "native-response",
      response: {
        version: 1,
        requestId: pending?.requestId,
        ok: false,
        error: { code: "APP_NOT_RUNNING", message: "private" },
      },
    });
    await tick();
    assert.match(markup, /connection--app-not-running/);
    assert.doesNotMatch(markup, /Private account|Private issuer|data-qr-file/);
  } finally {
    for (const undo of restore.reverse()) undo();
  }
});

test("reads local images, bounds inputs, and clears canvas and pixel buffers", async () => {
  for (const blob of [
    new Blob([], { type: "image/png" }),
    new Blob(["svg"], { type: "image/svg+xml" }),
    new Blob([new Uint8Array(MAX_IMAGE_BYTES + 1)], { type: "image/png" }),
  ]) {
    await assert.rejects(readQrImage(blob), /Choose a PNG/);
  }
  let image = pixels(matrices.auth);
  let closed = 0;
  let mode = "ok";
  const canvas = {
    width: 0,
    height: 0,
    getContext() {
      return mode === "no-context"
        ? null
        : {
            drawImage() {},
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
  const blob = new Blob(["test"], { type: "image/png" });
  try {
    assert.match(await readQrImage(blob), /^otpauth:\/\//);
    assert.ok(image.data.every((byte) => byte === 0));
    assert.equal(canvas.width, 0);
    assert.equal(canvas.height, 0);
    assert.equal(closed, 1);
    mode = "invalid";
    await assert.rejects(readQrImage(blob), /Could not read/);
    mode = "large";
    await assert.rejects(readQrImage(blob), /too large/);
    mode = "no-context";
    await assert.rejects(readQrImage(blob), /unavailable/);
    mode = "ok";
    image = pixels(matrices.url);
    await assert.rejects(readQrImage(blob), /not a supported/);
    assert.ok(image.data.every((byte) => byte === 0));
    assert.equal(closed, 4);
  } finally {
    restoreDocument();
    restoreBitmap();
  }
});

test("captures only browser-generated inline images and handles denied capture", async () => {
  let mode = "ok";
  const runtime = { lastError: undefined as undefined | { message: string } };
  const restore = setGlobal("chrome", {
    runtime,
    tabs: {
      captureVisibleTab(options: unknown, callback: (url: string) => void) {
        assert.deepEqual(options, { format: "png" });
        if (mode === "throws") throw new Error("capture failed");
        callback(
          mode === "url"
            ? "https://example.test/image.png"
            : mode === "large"
              ? "data:image/png;base64," + "A".repeat(MAX_IMAGE_BYTES * 2)
              : "data:image/png;base64,AQID",
        );
      },
    },
  });
  try {
    const blob = await capturePage();
    assert.equal(blob.type, "image/png");
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), new Uint8Array([1, 2, 3]));
    runtime.lastError = { message: "permission denied" };
    await assert.rejects(capturePage(), /Could not capture/);
    runtime.lastError = undefined;
    mode = "url";
    await assert.rejects(capturePage(), /Could not capture/);
    mode = "large";
    await assert.rejects(capturePage(), /too large/);
    mode = "throws";
    await assert.rejects(capturePage());
    const missing = setGlobal("chrome", {});
    try {
      await assert.rejects(capturePage(), /unavailable/);
    } finally {
      missing();
    }
  } finally {
    restore();
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
});

test("uncertain import delivery tells the user to inspect WinOTP without retrying automatically", async () => {
  let calls = 0;
  for (const reason of [
    "TIMEOUT",
    "NATIVE_ERROR",
    "INVALID_RESPONSE",
    "HOST_UNAVAILABLE",
  ] as const) {
    const gateway: NativeGateway = {
      async request() {
        calls++;
        throw new NativeTransportError(reason);
      },
    };
    await assert.rejects(
      sendQr(gateway, "otpauth://test"),
      /Check WinOTP for a pending import before scanning again/,
    );
  }
  assert.equal(calls, 4);
});
