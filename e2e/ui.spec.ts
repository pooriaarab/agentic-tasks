import AxeBuilder from "@axe-core/playwright";
import { expect, request, test, type APIRequestContext, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

const API = "/api/v1/tasks";
const unique = () => Math.random().toString(36).slice(2, 8);

async function connect(page: Page, id: string, kind = "human") {
  await page.goto("/");
  await page.getByLabel("Principal id").fill(id);
  await page.getByLabel("Principal kind").selectOption(kind);
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByRole("heading", { name: "Lists", exact: true })).toBeVisible();
}

async function createList(page: Page, title: string) {
  await page.getByLabel("New list name").fill(title);
  await page.getByRole("button", { name: "Create list" }).click();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
}

async function addTask(page: Page, title: string) {
  await page.getByRole("button", { name: "New task" }).first().click();
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: "Create task" }).click();
  await expect(page.getByRole("button", { name: new RegExp(title) })).toBeVisible();
}

const as = (id: string, kind: string): Promise<APIRequestContext> =>
  request.newContext({
    baseURL: "http://127.0.0.1:18743",
    extraHTTPHeaders: { "x-principal-id": id, "x-principal-kind": kind },
  });

const boardIdOf = (page: Page) => decodeURIComponent(page.url().split("#/b/")[1] as string);

