import { expect, test, type Page } from "@playwright/test";

import { fillEditor } from "./editor-helpers";
import { installSearchIpcMock, updateSearchIpcMock } from "./search-ipc-mock";

interface WorkerMessage {
  documents?: Array<{ id: string }>;
  query?: string;
  type?: string;
}

interface SearchPaletteFixture {
  calls: Array<{ args: Record<string, unknown>; command: string }>;
  workerMessages: WorkerMessage[];
}

async function installSearchPaletteFixture(
  page: Page,
  options: { initialUnlocked?: boolean; publicCount?: number } = {},
) {
  await installSearchIpcMock(page);
  await page.addInitScript((fixtureOptions) => {
    const now = "2026-09-25T08:00:00.000Z";
    const publicFragments = Array.from(
      { length: fixtureOptions.publicCount ?? 18 },
      (_, index) => ({
        id: `public-${index + 1}`,
        content: `# 共同词公开笔记 ${index + 1}\n\n公开正文 ${index + 1}`,
        createdAt: now,
        updatedAt: now,
        tags: index === 0 ? ["inbox", "公开"] : ["inbox", "note", "公开"],
        category: null,
        path: `notes/public-${index + 1}.md`,
        gitStatus: "committed",
        error: null,
        aiStatus: "none",
        archived: false,
        lockbox: false,
        pinned: false,
        related: [],
      }),
    );
    const lockboxFragments = Array.from({ length: 2 }, (_, index) => ({
      id: `lockbox-${index + 1}`,
      content: `# 密匣共同词 ${index + 1}\n\n密匣唯一词 ${index + 1}`,
      createdAt: now,
      updatedAt: now,
      tags: ["inbox", "note", "私密"],
      category: null,
      path: `lockbox/notes/private-${index + 1}.shard`,
      gitStatus: "committed",
      error: null,
      aiStatus: "none",
      archived: false,
      lockbox: true,
      pinned: false,
      related: [],
    }));
    const lockbox = {
      configured: true,
      unlocked: Boolean(fixtureOptions.initialUnlocked),
      expiresAt: fixtureOptions.initialUnlocked
        ? "2026-09-25T12:00:00.000Z"
        : null,
      ttlSeconds: 180,
    };
    const git = {
      branch: "main",
      shortCommit: "t07test",
      hasRemote: false,
      status: "ready",
      error: null,
      ahead: 0,
      behind: 0,
    };
    const mapSummary = {
      id: "map-t07",
      title: "T07 独立导图",
      createdAt: now,
      updatedAt: now,
      nodeCount: 1,
      path: "maps/map-t07.shardmap",
    };
    const mapFile = {
      kind: "shard.map",
      schemaVersion: 1,
      id: mapSummary.id,
      title: mapSummary.title,
      createdAt: now,
      updatedAt: now,
      savedWithAppVersion: "0.1.3",
      revision: 1,
      rootId: "root",
      hasProtectedLinks: false,
      nodes: {
        root: {
          id: "root",
          parentId: null,
          sortKey: "a",
          text: mapSummary.title,
          createdAt: now,
          updatedAt: now,
        },
      },
    };
    const tree = {
      entries: [],
      assets: [],
      trashEntries: [],
      fragmentTrashEntries: [],
      fragmentStream: {
        totalCount: publicFragments.length,
        years: [],
      },
    };
    const calls: SearchPaletteFixture["calls"] = [];
    const workerMessages: WorkerMessage[] = [];
    const clone = <T>(value: T): T => structuredClone(value);
    const state = () => ({
      vaultPath: "/tmp/shard-search-palette",
      fragments: clone([
        ...publicFragments,
        ...(lockbox.unlocked ? lockboxFragments : []),
      ]),
      git: clone(git),
      lockbox: clone(lockbox),
    });

    const NativeWorker = globalThis.Worker;
    class ObservedWorker extends NativeWorker {
      override postMessage(
        message: unknown,
        options?: StructuredSerializeOptions,
      ) {
        workerMessages.push(clone(message as WorkerMessage));
        if (options === undefined) super.postMessage(message);
        else super.postMessage(message, options);
      }
    }

    let callbackId = 0;
    Object.assign(globalThis, {
      Worker: ObservedWorker,
      isTauri: true,
      __SHARD_SEARCH_PALETTE_FIXTURE__: { calls, workerMessages },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
      __TAURI_INTERNALS__: {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { label: "main" },
        },
        transformCallback: () => ++callbackId,
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          calls.push({ args: clone(args), command });
          switch (command) {
            case "plugin:event|listen":
              return ++callbackId;
            case "plugin:event|unlisten":
            case "unhide_pointer":
            case "set_window_controls_hidden":
              return null;
            case "plugin:app|version":
              return "0.1.3-test";
            case "list_fragments":
              return state();
            case "list_library_tree":
              return clone(tree);
            case "migrate_legacy_notes":
              return { tree: clone(tree), migratedCount: 0 };
            case "list_mind_maps":
              return clone([mapSummary]);
            case "read_mind_map":
              return {
                file: clone(mapFile),
                path: mapSummary.path,
                lastSavedHash: "map-hash",
              };
            case "write_mind_map":
              return {
                file: clone(args.file ?? mapFile),
                path: mapSummary.path,
                lastSavedHash: "map-hash-next",
              };
            case "list_csv_files":
            case "list_diagram_documents":
              return [];
            case "update_fragment": {
              const fragment = publicFragments.find(
                (candidate) => candidate.id === args.id,
              );
              if (!fragment) throw new Error("Fragment not found");
              fragment.content = String(args.content ?? fragment.content);
              fragment.tags = Array.isArray(args.tags)
                ? (args.tags as string[])
                : fragment.tags;
              return clone(fragment);
            }
            case "unlock_lockbox":
              lockbox.unlocked = true;
              lockbox.expiresAt = "2026-09-25T12:00:00.000Z";
              return state();
            case "lock_lockbox":
              lockbox.unlocked = false;
              lockbox.expiresAt = null;
              return state();
            case "sync_vault":
              return clone(git);
            case "checkpoint_vault":
              return { status: "noop", git: clone(git) };
            default:
              throw new Error(`Unhandled Tauri test command: ${command}`);
          }
        },
      },
    });
  }, options);
}

