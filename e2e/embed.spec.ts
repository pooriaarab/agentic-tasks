import { expect, test } from "@playwright/test";
import { build } from "esbuild";

// Mounts the built `dist/embed.js` (the agentic-tasks/ui export) in a bare test page.
// The page and its API calls share the Worker origin. The test auth trusts the principal headers, not the token,
// so this spec shows that getToken is called, not that the Worker accepts the token.
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Embed</title></head>
<body><main><div id="host"></div></main><script type="module" src="/__embed-test.js"></script></body></html>`;

let bundle = "";
test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `
        import { mount } from "./dist/embed.js";
        const principal = { id: "embed-ada", kind: "human" };
        const headers = { "x-principal-id": principal.id, "x-principal-kind": principal.kind };
        window.__tokens = 0;
        window.__handle = mount(document.getElementById("host"), {
          baseUrl: location.origin,
          getToken: async () => (window.__tokens++, "test-token"),
          principal,
          fetch: (input, init) => fetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), ...headers } }),
        });`,
      resolveDir: process.cwd(),
      loader: "js",
    },
    bundle: true,
    write: false,
    format: "esm",
    jsx: "automatic",
    loader: { ".woff2": "dataurl" },
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });
  bundle = result.outputFiles[0]!.text;
});

test("the built UI export mounts, creates a list, and unmounts", async ({ page }) => {
  await page.route("**/__embed-test.html", (r) => r.fulfill({ contentType: "text/html", body: PAGE }));
  await page.route("**/__embed-test.js", (r) => r.fulfill({ contentType: "text/javascript", body: bundle }));
  await page.goto("/__embed-test.html");
  await expect(page.getByRole("heading", { name: "Lists", exact: true })).toBeVisible();

  await page.getByLabel("New list name").fill("Embedded");
  await page.getByRole("button", { name: "Create list" }).click();
  await expect(page.getByRole("heading", { name: "Embedded", exact: true })).toBeVisible();
  await expect(page.getByText("No tasks yet")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __tokens: number }).__tokens)).toBeGreaterThan(0);

  await page.evaluate(() => (window as unknown as { __handle: { unmount(): void } }).__handle.unmount());
  await expect(page.locator("#host")).toBeEmpty();
});
