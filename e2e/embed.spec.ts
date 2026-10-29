import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { build } from "esbuild";

// Mounts the built `dist/embed.js` (the agentic-tasks/ui export) in a bare test page.
// The page and its API calls share the Worker origin. The test auth trusts the principal headers, not the token,
// so this spec shows that getToken is called, not that the Worker accepts the token.
// The page loads `dist/embed.css` (the agentic-tasks/ui.css export), as a host page does.
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Embed</title><link rel="stylesheet" href="/__embed-test.css"></head>
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

async function open(page: Page) {
  await page.route("**/__embed-test.html", (r) => r.fulfill({ contentType: "text/html", body: PAGE }));
  await page.route("**/__embed-test.js", (r) => r.fulfill({ contentType: "text/javascript", body: bundle }));
  await page.route("**/__embed-test.css", (r) => r.fulfill({ contentType: "text/css", body: readFileSync("dist/embed.css", "utf8") }));
  await page.goto("/__embed-test.html");
}

test("the built UI export mounts, creates a list, and unmounts", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("heading", { name: "Lists", exact: true })).toBeVisible();

  await page.getByLabel("New list name").fill("Embedded");
  await page.getByRole("button", { name: "Create list" }).click();
  await expect(page.getByRole("heading", { name: "Embedded", exact: true })).toBeVisible();
  await expect(page.getByText("No tasks yet")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __tokens: number }).__tokens)).toBeGreaterThan(0);

  await page.evaluate(() => (window as unknown as { __handle: { unmount(): void } }).__handle.unmount());
  await expect(page.locator("#host")).toBeEmpty();
});

// The host page has only the embed in it, so the embed alone must pass. A host gives the UI no heading of its own.
for (const scheme of ["light", "dark"] as const) {
  test(`the embedded board passes axe WCAG 2.2 AA, ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.addInitScript((dark) => dark && document.documentElement.setAttribute("data-theme", "dark"), scheme === "dark");
    await open(page);
    await page.getByLabel("New list name").fill(`Axe ${scheme}`);
    await page.getByRole("button", { name: "Create list" }).click();
    await page.getByLabel("Add a task to To do").fill("Write the plan");
    await page.keyboard.press("Enter");
    await expect(page.locator("button.card-main", { hasText: "Write the plan" })).toBeVisible();
    // Heading order is a best practice in axe, not a WCAG tag. Host pages check it, so it is on here too.
    const { violations } = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .options({ rules: { "heading-order": { enabled: true }, "target-size": { enabled: true } } })
      .analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });
}
