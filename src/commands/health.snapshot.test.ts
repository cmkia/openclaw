import fs from "node:fs";
import path from "node:path";
import { Value } from "typebox/value";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SnapshotSchema } from "../../packages/gateway-protocol/src/schema/snapshot.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ChannelAccountSnapshot } from "../channels/plugins/types.public.js";
import type { HealthSummary } from "../gateway/health/types.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import { createPluginRecord } from "../plugins/status.test-fixtures.js";
import {
  loadFreshHealthModulesForTest,
  type HealthTestPlugin,
  type LegacyHealthSnapshotParams,
} from "./health.snapshot.test-support.js";
import { channelRuntime, pluginHealthError, unavailablePlugin } from "./health.test-fixtures.js";

let testConfig: Record<string, unknown> = {};
let healthPluginsForTest: HealthTestPlugin[] = [];
const tempDirs = createTempDirTracker();
let sessionStorePath: string;
let startPluginServices: typeof import("../plugins/services.test-support.js").startPluginServices;
let pluginServicesHandle: PluginServicesHandle | undefined;
const collect = (options: LegacyHealthSnapshotParams = {}) =>
  getHealthSnapshot({ probe: false, ...options });
const serviceEntry = (id: string, start: () => void, serviceId = id) => ({
  pluginId: "service-plugin",
  pluginName: "Service Plugin",
  id,
  service: { id: serviceId, start },
  source: "test",
  origin: "workspace" as const,
});
type PluginSeed = Parameters<typeof createPluginRecord>[0];
const pluginRegistry = (...plugins: PluginSeed[]) => ({
  ...createTestRegistry([]),
  plugins: plugins.map(createPluginRecord),
});
function failedPlugin(id: string, error: string, overrides: Partial<PluginSeed> = {}): PluginSeed {
  return { id, error, status: "error", activated: false, failurePhase: "load", ...overrides };
}

let setActivePluginRegistry: typeof import("../plugins/runtime.js").setActivePluginRegistry;
let setActiveDegradedPlugins: typeof import("../plugins/runtime-degraded-state.js").setActiveDegradedPlugins;
let createChannelTestPluginBase: typeof import("../test-utils/channel-plugins.js").createChannelTestPluginBase;
let createTestRegistry: typeof import("../test-utils/channel-plugins.js").createTestRegistry;
let getHealthSnapshot: (params?: LegacyHealthSnapshotParams) => Promise<HealthSummary>;
let buildTelegramHealthSummaryForTest: NonNullable<
  HealthTestPlugin["status"]
>["buildChannelSummary"];
let probeTelegramAccountForTestOverride: NonNullable<HealthTestPlugin["status"]>["probeAccount"];

function healthPlugin(
  id: string,
  label: string,
  config: HealthTestPlugin["config"],
  status: HealthTestPlugin["status"],
): HealthTestPlugin {
  return { ...createChannelTestPluginBase({ id, label }), config, status };
}

function accountPlugin<Account extends ChannelAccountSnapshot>(
  id: string,
  account: Account,
  status: HealthTestPlugin["status"],
): HealthTestPlugin {
  const resolveAccount = () => account;
  return healthPlugin(
    id,
    id,
    {
      listAccountIds: () => [account.accountId],
      resolveAccount,
      inspectAccount: resolveAccount,
      isEnabled: (resolved) => resolved.enabled !== false,
      isConfigured: (resolved) => resolved.configured === true,
    },
    status,
  );
}

