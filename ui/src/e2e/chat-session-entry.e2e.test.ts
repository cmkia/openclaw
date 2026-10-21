import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { captureControlUiE2eFailureDiagnostics } from "../test-helpers/control-ui-e2e-diagnostics.ts";
import { installControlUiE2eRendererStallProbe } from "../test-helpers/control-ui-e2e-renderer-stall.ts";
import {
  controlUiBundledGatewayUrl,
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  controlUiE2eWaitTimeoutMs,
  createControlUiMockSameOriginGatewayScript,
  installMockGateway,
  navigateToControlUiSession,
} from "../test-helpers/control-ui-e2e.ts";
import { navigationDrawerToggle } from "../test-helpers/control-ui-navigation.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

type EntrySample = { id: number; kind: string; y: number; height: number };
type TimedEntrySample = EntrySample & { time: number };
type EntryFrame = { time: number; samples: EntrySample[] };
type EntryRecorder = { enabled: boolean; done: boolean; frames: EntryFrame[] };
const homeKey = "agent:main:main";
const entryKey = "agent:main:entry-proof";
const chooseSession = "Choose the session in the sidebar.";
const text = (value: string) => ({ type: "text", text: value });
const sidebarPages = new Map<
  "light" | "dark",
  { page: Page; gateway: Awaited<ReturnType<typeof installMockGateway>>; pageErrors: string[] }
>();

function entryMessages(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: [
      text(
        `Entry checkpoint ${index + 1}. ${index % 2 ? "The transcript should appear in its final position." : "Review this session and preserve the reading position."}`,
      ),
    ],
    timestamp: Date.UTC(2026, 8, 10, 12, index),
    __openclaw: { id: `entry-${index}`, seq: index + 1 },
  }));
}

const sidebarKey = (count: number, width: number, motion: string, scheme: string) =>
  `${entryKey}-${count}-${width}-${motion}-${scheme}`;

declare global {
  interface Window {
    sessionEntryRecorder: EntryRecorder;
  }
}

const suite = createControlUiE2eSuite({
  name: "chat session entry",
  browserLaunchOptions: {
    channel: "chromium",
    args: ["--font-render-hinting=none", "--force-color-profile=srgb"],
  },
  resources: {
    run: async () => {
      for (const colorScheme of ["light", "dark"] as const) {
        const context = await suite.newBrowserContext({
          ...createControlUiE2eContextOptions(),
          viewport: { width: 1440, height: 900 },
          deviceScaleFactor: 2,
          reducedMotion: "no-preference",
          colorScheme,
        });
        const page = await context.newPage();
        await installControlUiE2eRendererStallProbe(page);
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        try {
          const targets = scenarios
            .filter((scenario) => scenario[0] === "sidebar" && scenario[4] === colorScheme)
            .map(([, count, width, motion, scheme]) => ({
              key: sidebarKey(count, width, motion, scheme),
              messages: entryMessages(count),
            }));
          const gateway = await installMockGateway(page, {
            sessionKey: homeKey,
            sessionTranscripts: {
              [homeKey]: { messages: [{ role: "assistant", content: [text(chooseSession)] }] },
              ...Object.fromEntries(targets.map(({ key, messages }) => [key, { messages }])),
            },
            sessions: [
              { key: homeKey, label: "Home", kind: "direct", updatedAt: 1000 },
              ...targets.map(({ key }) => ({
                key,
                label: "Entry proof",
                kind: "direct",
                updatedAt: 2000,
              })),
            ],
            models: [{ id: "mock-model", name: "Mock model", provider: "mock" }],
            agentModel: "mock/mock-model",
          });
          await page.addInitScript(createControlUiMockSameOriginGatewayScript());
          await page.addInitScript(
            ({ key, ...settings }) => localStorage.setItem(key, JSON.stringify(settings)),
            {
              key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
              gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl),
              theme: "claw",
              themeMode: colorScheme,
            },
          );
          sidebarPages.set(colorScheme, { page, gateway, pageErrors });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, homeKey));
          await page.getByText(chooseSession).waitFor();
        } catch (error) {
          await captureControlUiE2eFailureDiagnostics(page, {
            error: error instanceof Error ? error : new Error(String(error)),
            label: "Chat sidebar entry setup",
          });
          throw error;
        }
      }
    },
  },
});
const scenarios = (["boot", "direct", "sidebar"] as const).flatMap((entry) =>
  [4, 160].flatMap((count) =>
    [1440, 390].flatMap((width) =>
      (["no-preference", "reduce"] as const).flatMap((reducedMotion) =>
        (["light", "dark"] as const).map(
          (colorScheme) => [entry, count, width, reducedMotion, colorScheme] as const,
        ),
      ),
    ),
  ),
);

