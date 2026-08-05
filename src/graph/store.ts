import { mkdir, readFile, writeFile, rename, readdir, rm, open } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  SCHEMA_VERSION,
  SiteGraphSchema,
  emptyGraph,
  type SiteGraph,
} from "./schema.js";

/**
 * One JSON file per site, global so the agent works from any directory:
 *   ~/.claude/website-graphs/<domain>.json
 * Overridable with WGRAPH_HOME (used by the tests).
 */
export function storeDir(): string {
  return process.env.WGRAPH_HOME ?? join(homedir(), ".claude", "website-graphs");
}

export function sessionsDir(): string {
  return join(storeDir(), ".sessions");
}

/** Screenshots and other run artifacts. Never part of the graph. */
export function artifactsDir(domain: string): string {
  return join(storeDir(), ".artifacts", domain);
}

/**
 * `https://www.Example.com/a/b?x=1` -> `example.com`.
 * A leading `www.` is dropped: it is the same site, and keeping both would
 * split one site's knowledge across two files.
 */
export function domainKey(input: string): string {
  const url = new URL(hasScheme(input) ? input : `https://${input}`);
  return url.hostname.toLowerCase().replace(/^www\./, "");
}

export function originOf(input: string): string {
  return new URL(hasScheme(input) ? input : `https://${input}`).origin;
}

function hasScheme(s: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
}

export function graphPath(domain: string): string {
  return join(storeDir(), `${domain}.json`);
}

export function graphExists(domain: string): boolean {
  return existsSync(graphPath(domain));
}

export async function listGraphs(): Promise<string[]> {
  try {
    const entries = await readdir(storeDir());
    return entries
      .filter((e) => e.endsWith(".json"))
      .map((e) => e.slice(0, -".json".length))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export class GraphNotFoundError extends Error {
  constructor(public readonly domain: string) {
    super(
      `No knowledge graph for "${domain}". Learn it first: wgraph analyze https://${domain}`,
    );
    this.name = "GraphNotFoundError";
  }
}

export class GraphValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Graph failed validation:\n  - ${issues.join("\n  - ")}`);
    this.name = "GraphValidationError";
  }
}

export function parseGraph(raw: unknown): SiteGraph {
  const result = SiteGraphSchema.safeParse(raw);
  if (!result.success) {
    throw new GraphValidationError(
      result.error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
      ),
    );
  }
  return migrate(result.data);
}

/** Hook for "retraining after website changes": older files are upgraded on
 *  read rather than rejected. */
function migrate(graph: SiteGraph): SiteGraph {
  if (graph.schemaVersion > SCHEMA_VERSION) {
    throw new GraphValidationError([
      `graph was written by a newer wgraph (schemaVersion ${graph.schemaVersion} > ${SCHEMA_VERSION})`,
    ]);
  }
  return graph;
}

export async function loadGraph(domain: string): Promise<SiteGraph> {
  let raw: string;
  try {
    raw = await readFile(graphPath(domain), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new GraphNotFoundError(domain);
    }
    throw err;
  }
  return parseGraph(JSON.parse(raw));
}

export async function loadGraphOrNull(domain: string): Promise<SiteGraph | null> {
  try {
    return await loadGraph(domain);
  } catch (err) {
    if (err instanceof GraphNotFoundError) return null;
    throw err;
  }
}

/** Validate before writing, then write atomically, so a crashed run can never
 *  leave a half-written or invalid graph on disk. */
export async function saveGraph(domain: string, graph: SiteGraph): Promise<void> {
  const validated = parseGraph(graph);
  await mkdir(storeDir(), { recursive: true });
  const target = graphPath(domain);
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  await rename(tmp, target);
}

const LOCK_STALE_MS = 60_000;

/**
 * Read-modify-write under a lock. The analyze flow performs many small
 * mutations from separate CLI processes; without this, two overlapping writes
 * would silently drop one.
 */
export async function withGraph<T>(
  domain: string,
  fn: (graph: SiteGraph) => T | Promise<T>,
  options: { createOrigin?: string } = {},
): Promise<{ graph: SiteGraph; result: T }> {
  await mkdir(storeDir(), { recursive: true });
  const lock = `${graphPath(domain)}.lock`;
  await acquire(lock);
  try {
    const existing = await loadGraphOrNull(domain);
    const graph =
      existing ??
      (options.createOrigin
        ? emptyGraph(options.createOrigin)
        : (() => {
            throw new GraphNotFoundError(domain);
          })());
    const result = await fn(graph);
    await saveGraph(domain, graph);
    return { graph, result };
  } finally {
    await rm(lock, { force: true });
  }
}

async function acquire(lock: string): Promise<void> {
  const deadline = Date.now() + LOCK_STALE_MS;
  for (;;) {
    try {
      const handle = await open(lock, "wx");
      await handle.writeFile(String(process.pid));
      await handle.close();
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (await isStale(lock)) {
        await rm(lock, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out waiting for the graph lock at ${lock}. Delete it if no wgraph process is running.`,
        );
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

async function isStale(lock: string): Promise<boolean> {
  try {
    const pid = Number((await readFile(lock, "utf8")).trim());
    if (!Number.isInteger(pid) || pid <= 0) return true;
    try {
      process.kill(pid, 0); // signal 0 only tests for existence
      return false;
    } catch {
      return true; // holder died without cleaning up
    }
  } catch {
    return true;
  }
}