describe("collectGatewayHealthSnapshot", () => {
  beforeAll(async () => {
    ({
      setActivePluginRegistry,
      setActiveDegradedPlugins,
      createChannelTestPluginBase,
      createTestRegistry,
      getHealthSnapshot,
    } = await loadFreshHealthModulesForTest({
      getConfig: () => testConfig,
      getSessionStorePath: () => sessionStorePath,
      getSessions: () => ({}),
      getPlugins: () => healthPluginsForTest,
    }));
    ({ startPluginServices } = await import("../plugins/services.test-support.js"));
  });

  beforeEach(() => {
    // Snapshot contents must not depend on host scheduling; deadline tests advance time explicitly.
    vi.useFakeTimers({ toFake: ["Date"] });
    // Session rows are mocked, but the collector still resolves their physical store.
    sessionStorePath = path.join(
      tempDirs.make("openclaw-health-snapshot-sessions-"),
      "sessions.json",
    );
    setActiveDegradedPlugins([]);
    buildTelegramHealthSummaryForTest = ({
      snapshot: { accountId, configured, probe, lastProbeAt },
    }) => ({
      accountId,
      configured: Boolean(configured),
      ...(probe ? { probe } : {}),
      ...(lastProbeAt ? { lastProbeAt } : {}),
    });
    probeTelegramAccountForTestOverride = undefined;
    healthPluginsForTest = [
      accountPlugin(
        "telegram",
        {
          accountId: "default",
          token: "t-1",
          configured: true,
        },
        {
          buildChannelSummary: (params) => buildTelegramHealthSummaryForTest?.(params),
          probeAccount: async (params) => await probeTelegramAccountForTestOverride?.(params),
        },
      ),
    ];
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "telegram", plugin: healthPluginsForTest[0], source: "test" },
      ]),
    );
  });

  afterEach(async () => {
    await pluginServicesHandle?.stop();
    pluginServicesHandle = undefined;
    setActiveDegradedPlugins([]);
    vi.useRealTimers();
    setActivePluginRegistry(createTestRegistry([]));
    tempDirs.cleanup();
  });

  it.each([false, true])(
    "keeps unavailable accounts visible (resolved sibling=%s)",
    async (withSibling) => {
      testConfig = {};
      setActivePluginRegistry(createTestRegistry([]));
      const probeAccount = vi.fn(async () => ({ ok: true }));
      const runtimeOnly = vi.fn(() =>
        expect.unreachable("runtime hook received an inspection summary"),
      );
      const buildAccountSnapshot = vi.fn(({ account }: { account: unknown }) => {
        expect(account).toMatchObject({ token: "healthy-token" });
        return {
          accountId: "healthy",
          configured: true,
          name: "Resolved healthy account",
          tokenSource: "config",
          tokenStatus: "available",
        };
      });
      const id = "health-inspection-fixture";
      healthPluginsForTest = [
        healthPlugin(
          id,
          "Inspection",
          {
            listAccountIds: () => (withSibling ? ["default", "healthy"] : ["default"]),
            resolveAccount: (_cfg, accountId) => {
              if (!withSibling || accountId !== "healthy") {
                throw new Error("credential unavailable");
              }
              return { accountId, enabled: true, configured: true, token: "healthy-token" };
            },
            inspectAccount: (_cfg, accountId) =>
              withSibling
                ? {
                    accountId,
                    enabled: true,
                    configured: true,
                    tokenSource: "config",
                    tokenStatus: accountId === "healthy" ? "available" : "configured_unavailable",
                  }
                : undefined,
          },
          withSibling
            ? { probeAccount, buildAccountSnapshot }
            : {
                probeAccount: runtimeOnly,
                buildAccountSnapshot: runtimeOnly,
                buildChannelSummary: runtimeOnly,
              },
        ),
      ];
      const accounts = (await getHealthSnapshot({ probe: true })).channels[id]?.accounts;
      if (withSibling) {
        expect(accounts).toMatchObject({
          default: {
            configured: true,
            tokenSource: "config",
            tokenStatus: "configured_unavailable",
          },
          healthy: {
            configured: true,
            name: "Resolved healthy account",
            tokenSource: "config",
            tokenStatus: "available",
          },
        });
        expect(probeAccount).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            account: expect.objectContaining({ accountId: "healthy", token: "healthy-token" }),
          }),
        );
        expect(buildAccountSnapshot).toHaveBeenCalledTimes(1);
      } else {
        expect(accounts?.default?.configured).toBeUndefined();
        expect(accounts?.default?.stateReason).toBe("configuration status unavailable");
        expect(runtimeOnly).not.toHaveBeenCalled();
      }
    },
  );

  it("bounds probes by the fixed gateway collection deadline", async () => {
    testConfig = {
      session: { store: "/tmp/x" },
      channels: { telegram: { botToken: "123:test" } },
    };
    const timeouts: number[] = [];
    probeTelegramAccountForTestOverride = async ({ timeoutMs }) => {
      timeouts.push(timeoutMs);
      return { ok: true };
    };

    await getHealthSnapshot();

    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toBeGreaterThan(0);
    expect(timeouts[0]).toBeLessThanOrEqual(7_000);
  });

  it("preserves runtime state and probe payloads when plugin summaries omit them", async () => {
    testConfig = { channels: { telegram: { botToken: "t-1" } } };
    buildTelegramHealthSummaryForTest = ({ snapshot }) => ({
      accountId: snapshot.accountId,
      configured: Boolean(snapshot.configured),
    });
    probeTelegramAccountForTestOverride = async () => ({
      ok: true,
      bot: { username: "runtime_bot" },
    });

    const snap = await getHealthSnapshot({
      runtimeSnapshot: channelRuntime("telegram", {
        accountId: "default",
        running: true,
        connected: true,
        lastConnectedAt: 123,
        healthState: "reconnecting",
      }),
    });
    expect(snap.channels.telegram).toMatchObject({
      running: true,
      connected: true,
      lastConnectedAt: 123,
      healthState: "reconnecting",
      probe: { bot: { username: "runtime_bot" } },
      accounts: {
        default: {
          running: true,
          connected: true,
          healthState: "reconnecting",
          probe: { ok: true },
        },
      },
    });
  });

  it("redacts base URL credentials returned by channel summary hooks", async () => {
    testConfig = { channels: { discord: { token: "test" } } };
    const plugin = accountPlugin(
      "discord",
      { accountId: "default", enabled: true, configured: true },
      {
        buildChannelSummary: () => ({
          configured: true,
          baseUrl: [
            "https://summary-user",
            ":",
            "summary-pass",
            "@chat.example.test/?to",
            "ken=test",
          ].join(""),
        }),
      },
    );
    healthPluginsForTest = [plugin];

    const snap = await getHealthSnapshot({ probe: false, includeSensitive: false });
    const expected = { baseUrl: "https://chat.example.test/?token=***" };
    expect(snap.channels.discord).toMatchObject({ ...expected, accounts: { default: expected } });
  });

  it.each(["available", "configured_unavailable"])(
    "merges public %s credential metadata with runtime state",
    async (tokenStatus) => {
      const account = {
        accountId: "default",
        configured: true,
        enabled: true,
        tokenSource: "config",
        tokenStatus,
      };
      healthPluginsForTest = [accountPlugin("discord", account, {})];
      const snap = await getHealthSnapshot({
        probe: false,
        includeSensitive: false,
        runtimeSnapshot: channelRuntime("discord", {
          accountId: "default",
          running: true,
          connected: true,
          ...(tokenStatus === "available" ? { lastConnectedAt: 123 } : {}),
        }),
      });
      const expected = {
        configured: true,
        tokenSource: "config",
        tokenStatus,
        ...(tokenStatus === "available" ? { running: true, connected: true } : {}),
      };
      expect(snap.channels.discord).toMatchObject({ ...expected, accounts: { default: expected } });
    },
  );

  it("omits secret runtime fields and raw probe payloads from non-sensitive health snapshots", async () => {
    testConfig = { channels: { telegram: { botToken: "t-1" } } };
    buildTelegramHealthSummaryForTest = ({ snapshot }) => ({
      accountId: snapshot.accountId,
      configured: Boolean(snapshot.configured),
      probe: { ok: true, token: "test-token" },
    });
    probeTelegramAccountForTestOverride = async () => ({
      ok: true,
      bot: { username: "runtime_bot" },
      token: "test-token",
    });

    const snap = await getHealthSnapshot({
      includeSensitive: false,
      runtimeSnapshot: channelRuntime("telegram", {
        accountId: "default",
        connected: true,
        lastConnectedAt: 123,
        channelAccessToken: "line-token",
        channelSecret: "line-secret", // pragma: allowlist secret
        webhookUrl: "https://example.test/hook?secret=1",
      }),
    });
    const telegram = snap.channels.telegram!;
    expect(telegram.connected).toBe(true);
    expect(telegram.lastConnectedAt).toBe(123);
    expect(telegram.probe).toBeUndefined();
    expect(telegram["channelAccessToken"]).toBeUndefined();
    expect(telegram["channelSecret"]).toBeUndefined();
    expect(telegram["webhookUrl"]).toBeUndefined();
    expect(telegram.accounts?.default?.connected).toBe(true);
    expect(telegram.accounts?.default?.probe).toBeUndefined();
    expect(telegram.accounts?.default?.["channelAccessToken"]).toBeUndefined();
  });

  it("keeps redacted failed probes in non-sensitive health snapshots", async () => {
    healthPluginsForTest = [
      accountPlugin(
        "imessage",
        {
          accountId: "default",
          enabled: true,
          configured: true,
        },
        {
          buildChannelSummary: ({ snapshot }) => ({
            accountId: snapshot.accountId,
            configured: Boolean(snapshot.configured),
            ...(snapshot.probe ? { probe: snapshot.probe } : {}),
          }),
          probeAccount: async () => ({
            ok: false,
            error:
              "imsg cannot access /Users/alice/Library/Messages/chat.db. Grant Full Disk Access to the Gateway/launcher process and restart Gateway. privateApi=/tmp/openclaw/private.sock",
            privateApi: {
              rpcCommand: "imsg rpc --json",
              diagnostics: "sensitive transport details",
            },
          }),
        },
      ),
    ];
    testConfig = { channels: { imessage: { enabled: true } } };

    const snap = await getHealthSnapshot({
      includeSensitive: false,
    });
    const imessage = snap.channels.imessage!;
    const expectedProbe = {
      ok: false,
      error:
        "imsg cannot access ~/Library/Messages/chat.db. Grant Full Disk Access to the Gateway/launcher process and restart Gateway.",
    };
    expect(imessage.configured).toBe(true);
    expect(imessage.probe).toEqual(expectedProbe);
    expect(imessage.accounts?.default?.probe).toEqual(expectedProbe);
  });

  it("omits generic failed probe errors from non-sensitive health snapshots", async () => {
    testConfig = { channels: { telegram: { botToken: "bad-token" } } };
    probeTelegramAccountForTestOverride = async () => ({
      ok: false,
      status: null,
      error: "network down with private diagnostic",
      elapsedMs: 0,
    });

    const snap = await getHealthSnapshot({
      includeSensitive: false,
    });
    const telegram = snap.channels.telegram!;

    expect(telegram.configured).toBe(true);
    expect(telegram.probe).toBeUndefined();
    expect(telegram.accounts?.default?.probe).toBeUndefined();
  });
  describe("plugin state", () => {
    beforeEach(() => {
      healthPluginsForTest = [];
      testConfig = { session: { store: "/tmp/x" } };
    });
    it("deduplicates canonical-root quarantine while retaining unrelated same-id errors", async () => {
      const importError = "unrelated import error";
      const fixtureDir = tempDirs.make("openclaw-health-plugin-");
      const pluginRoot = path.join(fixtureDir, "plugin");
      const pluginRootAlias = path.join(fixtureDir, "alias");
      fs.mkdirSync(pluginRoot);
      fs.symlinkSync(pluginRoot, pluginRootAlias, "dir");
      setActivePluginRegistry(
        pluginRegistry(
          failedPlugin("discord", "configured plugin payload verification failed", {
            origin: "global",
            rootDir: pluginRoot,
            activationReason: "configured-unavailable: unreadable-package-json",
            failurePhase: "validation",
          }),
          failedPlugin("discord", importError, {
            origin: "config",
            rootDir: "/workspace/discord",
          }),
        ),
      );
      setActiveDegradedPlugins([
        {
          pluginId: "discord",
          state: "configured-unavailable",
          diagnostic: {
            kind: "plugin-verification",
            reason: "unreadable-package-json",
            detail: `Could not read ${pluginRootAlias}/package.json: permission denied`,
            installPath: pluginRootAlias,
          },
        },
      ]);

      const snap = await collect();

      expect(Value.Check(SnapshotSchema.properties.health, snap)).toBe(true);
      expect(snap.plugins?.unavailable).toEqual([
        unavailablePlugin(
          "discord",
          "Could not read <plugin-install>/package.json: permission denied",
        ),
      ]);
      expect(JSON.stringify(snap.plugins?.unavailable)).not.toContain(pluginRoot);
      expect(snap.plugins?.errors).toEqual([
        pluginHealthError("discord", importError, {
          origin: "config",
          activationSource: "explicit",
          failurePhase: "load",
        }),
      ]);
    });

    it("projects the recorded channel load failure instead of stale successful probes", async () => {
      const credential = "synthetic-health-loader-credential";
      const probeAccount = vi.fn(async () => ({ ok: true }));
      const base = createChannelTestPluginBase({ id: "broken-channel" });
      healthPluginsForTest = [
        {
          ...base,
          config: { ...base.config, listAccountIds: () => ["default", "disabled"] },
          status: { probeAccount },
        },
      ];
      testConfig.channels = { "broken-channel": { accounts: { Disabled: { enabled: false } } } };
      const registry = pluginRegistry(
        failedPlugin(
          "broken-owner",
          `missing SDK export; password=${credential}\n${"context ".repeat(300)}`,
          {
            activated: true,
            channelIds: ["broken-channel"],
          },
        ),
      );
      setActivePluginRegistry(registry);
      const snap = await collect({
        probe: true,
        runtimeSnapshot: channelRuntime(
          "broken-channel",
          { accountId: "default", running: true, connected: true, probe: { ok: true } },
          true,
        ),
      });
      expect(snap.channels["broken-channel"]).toMatchObject({
        configured: true,
        running: false,
        lifecycle: "blocked",
        lastError: expect.stringContaining("missing SDK export"),
        accounts: {
          disabled: {
            enabled: false,
            running: false,
            lastError: expect.stringContaining("missing SDK export"),
          },
        },
      });
      expect(snap.channels["broken-channel"]).not.toHaveProperty("probe");
      expect(JSON.stringify(snap)).not.toContain(credential);
      expect(snap.plugins?.errors[0]?.error.length).toBeLessThanOrEqual(1000);
      expect(probeAccount).not.toHaveBeenCalled();

      // A different live owner wins over a failed plugin declaring the same channel.
      setActivePluginRegistry({
        ...registry,
        ...createTestRegistry([
          { pluginId: "healthy-owner", plugin: healthPluginsForTest[0], source: "test" },
        ]),
        plugins: registry.plugins,
      });
      const { resolveUnavailableChannelAccountSnapshot } =
        await import("../channels/status/account-state.js");
      expect(
        resolveUnavailableChannelAccountSnapshot(testConfig, {
          channelId: "broken-channel",
          accountId: "default",
        }),
      ).toBeUndefined();
    });

    it("surfaces a failed service while continuing healthy siblings", async () => {
      const credential = "synthetic-service-credential";
      const siblingStart = vi.fn();
      const brokenStart = vi.fn().mockImplementationOnce(() => {
        throw new Error(`listen EADDRINUSE: address already in use; password=${credential}`);
      });
      const registry = {
        ...pluginRegistry({
          id: "service-plugin",
          services: ["broken", "healthy-sibling"],
        }),
        services: [
          serviceEntry("broken", brokenStart, " broken "),
          serviceEntry("healthy-sibling", siblingStart),
        ],
      };
      setActivePluginRegistry(registry);

      pluginServicesHandle = await startPluginServices({ registry, config: {} });
      const failed = await collect();

      expect(siblingStart).toHaveBeenCalledOnce();
      expect(failed.plugins?.loaded).toContain("service-plugin");
      expect(failed.plugins?.errors).toContainEqual(
        pluginHealthError(
          "service-plugin",
          expect.stringContaining("service broken: listen EADDRINUSE: address already in use"),
          {
            activated: true,
            activationSource: "explicit",
            failurePhase: "service",
          },
        ),
      );
      expect(JSON.stringify(failed)).not.toContain(credential);

      await pluginServicesHandle.stop();
      pluginServicesHandle = undefined;
      const stopped = await collect();
      expect(stopped.plugins?.errors).toEqual(failed.plugins?.errors);

      pluginServicesHandle = await startPluginServices({ registry, config: {} });
      const recovered = await collect();
      expect(brokenStart).toHaveBeenCalledTimes(2);
      expect(siblingStart).toHaveBeenCalledTimes(2);
      expect(recovered.plugins?.errors).toEqual([]);
    });
  });
});
