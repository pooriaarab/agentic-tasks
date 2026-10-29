import { defineConfig } from "@playwright/test";

const PORT = 18743;
const WRANGLER = "node node_modules/wrangler/bin/wrangler.js";

// Runs the real Worker under wrangler dev on a fresh local D1 database. The test
// auth trusts principal headers, and only on loopback requests.
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
  webServer: {
    command:
      `rm -rf .e2e-state && ${WRANGLER} d1 migrations apply DB --local --persist-to .e2e-state && ` +
      `exec ${WRANGLER} dev --ip 127.0.0.1 --port ${PORT} --persist-to .e2e-state ` +
      "--var TASKS_UNSAFE_LOCAL_TEST_AUTH:1 --var TASKS_REGION:unknown --var TASKS_UNSAFE_LOCAL_REGION:1",
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { WRANGLER_SEND_METRICS: "false", CI: "1" },
  },
});
