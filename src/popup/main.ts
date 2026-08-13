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

function clearActiveCode(): void {
  activeCode = undefined;
  if (timer !== undefined) window.clearInterval(timer);
  timer = undefined;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
    };
    return entities[character] ?? character;
  });
}

function statusView(kind: PopupState["kind"]): string {
  const content: Record<Exclude<PopupState["kind"], "ready">, readonly [string, string, string]> = {
    connecting: ["Connecting…", "Looking for the local WinOTP bridge.", ""],
    "host-missing": [
      "WinOTP bridge not installed",
      "Install or repair WinOTP Reborn to add the browser bridge.",
      "Retry",
    ],
    "app-not-running": [
      "WinOTP is not running",
      "Open WinOTP, then retry the connection.",
      "Retry",
    ],
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
  if (kind === "ready") return "";
  const [title, message, action] = content[kind];
  return `<section class="state-card state-card--${kind}" aria-live="polite">
    <div class="state-glyph" aria-hidden="true"><span></span></div>
    <h1>${title}</h1>
    <p>${message}</p>
    ${action ? `<button class="button button--primary" data-action="retry">${action}</button>` : ""}
  </section>`;
}

function accountView(): string {
  if (state.kind !== "ready") return "";
  const accounts = filterAccounts(state.accounts, query);
  const list = accounts
    .map((account) => {
      const code = activeCode?.accountId === account.id ? activeCode : undefined;
      const remaining = code ? Math.max(0, Math.ceil((code.expiresAt - Date.now()) / 1000)) : 0;
      const progress = code ? Math.max(0, Math.min(1, remaining / code.result.period)) : 0;
      return `<li class="account${code ? " account--revealed" : ""}">
        <button class="account__identity" data-account-id="${escapeHtml(account.id)}" aria-label="Show code for ${escapeHtml(account.name)}">
          <span class="account__issuer">${escapeHtml(account.issuer || "Account")}</span>
          <strong>${escapeHtml(account.name)}</strong>
        </button>
        <div class="account__code" ${code ? "" : "hidden"}>
          <button class="code" data-copy-code="${code ? escapeHtml(code.result.code) : ""}" aria-label="Copy current code">
            ${code ? escapeHtml(code.result.code) : ""}
          </button>
          <span class="countdown" style="--progress:${progress}" aria-label="${remaining} seconds remaining">${remaining}s</span>
        </div>
        <span class="reveal-mark" ${code ? "hidden" : ""} aria-hidden="true">→</span>
      </li>`;
    })
    .join("");

  return `<section class="accounts">
    <label class="search">
      <span class="sr-only">Search accounts</span>
      <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"></circle><path d="m16 16 4 4"></path></svg>
      <input type="search" data-search autocomplete="off" placeholder="Find an account" value="${escapeHtml(query)}">
      <kbd>${state.accounts.length}</kbd>
    </label>
    <ul class="account-list">${list || `<li class="empty">${query ? "No matching accounts" : "No accounts in WinOTP"}</li>`}</ul>
  </section>`;
}

function render(): void {
  const connectionLabel =
    state.kind === "ready"
      ? "WinOTP connected"
      : state.kind === "connecting"
        ? "Connecting"
        : "Attention needed";
  root.innerHTML = `<main class="shell">
    <header class="brand">
      <img src="icons/winotp.png" alt="">
      <div><span>WinOTP</span><strong>Reborn</strong></div>
      <p class="connection connection--${state.kind}"><i></i>${connectionLabel}</p>
    </header>
    ${state.kind === "ready" ? accountView() : statusView(state.kind)}
    <footer><span>Codes stay on this device</span><span aria-hidden="true">◆</span></footer>
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
