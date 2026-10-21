import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { prepareGatewayPluginLoad } from "../gateway/server-plugin-bootstrap.js";
import {
  readDeferredPluginMigrationsAsync,
  recordDeferredPluginMigrations,
} from "../infra/deferred-plugin-migrations.js";
import * as sql from "../infra/kysely-sync.js";
import * as safeCwd from "../infra/safe-cwd.js";
import {
  readStartupMigrationWarning,
  recordStartupMigrationWarnings,
} from "../infra/state-migrations.messages.js";
import { flushLogger, resetLogger, setLoggerOverride } from "../logging/logger.js";
import { loadOpenClawPlugins, loadOpenClawPluginsAsync } from "../plugins/loader.js";
import {
  createPluginCache,
  retirePluginCache,
  withPluginCache,
  type PluginCache,
} from "../plugins/plugin-cache.js";
import { loadPluginLookUpTable } from "../plugins/plugin-lookup-table.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import {
  listActiveDegradedPlugins,
  setActiveDegradedPlugins,
} from "../plugins/runtime-degraded-state.js";
import { disposePluginRegistryInstances } from "../plugins/runtime.js";
import { seedInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { createDeferredCore } from "../shared/deferred.js";
import { readAgentDatabaseAdmissionRefusal } from "../state/agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "../state/agent-database-startup.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  withOpenClawAgentDatabaseAsync,
} from "../state/openclaw-agent-db.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createConfigPreflightSnapshotReader } from "./config-preflight-snapshot.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { runStartupConfigPreflight } from "./startup-config-preflight.js";

const sourceBytes = '{"triggers":["leave-for-doctor"]}\n';
const migrationMeta = { migrations: { webhookListeners: true as const } };
const fixtureId = "fixture";
const localGateway = { mode: "local" as const, auth: { mode: "none" as const } };

async function writeJson(file: string, value: unknown) {
  const bytes = JSON.stringify(value);
  await fs.writeFile(file, bytes);
  return bytes;
}

async function withStartupHome(run: (home: string) => Promise<void>) {
  return withDoctorConfigPreflightHome((home) =>
    withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, () => run(home)),
  );
}

