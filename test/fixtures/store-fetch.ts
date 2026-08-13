const mode = process.env.WINOTP_TEST_STORE;
let requestIndex = 0;

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

globalThis.fetch = async (input, init) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  requestIndex += 1;

  if (mode === "chrome") {
    const extensionId = process.env.CHROME_EXTENSION_ID;
    if (requestIndex === 1 && url === "https://oauth2.googleapis.com/token" && method === "POST") {
      return jsonResponse({ access_token: "test-access-token" });
    }
    if (requestIndex === 2 && url.endsWith(":upload") && method === "POST") {
      return jsonResponse({
        itemId: extensionId,
        uploadState: "SUCCEEDED",
        crxVersion: "1.0.0",
      });
    }
    if (requestIndex === 3 && url.endsWith(":publish") && method === "POST") {
      return jsonResponse({ itemId: extensionId, state: "PUBLISHED" });
    }
  }

  if (mode === "firefox") {
    const guid = "{250f3c41-cf5e-4c20-a07c-e99a8532436b}";
    if (requestIndex === 1 && url.endsWith("/addons/upload/") && method === "POST") {
      return jsonResponse({
        uuid: "test-upload",
        processed: true,
        valid: true,
        submitted: false,
        version: "1.0.0",
      });
    }
    if (requestIndex === 2 && url.includes("/addons/addon/") && method === "PUT") {
      return jsonResponse({ guid, status: "nominated" }, 201);
    }
    if (requestIndex === 3 && url.includes("/versions/v1.0.0/") && method === "PATCH") {
      return jsonResponse({ source: "source.zip", version: "1.0.0" });
    }
    if (requestIndex === 4 && url.endsWith("/eula_policy/") && method === "PATCH") {
      return jsonResponse({ privacy_policy: { "en-US": "Local only." } });
    }
  }

  throw new Error(
    `Unexpected ${mode ?? "unknown"} store request ${requestIndex}: ${method} ${url}`,
  );
};