async function openLockbox(page: Page) {
  await page.getByRole("button", { name: "资料库", exact: true }).click();
  await page
    .getByRole("complementary", { name: "资料库目录" })
    .getByRole("button", { name: "密匣（上锁空间）", exact: true })
    .click();
}

async function unlockLockbox(page: Page) {
  const gate = page.getByRole("form", { name: "解锁密匣" });
  await gate.getByPlaceholder("密匣密码").fill("correct-password");
  await gate.getByRole("button", { name: "解锁", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "密匣", exact: true }),
  ).toBeVisible();
}

function fixture(page: Page) {
  return page.evaluate(() =>
    structuredClone(
      (
        globalThis as typeof globalThis & {
          __SHARD_SEARCH_PALETTE_FIXTURE__: SearchPaletteFixture;
        }
      ).__SHARD_SEARCH_PALETTE_FIXTURE__,
    ),
  );
}

function searchCalls(page: Page) {
  return page.evaluate(() =>
    structuredClone(
      (
        globalThis as typeof globalThis & {
          __SHARD_SEARCH_IPC_MOCK__: {
            calls: Array<{
              command: string;
              request: Record<string, unknown>;
            }>;
          };
        }
      ).__SHARD_SEARCH_IPC_MOCK__.calls,
    ),
  );
}

test("shortcuts switch modes without remounting palette", async ({ page }) => {
  await installSearchPaletteFixture(page);
  await page.goto("/");

  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "搜索" });
  const input = page.getByRole("combobox", { name: "搜索内容" });
  await dialog.evaluate((element) => {
    element.setAttribute("data-t07-mount", "stable");
  });
  await input.fill("共同词");
  await expect(page.getByRole("option")).toHaveCount(18);

  await page.keyboard.press("Control+o");
  await expect(dialog).toHaveAttribute("data-t07-mount", "stable");
  await expect(dialog).toHaveAttribute("data-search-mode", "open");
  await expect(input).toHaveValue("");
  await input.fill("公开笔记 2");

  await page.keyboard.press("Control+k");
  await expect(dialog).toHaveAttribute("data-t07-mount", "stable");
  await expect(dialog).toHaveAttribute("data-search-mode", "fullText");
  await expect(input).toHaveValue("共同词");
});

test("opening search does not flush or blur-save a draft", async ({ page }) => {
  await installSearchPaletteFixture(page);
  await page.goto("/");

  const card = page.locator('[data-shard-fragment-id="public-1"]');
  await card.getByRole("button", { name: "片段操作" }).click();
  await page.getByRole("menuitem", { name: "编辑", exact: true }).click();
  await fillEditor(page, "fragment:public-1", "尚未保存的 T07 草稿");
  const before = (await fixture(page)).calls.filter(
    ({ command }) => command === "update_fragment",
  ).length;

  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "搜索" })).toBeVisible();
  await page.waitForTimeout(100);

  const after = (await fixture(page)).calls.filter(
    ({ command }) => command === "update_fragment",
  ).length;
  expect(after).toBe(before);
});