it.each(["unavailable", "no-home", "EACCES"])(
  "preserves retired state during %s startup",
  (fault) =>
    withStartupHome(async (home) => {
      const unavailable = fault === "unavailable";
      const config: OpenClawConfig = {
        gateway: unavailable ? localGateway : { mode: "local" },
        plugins: unavailable
          ? { allow: [fixtureId], entries: { [fixtureId]: { enabled: true } } }
          : { enabled: false },
        meta: migrationMeta,
      };
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const sourcePath = path.join(home, ".openclaw", "settings", "voicewake.json");
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      const configBytes = await writeJson(configPath, config);
      await fs.writeFile(sourcePath, sourceBytes);
      await seedInstalledPluginIndex(
        unavailable ? { [fixtureId]: { source: "npm", spec: `${fixtureId}@1.0.0` } } : {},
        { config },
      );
      const lstat = fsSync.lstatSync;
      const denied = `EACCES: permission denied, lstat ${sourcePath}`;
      try {
        if (fault === "EACCES") {
          vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
            if (args[0] === sourcePath) {
              throw Object.assign(new Error(denied), { code: "EACCES" });
            }
            return lstat(...args);
          });
        }
        const ready = await runStartupConfigPreflight({
          gateway: fault !== "no-home",
          observe: false,
          beforeStatePreparation:
            fault === "no-home"
              ? async () => {
                  for (const key of ["OPENCLAW_HOME", "HOME", "USERPROFILE", "PREFIX"]) {
                    vi.stubEnv(key, undefined);
                  }
                  vi.spyOn(os, "homedir").mockReturnValue("");
                  vi.spyOn(safeCwd, "tryProcessCwd").mockReturnValue(undefined);
                  return true;
                }
              : undefined,
        });
        expect(ready.snapshot.valid).toBe(true);
        const warning = readStartupMigrationWarning();
        if (unavailable) {
          expect(listActiveDegradedPlugins()).toMatchObject([
            {
              pluginId: fixtureId,
              state: "configured-unavailable",
              diagnostic: { reason: "missing-install-path" },
            },
          ]);
          for (const part of [
            `Plugin "${fixtureId}"`,
            "openclaw update repair",
            "Retired runtime state was left unchanged for Doctor; no import was attempted.",
            sourcePath,
          ]) {
            expect(warning).toContain(part);
          }
          expect(readConfigMachineState("voicewake.triggers")).toBeUndefined();
          expect(await fs.readdir(path.dirname(sourcePath))).toEqual(["voicewake.json"]);
        } else {
          expect(warning).toContain("Could not inspect retired runtime state:");
          expect(warning).toContain("; run openclaw doctor");
          expect(warning).toContain(
            fault === "no-home" ? "Unable to resolve an OpenClaw home" : denied,
          );
        }
      } finally {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
      }
      expect(await fs.readFile(configPath, "utf8")).toBe(configBytes);
      expect(await fs.readFile(sourcePath, "utf8")).toBe(sourceBytes);
    }),
);
it.each([false, true])(
  "loads plugin repair diagnostics only for invalid startup config (invalid: %s)",
  (invalid) =>
    withStartupHome(async (home) => {
      const pluginDir = path.join(home, "plugins", fixtureId);
      const marker = path.join(home, "doctor-loaded");
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(pluginDir, { recursive: true });
      await writeJson(path.join(pluginDir, "openclaw.plugin.json"), {
        id: fixtureId,
        doctorContract: { configRepair: true },
        configSchema: { type: "object", additionalProperties: false },
      });
      await fs.writeFile(path.join(pluginDir, "index.cjs"), "exports.register = () => {};\n");
      await fs.writeFile(
        path.join(pluginDir, "doctor-contract-api.cjs"),
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "loaded");
exports.legacyConfigRules = [{
  path: ["plugins", "entries", "${fixtureId}", "config", "retired"],
  message: "Remove the retired fixture setting."
}];\n`,
      );
      const config = {
        gateway: localGateway,
        plugins: {
          allow: [fixtureId],
          load: { paths: [pluginDir] },
          entries: { [fixtureId]: { enabled: true, config: invalid ? { retired: true } : {} } },
        },
        meta: migrationMeta,
      };
      const configBytes = await writeJson(configPath, config);
      await seedInstalledPluginIndex({}, { config });

      const ready = await runStartupConfigPreflight({ gateway: true, observe: false });

      expect(ready.snapshot.valid).toBe(!invalid);
      expect(await fs.readFile(configPath, "utf8")).toBe(configBytes);
      if (invalid) {
        expect(await fs.readFile(marker, "utf8")).toBe("loaded");
        expect(ready.snapshot.legacyIssues).toContainEqual({
          path: `plugins.entries.${fixtureId}.config.retired`,
          message: "Remove the retired fixture setting.",
        });
      } else {
        await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
        await using snapshots = createConfigPreflightSnapshotReader();
        await snapshots.read({
          purpose: "doctor",
          allowCurrentPluginMetadata: false,
          includePluginMetadata: true,
          skipPluginValidation: false,
          observe: false,
        });
        expect(await fs.readFile(marker, "utf8")).toBe("loaded");
      }
    }),
);

afterEach(async () => {
  await closeDatabases();
  await flushLogger();
  setLoggerOverride(null);
  resetLogger();
  vi.unstubAllEnvs();
  setActiveDegradedPlugins([]);
  recordStartupMigrationWarnings([]);
});

async function closeDatabases() {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeStateDatabaseForTest();
}

it("reports failed preparation without retaining pending agents as startup migration warnings", async () => {
  await withDoctorConfigPreflightHome(async (home) => {
    const stateDir = path.join(home, ".openclaw");
    const logPath = path.join(home, "startup.log");
    const config = {
      gateway: { mode: "local" },
      agents: { ownership: "explicit", entries: { main: {}, worker: {} } },
      plugins: { enabled: false },
      meta: { migrations: { webhookListeners: true } },
    };
    await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify(config));
    await fs.writeFile(logPath, "");
    vi.stubEnv("OPENCLAW_LOG_LEVEL", "warn");
    setLoggerOverride({ level: "warn", file: logPath, consoleLevel: "silent" });
    const paths = ["main", "worker"].map((agentId) => openOpenClawAgentDatabase({ agentId }).path);
    await closeDatabases();
    for (const pathname of paths) {
      using db = new DatabaseSync(pathname);
      // Request preparation without waiting for a timeout.
      db.exec("DROP INDEX idx_agent_session_nodes_active");
    }

    await withAgentDatabaseStartupAdmission(async (admission) => {
      const owner = admission.adopt();
      const failWorker = createDeferredCore();
      const credential = "sk-" + "syntheticfixture".repeat(4);
      try {
        const ready = await runStartupConfigPreflight({ gateway: true, observe: false });
        expect(ready.snapshot.valid).toBe(true);
        expect(["main", "worker"].map((id) => readAgentDatabaseAdmissionRefusal(id)?.code)).toEqual(
          ["agent-database-inspection-pending", "agent-database-inspection-pending"],
        );
        expect.soft(readStartupMigrationWarning()).toBeUndefined();
        expect.soft(readStartupMigrationWarning(false)).toBeUndefined();
        await flushLogger();
        expect.soft(await fs.readFile(logPath, "utf8")).not.toContain("Startup migration warnings");

        const mainPreparation = admission.waitForAgentPreparation("main");
        const allPreparation = admission.pendingPreparation;
        admission.activate({
          isCurrent: () => true,
          preparationReady: Promise.resolve(),
          openAgent: async ({ agentId, env, assertCurrent }) => {
            await withOpenClawAgentDatabaseAsync({ agentId, env }, () => {}, assertCurrent);
          },
          migrateAgent: async ({ agentId }) => {
            if (agentId === "worker") {
              await failWorker.promise;
              throw new Error(
                `Synthetic agent preparation failure ${credential} \u001b[31m${"details ".repeat(1000)}`,
              );
            }
          },
          publishAgent: async () => {},
        });
        await mainPreparation;
        expect(readAgentDatabaseAdmissionRefusal("main")).toBeUndefined();
        expect.soft(readStartupMigrationWarning()).toBeUndefined();
        await flushLogger();
        expect.soft(await fs.readFile(logPath, "utf8")).not.toContain("Startup migration warnings");

        failWorker.resolve();
        await allPreparation;
        expect(readAgentDatabaseAdmissionRefusal("worker")?.code).toBe(
          "agent-database-inspection-failed",
        );
        const failure = readStartupMigrationWarning();
        expect.soft(failure).toContain("Synthetic agent preparation failure");
        expect(failure).toContain('Run "openclaw doctor --fix" against the same state/config');
        expect.soft(failure).not.toContain("has not completed startup inspection");
        expect(failure).not.toContain(credential);
        expect(failure).not.toContain("\u001b");
        expect(failure?.length).toBeLessThan(2200);
        await flushLogger();
        const failureLog = (await fs.readFile(logPath, "utf8"))
          .trim()
          .split("\n")
          .map((line): { message?: string; "1"?: { repairHint?: string } } => JSON.parse(line))
          .find((record) => record.message === "agent database remains degraded");
        expect(failureLog?.["1"]?.repairHint).toContain("openclaw doctor --fix");

        recordStartupMigrationWarnings(["Retained session history requires repair"]);
        expect(readStartupMigrationWarning()).toContain("Retained session history requires repair");
        expect(readStartupMigrationWarning()).toContain("Synthetic agent preparation failure");
        expect(readStartupMigrationWarning(false)).toBe(
          'Startup migrations need attention. Run "openclaw doctor --fix" against the same state/config, then restart the gateway.',
        );
      } finally {
        failWorker.resolve();
        await owner.stop();
      }
    });
  });
});

it("defers runtime evaluation until Doctor migrates a startup plugin's retained data", async () => {
  await withStartupHome(async (home) => {
    const pluginId = "pending-data-fixture";
    const root = path.join(home, "fixture-plugin");
    const legacyPath = path.join(home, "legacy.json");
    const currentPath = path.join(home, "current.json");
    const evaluatedPath = path.join(home, "runtime-evaluated");
    const registeredPath = path.join(home, "registered.json");
    const retained = [
      { id: "alpha", age: 37 },
      { id: "beta", age: 64 },
    ];
    const legacyBytes = JSON.stringify(retained);
    const config = {
      meta: { migrations: { webhookListeners: true as const } },
      gateway: { mode: "local" as const },
      plugins: {
        allow: [pluginId],
        load: { paths: [root] },
        entries: { [pluginId]: { enabled: true, config: { label: "operator label" } } },
      },
    };
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await writeJson(configPath, config);
    await fs.writeFile(legacyPath, legacyBytes);
    await writeJson(path.join(root, "package.json"), {
      name: "@example/pending-data-fixture",
      version: "2.1.0",
      openclaw: { extensions: ["./index.cjs"] },
    });
    await writeJson(path.join(root, "openclaw.plugin.json"), {
      id: pluginId,
      activation: { onStartup: true },
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: { label: { type: "string" } },
      },
      doctorContract: { stateMigrations: [{ id: "retained-records" }] },
    });
    await fs.writeFile(
      path.join(root, "index.cjs"),
      `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(evaluatedPath)}, "evaluated");
module.exports = {
  id: ${JSON.stringify(pluginId)},
  register(api) {
    const records = JSON.parse(fs.readFileSync(${JSON.stringify(currentPath)}, "utf8"));
    fs.writeFileSync(${JSON.stringify(registeredPath)}, JSON.stringify({
      records, label: api.pluginConfig.label
    }));
  }
};
`,
    );
    await fs.writeFile(
      path.join(root, "doctor-contract-api.cjs"),
      `const fs = require("node:fs");
module.exports = { stateMigrations: [{
  id: "retained-records", label: "Retained fixture records",
  detectLegacyState: () => fs.existsSync(${JSON.stringify(legacyPath)})
    ? { preview: ["Convert retained fixture records"] } : null,
  migrateLegacyState: () => {
    fs.copyFileSync(${JSON.stringify(legacyPath)}, ${JSON.stringify(currentPath)});
    fs.unlinkSync(${JSON.stringify(legacyPath)});
    return { changes: ["Converted retained fixture records"], warnings: [] };
  }
}] };
`,
    );
    await seedInstalledPluginIndex(
      {
        [pluginId]: {
          source: "path",
          installPath: root,
          sourcePath: root,
          version: "2.1.0",
        },
      },
      { config },
    );
    const pending = {
      pending: [
        {
          pluginId,
          reason: "The replacement package still needs its data migration",
          command: "openclaw doctor --fix",
          requiresStateMigration: true as const,
        },
      ],
    };
    const caches: PluginCache[] = [];
    const registries: PluginRegistry[] = [];
    const load = async () => {
      const startup = await runStartupConfigPreflight({ gateway: true, observe: false });
      expect(startup.snapshot.valid).toBe(true);
      const cache = startup.pluginCache ?? createPluginCache();
      caches.push(cache);
      return withPluginCache(cache, async () => {
        const lookup = loadPluginLookUpTable({
          config: startup.baseConfig,
          env: process.env,
          metadataSnapshot: startup.pluginMetadataSnapshot,
        });
        expect(lookup.startup.pluginIds).toContain(pluginId);
        const registry = await loadOpenClawPluginsAsync({
          config: startup.baseConfig,
          metadataSnapshot: lookup,
          onlyPluginIds: lookup.startup.pluginIds,
          activate: false,
          runtimeSideEffects: true,
        });
        registries.push(registry);
        return { registry, cache, lookup };
      });
    };
    try {
      const replacementSource = await fs.readFile(path.join(root, "index.cjs"), "utf8");
      await fs.writeFile(
        path.join(root, "index.cjs"),
        `const fs = require("node:fs");
module.exports = { id: ${JSON.stringify(pluginId)}, register(api) {
  api.registerGatewayMethod("retained.probe", ({ respond }) =>
    respond(true, JSON.parse(fs.readFileSync(${JSON.stringify(legacyPath)}, "utf8"))));
} };`,
      );
      const previous = await load();
      await fs.writeFile(path.join(root, "index.cjs"), replacementSource);
      await recordDeferredPluginMigrations(pending);
      const held = await load();
      const heldRecord = held.registry.plugins.find((record) => record.id === pluginId);
      expect(heldRecord).toMatchObject({
        status: "error",
        activated: false,
        activationReason: "configured-unavailable: pending-state-migration",
      });
      expect(heldRecord?.error).toContain("openclaw doctor --fix");
      const log = { info() {}, warn() {}, error() {}, debug() {} };
      await expect(
        withPluginCache(held.cache, () =>
          prepareGatewayPluginLoad({
            cfg: config,
            pluginIds: [pluginId],
            pluginLookUpTable: held.lookup,
            baseMethods: [],
            loadIntent: "replacement",
            previousRegistry: previous.registry,
            replacePluginIds: new Set([pluginId]),
            loadModules: false,
            log,
          }),
        ),
      ).rejects.toThrow("migration");
      const handler = previous.registry.gatewayHandlers["retained.probe"];
      assert(handler);
      const respond = vi.fn();
      await handler({
        req: { type: "req", id: "retained", method: "retained.probe" },
        params: {},
        client: null,
        isWebchatConnect: () => false,
        respond,
        context: {} as Parameters<typeof handler>[0]["context"],
      });
      expect(respond).toHaveBeenCalledWith(true, retained, undefined, undefined);
      await expect(fs.stat(evaluatedPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(legacyPath, "utf8")).toBe(legacyBytes);
      expect(await fs.readFile(configPath, "utf8")).toBe(JSON.stringify(config));
      await runDoctorConfigPreflight({
        migrateLegacyConfig: false,
        invalidConfigNote: false,
        doctorOnlyStateMigrations: true,
        repairPrefixedConfig: true,
      });
      expect(await readDeferredPluginMigrationsAsync()).toEqual([]);
      const retried = await withPluginCache(held.cache, () =>
        loadOpenClawPluginsAsync({
          config,
          metadataSnapshot: held.lookup,
          onlyPluginIds: [pluginId],
          activate: false,
          runtimeSideEffects: true,
        }),
      );
      registries.push(retried);
      expect(retried.plugins.find((record) => record.id === pluginId)?.status).toBe("loaded");
      const ready = await load();
      expect(ready.registry.plugins.find((record) => record.id === pluginId)).toMatchObject({
        status: "loaded",
        activated: true,
      });
      expect(JSON.parse(await fs.readFile(registeredPath, "utf8"))).toEqual({
        records: retained,
        label: "operator label",
      });
      writeConfigMachineState("fixture.unrelated", true);
      const reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
      const mainQueries = vi.spyOn(sql, "executeSqliteQuerySync");
      try {
        for (const loader of [loadOpenClawPluginsAsync, loadOpenClawPlugins]) {
          const cache = createPluginCache();
          caches.push(cache);
          const registry = await withPluginCache(cache, () =>
            loader({
              config,
              metadataSnapshot: ready.lookup,
              onlyPluginIds: [pluginId],
              activate: false,
              cache: false,
              runtimeSideEffects: true,
            }),
          );
          registries.push(registry);
          expect(registry.plugins.find((record) => record.id === pluginId)?.status).toBe("loaded");
        }
        expect(
          reads.mock.calls.filter(
            ([, command]) => command.type === "plugins.deferredMigrations.read",
          ),
        ).toHaveLength(0);
        expect(
          mainQueries.mock.calls.filter(([, query]) =>
            query.compile().sql.includes('"migration_runs"'),
          ),
        ).toHaveLength(0);
      } finally {
        reads.mockRestore();
        mainQueries.mockRestore();
      }
    } finally {
      for (const registry of registries.toReversed()) {
        await disposePluginRegistryInstances(registry);
      }
      for (const cache of caches) {
        await retirePluginCache(cache);
      }
    }
  });
});
