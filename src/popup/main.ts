import type { TotpResult } from "../shared/protocol.ts";
import { getRuntime } from "../shared/webextension.ts";
import { createGateway } from "./gateway.ts";
import {
  filterAccounts,
  loadPopup,
  requestTotp,
  stateForTotpError,
  type PopupState,
} from "./state.ts";

const appRoot = document.querySelector<HTMLElement>("#app");
if (!appRoot) throw new Error("Popup root is missing");
const root: HTMLElement = appRoot;

const gateway = createGateway(getRuntime());
let state: PopupState = { kind: "connecting" };
let query = "";
let activeCode: Readonly<{ accountId: string; result: TotpResult; expiresAt: number }> | undefined;
let timer: number | undefined;
let refreshGeneration = 0;
let codeGeneration = 0;

const htmlEntities: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

function clearActiveCode(): void {
  activeCode = undefined;
  if (timer !== undefined) window.clearInterval(timer);
  timer = undefined;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) => htmlEntities[character] ?? character);
}

type StatusKind = Exclude<PopupState["kind"], "ready">;
type ConnectionGuideKind = Extract<
  StatusKind,
  "host-missing" | "app-not-running" | "connection-error"
>;
type ReadyState = Extract<PopupState, { kind: "ready" }>;

function connectionGuideView(kind: ConnectionGuideKind): string {
  const content: Record<ConnectionGuideKind, readonly [string, string]> = {
    "host-missing": [
      "WinOTP bridge not installed",
      "Install or update WinOTP Reborn, then enable browser access in the desktop app.",
    ],
    "app-not-running": [
      "WinOTP is not connected",
      "Open the desktop app and allow browser access to start the local connection.",
    ],
    "connection-error": [
      "Couldn’t connect to WinOTP",
      "Check browser access in the desktop app, then try the connection again.",
    ],
  };
  const [title, message] = content[kind];
  return `<section class="connection-guide" aria-live="polite">
    <header class="connection-guide__intro">
      <h1>${title}</h1>
      <p>${message}</p>
    </header>
    <ol class="connection-steps">
      <li>
        <span aria-hidden="true">1</span>
        <div><strong>Open WinOTP Reborn</strong><p>Launch the desktop app and unlock it.</p></div>
      </li>
      <li>
        <span aria-hidden="true">2</span>
        <div><strong>Open Settings</strong><p>Select Settings from the app navigation.</p></div>
      </li>
      <li>
        <span aria-hidden="true">3</span>
        <div><strong>Enable browser access</strong><p>Turn on <q>Allow browser extension access</q>.</p></div>
      </li>
    </ol>
    <button class="button button--primary connection-guide__retry" data-action="retry">Retry connection</button>
  </section>`;
}

function statusView(kind: StatusKind): string {
  if (kind === "host-missing" || kind === "app-not-running" || kind === "connection-error") {
    return connectionGuideView(kind);
  }
  const content: Record<
    "connecting" | "locked" | "incompatible" | "error",
    readonly [string, string, string]
  > = {
    connecting: ["Connecting…", "Looking for the local WinOTP bridge.", ""],
    locked: ["WinOTP is locked", "Unlock WinOTP on your desktop to view accounts.", "Check again"],
    incompatible: [
      "Bridge version incompatible",
      "Update WinOTP Reborn and this extension, then try again.",
      "Retry",
    ],
    error: [
      "Unexpected bridge error",
      "No account data or codes were returned. Try again.",
      "Retry",
    ],
  };
  const [title, message, action] = content[kind];
  return `<section class="state-card state-card--${kind}" aria-live="polite">
    <div class="state-glyph" aria-hidden="true"><span></span></div>
    <h1>${title}</h1>
    <p>${message}</p>
    ${action ? `<button class="button button--primary" data-action="retry">${action}</button>` : ""}
  </section>`;
}