type RecorderOptions = { target: string; enabled: boolean; lastEntryId: string };
function recordEntryFrames({ target, enabled, lastEntryId }: RecorderOptions) {
  const recorder: EntryRecorder = { enabled, done: false, frames: [] };
  window.sessionEntryRecorder = recorder;
  const ids = new WeakMap<Element, number>();
  let nextId = 0;
  let lastEntryPaintedAt: number | undefined;
  let lastEntryPaintedFrames = 0;
  const visibility = {
    contentVisibilityAuto: true,
    opacityProperty: true,
    visibilityProperty: true,
  };
  const tick = (time: number) => {
    if (recorder.done) {
      return;
    }
    requestAnimationFrame(tick);
    if (!recorder.enabled) {
      return;
    }
    const panes = document.querySelectorAll<HTMLElement & { sessionKey: string }>(
      "openclaw-chat-pane",
    );
    const pane = Array.from(panes).find(
      (el) => el.sessionKey === target && el.getBoundingClientRect().height > 0,
    );
    const thread = pane?.querySelector<HTMLElement>(".chat-thread");
    const viewport = thread?.getBoundingClientRect();
    const elements = [
      document.querySelector(".shell"),
      ...(pane?.querySelectorAll(
        ".chat-pane__header, .agent-chat__header--mobile, .chat, .chat-bubble[data-entry-id]",
      ) ?? []),
    ];
    const samples: EntrySample[] = [];
    for (const element of elements) {
      // Layout boxes alone do not prove that pixels were painted.
      if (!element?.checkVisibility(visibility)) {
        continue;
      }
      const rect = element.getBoundingClientRect();
      const entryId = element.getAttribute("data-entry-id");
      if (
        !rect.height ||
        (entryId && (!viewport || rect.bottom <= viewport.top || rect.top >= viewport.bottom))
      ) {
        continue;
      }
      let id = ids.get(element);
      if (id === undefined) {
        id = ++nextId;
        ids.set(element, id);
      }
      const kind =
        entryId ??
        (element.matches(".chat-pane__header, .agent-chat__header--mobile")
          ? "session-header"
          : element.className);
      samples.push({ id, kind, y: rect.y, height: rect.height });
      if (entryId === lastEntryId) {
        lastEntryPaintedAt ??= time;
        lastEntryPaintedFrames += 1;
      }
    }
    if (samples.length) {
      recorder.frames.push({ time, samples });
    }
    // Include the first paint and outlast the 300 ms entry animation.
    if (
      lastEntryPaintedAt !== undefined &&
      time - lastEntryPaintedAt >= 750 &&
      lastEntryPaintedFrames >= 10
    ) {
      recorder.done = true;
    }
  };
  requestAnimationFrame(tick);
}

function assertEntryFrames(frames: EntryFrame[], lastEntryId: string) {
  expect(frames.length).toBeGreaterThanOrEqual(10);
  const samplesById = new Map<number, [TimedEntrySample, ...TimedEntrySample[]]>();
  for (const { time, samples } of frames) {
    for (const sample of samples) {
      const timed = { ...sample, time };
      const trace = samplesById.get(sample.id);
      if (trace) {
        trace.push(timed);
      } else {
        samplesById.set(sample.id, [timed]);
      }
    }
  }
  const observed = Array.from(samplesById.values());
  for (const kind of ["session-header", "chat", "shell", lastEntryId]) {
    const samples = observed.find((rows) => rows[0].kind.split(" ").includes(kind));
    expect(samples?.length, `${kind} painted frame coverage`).toBeGreaterThanOrEqual(10);
    const duration = samples!.at(-1)!.time - samples![0].time;
    expect(duration, `${kind} observation duration`).toBeGreaterThanOrEqual(700);
  }
  expect(
    observed.filter((rows) => rows[0].kind.startsWith("entry-")).length,
  ).toBeGreaterThanOrEqual(2);
  // Transcript scrolling is independent of inherited shell/header/chat entry motion.
  for (const samples of observed.filter((rows) => !rows[0].kind.startsWith("entry-"))) {
    const positions = samples.map((sample) => sample.y);
    // Allow only floating-point layout noise, below one device pixel.
    expect(
      Math.max(...positions) - Math.min(...positions),
      `${samples[0].kind} vertical displacement`,
    ).toBeLessThanOrEqual(0.1);
  }
}