test("composition does not query or open a result", async ({ page }) => {
  await installSearchPaletteFixture(page);
  await page.goto("/");
  await page.keyboard.press("Control+k");

  const dialog = page.getByRole("dialog", { name: "搜索" });
  const input = page.getByRole("combobox", { name: "搜索内容" });
  await input.dispatchEvent("compositionstart", { data: "共同词" });
  await input.evaluate((element) => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(element, "共同词");
    element.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: "共同词",
        inputType: "insertCompositionText",
        isComposing: true,
      }),
    );
  });
  await input.press("Enter");
  await input.press("Escape");

  expect(
    (await fixture(page)).workerMessages.filter(
      ({ type }) => type === "search",
    ),
  ).toHaveLength(0);
  await expect(dialog).toHaveAttribute("data-search-pending", "false");
  await expect(dialog).toBeVisible();

  await input.dispatchEvent("compositionend", { data: "共同词" });
  await expect(page.getByRole("option")).toHaveCount(18);
  expect(
    (await fixture(page)).workerMessages.filter(
      ({ type }) => type === "search",
    ),
  ).toHaveLength(1);
});

test("tab never switches search mode", async ({ page }) => {
  await installSearchPaletteFixture(page);
  await page.goto("/");
  await page.keyboard.press("Control+k");

  const dialog = page.getByRole("dialog", { name: "搜索" });
  const input = page.getByRole("combobox", { name: "搜索内容" });
  await expect(input).toBeFocused();
  await input.press("Tab");
  await input.press("Shift+Tab");

  await expect(dialog).toHaveAttribute("data-search-mode", "fullText");
  await expect(
    page.getByRole("button", { name: "全文", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("palette is available in standalone mindmap workspace", async ({
  page,
}) => {
  await installSearchPaletteFixture(page);
  await page.goto("/");
  await page.locator("[data-shard-utility-menu-trigger]:visible").click();
  await page.getByRole("menuitem", { name: "思维导图", exact: true }).click();
  await page.getByLabel("打开思维导图：T07 独立导图", { exact: true }).click();
  await expect(
    page.getByRole("button", { name: "退出思维导图", exact: true }),
  ).toBeVisible();

  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "搜索" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "搜索内容" })).toBeFocused();
});

test("states distinguish indexing stale locked and failure", async ({
  page,
}) => {
  await installSearchPaletteFixture(page);
  await page.goto("/");
  await openLockbox(page);
  await unlockLockbox(page);

  await updateSearchIpcMock(page, { indexState: "indexing" });
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "搜索" });
  const input = page.getByRole("combobox", { name: "搜索内容" });
  await input.fill("密匣共同词");
  await expect(dialog).toHaveAttribute("data-search-state", "indexing");
  await expect
    .poll(async () => (await searchCalls(page)).length)
    .toBeGreaterThan(0);

  await updateSearchIpcMock(page, { indexState: "ready" });
  await expect(page.getByRole("option")).toHaveCount(2);

  await updateSearchIpcMock(page, { indexState: "stale" });
  await input.fill("密匣唯一词");
  await expect(dialog).toHaveAttribute("data-search-state", "stale");
  await expect(page.getByText("结果可能已过期，正在更新")).toBeVisible();

  await updateSearchIpcMock(page, {
    indexState: "ready",
    nextError: {
      command: "search_vault",
      error: { code: "io", retryable: false },
    },
  });
  await input.fill("失败状态");
  await expect(dialog).toHaveAttribute("data-search-state", "error");
  await expect(page.getByText("搜索失败", { exact: true })).toBeVisible();

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "上锁", exact: true }).click();
  await openLockbox(page);
  await expect(page.getByRole("heading", { name: "密匣已上锁" })).toBeVisible();
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "搜索" })).toHaveAttribute(
    "data-search-state",
    "locked",
  );
  await expect(
    page
      .getByRole("dialog", { name: "搜索" })
      .getByText("密匣已上锁", { exact: true }),
  ).toBeVisible();
});

