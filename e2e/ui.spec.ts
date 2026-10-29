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

// A task card is the button that opens it. Its actions menu button has a longer name.
const card = (page: Page, title: string) => page.locator("button.card-main", { hasText: title });

async function addTask(page: Page, title: string, column = "To do") {
  await page.getByLabel(`Add a task to ${column}`).fill(title);
  await page.keyboard.press("Enter");
  await expect(card(page, title)).toBeVisible();
}

const as = (id: string, kind: string): Promise<APIRequestContext> =>
  request.newContext({
    baseURL: `http://127.0.0.1:${process.env.E2E_PORT ?? 18743}`,
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
  await card(page, "Write the docs").click();
  await page.getByRole("button", { name: "Claim", exact: true }).click();
  await expect(page.getByText(`Claimed by ${me} until`)).toBeVisible();
  await page.getByRole("button", { name: "Close task" }).click();
  await expect(page.getByText("This task is closed.")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.reload();
  await expect(card(page, "Write the docs")).toContainText("Closed");
  await page.getByLabel("Status").selectOption("open");
  await expect(page.getByText("No task matches the filters")).toBeVisible();
});

test("a keyboard alone adds, renames, moves, and opens a task, and focus is visible", async ({ page }) => {
  await connect(page, `kay-${unique()}`);
  await createList(page, "Keys");
  const newTask = page.getByRole("button", { name: "New task" }).first();
  await newTask.focus();
  const outline = await newTask.evaluate((el) => getComputedStyle(el).outlineWidth);
  expect(parseFloat(outline)).toBeGreaterThan(0);
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Add a task to To do")).toBeFocused();
  await page.keyboard.type("Typed task");
  await page.keyboard.press("Enter");
  const typed = card(page, "Typed task");
  await expect(typed).toBeVisible();
  await typed.focus();
  // The focus ring sits on the whole card.
  expect(parseFloat(await typed.evaluate((el) => getComputedStyle(el.parentElement!).outlineWidth))).toBeGreaterThan(0);

  await page.keyboard.press("F2");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Renamed task");
  await page.keyboard.press("Enter");
  await expect(card(page, "Renamed task")).toBeFocused();

  // Alt+ArrowRight moves the card to the next column, with no pointer.
  await page.keyboard.press("Alt+ArrowRight");
  await expect(page.getByRole("region", { name: /Doing/ }).locator("button.card-main", { hasText: "Renamed task" })).toBeVisible();

  await expect(card(page, "Renamed task")).toBeFocused();
  await expect(page.getByRole("status").filter({ hasText: "Moved Renamed task to Doing." })).toBeAttached();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("complementary", { name: "Task details" })).toBeVisible();
  await expect(page.getByLabel("Title")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("complementary")).toHaveCount(0);
  await expect(card(page, "Renamed task")).toBeFocused();
});

