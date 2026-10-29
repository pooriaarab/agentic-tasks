// Bundles the web UI into dist-ui, which the Worker serves as static assets.
// agentic-design is bundled from npm, not copied into this repo.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

rmSync("dist-ui", { recursive: true, force: true });
mkdirSync("dist-ui", { recursive: true });
await build({
  entryPoints: ["ui/main.tsx"],
  bundle: true,
  format: "esm",
  minify: true,
  sourcemap: false,
  target: "es2022",
  jsx: "automatic",
  outdir: "dist-ui",
  loader: { ".woff2": "file" },
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
});
cpSync("ui/index.html", "dist-ui/index.html");
cpSync("ui/_headers", "dist-ui/_headers");