test("public and lockbox providers never share payloads", async ({ page }) => {
  await installSearchPaletteFixture(page);
  await page.goto("/");

  await page.keyboard.press("Control+k");
  const input = page.getByRole("combobox", { name: "搜索内容" });
  await input.fill("密匣唯一词");
  await expect(page.getByText("没有找到“密匣唯一词”")).toBeVisible();
  const publicMessages = (await fixture(page)).workerMessages;
  expect(
    publicMessages
      .filter(({ type }) => type === "index")
      .at(-1)
      ?.documents?.map(({ id }) => id),
  ).toEqual(Array.from({ length: 18 }, (_, index) => `public-${index + 1}`));

  await page.keyboard.press("Escape");
  const publicWorkerCount = publicMessages.filter(
    ({ documents, query }) => documents !== undefined || query !== undefined,
  ).length;
  await openLockbox(page);
  await unlockLockbox(page);
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "搜索内容" }).fill("密匣唯一词");
  await expect(page.getByRole("option")).toHaveCount(2);

  expect(
    (await fixture(page)).workerMessages.filter(
      ({ documents, query }) => documents !== undefined || query !== undefined,
    ),
  ).toHaveLength(publicWorkerCount);
  const nativeRequests = await searchCalls(page);
  expect(nativeRequests).not.toHaveLength(0);
  expect(
    nativeRequests.every(({ request }) => request.scope === "lockbox"),
  ).toBe(true);
});

test("result geometry shows every row promised by the net viewport", async ({
  page,
}) => {
  await installSearchPaletteFixture(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "搜索内容" }).fill("共同词");
  await expect(page.getByRole("option")).toHaveCount(18);

  for (const height of [720, 520]) {
    await page.setViewportSize({ width: 1280, height });
    await assertCompleteRows(page, 56, 60);
  }

  await page.keyboard.press("Control+o");
  await expect(page.getByRole("option")).toHaveCount(18);
  for (const height of [720, 520]) {
    await page.setViewportSize({ width: 1280, height });
    await assertCompleteRows(page, 40, 44);
  }
});

test("fragment results render one highlighted preview without a duplicate title", async ({
  page,
}) => {
  await installSearchPaletteFixture(page);
  await page.goto("/");
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "搜索内容" }).fill("共同词");

  const fragment = page.getByRole("option").filter({
    has: page.locator('[data-search-result-content="fragment-preview"]'),
  });
  await expect(fragment).toHaveCount(1);
  const text = await fragment.innerText();
  expect(text.match(/共同词公开笔记 1/gu)).toHaveLength(1);
  await expect(fragment.locator("mark")).toHaveText("共同词");
  expect(
    await fragment
      .locator('[data-search-result-content="fragment-preview"]')
      .evaluate((element) => getComputedStyle(element).webkitLineClamp),
  ).toBe("2");

  const titledNoteText = await page.getByRole("option").nth(1).innerText();
  expect(titledNoteText.match(/共同词公开笔记 2(?!\d)/gu)).toHaveLength(1);
});

test("title hit parts use the same highlight in full text and Open modes", async ({
  page,
}) => {
  await installSearchPaletteFixture(page);
  await page.goto("/");
  await page.keyboard.press("Control+k");
  const input = page.getByRole("combobox", { name: "搜索内容" });
  await input.fill("共同词");
  await expect(
    page.locator("[data-search-result-title] mark").first(),
  ).toHaveText("共同词");

  await page.keyboard.press("Control+o");
  await input.fill("共同词");
  await expect(
    page.locator("[data-search-result-title] mark").first(),
  ).toHaveText("共同词");
});

test("header stays on one line and keeps controls ordered in narrow viewports", async ({
  page,
}) => {
  await installSearchPaletteFixture(page);
  await page.setViewportSize({ width: 720, height: 640 });
  await page.goto("/");
  await page.keyboard.press("Control+k");

  const header = page.locator("[data-search-palette-header]");
  const layout = await header.evaluate((element) => {
    const input = element.querySelector<HTMLElement>('[role="combobox"]');
    const modes = element.querySelector<HTMLElement>('[role="group"]');
    const close = element.querySelector<HTMLElement>('[aria-label="关闭搜索"]');
    const rect = (target: HTMLElement | null) => {
      if (!target) return null;
      const value = target.getBoundingClientRect();
      return {
        bottom: value.bottom,
        height: value.height,
        left: value.left,
        right: value.right,
        top: value.top,
        width: value.width,
      };
    };
    return {
      close: rect(close),
      header: rect(element),
      input: rect(input),
      modes: rect(modes),
    };
  });
  expect(layout.input?.top).toBeCloseTo(layout.modes?.top ?? 0, 0);
  expect(layout.close?.top).toBeCloseTo(layout.modes?.top ?? 0, 0);
  expect(layout.close?.left ?? 0).toBeGreaterThan(layout.modes?.right ?? 0);
  expect(layout.header?.height ?? 0).toBeLessThanOrEqual(52);

  await page.setViewportSize({ width: 360, height: 640 });
  await expect(header).toBeVisible();
  expect(
    await header.evaluate((element) => getComputedStyle(element).flexWrap),
  ).toBe("nowrap");
});

