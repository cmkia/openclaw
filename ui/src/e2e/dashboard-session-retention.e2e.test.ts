import type { Page } from "playwright";
import { expect, it } from "vitest";
import { openSlot, setSidebarOpen } from "../pages/chat/sidebar-layout.ts";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionPath,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI retained dashboard sessions",
  startServerBeforeBrowser: true,
});

const alphaKey = "agent:main:dashboard-alpha";
const betaKey = "agent:main:dashboard-beta";
const viewport = { height: 900, width: 1280 };
const featureMethods = ["board.get", "chat.metadata", "chat.startup"];
const gatewayDefaults = { sessionKey: alphaKey, featureMethods };
const emptyBoard = { sessionKey: alphaKey, revision: 1, tabs: [], widgets: [] };
const sessionLink = (page: Page, key: string) =>
  page.locator(`.sidebar-recent-session[data-session-key="${key}"] a.sidebar-recent-session__link`);
const boardCases = (alpha = dashboardSnapshot(alphaKey, "alpha")) => ({
  cases: [alpha, dashboardSnapshot(betaKey, "beta")].map((response) => ({
    match: { sessionKey: response.sessionKey },
    response,
  })),
});
const installDashboard = (
  page: Page,
  responses: NonNullable<Parameters<typeof installMockGateway>[1]>["methodResponses"],
  options: Parameters<typeof installMockGateway>[1] = {},
) => installMockGateway(page, { ...gatewayDefaults, methodResponses: responses, ...options });

