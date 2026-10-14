import assert from "node:assert/strict";
import test from "node:test";
import {
  assertChromePublication,
  chromeStoreApiError,
  waitForChromeUpload,
} from "../scripts/chrome-store.ts";

test("explains dashboard metadata failures while preserving Google's error details", () => {
  const body = {
    error: {
      message: "Your submission does not meet the requirements",
      details: [{ reason: "INVALID_ITEM_METADATA" }],
    },
  };
  const error = chromeStoreApiError(400, body);
  assert.match(error.message, /INVALID_ITEM_METADATA/u);
  assert.match(error.message, /justification for every permission/u);
  assert.match(error.message, /retry the same release/u);
  assert.match(error.message, /API cannot edit/u);

  for (const body of [{}, { error: null }, { error: { details: [null, "invalid"] } }]) {
    const error = chromeStoreApiError(401, body);
    assert.match(error.message, /failed \(401\)/u);
    assert.doesNotMatch(error.message, /ZIP upload succeeded/u);
  }
});

test("polls Chrome's lastAsyncUploadState until an asynchronous upload succeeds", async () => {
  let polls = 0;
  const result = await waitForChromeUpload(
    { uploadState: "UPLOAD_IN_PROGRESS" },
    async () => {
      polls += 1;
      return { lastAsyncUploadState: polls === 1 ? "UPLOAD_IN_PROGRESS" : "SUCCEEDED" };
    },
    async () => {},
  );
  assert.equal(polls, 2);
  assert.deepEqual(result, { lastAsyncUploadState: "SUCCEEDED" });
});

test("rejects failed, malformed, and stalled Chrome uploads", async () => {
  await assert.rejects(
    waitForChromeUpload(
      { uploadState: "FAILED" },
      async () => ({}),
      async () => {},
    ),
    /rejected the upload/u,
  );
  await assert.rejects(
    waitForChromeUpload(
      { uploadState: "UPLOAD_IN_PROGRESS" },
      async () => ({}),
      async () => {},
    ),
    /did not finish successfully/u,
  );
});

test("accepts only successful Chrome publication states for the expected item", () => {
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  assert.doesNotThrow(() =>
    assertChromePublication({ itemId: extensionId, state: "PENDING_REVIEW" }, extensionId),
  );
  for (const response of [
    { itemId: "ponmlkjihgfedcbaponmlkjihgfedcba", state: "PENDING_REVIEW" },
    { itemId: extensionId, state: "REJECTED" },
    { itemId: extensionId, state: "STAGED" },
    { itemId: extensionId },
  ]) {
    assert.throws(() => assertChromePublication(response, extensionId), /did not accept/u);
  }
});