test("Open empty query labels recent or modified results", async ({ page }) => {
  await installSearchPaletteFixture(page);
  await page.goto("/");
  await page.keyboard.press("Control+o");
  await expect(page.locator("[data-search-section-title]")).toHaveText(
    "最近修改",
  );

  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    const key = JSON.stringify([
      "/tmp/shard-search-palette",
      "public",
      "notes/public-2.md",
    ]);
    localStorage.setItem(
      "shard.recent./tmp/shard-search-palette",
      JSON.stringify([{ key, openedAt: Date.now() }]),
    );
  });
  await page.reload();
  await page.keyboard.press("Control+o");
  await expect(page.locator("[data-search-section-title]")).toHaveText(
    "最近打开",
  );
});

test("footer distinguishes complete and truncated result counts", async ({
  page,
}) => {
  await installSearchPaletteFixture(page, { publicCount: 60 });
  await page.goto("/");
  await page.keyboard.press("Control+k");
  const input = page.getByRole("combobox", { name: "搜索内容" });
  await input.fill("共同词");
  await expect(
    page.getByText("显示前 50 条 · 共 60 条", { exact: true }),
  ).toBeVisible();

  await input.fill("公开正文 60");
  await expect(page.getByText("1 条", { exact: true })).toBeVisible();
});

test("captures T07 polish evidence at desktop and compact sizes", async ({
  page,
}) => {
  await installSearchPaletteFixture(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "搜索内容" }).fill("共同词");
  await expect(page.getByRole("option")).toHaveCount(18);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.screenshot({
    path: "docs/design/evidence/search-t07-polish/1280x720-fulltext-results.png",
  });

  await page.keyboard.press("Control+o");
  await expect(page.locator("[data-search-section-title]")).toHaveText(
    "最近修改",
  );
  await page.screenshot({
    path: "docs/design/evidence/search-t07-polish/1280x720-open-empty.png",
  });

  await page.setViewportSize({ width: 720, height: 640 });
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("option")).toHaveCount(18);
  await page.screenshot({
    path: "docs/design/evidence/search-t07-polish/720x640-fulltext-results.png",
  });

  await page.keyboard.press("Control+o");
  await expect(page.locator("[data-search-section-title]")).toHaveText(
    "最近修改",
  );
  await page.screenshot({
    path: "docs/design/evidence/search-t07-polish/720x640-open-empty.png",
  });
});

async function assertCompleteRows(
  page: Page,
  minimum: number,
  maximum: number,
) {
  const geometry = await page
    .locator(
      '[data-search-results-viewport] [data-slot="scroll-area-viewport"]',
    )
    .evaluate((viewport) => {
      const viewportRect = viewport.getBoundingClientRect();
      const rows = Array.from(
        viewport.querySelectorAll<HTMLElement>('[role="option"]'),
      );
      const rowHeight = rows[0]?.getBoundingClientRect().height ?? 0;
      const sectionHeight =
        viewport
          .querySelector<HTMLElement>("[data-search-section-title]")
          ?.getBoundingClientRect().height ?? 0;
      const completeRows = rows.filter((row) => {
        const rect = row.getBoundingClientRect();
        return (
          rect.top >= viewportRect.top - 0.5 &&
          rect.bottom <= viewportRect.bottom + 0.5
        );
      }).length;
      return {
        completeRows,
        promisedRows: Math.floor(
          (viewport.clientHeight - sectionHeight) / rowHeight,
        ),
        rowHeight,
        viewportHeight: viewport.clientHeight,
      };
    });

  expect(geometry.rowHeight).toBeGreaterThanOrEqual(minimum);
  expect(geometry.rowHeight).toBeLessThanOrEqual(maximum);
  expect(geometry.viewportHeight).toBeGreaterThan(0);
  expect(geometry.completeRows).toBeGreaterThanOrEqual(geometry.promisedRows);
}
