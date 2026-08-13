export type TransportFailureReason =
  | "HOST_UNAVAILABLE"
  | "TIMEOUT"
  | "UNSUPPORTED_PROTOCOL"
  | "INVALID_RESPONSE"
  | "NATIVE_ERROR";

export type BackgroundReply =
  | Readonly<{ kind: "native-response"; response: unknown }>
  | Readonly<{ kind: "transport-error"; reason: TransportFailureReason }>;

const FAILURE_REASONS = new Set<TransportFailureReason>([
  "HOST_UNAVAILABLE",
  "TIMEOUT",
  "UNSUPPORTED_PROTOCOL",
  "INVALID_RESPONSE",
  "NATIVE_ERROR",
]);

export function isBackgroundReply(value: unknown): value is BackgroundReply {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (record.kind === "native-response") {
    return keys.length === 2 && keys[0] === "kind" && keys[1] === "response";
  }
  return (
    record.kind === "transport-error" &&
    keys.length === 2 &&
    keys[0] === "kind" &&
    keys[1] === "reason" &&
    typeof record.reason === "string" &&
    FAILURE_REASONS.has(record.reason as TransportFailureReason)
  );
}

export class NativeTransportError extends Error {
  public readonly reason: TransportFailureReason;

  public constructor(reason: TransportFailureReason) {
    super("Native Messaging transport failed");
    this.name = "NativeTransportError";
    this.reason = reason;
  }
}
