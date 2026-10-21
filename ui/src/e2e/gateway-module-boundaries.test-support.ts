import { describe, expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { installMockGateway, pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
import type { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

export function defineGatewayModuleBoundaryTests(
  suite: ReturnType<typeof createControlUiE2eSuite>,
  moduleRequest: (sourcePath: string) => RegExp,
) {
  describe("Gateway recovery while a module is unavailable", () => {
    it.each([390, 1280])(
      "keeps recovery available after a sidebar download failure at %ipx",
      async (width) => {
        await suite.withPage(
          {
            viewport: { width, height: 844 },
            colorScheme: "dark",
            locale: "en-US",
            serviceWorkers: "block",
          },
          async ({ page }) => {
            let blockedSidebarRequests = 0;
            await page.route(moduleRequest("ui/src/components/app-sidebar.tsx"), async (route) => {
              blockedSidebarRequests += 1;
              await route.abort("failed");
            });
            const gateway = await installMockGateway(page, {
              // The sidebar module is deliberately unavailable, so no roster can render.
              awaitInitialRoster: false,
            });
            // Failed production imports trigger the one-shot document reload.
            // Finish that replacement before testing a later Gateway disconnect.
            await Promise.all([
              page.waitForEvent("framenavigated", {
                predicate: (frame) =>
                  frame === page.mainFrame() &&
                  new URL(frame.url()).searchParams.has("openclaw_mount_recovery"),
              }),
              page.goto(`${suite.server.baseUrl}new`),
            ]);
            await waitForControlUiGatewayReady(page);
            await page.locator(".new-session-page__message").waitFor({ state: "visible" });
            await expect.poll(() => blockedSidebarRequests).toBeGreaterThan(0);
            expect(await page.locator(".sidebar-identity-card").isVisible()).toBe(false);

            await page.clock.install();
            await pauseVirtualClock(page);
            const connectedSocketCount = await gateway.getSocketCount();
            await gateway.setOnline(false);
            await page.clock.runFor(2_001);
            await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(connectedSocketCount);
            const connectionStatus = page.locator(
              width === 390
                ? ".mobile-connection-status .gateway-status:visible"
                : ".sidebar-shell__footer .gateway-status:visible",
            );
            await connectionStatus
              .locator(".gateway-status__label")
              .getByText("Reconnecting…", { exact: true })
              .waitFor({ state: "visible" });
            expect(await connectionStatus.getByRole("button", { name: /Retry now/ }).count()).toBe(
              0,
            );
            // Settle the pending mock attempt, then let the owner's scheduled retry run.
            await gateway.closeLatest(1006, "synthetic failed attempt");
            const retryDelay = await evaluateControlUiContext(page, ({ gateway: connection }) => {
              const deadline = connection.snapshot.reconnectAt;
              if (deadline === undefined) {
                throw new Error("Expected a scheduled Gateway reconnect");
              }
              return Math.max(0, deadline - Date.now());
            });
            const socketCount = await gateway.getSocketCount();
            await page.clock.runFor(retryDelay + 1);
            await expect.poll(() => gateway.getSocketCount()).toBe(socketCount + 1);
            await gateway.setOnline(true);
            await page.clock.resume();
            await waitForControlUiGatewayReady(page);
            await connectionStatus.waitFor({ state: "detached" });
          },
        );
      },
    );
  });
}
