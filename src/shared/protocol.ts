export const PROTOCOL_VERSION = 1 as const;
export const NATIVE_HOST_NAME = "com.xbounceit.winotp";
export const MAX_NATIVE_MESSAGE_BYTES = 64 * 1024;

export type BrowserAccount = Readonly<{
  id: string;
  issuer: string;
  name: string;
}>;

export type TotpResult = Readonly<{
  code: string;
  expiresIn: number;
  period: number;
}>;

export type StatusResult = Readonly<{
  state: "locked" | "unlocked";
  appVersion: string;
}>;

export type PingResult = Readonly<{
  protocolVersion: typeof PROTOCOL_VERSION;
  bridgeVersion: string;
}>;

export type NativeRequest =
  | Readonly<{ version: 1; requestId: string; method: "ping" }>
  | Readonly<{ version: 1; requestId: string; method: "getStatus" }>
  | Readonly<{ version: 1; requestId: string; method: "listAccounts" }>
  | Readonly<{
      version: 1;
      requestId: string;
      method: "getTotp";
      params: Readonly<{ accountId: string }>;
    }>;

export type ErrorCode =
  | "APP_NOT_RUNNING"
  | "APP_LOCKED"
  | "ACCOUNT_NOT_FOUND"
  | "INVALID_REQUEST"
  | "UNSUPPORTED_PROTOCOL"
  | "NATIVE_HOST_ERROR"
  | "INTERNAL_ERROR";

export type NativeError = Readonly<{
  code: ErrorCode;
  message: string;
}>;

export type NativeResponse<T = unknown> =
  | Readonly<{ version: 1; requestId: string; ok: true; result: T }>
  | Readonly<{ version: 1; requestId: string; ok: false; error: NativeError }>;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const ERROR_CODES = new Set<ErrorCode>([
  "APP_NOT_RUNNING",
  "APP_LOCKED",
  "ACCOUNT_NOT_FOUND",
  "INVALID_REQUEST",
  "UNSUPPORTED_PROTOCOL",
  "NATIVE_HOST_ERROR",
  "INTERNAL_ERROR",
]);

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasUtf8Length(value: string, minimum: number, maximum: number): boolean {
  const length = new TextEncoder().encode(value).byteLength;
  return length >= minimum && length <= maximum;
}

export function isValidId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export function createRequest(method: "ping" | "getStatus" | "listAccounts"): NativeRequest;
export function createRequest(method: "getTotp", params: { accountId: string }): NativeRequest;
export function createRequest(
  method: NativeRequest["method"],
  params?: { accountId: string },
): NativeRequest {
  const requestId = crypto.randomUUID();
  if (method === "getTotp") {
    if (!params || !isValidId(params.accountId)) {
      throw new TypeError("A valid account ID is required");
    }
    return { version: PROTOCOL_VERSION, requestId, method, params };
  }
  return { version: PROTOCOL_VERSION, requestId, method };
}

export function isNativeRequest(value: unknown): value is NativeRequest {
  if (!isRecord(value) || value.version !== PROTOCOL_VERSION || !isValidId(value.requestId)) {
    return false;
  }
  if (value.method === "getTotp") {
    return (
      hasExactKeys(value, ["version", "requestId", "method", "params"]) &&
      isRecord(value.params) &&
      hasExactKeys(value.params, ["accountId"]) &&
      isValidId(value.params.accountId)
    );
  }
  return (
    (value.method === "ping" || value.method === "getStatus" || value.method === "listAccounts") &&
    hasExactKeys(value, ["version", "requestId", "method"])
  );
}

function isError(value: unknown): value is NativeError {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["code", "message"]) &&
    typeof value.code === "string" &&
    ERROR_CODES.has(value.code as ErrorCode) &&
    typeof value.message === "string" &&
    hasUtf8Length(value.message, 1, 256)
  );
}

function isAccount(value: unknown): value is BrowserAccount {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["id", "issuer", "name"]) &&
    isValidId(value.id) &&
    typeof value.issuer === "string" &&
    hasUtf8Length(value.issuer, 0, 256) &&
    typeof value.name === "string" &&
    hasUtf8Length(value.name, 1, 256)
  );
}

function isAccountList(value: unknown): value is readonly BrowserAccount[] {
  if (!Array.isArray(value) || value.length > 10_000) return false;
  const ids = new Set<string>();
  return value.every((account) => {
    if (!isAccount(account) || ids.has(account.id)) return false;
    ids.add(account.id);
    return true;
  });
}

function isResultFor(request: NativeRequest, result: unknown): boolean {
  if (!isRecord(result)) return false;
  switch (request.method) {
    case "ping":
      return (
        hasExactKeys(result, ["protocolVersion", "bridgeVersion"]) &&
        result.protocolVersion === PROTOCOL_VERSION &&
        typeof result.bridgeVersion === "string" &&
        VERSION_PATTERN.test(result.bridgeVersion)
      );
    case "getStatus":
      return (
        hasExactKeys(result, ["state", "appVersion"]) &&
        (result.state === "locked" || result.state === "unlocked") &&
        typeof result.appVersion === "string" &&
        hasUtf8Length(result.appVersion, 1, 64)
      );
    case "listAccounts":
      return hasExactKeys(result, ["accounts"]) && isAccountList(result.accounts);
    case "getTotp":
      return (
        hasExactKeys(result, ["code", "expiresIn", "period"]) &&
        typeof result.code === "string" &&
        /^\d{4,10}$/.test(result.code) &&
        Number.isInteger(result.expiresIn) &&
        (result.expiresIn as number) > 0 &&
        Number.isInteger(result.period) &&
        (result.period as number) > 0 &&
        (result.period as number) <= 300 &&
        (result.expiresIn as number) <= (result.period as number)
      );
  }
}

export function parseNativeResponse<T>(request: NativeRequest, value: unknown): NativeResponse<T> {
  if (
    !isRecord(value) ||
    value.version !== PROTOCOL_VERSION ||
    value.requestId !== request.requestId ||
    typeof value.ok !== "boolean"
  ) {
    throw new TypeError("Invalid Native Messaging response envelope");
  }

  if (value.ok) {
    if (
      !hasExactKeys(value, ["version", "requestId", "ok", "result"]) ||
      !isResultFor(request, value.result)
    ) {
      throw new TypeError("Invalid or unsafe Native Messaging result");
    }
    return value as NativeResponse<T>;
  }

  if (!hasExactKeys(value, ["version", "requestId", "ok", "error"]) || !isError(value.error)) {
    throw new TypeError("Invalid Native Messaging error");
  }
  return value as NativeResponse<T>;
}