test("drag a card to another column, and move it from the card menu", async ({ page }) => {
  await connect(page, `dan-${unique()}`);
  await createList(page, "Drag");
  await addTask(page, "Dragged");
  const doing = page.getByRole("region", { name: /Doing/ });
  await card(page, "Dragged").dragTo(doing);
  await expect(doing.locator("button.card-main", { hasText: "Dragged" })).toBeVisible();

  // The menu is the single-pointer alternative to dragging (WCAG 2.2, 2.5.7).
  await page.getByRole("button", { name: "Actions for Dragged" }).click();
  await page.getByRole("menuitem", { name: "Move to Done" }).click();
  await expect(page.getByRole("region", { name: /Done/ }).locator("button.card-main", { hasText: "Dragged" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("region", { name: /Done/ }).locator("button.card-main", { hasText: "Dragged" })).toBeVisible();
});

test("a card shows due date and assignee chips, and an empty column says so", async ({ page }) => {
  const me = `chi-${unique()}`;
  await connect(page, me);
  await createList(page, "Chips");
  await addTask(page, "Chipped");
  await expect(page.getByText("Nothing here yet.")).toHaveCount(2);
  await card(page, "Chipped").click();
  await page.getByLabel("Due date").fill("2020-01-02");
  await page.getByRole("button", { name: "Assign to me" }).click();
  await page.getByRole("button", { name: "Save task" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await expect(card(page, "Chipped")).toContainText("Late, due 2020-01-02");
  await expect(card(page, "Chipped")).toContainText(`Assigned to ${me}`);
});

test("edit and assign a task, and filter", async ({ page }) => {
  const me = `eve-${unique()}`;
  await connect(page, me);
  await createList(page, "Edits");
  await addTask(page, "First");
  await addTask(page, "Second");
  await card(page, "First").click();
  await page.getByLabel("Labels").fill("urgent, docs");
  await page.getByRole("button", { name: "Assign to me" }).click();
  await page.getByRole("complementary").getByLabel("Column").selectOption({ label: "Doing" });
  await page.getByRole("button", { name: "Save task" }).click();
  await page.keyboard.press("Escape");
  await expect(card(page, "First")).toContainText(`Assigned to ${me}`);
  await page.getByLabel("Search").fill("urgent");
  await expect(card(page, "Second")).toHaveCount(0);
  await page.getByRole("tab", { name: "List" }).click();
  await expect(card(page, "First")).toContainText("Doing");
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
  const mine = await (await human.post(`${API}/tasks`, { data: { boardId, title: "Human task", columnId: board.columns[0].id } })).json();
  await bot.patch(`${API}/tasks/${mine.id}`, { data: { description: "Rewritten by the bot" } });

  await page.reload();
  const bots = card(page, "Bot task");
  await expect(bots).toContainText("Agent created");
  await expect(card(page, "Human task")).toContainText("Last changed by an agent");
  await page.getByLabel("Created or last changed by an agent").check();
  await expect(bots).toBeVisible();
  await bots.click();
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
    const boardId = boardIdOf(page);
    await addTask(page, "Draft the announcement");
    const bot = await as("writer", "agent");
    const human = await as(me, "human");
    await human.put(`${API}/boards/${boardId}/members/agent/writer`, { data: { role: "editor" } });
    const board = await (await human.get(`${API}/boards/${boardId}`)).json();
    await bot.post(`${API}/tasks`, { data: { boardId, title: "Check the links", labels: ["docs"], dueDate: "2099-12-01", assignees: [{ id: me, kind: "human" }], columnId: board.columns[1].id } });
    await human.post(`${API}/tasks`, { data: { boardId, title: "Pay the invoice", dueDate: "2020-01-01", columnId: board.columns[0].id } });
    await page.reload();
    await expect(card(page, "Check the links")).toBeVisible();
    await check("board");
    await page.getByRole("tab", { name: "List" }).click();
    await check("list");
    await page.getByRole("link", { name: "Lists", exact: true }).click();
    await expect(page.getByRole("link", { name: "Launch plan" }).last()).toBeVisible();
    await check("lists");
    await page.getByRole("link", { name: "Launch plan" }).last().click();
    await page.getByRole("tab", { name: "List" }).click();
    await card(page, "Check the links").click();
    await expect(page.getByRole("complementary", { name: "Task details" })).toBeVisible();
    await check("task-panel");
    await page.keyboard.press("Escape");
    await page.getByLabel("Search").fill("zzz");
    await check("no-match");
    await page.goto("/#/b/missing");
    await expect(page.getByRole("alert")).toBeVisible();
    await check("error");
  });
}

test("at 390px wide the board content and the panel fit", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await connect(page, `sml-${unique()}`);
  await createList(page, "Small");
  await addTask(page, "A task with a rather long title that must wrap inside its card");
  await card(page, "A task").click();
  const panel = page.getByRole("dialog", { name: "Task details" });
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await page.keyboard.press("Escape");
  // The columns scroll inside their own box. The shell top bar belongs to the design package.
  const wide = await page.evaluate(() => [...document.querySelectorAll("body *")].filter((e) => !e.closest(".columns, .agd-shell__actions") && e.getBoundingClientRect().right > 391).map((e) => e.className || e.tagName).slice(0, 8));
  expect(wide).toEqual([]);
});

test("rename again, rename from the card menu, a stale panel does not undo a move, and a drop with no task moves nothing", async ({ page }) => {
  await connect(page, `rev-${unique()}`);
  await createList(page, "Review");
  await addTask(page, "Alpha");

  // Rename twice in a row, the second time from the card menu.
  await card(page, "Alpha").focus();
  await page.keyboard.press("F2");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Beta");
  await page.keyboard.press("Enter");
  await expect(card(page, "Beta")).toBeFocused();
  await page.getByRole("button", { name: "Actions for Beta" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await expect(page.getByLabel("Title of Beta")).toBeFocused();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Gamma");
  await page.keyboard.press("Enter");
  await expect(card(page, "Gamma")).toBeVisible();

  // Open the panel, move the card elsewhere, then save a description: the move stays.
  await card(page, "Gamma").click();
  await card(page, "Gamma").focus();
  await page.keyboard.press("Alt+ArrowRight");
  await expect(page.getByRole("region", { name: /Doing/ }).locator("button.card-main", { hasText: "Gamma" })).toBeVisible();
  await page.getByLabel("Description").fill("Notes");
  await page.getByRole("button", { name: "Save task" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  const shown = await page.getByRole("complementary").getByLabel("Column").evaluate((el: HTMLSelectElement) => el.selectedOptions[0]!.text);
  expect(shown).toBe("Doing");
  await expect(page.getByRole("region", { name: /Doing/ }).locator("button.card-main", { hasText: "Gamma" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("region", { name: /Doing/ }).locator("button.card-main", { hasText: "Gamma" })).toBeVisible();

  // A drop that carries no task, such as dropped text, moves nothing.
  // A drag starts on the card, then something else, with no task in it, is dropped on Done.
  const dt = await page.evaluateHandle(() => new DataTransfer());
  await card(page, "Gamma").dispatchEvent("dragstart", { dataTransfer: dt });
  await page.getByRole("region", { name: /Done/ }).dispatchEvent("drop", { dataTransfer: await page.evaluateHandle(() => new DataTransfer()) });
  // A wrong move would reach the server and the screen after a round trip, so wait before the negative check.
  await page.waitForTimeout(600);
  await expect(page.getByRole("region", { name: /Done/ }).locator("button.card-main")).toHaveCount(0);
  await expect(page.getByRole("region", { name: /Doing/ }).locator("button.card-main", { hasText: "Gamma" })).toBeVisible();
});

test("a cancelled drag leaves no column highlighted, and Escape keeps unsaved edits", async ({ page }) => {
  await connect(page, `can-${unique()}`);
  await createList(page, "Cancel");
  await addTask(page, "Hold");
  const doing = page.getByRole("region", { name: /Doing/ });
  const dt = await page.evaluateHandle(() => new DataTransfer());
  await card(page, "Hold").dispatchEvent("dragstart", { dataTransfer: dt });
  await doing.dispatchEvent("dragover", { dataTransfer: dt });
  await expect(doing).toHaveAttribute("data-over", "true");
  await card(page, "Hold").dispatchEvent("dragend", { dataTransfer: dt });
  await expect(doing).not.toHaveAttribute("data-over", "true");

  await card(page, "Hold").click();
  await page.getByLabel("Description").fill("Keep me");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("complementary", { name: "Task details" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("unsaved changes");
  await page.getByRole("button", { name: "Save task" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await page.getByRole("button", { name: "Assign to me" }).click();
  await expect(page.getByText("Saved.")).toHaveCount(0);
});

test("at 390px the Tab key stays inside the open panel", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await connect(page, `tab-${unique()}`);
  await createList(page, "Trap");
  await addTask(page, "Trapped");
  await card(page, "Trapped").click();
  const panel = page.getByRole("dialog", { name: "Task details" });
  await expect(page.getByLabel("Title")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  expect(await panel.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.getByRole("button", { name: "Save task" }).focus();
  await page.keyboard.press("Tab");
  expect(await panel.evaluate((el) => el.contains(document.activeElement))).toBe(true);
});

test("a rename ended by a click elsewhere does not pull the focus back", async ({ page }) => {
  await connect(page, `blu-${unique()}`);
  await createList(page, "Blur");
  await addTask(page, "Quiet");
  await card(page, "Quiet").focus();
  await page.keyboard.press("F2");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Quieter");
  await page.getByLabel("Search").click();
  await page.keyboard.type("zz");
  await expect(page.getByLabel("Search")).toBeFocused();
  await expect(page.getByLabel("Search")).toHaveValue("zz");
});

test("a card click does not drop unsaved panel edits, and a quick add clears the filters", async ({ page }) => {
  await connect(page, `uns-${unique()}`);
  await createList(page, "Unsaved");
  await addTask(page, "One");
  await addTask(page, "Two");
  await card(page, "One").click();
  await page.getByLabel("Description").fill("Draft notes");
  await card(page, "Two").click();
  await expect(page.getByRole("alert")).toContainText("unsaved changes");
  await expect(page.getByLabel("Description")).toHaveValue("Draft notes");
  await page.getByRole("button", { name: "Save task" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();

  await page.keyboard.press("Escape");
  await page.getByLabel("Search").fill("One");
  await page.getByLabel("Add a task to To do").fill("Three");
  await page.keyboard.press("Enter");
  await expect(card(page, "Three")).toBeVisible();
});
