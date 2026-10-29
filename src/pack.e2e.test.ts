import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Packs the built package and imports each public subpath from a fresh project.
// `npm run build` runs before this suite in ci:local, so the pack skips scripts.
const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("packed tarball", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "agentic-tasks-pack-"));
    const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", dir, "--json"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(packed.status, packed.stderr).toBe(0);
    const [{ filename }] = JSON.parse(packed.stdout) as [{ filename: string }];
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "probe", private: true, type: "module" }));
    const installed = spawnSync("npm", ["install", join(dir, filename), "--no-audit", "--no-fund"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(installed.status, installed.stderr).toBe(0);
  }, 180_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("imports ./worker, ./client and the root", async () => {
    await writeFile(
      join(dir, "probe.mjs"),
      [
        'import worker, { createApp } from "agentic-tasks/worker";',
        'import { createClient } from "agentic-tasks/client";',
        'import { createTasks } from "agentic-tasks";',
        'if (typeof createApp !== "function") throw new Error("createApp");',
        'if (typeof worker.fetch !== "function") throw new Error("default.fetch");',
        'if (typeof createClient !== "function" || typeof createTasks !== "function") throw new Error("exports");',
        'console.log("ok");',
      ].join("\n"),
    );
    const result = spawnSync(process.execPath, ["probe.mjs"], { cwd: dir, encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("ok");
    expect(result.status).toBe(0);
    const help = spawnSync(process.execPath, ["node_modules/agentic-tasks/dist/cli.js", "--help"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(help.status).toBe(0);
  });
});