test("create a list, add a task, claim it, close it, and reload", async ({ page }) => {
  const me = `ada-${unique()}`;
  await connect(page, me);
  await expect(page.getByText("No lists on this device")).toBeVisible();
  await createList(page, "Sprint");
  await expect(page.getByText("No tasks yet")).toBeVisible();

  await addTask(page, "Write the docs");
  await page.getByRole("button", { name: /Write the docs/ }).click();
  await page.getByRole("button", { name: "Claim", exact: true }).click();
  await expect(page.getByText(`Claimed by ${me} until`)).toBeVisible();
  await page.getByRole("button", { name: "Close task" }).click();
  await expect(page.getByText("This task is closed.")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.reload();
  const card = page.getByRole("button", { name: /Write the docs/ });
  await expect(card).toContainText("Closed");
  await page.getByLabel("Status").selectOption("open");
  await expect(page.getByText("No task matches the filters")).toBeVisible();
});

test("a keyboard alone creates a task and focus is visible", async ({ page }) => {
  await connect(page, `kay-${unique()}`);
  await createList(page, "Keys");
  const newTask = page.getByRole("button", { name: "New task" }).first();
  await newTask.focus();
  const outline = await newTask.evaluate((el) => getComputedStyle(el).outlineWidth);
  expect(parseFloat(outline)).toBeGreaterThan(0);
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Title")).toBeFocused();
  await page.keyboard.type("Typed task");
  await page.keyboard.press("Enter");
  const card = page.getByRole("button", { name: /Typed task/ });
  await expect(card).toBeVisible();
  await card.focus();
  expect(parseFloat(await card.evaluate((el) => getComputedStyle(el).outlineWidth))).toBeGreaterThan(0);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Edit task" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(card).toBeFocused();
});

test("edit and assign a task, and filter", async ({ page }) => {
  const me = `eve-${unique()}`;
  await connect(page, me);
  await createList(page, "Edits");
  await addTask(page, "First");
  await addTask(page, "Second");
  await page.getByRole("button", { name: /First/ }).click();
  await page.getByLabel("Labels").fill("urgent, docs");
  await page.getByRole("button", { name: "Assign to me" }).click();
  await page.getByRole("dialog").getByLabel("Column").selectOption({ label: "Doing" });
  await page.getByRole("button", { name: "Save task" }).click();
  await expect(page.getByRole("button", { name: /First/ })).toContainText(`assigned to ${me}`);
  await page.getByLabel("Search").fill("urgent");
  await expect(page.getByRole("button", { name: /Second/ })).toHaveCount(0);
  await page.getByRole("tab", { name: "List" }).click();
  await expect(page.getByRole("button", { name: /First/ })).toContainText("Doing");
});

test("an agent change is marked, and a refused claim shows its code", async ({ page }) => {
  const me = `ivy-${unique()}`;
  await connect(page, me);
  await createList(page, "Agents");
  const boardId = boardIdOf(page);
  const human = await as(me, "human");
  await human.put(`${API}/boards/${boardId}/members/agent/bot-${me}`, { data: { role: "editor" } });
  const bot = await as(`bot-${me}`, "agent");
  const board = await (await human.get(`${API}/boards/${boardId}`)).json();
  const made = await bot.post(`${API}/tasks`, { data: { boardId, title: "Bot task", columnId: board.columns[0].id } });
  const task = await made.json();
  await bot.post(`${API}/tasks/${task.id}/claim`, { data: {} });

  await page.reload();
  const card = page.getByRole("button", { name: /Bot task/ });
  await expect(card).toContainText("Agent created");
  await page.getByLabel("Agent-made only").check();
  await expect(card).toBeVisible();
  await card.click();
  await page.getByRole("button", { name: "Claim", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("CLAIM_HELD");
  await page.keyboard.press("Escape");
});

test("loading and error states", async ({ page }) => {
  await connect(page, `lee-${unique()}`);
  await page.route(/\/api\/v1\/tasks\/(boards\/slow|tasks\?boardId=slow)/, async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await page.goto("/#/b/slow");
  await expect(page.getByRole("status")).toHaveText("Loading tasks…");
  await expect(page.getByRole("alert")).toContainText(/NOT_FOUND|FORBIDDEN/);
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

for (const scheme of ["light", "dark"] as const) {
  test(`axe WCAG 2.2 AA and screenshots, ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    mkdirSync("docs/screenshots", { recursive: true });
    const check = async (name: string) => {
      const result = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(result.violations, `${name} (${scheme})`).toEqual([]);
      if (process.env.SCREENSHOTS === "1") {
        await page.screenshot({ path: `docs/screenshots/${name}-${scheme}.png`, fullPage: true });
      }
    };
    const me = `axe-${unique()}`;
    await page.goto("/");
    await check("connect");
    await connect(page, me);
    await check("lists-empty");
    await createList(page, "Launch plan");
    await check("board-empty");
    await page.getByRole("button", { name: "New task" }).first().click();
    await expect(page.getByRole("dialog", { name: "New task" })).toBeVisible();
    await check("new-task-dialog");
    await page.keyboard.press("Escape");
    const boardId = boardIdOf(page);
    await addTask(page, "Draft the announcement");
    const bot = await as("writer", "agent");
    const human = await as(me, "human");
    await human.put(`${API}/boards/${boardId}/members/agent/writer`, { data: { role: "editor" } });
    const board = await (await human.get(`${API}/boards/${boardId}`)).json();
    await bot.post(`${API}/tasks`, { data: { boardId, title: "Check the links", labels: ["docs"], columnId: board.columns[1].id } });
    await page.reload();
    await expect(page.getByRole("button", { name: /Check the links/ })).toBeVisible();
    await check("board");
    await page.getByRole("tab", { name: "List" }).click();
    await check("list");
    await page.getByRole("link", { name: "Lists", exact: true }).click();
    await expect(page.getByRole("link", { name: "Launch plan" }).last()).toBeVisible();
    await check("lists");
    await page.getByRole("link", { name: "Launch plan" }).last().click();
    await page.getByRole("tab", { name: "List" }).click();
    await page.getByRole("button", { name: /Check the links/ }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await check("task-dialog");
    await page.keyboard.press("Escape");
    await page.getByLabel("Search").fill("zzz");
    await check("no-match");
    await page.goto("/#/b/missing");
    await expect(page.getByRole("alert")).toBeVisible();
    await check("error");
  });
}