suite.define(() => {
  for (const [entry, count, width, reducedMotion, colorScheme] of scenarios) {
    it(`opens the session frame at its final position: ${entry}, ${count} messages, ${width} px, ${reducedMotion}, ${colorScheme}`, async (testContext) => {
      const contextOptions = {
        ...createControlUiE2eContextOptions(),
        viewport: { width, height: 900 },
        deviceScaleFactor: 2,
        reducedMotion,
        colorScheme,
      };
      const runCase = async ({ page }: { page: Page }) => {
        const pageErrors = entry === "sidebar" ? sidebarPages.get(colorScheme)!.pageErrors : [];
        if (entry !== "sidebar") {
          page.on("pageerror", (error) => pageErrors.push(error.message));
        }
        const target =
          entry === "boot"
            ? homeKey
            : entry === "sidebar"
              ? sidebarKey(count, width, reducedMotion, colorScheme)
              : entryKey;
        const messages = entryMessages(count);
        const gateway =
          entry === "sidebar"
            ? sidebarPages.get(colorScheme)!.gateway
            : await installMockGateway(page, {
                sessionKey: target,
                sessionTranscripts: { [target]: { messages } },
                sessions: [
                  { key: homeKey, label: "Home", kind: "direct", updatedAt: 1000 },
                  { key: entryKey, label: "Entry proof", kind: "direct", updatedAt: 2000 },
                ],
                models: [{ id: "mock-model", name: "Mock model", provider: "mock" }],
                agentModel: "mock/mock-model",
              });
        if (entry === "sidebar") {
          await page.bringToFront();
          await page.evaluate(() => {
            if (window.sessionEntryRecorder) {
              window.sessionEntryRecorder.done = true;
            }
          });
          await navigateToControlUiSession(page, homeKey);
          await page.setViewportSize({ width, height: 900 });
          await page.emulateMedia({ reducedMotion, colorScheme });
          await page.waitForFunction(
            ({ width: expectedWidth, reducedMotion: expectedMotion }) =>
              innerWidth === expectedWidth &&
              matchMedia("(prefers-reduced-motion: reduce)").matches ===
                (expectedMotion === "reduce") &&
              document
                .querySelector(".chat-split-view")
                ?.classList.contains("chat-split-view--narrow") ===
                (expectedWidth === 390),
            { width, reducedMotion },
          );
          // Each target is unseen; a retained pane would skip the entry being measured.
          await page.evaluate(recordEntryFrames, {
            target,
            enabled: false,
            lastEntryId: `entry-${count - 1}`,
          });
        } else {
          await page.addInitScript(createControlUiMockSameOriginGatewayScript());
          await page.addInitScript(
            ({ key, ...settings }) => localStorage.setItem(key, JSON.stringify(settings)),
            {
              key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
              gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl),
              theme: "claw",
              themeMode: colorScheme,
            },
          );
          await page.addInitScript(recordEntryFrames, {
            target,
            enabled: true,
            lastEntryId: `entry-${count - 1}`,
          });
          const url = controlUiSessionUrl(suite.server.baseUrl, target);
          await page.goto(entry === "boot" ? `${suite.server.baseUrl}chat` : url);
        }
        if (entry === "sidebar") {
          await page.getByText(chooseSession).waitFor();
          if (width === 390) {
            await navigationDrawerToggle(page).click();
          }
          const link = page.locator(
            `[data-session-key="${target}"] a.sidebar-recent-session__link`,
          );
          await link.waitFor();
          await page.evaluate(() => {
            window.sessionEntryRecorder.enabled = true;
          });
          await link.click();
        }
        await page.waitForFunction(() => window.sessionEntryRecorder.done, undefined, {
          timeout: controlUiE2eWaitTimeoutMs,
        });
        expect(pageErrors).toEqual([]);
        const frames = await page.evaluate(() => window.sessionEntryRecorder.frames);
        await writeFile(
          path.join(suite.artifactDir, "entry-frames.json"),
          JSON.stringify(frames, null, 2),
        );
        expect(
          await page.evaluate(() => ({
            width: innerWidth,
            theme: document.documentElement.dataset.themeMode,
            reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
            colorScheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
          })),
        ).toEqual({
          width,
          theme: colorScheme,
          reducedMotion: reducedMotion === "reduce",
          colorScheme,
        });
        const startups = await gateway.getRequests("chat.startup");
        expect(startups.length).toBeGreaterThan(0);
        if (entry === "sidebar") {
          expect(await gateway.getRequests("chat.startup", { sessionKey: target })).not.toEqual([]);
        }
        assertEntryFrames(frames, `entry-${count - 1}`);
      };
      if (entry !== "sidebar") {
        await suite.withPage(contextOptions, runCase);
        return;
      }
      const { page } = sidebarPages.get(colorScheme)!;
      let failedClose: Promise<void> | undefined;
      const closeAfterFailure = (error: unknown) => {
        failedClose ??= (async () => {
          await captureControlUiE2eFailureDiagnostics(page, {
            error: error instanceof Error ? error : new Error(String(error)),
            label: "Chat sidebar entry",
          });
          await suite.closeBrowserContext(page.context());
        })();
        return failedClose;
      };
      const onAbort = () => void closeAfterFailure(testContext.signal.reason).catch(() => {});
      testContext.signal.addEventListener("abort", onAbort, { once: true });
      try {
        await suite.runScenario(testContext, {
          run: async () => {
            try {
              await runCase({ page });
            } catch (error) {
              void closeAfterFailure(error).catch(() => {});
              throw error;
            }
          },
          close: async () => {
            await failedClose;
          },
        });
      } finally {
        testContext.signal.removeEventListener("abort", onAbort);
      }
    });
  }
});
