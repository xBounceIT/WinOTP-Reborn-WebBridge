import {
  createRequest,
  type BrowserAccount,
  type NativeRequest,
  type NativeResponse,
  type PingResult,
  type StatusResult,
  type TotpResult,
} from "../shared/protocol.ts";
import { NativeTransportError } from "../shared/transport.ts";

export interface NativeGateway {
  request<T>(request: NativeRequest): Promise<NativeResponse<T>>;
}

export type PopupState =
  | Readonly<{ kind: "connecting" }>
  | Readonly<{ kind: "host-missing" }>
  | Readonly<{ kind: "app-not-running"; bridgeVersion: string }>
  | Readonly<{ kind: "locked"; bridgeVersion: string; appVersion: string }>
  | Readonly<{ kind: "incompatible" }>
  | Readonly<{ kind: "connection-error" }>
  | Readonly<{ kind: "error" }>
  | Readonly<{
      kind: "ready";
      bridgeVersion: string;
      appVersion: string;
      accounts: readonly BrowserAccount[];
    }>;

function stateForError(code: string, bridgeVersion?: string, appVersion?: string): PopupState {
  if (code === "APP_NOT_RUNNING") {
    return bridgeVersion ? { kind: "app-not-running", bridgeVersion } : { kind: "host-missing" };
  }
  if (code === "APP_LOCKED") {
    return {
      kind: "locked",
      bridgeVersion: bridgeVersion ?? "unknown",
      appVersion: appVersion ?? "unknown",
    };
  }
  if (code === "UNSUPPORTED_PROTOCOL") return { kind: "incompatible" };
  return { kind: "error" };
}

function stateForTransportError(error: NativeTransportError): PopupState {
  if (error.reason === "HOST_UNAVAILABLE") return { kind: "host-missing" };
  if (error.reason === "UNSUPPORTED_PROTOCOL") return { kind: "incompatible" };
  return { kind: "connection-error" };
}

export async function loadPopup(gateway: NativeGateway): Promise<PopupState> {
  let ping: NativeResponse<PingResult>;
  try {
    ping = await gateway.request<PingResult>(createRequest("ping"));
  } catch (error) {
    if (error instanceof NativeTransportError) return stateForTransportError(error);
    return { kind: "connection-error" };
  }
  if (!ping.ok) return stateForError(ping.error.code);

  const bridgeVersion = ping.result.bridgeVersion;
  const status = await gateway
    .request<StatusResult>(createRequest("getStatus"))
    .catch(() => undefined);
  if (!status) return { kind: "connection-error" };
  if (!status.ok) return stateForError(status.error.code, bridgeVersion);
  if (status.result.state === "locked") {
    return {
      kind: "locked",
      bridgeVersion,
      appVersion: status.result.appVersion,
    };
  }

  const accounts = await gateway
    .request<{ accounts: readonly BrowserAccount[] }>(createRequest("listAccounts"))
    .catch(() => undefined);
  if (!accounts) return { kind: "connection-error" };
  if (!accounts.ok) {
    return stateForError(accounts.error.code, bridgeVersion, status.result.appVersion);
  }

  return {
    kind: "ready",
    bridgeVersion,
    appVersion: status.result.appVersion,
    accounts: accounts.result.accounts,
  };
}

export async function requestTotp(gateway: NativeGateway, accountId: string): Promise<TotpResult> {
  const response = await gateway.request<TotpResult>(createRequest("getTotp", { accountId }));
  if (!response.ok) throw response.error;
  return response.result;
}

export function stateForTotpError(
  error: unknown,
  current: Extract<PopupState, { kind: "ready" }>,
): PopupState {
  if (error instanceof NativeTransportError) return stateForTransportError(error);
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    typeof error.code !== "string"
  ) {
    return { kind: "error" };
  }
  return stateForError(error.code, current.bridgeVersion, current.appVersion);
}

export function filterAccounts(
  accounts: readonly BrowserAccount[],
  query: string,
): readonly BrowserAccount[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return accounts;
  return accounts.filter((account) =>
    `${account.issuer}\n${account.name}`.toLowerCase().includes(needle),
  );
}
