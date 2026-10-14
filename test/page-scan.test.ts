import assert from "node:assert/strict";
import test from "node:test";
import { captureSenderPage, startPageScan } from "../src/background/page-scan.ts";
import {
  isPageScanMessage,
  isPageSender,
  pageMessage,
  pageScanError,
} from "../src/shared/page-scan.ts";
import { createRequest } from "../src/shared/protocol.ts";
import type { RuntimeApi, RuntimeMessageSender } from "../src/shared/webextension.ts";

const sender: RuntimeMessageSender = {
  id: "extension",
  frameId: 0,
  url: "https://example.test/setup",
  tab: { id: 10, windowId: 7 },
};

test("page scan routes allow only top-level page captures and opaque QR imports", () => {
  assert.ok(isPageScanMessage({ kind: "qr-start" }));
  assert.ok(isPageScanMessage({ kind: "qr-capture" }));
  assert.ok(
    isPageScanMessage({
      kind: "qr-import",
      request: createRequest("importQr", { text: "otpauth://test" }),
    }),
  );
  for (const request of [
    null,
    {},
    { kind: "qr-start", extra: true },
    { kind: "qr-import", request: createRequest("listAccounts") },
    { kind: "qr-import", request: createRequest("getTotp", { accountId: "test" }) },
  ])
    assert.equal(isPageScanMessage(request), false);
  assert.equal(isPageSender(sender), true);
  for (const source of [
    {},
    { ...sender, frameId: 1 },
    { ...sender, url: "moz-extension://test/popup.html" },
    { ...sender, tab: { windowId: 7 } },
  ])
    assert.equal(isPageSender(source), false);
  assert.equal(pageScanError({ error: "safe message" }), "safe message");
  assert.equal(pageScanError(undefined), undefined);
  assert.equal(pageScanError({ error: 42 }), undefined);
});

test("overlay injection and capture target the invoking page and reject browser failures", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  let mode = "ok";
  let queries = 0;
  let captured = 0;
  const runtime = { lastError: undefined as { message: string } | undefined };
  const calls: unknown[] = [];
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      runtime,
      tabs: {
        query(options: unknown, callback: (tabs?: unknown[]) => void) {
          calls.push(options);
          queries++;
          if (mode === "missing") {
            runtime.lastError = { message: "private error" };
            callback();
          } else
            callback([
              {
                id: mode === "changed" || (mode === "changed-after" && queries === 2) ? 11 : 10,
                windowId: 7,
              },
            ]);
        },
        sendMessage(
          tabId: number,
          message: unknown,
          options: unknown,
          callback: (reply: unknown) => void,
        ) {
          calls.push([tabId, message, options]);
          callback(mode === "no-listener" ? undefined : { ok: true });
        },
        captureVisibleTab(windowId: number, options: unknown, callback: (url?: string) => void) {
          assert.equal(windowId, 7);
          assert.deepEqual(options, { format: "png" });
          captured++;
          if (mode === "capture-denied") {
            runtime.lastError = { message: "private capture error" };
            callback();
          } else if (mode === "large")
            callback("data:image/png;base64," + "A".repeat(15 * 1024 * 1024));
          else callback("data:image/png;base64,AQID");
        },
      },
      scripting: {
        executeScript(options: unknown, callback: (results?: unknown[]) => void) {
          calls.push(options);
          if (mode === "restricted") {
            runtime.lastError = { message: "private permission error" };
            callback();
          } else callback(mode === "script-error" ? [{ error: "private" }] : [{}]);
        },
      },
    },
  });
  try {
    await startPageScan();
    assert.deepEqual(calls, [
      { active: true, currentWindow: true },
      { target: { tabId: 10, frameIds: [0] }, files: ["overlay.js"] },
      [10, { kind: "activate-qr-overlay" }, { frameId: 0 }],
    ]);
    assert.equal(captured, 0);
    assert.equal(await captureSenderPage(sender), "data:image/png;base64,AQID");
    assert.equal(captured, 1);
    for (const [failure, pattern] of [
      ["restricted", /does not allow overlays/],
      ["script-error", /does not allow overlays/],
      ["no-listener", /Could not show/],
      ["missing", /Could not find/],
    ] as const) {
      runtime.lastError = undefined;
      mode = failure;
      await assert.rejects(startPageScan(), pattern);
    }
    for (const [failure, pattern] of [
      ["changed", /active tab changed/],
      ["changed-after", /active tab changed/],
      ["capture-denied", /Could not capture/],
      ["large", /too large/],
    ] as const) {
      runtime.lastError = undefined;
      mode = failure;
      queries = 0;
      await assert.rejects(captureSenderPage(sender), pattern);
    }
    Object.defineProperty(globalThis, "chrome", { configurable: true, value: {} });
    await assert.rejects(startPageScan(), /unavailable/);
  } finally {
    if (original) Object.defineProperty(globalThis, "chrome", original);
    else Reflect.deleteProperty(globalThis, "chrome");
  }
});

test("page-message transport reports runtime failures with safe text", async () => {
  const runtime: Pick<RuntimeApi, "sendMessage" | "lastError"> = {
    sendMessage(_message, callback) {
      callback({ ok: true });
    },
  };
  assert.deepEqual(await pageMessage(runtime, { kind: "qr-start" }), { ok: true });
  await assert.rejects(
    pageMessage(
      { lastError: { message: "private" }, sendMessage: runtime.sendMessage },
      { kind: "qr-start" },
    ),
    /Could not start/,
  );
  await assert.rejects(
    pageMessage(
      {
        sendMessage() {
          throw new Error("private");
        },
      },
      { kind: "qr-start" },
    ),
    /unavailable/,
  );
});
