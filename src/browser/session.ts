import { mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { sessionsDir } from "../graph/store.js";
import { addDomHelpers } from "./dom-helpers.js";

/**
 * A session is saved state, not a running browser.
 *
 * Playwright's `launchServer` + `connect` cannot carry a context across CLI
 * invocations: closing a connection destroys the contexts it created, so a
 * later `connect()` sees none. Rather than run a daemon that owns the
 * Playwright objects and talk to it over RPC, each command drives its own
 * browser and persists what actually needs to survive — the current URL and
 * the storage state.
 *
 * This costs a browser launch per command and loses in-page JS state between
 * commands. Neither matters: a probe is atomic inside one command, and the
 * approval checkpoint may be answered hours later, by which time no browser
 * should still be open.
 */

export interface SessionState {
  name: string;
  origin: string;
  currentUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunOptions {
  url: string;
  /** Persist cookies and localStorage under this name between commands. */
  session?: string;
  headless?: boolean;
  viewport?: { width: number; height: number };
  /** Milliseconds to wait for the initial navigation. */
  timeout?: number;
}

export interface Run {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

const DEFAULT_VIEWPORT = { width: 1280, height: 900 };
const DEFAULT_TIMEOUT = 20_000;

function statePath(name: string): string {
  return join(sessionsDir(), `${name}.json`);
}

function storagePath(name: string): string {
  return join(sessionsDir(), `${name}.storage.json`);
}

export async function readSession(name: string): Promise<SessionState | null> {
  try {
    return JSON.parse(await readFile(statePath(name), "utf8")) as SessionState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function listSessions(): Promise<SessionState[]> {
  try {
    const files = await readdir(sessionsDir());
    const names = files
      .filter((f) => f.endsWith(".json") && !f.endsWith(".storage.json"))
      .map((f) => f.slice(0, -".json".length));
    const states = await Promise.all(names.map(readSession));
    return states.filter((s): s is SessionState => s !== null);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function clearSession(name: string): Promise<void> {
  await rm(statePath(name), { force: true });
  await rm(storagePath(name), { force: true });
}

/**
 * Opens a browser, restores any saved storage state for the session, and
 * navigates. Always pair with `finishRun` — use `withPage` unless you need the
 * context itself.
 */
export async function startRun(options: RunOptions): Promise<Run> {
  const headless = options.headless ?? true;
  const browser = await chromium.launch({ headless });

  const restore =
    options.session && existsSync(storagePath(options.session))
      ? { storageState: storagePath(options.session) }
      : {};

  const context = await browser.newContext({
    viewport: options.viewport ?? DEFAULT_VIEWPORT,
    ...restore,
  });
  // Before the first page exists, so every document in this context — including
  // the ones a learn run navigates to later — has the analyzer's DOM helpers.
  await addDomHelpers(context);

  const page = await context.newPage();
  page.setDefaultTimeout(options.timeout ?? DEFAULT_TIMEOUT);
  await page.goto(options.url, {
    waitUntil: "domcontentloaded",
    timeout: options.timeout ?? DEFAULT_TIMEOUT,
  });

  return { browser, context, page };
}

export async function finishRun(
  run: Run,
  options: { session?: string; origin?: string } = {},
): Promise<void> {
  if (options.session) {
    await mkdir(sessionsDir(), { recursive: true });
    const now = new Date().toISOString();
    const previous = await readSession(options.session);
    const state: SessionState = {
      name: options.session,
      origin: options.origin ?? previous?.origin ?? "",
      currentUrl: run.page.url(),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    await writeFile(statePath(options.session), JSON.stringify(state, null, 2), "utf8");
    await run.context.storageState({ path: storagePath(options.session) });
  }
  await run.browser.close();
}

export async function withPage<T>(
  options: RunOptions,
  fn: (page: Page, run: Run) => Promise<T>,
): Promise<T> {
  const run = await startRun(options);
  try {
    return await fn(run.page, run);
  } finally {
    await finishRun(run, {
      ...(options.session ? { session: options.session } : {}),
      origin: new URL(options.url).origin,
    });
  }
}
