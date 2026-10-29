import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Files that boot wrangler dev collide when they boot together.
    fileParallelism: false,
  },
});
