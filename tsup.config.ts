import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  // Named entries, so `ui/embed.tsx` lands next to the others as `dist/embed.js`.
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
    client: "src/client.ts",
    worker: "src/worker.ts",
    embed: "ui/embed.tsx",
  },
  // The UI fonts are package files, copied next to the bundle.
  loader: { ".woff2": "file" },
  // React and react-dom are peer dependencies and stay out of the bundle.
  external: ["react", "react-dom"],
  format: ["esm"],
  dts: true,
  clean: true,
  define: {
    __PACK_VERSION__: JSON.stringify(pkg.version),
  },
});
