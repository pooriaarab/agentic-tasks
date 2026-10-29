// Starts the real Worker with `wrangler dev` for the end-to-end tests.
// ci:local installs wrangler first. Instances that share a persist directory
// share one local D1 database.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const WRANGLER = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
// The last text a Worker process wrote to stderr, for the error when it dies.
const lastErrors = new WeakMap<ChildProcess, string>();
const ENV = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" };

// Creates the tables in a persist directory, as `migrations apply` does for a real database.
export function migrate(persistDir: string): void {
  const result = spawnSync(
    process.execPath,
    [WRANGLER, "d1", "migrations", "apply", "DB", "--local", "--persist-to", persistDir],
    { env: ENV, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`migration failed: ${result.stdout}${result.stderr}`);
}

// Local D1 reports no served region, so the store cannot check a claim. Local
// Workers run with TASKS_UNSAFE_LOCAL_REGION=1 and an "unknown" region.
export const LOCAL_REGION = ["TASKS_REGION:unknown", "TASKS_UNSAFE_LOCAL_REGION:1"];

export function startWorker(port: number, persistDir: string, vars: string[]): ChildProcess {
  const child = spawn(
    process.execPath,
    [
      WRANGLER,
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--persist-to",
      persistDir,
      ...vars.flatMap((v) => ["--var", v]),
    ],
    { env: ENV, stdio: ["ignore", "ignore", "pipe"] },
  );
  child.stderr?.on("data", (chunk: Buffer) => {
    lastErrors.set(child, `${lastErrors.get(child) ?? ""}${chunk}`.slice(-2000));
  });
  return child;
}

// Any HTTP reply counts as up. The first request can fail while wrangler boots.
export async function waitForWorker(base: string, server: ChildProcess): Promise<void> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (server.exitCode !== null) {
      throw new Error(`wrangler dev exited with ${server.exitCode}: ${lastErrors.get(server) ?? ""}`);
    }
    try {
      await fetch(`${base}/boards/not-there`);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error("wrangler dev did not start in time");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

// Stops the child and waits until it has exited, so a restart can reuse its port.
export async function stopWorker(server: ChildProcess | undefined): Promise<void> {
  if (server === undefined || server.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()));
  server.kill("SIGTERM");
  await exited;
}
