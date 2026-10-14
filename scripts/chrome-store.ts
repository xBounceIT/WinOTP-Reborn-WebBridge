export type ChromeStoreResponse = Record<string, unknown>;

const MAX_POLL_ATTEMPTS = 30;

export function chromeStoreApiError(status: number, body: ChromeStoreResponse): Error {
  const error = body.error;
  const details =
    typeof error === "object" && error !== null && "details" in error ? error.details : undefined;
  const invalidMetadata =
    Array.isArray(details) &&
    details.some(
      (detail: unknown) =>
        typeof detail === "object" &&
        detail !== null &&
        "reason" in detail &&
        detail.reason === "INVALID_ITEM_METADATA",
    );
  const guidance = invalidMetadata
    ? " The ZIP upload succeeded, but the Store listing is incomplete or invalid. Complete the Store Listing, Privacy practices (including a justification for every permission), and Distribution tabs in the Developer Dashboard. See docs/release.md, then retry the same release with the Retry Chrome Web Store submission workflow. The API cannot edit these dashboard fields."
    : "";
  return new Error(
    `Chrome Web Store API request failed (${status}): ${JSON.stringify(error ?? body)}${guidance}`,
  );
}

export async function waitForChromeUpload(
  upload: ChromeStoreResponse,
  fetchStatus: () => Promise<ChromeStoreResponse>,
  delay: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 2_000)),
): Promise<ChromeStoreResponse> {
  let result = upload;
  let state = upload.uploadState;
  if (state !== "SUCCEEDED" && state !== "UPLOAD_IN_PROGRESS") {
    throw new Error(`Chrome Web Store rejected the upload: ${JSON.stringify(upload)}`);
  }

  for (
    let attempt = 0;
    state === "UPLOAD_IN_PROGRESS" && attempt < MAX_POLL_ATTEMPTS;
    attempt += 1
  ) {
    await delay();
    result = await fetchStatus();
    state = result.lastAsyncUploadState;
  }
  if (state !== "SUCCEEDED") throw new Error("Chrome Web Store upload did not finish successfully");
  return result;
}

const ACCEPTED_PUBLICATION_STATES = new Set(["PENDING_REVIEW", "PUBLISHED"]);

export function assertChromePublication(response: ChromeStoreResponse, extensionId: string): void {
  if (response.itemId !== extensionId || !ACCEPTED_PUBLICATION_STATES.has(String(response.state))) {
    throw new Error(`Chrome Web Store did not accept the submission: ${JSON.stringify(response)}`);
  }
}