function accountView(readyState: ReadyState): string {
  const accounts = filterAccounts(readyState.accounts, query);
  const list = accounts
    .map((account) => {
      const code = activeCode?.accountId === account.id ? activeCode : undefined;
      const remaining = code ? Math.max(0, Math.ceil((code.expiresAt - Date.now()) / 1000)) : 0;
      const progress = code ? Math.max(0, Math.min(1, remaining / code.result.period)) : 0;
      const issuer = account.issuer.trim();
      const identity = `<span class="account__issuer">${escapeHtml(issuer || account.name)}</span>
          ${issuer ? `<strong>${escapeHtml(account.name)}</strong>` : ""}`;
      const accountAction = code
        ? `<div class="account__identity">${identity}</div>`
        : `<button class="account__reveal" data-account-id="${escapeHtml(account.id)}" aria-label="Show code for ${escapeHtml(account.name)}">
          <span class="account__identity">${identity}</span>
          <span class="reveal-action" aria-hidden="true">Show</span>
        </button>`;
      return `<li class="account${code ? " account--revealed" : ""}">
        ${accountAction}
        ${
          code
            ? `<div class="account__code">
          <button class="code" data-copy-code="${escapeHtml(code.result.code)}" aria-label="Copy current code">
            ${escapeHtml(code.result.code)}
          </button>
          <span class="countdown" style="--progress:${progress}" aria-label="${remaining} seconds remaining">${remaining}s</span>
        </div>`
            : ""
        }
      </li>`;
    })
    .join("");

  return `<section class="accounts">
    <label class="search">
      <span class="sr-only">Search accounts</span>
      <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"></circle><path d="m16 16 4 4"></path></svg>
      <input type="search" data-search autocomplete="off" placeholder="Find an account" value="${escapeHtml(query)}">
      <kbd>${readyState.accounts.length}</kbd>
    </label>
    <ul class="account-list">${list || `<li class="empty">${query ? "No matching accounts" : "No accounts in WinOTP"}</li>`}</ul>
  </section>`;
}

function render(): void {
  const connectionLabel =
    state.kind === "ready"
      ? "Connected"
      : state.kind === "connecting"
        ? "Connecting"
        : "Attention needed";
  root.innerHTML = `<main class="shell">
    <header class="brand">
      <img src="icons/winotp-32.png" alt="">
      <div><span>WinOTP</span><strong>WebBridge</strong></div>
      <p class="connection connection--${state.kind}">${connectionLabel}</p>
    </header>
    ${state.kind === "ready" ? accountView(state) : statusView(state.kind)}
    <div class="toast" role="status" aria-live="polite" hidden>Code copied</div>
  </main>`;

  root
    .querySelector<HTMLElement>("[data-action='retry']")
    ?.addEventListener("click", () => void refresh());
  const search = root.querySelector<HTMLInputElement>("[data-search]");
  search?.addEventListener("input", () => {
    query = search.value;
    render();
    const nextSearch = root.querySelector<HTMLInputElement>("[data-search]");
    nextSearch?.focus();
    nextSearch?.setSelectionRange(query.length, query.length);
  });
  root.querySelectorAll<HTMLButtonElement>("[data-account-id]").forEach((button) => {
    button.addEventListener("click", () => void revealCode(button.dataset.accountId));
  });
  root.querySelector<HTMLButtonElement>("[data-copy-code]")?.addEventListener("click", (event) => {
    const code = (event.currentTarget as HTMLButtonElement).dataset.copyCode;
    if (code) void copyCode(code);
  });
}

async function refresh(): Promise<void> {
  const generation = ++refreshGeneration;
  codeGeneration += 1;
  clearActiveCode();
  state = { kind: "connecting" };
  render();
  const loaded = await loadPopup(gateway);
  if (generation !== refreshGeneration) return;
  state = loaded;
  render();
}

async function revealCode(accountId: string | undefined): Promise<void> {
  if (!accountId || state.kind !== "ready") return;
  const generation = ++codeGeneration;
  const readyState = state;
  try {
    const result = await requestTotp(gateway, accountId);
    if (generation !== codeGeneration || state !== readyState) return;
    activeCode = { accountId, result, expiresAt: Date.now() + result.expiresIn * 1000 };
    if (timer !== undefined) window.clearInterval(timer);
    timer = window.setInterval(updateCountdown, 250);
    render();
  } catch (error) {
    if (generation !== codeGeneration || state !== readyState) return;
    clearActiveCode();
    state = stateForTotpError(error, readyState);
    render();
  }
}

function updateCountdown(): void {
  if (!activeCode) return;
  const remaining = Math.max(0, Math.ceil((activeCode.expiresAt - Date.now()) / 1000));
  if (remaining === 0 && Date.now() >= activeCode.expiresAt) {
    clearActiveCode();
    render();
    return;
  }
  const countdown = root.querySelector<HTMLElement>(".countdown");
  if (!countdown) return;
  countdown.textContent = `${remaining}s`;
  countdown.setAttribute("aria-label", `${remaining} seconds remaining`);
  countdown.style.setProperty(
    "--progress",
    String(Math.max(0, Math.min(1, remaining / activeCode.result.period))),
  );
}

async function copyCode(code: string): Promise<void> {
  await navigator.clipboard.writeText(code);
  const toast = root.querySelector<HTMLElement>(".toast");
  if (!toast) return;
  toast.hidden = false;
  window.setTimeout(() => {
    toast.hidden = true;
  }, 1_400);
}

render();
void refresh();
