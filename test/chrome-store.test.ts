import assert from "node:assert/strict";
import test from "node:test";
import { assertChromePublication, waitForChromeUpload } from "../scripts/chrome-store.ts";

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
    waitForChromeUpload({ uploadState: "FAILED" }, async () => ({}), async () => {}),
    /rejected the upload/u,
  );
  await assert.rejects(
    waitForChromeUpload({ uploadState: "UPLOAD_IN_PROGRESS" }, async () => ({}), async () => {}),
    /did not finish successfully/u,
  );
});

test("accepts only successful Chrome publication states for the expected item", () => {
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  assert.doesNotThrow(() => assertChromePublication({ itemId: extensionId, state: "PENDING_REVIEW" }, extensionId));
  for (const response of [
    { itemId: "ponmlkjihgfedcbaponmlkjihgfedcba", state: "PENDING_REVIEW" },
    { itemId: extensionId, state: "REJECTED" },
    { itemId: extensionId, state: "STAGED" },
    { itemId: extensionId },
  ]) {
    assert.throws(() => assertChromePublication(response, extensionId), /did not accept/u);
  }
});