function dashboardPath(key: string): string {
  return controlUiSessionPath(key).replace(/^\/chat\//u, "/dashboard/");
}

function dashboardSnapshot(key: string, prefix: string) {
  return {
    sessionKey: key,
    revision: 1,
    tabs: [
      { tabId: `${prefix}-main`, title: `${prefix} main`, position: 0, chatDock: "right" },
      { tabId: `${prefix}-other`, title: `${prefix} other`, position: 1, chatDock: "right" },
    ],
    widgets: [],
  };
}

function sessionList(dashboards = false) {
  return {
    count: 2,
    defaults: { contextTokens: null, model: "gpt-5.6-luna", modelProvider: "openai" },
    path: "",
    sessions: [alphaKey, betaKey].map((key, index) => ({
      key,
      kind: "direct",
      label: `${index === 0 ? "Alpha" : "Beta"} ${dashboards ? "dashboard" : "chat"}`,
      updatedAt: 2 - index,
      boardFace: dashboards ? "dashboard" : undefined,
    })),
    ts: Date.now(),
  };
}

suite.define(() => {
  it("opens an empty task dashboard without editing the draft and preserves its chosen layout", async () => {
    await suite.withPage({ viewport }, async ({ page }) => {
      const gateway = await installDashboard(
        page,
        { "board.get": emptyBoard },
        {
          deferredMethods: ["board.get"],
        },
      );
      await page.goto(new URL(controlUiSessionPath(alphaKey), suite.server.baseUrl).href);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      const draft = "Review the release checklist.";
      await composer.fill(draft);
      await openChatSidePanelType(page, "Dashboard");
      const dashboard = page.locator('[data-panel-slot="dashboard"]');
      const boardView = dashboard.locator("openclaw-board-view");
      await dashboard.getByRole("status").waitFor();
      expect(await composer.inputValue()).toBe(draft);
      await gateway.rejectDeferred("board.get", {
        code: "UNAVAILABLE",
        message: "Dashboard temporarily unavailable",
        retryable: false,
      });
      await dashboard.getByRole("alert").waitFor();
      expect(await dashboard.getByRole("alert").textContent()).toContain(
        "Dashboard temporarily unavailable",
      );
      expect(await dashboard.locator('[data-test-id="board-empty"]').count()).toBe(0);
      await gateway.deferNext("board.get");
      await gateway.emitGatewayEvent("board.changed", { sessionKey: alphaKey });
      await expect.poll(async () => (await gateway.getRequests("board.get")).length).toBe(2);
      await gateway.resolveDeferred("board.get");
      await dashboard.locator('[data-test-id="board-empty"]').waitFor();
      const board = await boardView.elementHandle();

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await selectChatLayoutAction(page, /^(Side panel|Minimize side panel)$/);
        await dashboard.waitFor({ state: "hidden" });
        await selectChatLayoutAction(page, /^(Side panel|Minimize side panel)$/);
        await dashboard.locator('[data-test-id="board-empty"]').waitFor();
        expect(await composer.inputValue()).toBe(draft);
      }
      await selectChatLayoutAction(page, /^Swap /);
      await selectChatLayoutAction(page, "Focus");
      await composer.waitFor({ state: "hidden" });
      await gateway.setMethodResponse("board.get", dashboardSnapshot(alphaKey, "alpha"));
      await gateway.emitGatewayEvent("board.changed", { sessionKey: alphaKey });
      await page.locator('[data-board-tab-id="alpha-main"]').waitFor();
      expect(await composer.isVisible()).toBe(false);
      expect(await boardView.evaluate((element, previous) => element === previous, board)).toBe(
        true,
      );
      await selectChatLayoutAction(page, "Restore split");
      await composer.waitFor();
      expect(await composer.inputValue()).toBe(draft);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });

  it("does not mount an unopened dashboard after leaving another session's open panel", async () => {
    await suite.withPage({ viewport }, async ({ page }) => {
      const gateway = await installDashboard(
        page,
        {
          "board.get": boardCases(emptyBoard),
          "browser.request": {
            cases: [
              { match: { method: "GET", path: "/tabs" }, response: { running: false, tabs: [] } },
            ],
          },
          "sessions.list": sessionList(),
        },
        { featureMethods: [...featureMethods, "browser.request"] },
      );
      await page.addInitScript(
        ({ storageKey, key, layout }) => {
          const settings = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
          settings.sidebarSessionLayouts = { [key]: layout };
          localStorage.setItem(storageKey, JSON.stringify(settings));
        },
        {
          storageKey: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
          key: betaKey,
          layout: setSidebarOpen(openSlot({ columns: [] }, "dashboard"), false),
        },
      );
      await page.goto(new URL(controlUiSessionPath(alphaKey), suite.server.baseUrl).href);
      await openChatSidePanelType(page, "Browser");
      const alphaRegion = await page.locator("openclaw-chat-sidebar-region").elementHandle();
      expect(alphaRegion).not.toBeNull();
      await sessionLink(page, betaKey).click();
      await page.waitForURL(new URL(controlUiSessionPath(betaKey), suite.server.baseUrl).href);
      await expect
        .poll(() => gateway.getRequests("board.get"))
        .toContainEqual(
          expect.objectContaining({ params: expect.objectContaining({ sessionKey: betaKey }) }),
        );
      const betaPane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--visible");
      const betaRegion = betaPane.locator("openclaw-chat-sidebar-region");
      await betaRegion.waitFor({ state: "attached" });
      expect(
        await betaRegion.evaluate((element, previous) => element === previous, alphaRegion),
      ).toBe(false);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      expect(await betaPane.locator('[data-region-header="side"]').isVisible()).toBe(false);
      expect(await betaPane.locator("openclaw-board-view").count()).toBe(0);
      await selectChatLayoutAction(betaPane, "Side panel");
      await betaPane.locator('[data-board-tab-id="beta-main"]').waitFor();
    });
  });

  it("shows a warmed dashboard immediately while its refresh is pending", async () => {
    await suite.withPage({ viewport }, async ({ page }) => {
      const gateway = await installDashboard(page, {
        "board.get": boardCases(),
        "sessions.list": sessionList(true),
      });

      await page.goto(new URL(dashboardPath(alphaKey), suite.server.baseUrl).href);
      const alphaTab = page.locator('[data-board-tab-id="alpha-main"]');
      await alphaTab.waitFor();

      const activeDashboards = () =>
        page.locator("openclaw-chat-pane").evaluateAll(
          (panes, keys) =>
            keys.map((key) => {
              const board = panes
                .find((pane) => Reflect.get(pane, "sessionKey") === key)
                ?.querySelector("openclaw-board-view");
              return board ? Reflect.get(board, "active") : null;
            }),
          [alphaKey, betaKey],
        );
      await sessionLink(page, betaKey).click();
      await page.locator('[data-board-tab-id="beta-main"]').waitFor();
      await expect.poll(() => new URL(page.url()).pathname).toBe(dashboardPath(betaKey));
      await expect.poll(activeDashboards).toEqual([false, true]);

      await gateway.deferNext("board.get", { sessionKey: alphaKey });
      await sessionLink(page, alphaKey).click();
      await alphaTab.waitFor({ state: "visible", timeout: 1_000 });
      expect(await alphaTab.textContent()).toContain("alpha main");
      await expect.poll(activeDashboards).toEqual([true, false]);
    });
  });

  it("projects a distinct durable reply after interim text and a message-less terminal", async () => {
    const sessionKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
    const textContent = (text: string) => [{ type: "text", text }];
    await suite.withPage(
      { locale: "en-US", viewport: { height: 900, width: 1280 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          sessionKey,
          featureMethods: ["board.get", "chat.metadata", "chat.startup"],
          sessions: [
            {
              boardFace: "dashboard",
              key: sessionKey,
              kind: "direct",
              label: "Nightly Disk Cleanup",
              updatedAt: Date.now(),
            },
          ],
          methodResponses: {
            "board.get": {
              revision: 1,
              sessionKey,
              tabs: [
                { tabId: "main", title: "Nightly Disk Cleanup", position: 0, chatDock: "right" },
              ],
              widgets: [],
            },
            "sessions.resolve": { ok: true, key: sessionKey, boardFace: "dashboard" },
          },
        });

        await page.goto(new URL(dashboardPath(sessionKey), suite.server.baseUrl).href);
        const prompt = "Why did Done appear without my reply?";
        const interimText = "Checking the dashboard state.";
        const updatedInterimText = "Still checking the dashboard state.";
        const partialFinalText = "Drafting the durable dashboard reply.";
        const stalePartialFinalText = "Drafting more of the durable dashboard reply.";
        const finalText = "The durable dashboard reply is visible after Done.";
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.fill(prompt);
        await page.getByRole("button", { name: "Send message" }).click();
        const send = await gateway.waitForRequest("chat.send");
        const params = send.params as Record<string, unknown>;
        const runId = typeof params.idempotencyKey === "string" ? params.idempotencyKey : "";
        expect(runId).not.toBe("");

        const emitDelta = (text: string, seq: number, replace = false) =>
          gateway.emitGatewayEvent("chat", {
            runId,
            sessionKey,
            seq,
            state: "delta",
            deltaText: text,
            ...(replace ? { replace } : {}),
            message: { role: "assistant", content: textContent(text), timestamp: seq },
          });
        await emitDelta(interimText, 1);
        await page.locator(".chat-thread-inner", { hasText: interimText }).waitFor();
        await emitDelta(partialFinalText, 2, true);
        await page.locator(".chat-thread-inner", { hasText: partialFinalText }).waitFor();

        const assistantMessage = (id: string, text: string, seq: number, phase?: string) => ({
          role: "assistant",
          timestamp: seq,
          __openclaw: { id: `dashboard-${id}`, runId, seq },
          ...(phase
            ? { phase, content: [{ text, type: "text", cache_control: { type: "ephemeral" } }] }
            : { content: textContent(text), stopReason: "stop" }),
        });
        const persistedHistory = [
          {
            role: "user",
            content: textContent(prompt),
            timestamp: 1,
            __openclaw: { id: "dashboard-prompt", idempotencyKey: `${runId}:user`, seq: 1 },
          },
          // Stale phased messages retain reordered keys and cache metadata, not a terminal reply.
          assistantMessage("interim", updatedInterimText, 2, "commentary"),
          assistantMessage("partial-final", stalePartialFinalText, 3, "final_answer"),
          assistantMessage("final", finalText, 4),
        ];
        const historyCount = (await gateway.getRequests("chat.history")).length;
        await gateway.setHistoryMessages(persistedHistory);
        await gateway.emitGatewayEvent("chat", {
          runId,
          sessionKey,
          state: "final",
        });

        const recoveryRequest = await gateway.waitForRequest("chat.history", {
          after: historyCount,
        });
        expect(recoveryRequest.params).toMatchObject({ sessionKey, limit: 80 });
        const visibleFinal = page.locator(".chat-thread-inner .chat-text", { hasText: finalText });
        await visibleFinal.waitFor({ timeout: 10_000 });
        await expect.poll(() => visibleFinal.count()).toBe(1);
        await expect
          .poll(async () => (await gateway.getRequests("chat.history")).length)
          .toBe(historyCount + 1);
      },
    );
  });
});
