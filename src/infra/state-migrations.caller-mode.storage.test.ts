import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAgentDir } from "../agents/config.js";
import { resolveInstallAgentDir } from "../agents/install-agent-dir.js";
import { readCurrentConfigForResolution } from "../config/io.runtime.js";
import type { OpenClawConfigWithLegacyRoster } from "../config/legacy.roster.js";
import { loadExactSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import * as pluginSetupModule from "../plugins/plugin-setup-module.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { deriveMeetingTranscriptSessionColumns } from "../transcripts/store-columns.js";
import { meetingTranscriptDb } from "../transcripts/store-sqlite.js";
import { executeSqliteQuerySync } from "./kysely-sync.js";
import {
  createCallerModeSnapshot,
  expectBlockedTailInPlanOrder,
  snapshotFiles,
} from "./state-migrations.caller-mode.test-helpers.js";
import { autoMigrateLegacyState, detectLegacyStateMigrations } from "./state-migrations.doctor.js";
import { resolveLegacyStateMigrationOwner } from "./state-migrations.legacy-owner.js";
import { migrateLegacyAgentDir } from "./state-migrations.legacy-sessions.js";
import {
  byId,
  createMigrationFixture,
  writeFixtureFile as writeFile,
} from "./state-migrations.shard-fixture.test-support.js";
import type { LegacyStateMigrationPlan } from "./state-migrations.types.js";
import { buildUpdateRehearsalPathEnv } from "./update-rehearsal-paths.js";

const tempDirs = createTrackedTempDirs();
const sqliteSuffixes = ["", "-wal", "-shm"];
const candidateConfig = { plugins: { entries: { "candidate-plugin": { enabled: true } } } };

async function makeFixture(kind: "planning" | "storage") {
  const root = await tempDirs.make("openclaw-doctor-caller-mode-");
  let bundledPluginsDir = path.resolve("extensions");
  if (kind === "storage") {
    bundledPluginsDir = path.join(root, "extensions");
    const pluginRoot = path.join(bundledPluginsDir, "candidate-plugin");
    fs.mkdirSync(pluginRoot, { recursive: true });
    createColdPluginFixture({
      rootDir: pluginRoot,
      pluginId: "candidate-plugin",
      manifest: {
        providers: [],
        channels: [],
        channelConfigs: {},
        providerAuthChoices: [],
        doctorContract: { stateMigrations: [] },
      },
    });
  } else {
    for (const directory of [root, path.join(root, "candidate")]) {
      fs.mkdirSync(directory, { recursive: true });
      fs.symlinkSync(
        bundledPluginsDir,
        path.join(directory, "extensions"),
        process.platform === "win32" ? "junction" : "dir",
      );
    }
  }
  return createMigrationFixture(root, {
    copied: kind !== "planning",
    bundledPluginsDir,
    config: candidateConfig,
  });
}

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
  vi.restoreAllMocks();
});

describe("copied-state planning", () => {
  function sha256(value: string | Buffer): string {
    return `sha256:${createHash("sha256").update(value).digest("hex")}`;
  }

  it("derives bundled migration authority from the supplied candidate root", async () => {
    const fixture = await makeFixture("planning");
    const candidateRoot = path.join(fixture.root, "isolated-candidate");
    const pluginRoot = path.join(candidateRoot, "extensions/candidate-only");
    fs.mkdirSync(pluginRoot, { recursive: true });
    for (const [name, content] of Object.entries({
      "package.json": {
        name: "@openclaw/candidate-only",
        version: "0.0.0-test",
        openclaw: { extensions: ["./index.js"] },
      },
      "openclaw.plugin.json": {
        id: "candidate-only",
        configSchema: {},
        doctorContract: { stateMigrations: [{ id: "candidate-state" }] },
      },
    })) {
      fs.writeFileSync(path.join(pluginRoot, name), `${JSON.stringify(content)}\n`);
    }
    fs.writeFileSync(path.join(pluginRoot, "index.js"), "export default {};\n");

    const before = snapshotFiles(fixture.root);
    const pluginLoader = vi
      .spyOn(pluginSetupModule, "getPluginSetupModuleLoader")
      .mockImplementation(() => {
        throw new Error("copied planning must not load plugins");
      });
    const plan = await fixture.plan({
      candidate: { root: candidateRoot, version: "test" },
    });

    const pluginStep = byId(plan.steps, "plugin-doctor-state");
    expect(pluginStep).toMatchObject({
      source: expect.arrayContaining([
        { kind: "owner", id: "plugin:candidate-only:candidate-state" },
      ]),
      target: expect.arrayContaining([{ kind: "owner", id: "plugin:candidate-only:doctor-state" }]),
    });
    expect(pluginStep?.source).not.toContainEqual(
      expect.objectContaining({ id: expect.stringContaining("plugin:matrix:") }),
    );
    expect(pluginLoader).not.toHaveBeenCalled();
    expect(snapshotFiles(fixture.root)).toEqual(before);
    expect(fs.existsSync(resolveOpenClawStateSqlitePath(fixture.env))).toBe(false);
  });

  it("binds an ordinary -shm file when its unsuffixed sibling is a directory", async () => {
    const fixture = await makeFixture("planning");
    const ordinarySharedMemoryPath = path.join(fixture.stateDir, "cache-shm");
    fs.mkdirSync(path.join(fixture.stateDir, "cache"));
    fs.writeFileSync(ordinarySharedMemoryPath, "ordinary snapshot content\n");

    const first = await fixture.plan();
    expect(first.warnings).toEqual([]);
    expect(first.snapshot.stateDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);

    fs.writeFileSync(ordinarySharedMemoryPath, "changed ordinary snapshot content\n");
    const second = await fixture.plan();
    expect(second.snapshot.stateDigest).not.toBe(first.snapshot.stateDigest);
  });

  it("binds plan targets and identity to every resolved copied config input", async () => {
    const fixture = await makeFixture("planning");
    const intermediatePath = path.join(fixture.root, "planner-base.json");
    const includePath = path.join(fixture.root, "planner-agents.json");
    const configFor = (agentId: string): OpenClawConfig => ({
      agents: { ownership: "explicit", entries: { [agentId]: {} } },
    });
    fs.writeFileSync(fixture.configPath, '{"$include":"./planner-base.json"}\n');
    fs.writeFileSync(intermediatePath, '{"$include":"./planner-agents.json"}\n');
    fs.writeFileSync(includePath, `${JSON.stringify(configFor("atlas"))}\n`);

    const first = await fixture.plan();
    expect(first.warnings).toEqual([]);
    const configIncludedPaths = [
      ...new Set([includePath, intermediatePath].flatMap((file) => [file, fs.realpathSync(file)])),
    ].toSorted();
    const configSources = [fixture.configPath, ...configIncludedPaths].map((inputPath) => ({
      kind: "path" as const,
      path: inputPath,
    }));
    const configStepIds = [
      "config-machine-state",
      "agent-migration-targets",
      "plugin-migration-preparation",
      "orphan-session-keys",
      "migration-detection",
    ];
    const agentTargets = (agentId: string) => [
      {
        kind: "path",
        path: path.join(fixture.stateDir, "agents", agentId, "sessions/sessions.json"),
      },
      { kind: "sqlite", path: resolveOpenClawStateSqlitePath(fixture.env) },
    ];
    for (const stepId of configStepIds) {
      expect.soft(byId(first.steps, stepId)?.source).toEqual(expect.arrayContaining(configSources));
    }
    expect.soft(byId(first.steps, "acp-session-metadata")?.target).toEqual(agentTargets("atlas"));
    const firstConfigDigest = first.snapshot.configDigest;
    if (!firstConfigDigest) {
      throw new Error("expected the copied config inputs to have a bound digest");
    }

    fs.writeFileSync(includePath, `${JSON.stringify(configFor("beacon"))}\n`);
    const stale = await fixture.plan({
      snapshot: {
        ...createCallerModeSnapshot(fixture),
        configDigest: firstConfigDigest,
      },
    });
    expect.soft(stale).toMatchObject({
      outcome: "refused",
      refusal: { code: "snapshot-identity-mismatch" },
      steps: [],
    });

    const second = await fixture.plan();
    expect.soft(second.snapshot.configDigest).not.toBe(firstConfigDigest);
    expect.soft(byId(second.steps, "acp-session-metadata")?.target).toEqual(agentTargets("beacon"));

    const execution = await fixture.migrate(configFor("beacon"), {
      configIncludedPaths,
    });
    for (const stepId of configStepIds) {
      expect
        .soft(byId(execution.stepReceipts, stepId)?.source)
        .toEqual(byId(second.steps, stepId)?.source);
    }
  });

  it.each(["OPENCLAW_AGENT_DIR", "PI_CODING_AGENT_DIR"] as const)(
    "excludes copied %s agent inputs without overriding live shared-auth authority",
    async (overrideKey) => {
      const fixture = await makeFixture("planning");
      const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
      fs.writeFileSync(fixture.configPath, `${JSON.stringify(cfg)}\n`);
      openOpenClawStateDatabase({ env: fixture.env });
      const legacyAgentDir = path.join(fixture.stateDir, "agent");
      const legacySessionStorePath = path.join(fixture.stateDir, "sessions/sessions.json");
      for (const [file, value] of [
        [path.join(legacyAgentDir, "settings.json"), {}],
        [legacySessionStorePath, { main: { sessionId: "legacy-main", updatedAt: 1 } }],
      ] as const) {
        writeFile(file, `${JSON.stringify(value)}\n`);
      }
      const externalAgentDir = path.join(fixture.root, `custom-${overrideKey.toLowerCase()}`);
      const externalDatabasePath = path.join(externalAgentDir, "openclaw-agent.sqlite");
      fs.mkdirSync(externalAgentDir, { recursive: true });
      for (const suffix of sqliteSuffixes) {
        fs.writeFileSync(`${externalDatabasePath}${suffix}`, `external${suffix}\n`);
      }
      const env: NodeJS.ProcessEnv = {
        ...fixture.env,
        OPENCLAW_AGENT_DIR: undefined,
        PI_CODING_AGENT_DIR: undefined,
        [overrideKey]: externalAgentDir,
      };
      const externalBeforePlanning = snapshotFiles(externalAgentDir);
      const plan = await fixture.plan({ env });
      expect(snapshotFiles(externalAgentDir)).toEqual(externalBeforePlanning);
      for (const suffix of sqliteSuffixes) {
        fs.writeFileSync(`${externalDatabasePath}${suffix}`, `changed${suffix}\n`);
      }
      const externalBeforeRepeatedPlan = snapshotFiles(externalAgentDir);
      const repeatedPlan = await fixture.plan({ env });
      expect(snapshotFiles(externalAgentDir)).toEqual(externalBeforeRepeatedPlan);
      const externalAfterPlanning = snapshotFiles(externalAgentDir);
      let firstLiveRefusal: { id: string; files: Record<string, string> } | undefined;

      const result = await fixture.migrate(cfg, {
        env,
        onStepReceipt: (receipt) => {
          if (receipt.outcome === "refused" && firstLiveRefusal === undefined) {
            firstLiveRefusal = { id: receipt.id, files: snapshotFiles(externalAgentDir) };
          }
        },
      });

      if (overrideKey === "OPENCLAW_AGENT_DIR") {
        // This key also selects the shipped live shared-auth source. Its malformed
        // database refuses live discovery; the copied plan never authorized it.
        expect(byId(result.stepReceipts, "migration-detection")).toMatchObject({
          outcome: "refused",
          requiredness: "required",
          refusal: { code: "step-threw" },
          warnings: [expect.stringContaining(externalDatabasePath)],
        });
        expectBlockedTailInPlanOrder({
          plan,
          receipts: result.stepReceipts,
          blockerId: "migration-detection",
        });
        expect(result.postSessionPluginMigration).toBeUndefined();
        expect(result.skipped).toBe(false);
        expect(firstLiveRefusal?.id).toBe("migration-detection");
        expect(snapshotFiles(externalAgentDir)).toEqual(firstLiveRefusal?.files);
      } else {
        expect(result.postSessionPluginMigration?.step.id).toBe("plugin-doctor-post-session-state");
        expect([
          ...result.stepReceipts.map((receipt) => receipt.id),
          result.postSessionPluginMigration?.step.id,
        ]).toEqual(plan.steps.map((step) => step.id));
        expect(result.skipped).toBe(true);
        expect(firstLiveRefusal).toBeUndefined();
        expect(snapshotFiles(externalAgentDir)).toEqual(externalAfterPlanning);
      }
      expect(repeatedPlan.snapshot.stateDigest).toBe(plan.snapshot.stateDigest);
      expect(repeatedPlan.planDigest).toBe(plan.planDigest);
      for (const stepId of ["media-persistence", "transcript-directives", "shared-auth-store"]) {
        const plannedSource = byId(plan.steps, stepId)?.source;
        if (overrideKey === "PI_CODING_AGENT_DIR") {
          expect(plannedSource).toEqual(byId(result.stepReceipts, stepId)?.source);
        }
        expect(
          plannedSource?.some(
            (endpoint) => endpoint.kind !== "owner" && endpoint.path.startsWith(externalAgentDir),
          ),
        ).toBe(false);
      }
      for (const stepId of ["sessions", "acp-session-metadata"]) {
        expect(byId(plan.steps, stepId)).toBeUndefined();
        expect(byId(result.stepReceipts, stepId)).toBeUndefined();
      }
      if (overrideKey === "OPENCLAW_AGENT_DIR") {
        expect(byId(plan.steps, "agent-dir")).toBeDefined();
        expect(byId(result.stepReceipts, "agent-dir")).toMatchObject({
          outcome: "refused",
          refusal: { code: "blocked-by-prior-refusal" },
        });
      } else {
        expect(byId(plan.steps, "agent-dir")).toBeUndefined();
        expect(byId(result.stepReceipts, "agent-dir")).toBeUndefined();
      }
      expect(fs.existsSync(legacyAgentDir)).toBe(true);
      expect(fs.existsSync(legacySessionStorePath)).toBe(true);
    },
  );

  it("keeps an unbound configured agent database unopened during copied-state planning", async () => {
    const fixture = await makeFixture("planning");
    const externalDatabasePath = path.join(fixture.root, "external", "sessions.sqlite");
    fs.mkdirSync(path.dirname(externalDatabasePath), { recursive: true });
    using database = new DatabaseSync(externalDatabasePath);
    database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = 0;
        CREATE TABLE external_probe (value TEXT NOT NULL);
        INSERT INTO external_probe(value) VALUES ('initial');
      `);
    const cfg: OpenClawConfig = { session: { store: externalDatabasePath } };
    fs.writeFileSync(fixture.configPath, `${JSON.stringify(cfg)}\n`);
    const snapshotExternalArtifacts = () =>
      Object.fromEntries(
        sqliteSuffixes.map((suffix) => {
          const pathname = `${externalDatabasePath}${suffix}`;
          const bytes = fs.existsSync(pathname) ? fs.readFileSync(pathname) : undefined;
          if (bytes && suffix === "-shm") {
            bytes.fill(0, 96, 120);
            bytes.fill(0, 128, 132);
          }
          return [suffix || "database", bytes ? sha256(bytes) : undefined];
        }),
      );
    const externalArtifactsBeforePlan = snapshotExternalArtifacts();
    expect(externalArtifactsBeforePlan["-wal"]).toBeDefined();
    expect(externalArtifactsBeforePlan["-shm"]).toBeDefined();
    // oxlint-disable-next-line typescript/unbound-method
    const originalPrepare = DatabaseSync.prototype.prepare;
    const externalQueries: string[] = [];
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      const databases = originalPrepare.call(this, "PRAGMA database_list").all() as Array<{
        file?: unknown;
      }>;
      if (
        databases.some(
          (entry) =>
            typeof entry.file === "string" && path.resolve(entry.file) === externalDatabasePath,
        )
      ) {
        externalQueries.push(sql);
      }
      return originalPrepare.call(this, sql);
    });
    const plan = await fixture.plan();
    expect(snapshotExternalArtifacts()).toEqual(externalArtifactsBeforePlan);
    const plannedDiscovery = byId(plan.steps, "agent-migration-targets");
    expect(plannedDiscovery).toMatchObject({
      outcome: "deferred",
      refusal: { code: "session-target-outside-snapshot" },
    });
    expect(plannedDiscovery?.source).toContainEqual({
      kind: "path",
      path: externalDatabasePath,
    });
    const discoveryIndex = plan.steps.findIndex((step) => step.id === "agent-migration-targets");
    for (const step of plan.steps.slice(discoveryIndex + 1)) {
      expect(step).toMatchObject({
        outcome: "deferred",
        refusal: { code: "blocked-by-prior-refusal" },
      });
    }

    database.exec("INSERT INTO external_probe(value) VALUES ('wal-change')");
    const repeatedPlan = await fixture.plan();
    expect(repeatedPlan.planDigest).toBe(plan.planDigest);
    expect(repeatedPlan.snapshot.stateDigest).toBe(plan.snapshot.stateDigest);
    expect(externalQueries).toEqual([]);
    const externalArtifactsBeforeExecution = snapshotExternalArtifacts();

    const result = await fixture.migrate(cfg);
    const executionDiscovery = byId(result.stepReceipts, "agent-migration-targets");
    expect(executionDiscovery).toMatchObject({
      outcome: "skipped",
      changes: [],
      warnings: [],
    });
    expect(executionDiscovery?.refusal).toBeUndefined();
    expect(externalQueries.length).toBeGreaterThan(0);
    expect(snapshotExternalArtifacts()).toEqual(externalArtifactsBeforeExecution);
  });
});

describe("caller-mode storage", () => {
  function migrationOptions(cfg: OpenClawConfig, env: NodeJS.ProcessEnv, home: string) {
    return { cfg, env, homedir: () => home, legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES };
  }

  function withState(
    run: Parameters<typeof withOpenClawTestState>[1],
    layout: "split" | "home" = "split",
  ) {
    return withOpenClawTestState({ layout, agentEnv: "clear" }, run);
  }

  it("reports legacy-main session repairs without migrating when other detectors are empty", async () => {
    await withState(async (state) => {
      const cfg = { agents: { entries: { worker: {} } } };
      const source = { agentId: "main", env: state.env, sessionKey: "agent:main:chat" };
      const destination = { agentId: "worker", env: state.env, sessionKey: "agent:worker:chat" };
      const entry = { sessionId: "legacy-main-session", updatedAt: 100 };
      runOpenClawAgentWriteTransaction(
        (database) =>
          writeSessionEntry(database, source.sessionKey, entry, {
            allowStoredAliases: true,
            previousEntry: null,
          }),
        source,
      );

      const result = await autoMigrateLegacyState(migrationOptions(cfg, state.env, state.home));

      expect(result.changes).not.toContain("Migrated legacy main session claim agent:worker:chat.");
      expect(result.notices).toContainEqual(expect.stringContaining("openclaw doctor --fix"));
      expect(loadExactSessionEntryReadOnly(source)?.entry).toMatchObject(entry);
      expect(loadExactSessionEntryReadOnly(destination)).toBeUndefined();
    });
  });

  it.each([undefined, "missing"])(
    "keeps raw migration ownership separate from runtime selection with system owner %s",
    async (systemAgentId) => {
      await withState(async (state) => {
        const cfg: OpenClawConfig = {
          agents: {
            ownership: "explicit",
            defaults: systemAgentId ? { systemAgent: { agentId: systemAgentId } } : {},
            entries: { main: {}, worker: {} },
          },
        };
        const runtime = { env: state.env, homedir: () => state.home };
        const resolution = resolveInstallAgentDir(cfg, runtime);
        const locatorConfig: OpenClawConfigWithLegacyRoster = {
          agents: { list: [{ id: "main" }, { id: "worker", default: true }] },
        };
        const migration = resolveLegacyStateMigrationOwner({
          cfg,
          locatorConfig,
          ...runtime,
        });

        expect(migration.migrationTarget).toEqual({
          dir: state.agentDir("worker"),
          owner: "worker",
        });
        expect(migration.sessionMigrationAgentId).toBe("worker");
        expect(resolution.migrationTarget).toBeUndefined();
        expect(resolution.optionalDirectory).toBeUndefined();
      });
    },
  );

  it.each([
    ["deferred main SQLite family", "main", true, false, true, false],
    ["configured non-main directory", "worker", true, false, false, false],
    ["non-main default", "worker", false, false, false, false],
    ["malformed default config", "main", true, false, false, true],
    ["tilde legacy directory in a named profile", "worker", true, true, false, true],
  ] as const)(
    "shares the SDK and Doctor install directory: %s",
    async (_name, agentId, custom, tilde, sqlite, malformed) => {
      await withState(
        async (state) => {
          const legacyDir = path.join(state.home, ".openclaw", "agent");
          const configuredDir = custom ? state.path("configured-agent") : state.agentDir(agentId);
          const overrideDir = tilde ? legacyDir : undefined;
          const targetDir = overrideDir ?? (malformed ? state.agentDir("main") : configuredDir);
          const agentConfig = {
            ownership: "explicit",
            defaults: { systemAgent: { agentId } },
            entries: {
              spare: {},
              [agentId]: custom ? { agentDir: "${SDK_FIXTURE_AGENT_DIR}" } : {},
            },
          };
          await state.writeConfig({
            agents: { $include: "agents.json" },
            env: { vars: { SDK_FIXTURE_AGENT_DIR: configuredDir } },
            plugins: { enabled: false },
          });
          fs.writeFileSync(
            path.join(path.dirname(state.configPath), "agents.json"),
            JSON.stringify(agentConfig),
          );
          if (malformed) {
            fs.writeFileSync(state.configPath, "{broken config");
          }
          const binary = process.platform === "win32" ? "fd.exe" : "fd";
          writeFile(path.join(legacyDir, "bin", binary), "legacy binary");
          writeFile(path.join(legacyDir, "settings.json"), "SDK settings");
          const legacyDatabase = path.join(legacyDir, "openclaw-agent.sqlite");
          if (sqlite) {
            openOpenClawAgentDatabase({ agentId: "main", env: state.env, path: legacyDatabase });
            closeOpenClawAgentDatabasesForTest();
          }
          if (targetDir !== legacyDir) {
            writeFile(path.join(targetDir, "bin", binary), "current binary");
          }
          await withEnvAsync(
            {
              OPENCLAW_AGENT_DIR: tilde ? "~/.openclaw/agent" : overrideDir,
              OPENCLAW_PROFILE: tilde ? "isolated" : undefined,
              OPENCLAW_OFFLINE: "1",
              SDK_FIXTURE_AGENT_DIR: undefined,
            },
            async () => {
              const before = snapshotFiles(state.root);
              expect(getAgentDir()).toBe(overrideDir ?? legacyDir);
              expect(snapshotFiles(state.root)).toEqual(before);
              expect(process.env.SDK_FIXTURE_AGENT_DIR).toBeUndefined();
              const { ensureTool } = await import("../agents/utils/tools-manager.js");
              const resolution = readCurrentConfigForResolution();
              const { config: cfg, env } = resolution;
              expect(Boolean(resolution.configDiagnostics)).toBe(malformed);
              const options = migrationOptions(cfg, env, state.home);
              const detected = await detectLegacyStateMigrations(options);
              // Doctor's invalid-config gate is separate from its selected directory repair.
              const migration = malformed
                ? await migrateLegacyAgentDir(detected, () => 1234)
                : (
                    await autoMigrateLegacyState({
                      ...options,
                      doctorOnlyStateMigrations: true,
                    })
                  ).stepReceipts.find((receipt) => receipt.id === "agent-dir");
              expect(migration).toBeDefined();
              if (sqlite) {
                expect(migration).toMatchObject({
                  outcome: "deferred",
                  sqliteFamilies: [
                    {
                      database: legacyDatabase,
                      files: expect.arrayContaining([legacyDatabase]),
                      destination: path.join(targetDir, "openclaw-agent.sqlite"),
                      outcome: "deferred",
                      reason: "sqlite-family",
                    },
                  ],
                });
                expect(fs.existsSync(legacyDatabase)).toBe(true);
                expect(fs.existsSync(path.join(targetDir, "openclaw-agent.sqlite"))).toBe(false);
                expect(
                  fs.existsSync(path.join(targetDir, ".legacy-agent-dir-migration.json")),
                ).toBe(false);
              }

              const activeDir = sqlite ? legacyDir : targetDir;
              expect(getAgentDir()).toBe(activeDir);
              expect(
                resolveInstallAgentDir(cfg, { env, homedir: () => state.home }).directory.dir,
              ).toBe(activeDir);
              expect(fs.readFileSync(path.join(getAgentDir(), "settings.json"), "utf8")).toBe(
                "SDK settings",
              );
              expect(detected.agentDir.targetDir).toBe(targetDir);
              await expect(ensureTool("fd")).resolves.toBe(path.join(activeDir, "bin", binary));
              expect(fs.readFileSync(path.join(targetDir, "bin", binary), "utf8")).toBe(
                targetDir === legacyDir ? "legacy binary" : "current binary",
              );
              expect(snapshotFiles(state.root)[path.relative(state.root, state.configPath)]).toBe(
                before[path.relative(state.root, state.configPath)],
              );
              expect(process.env.SDK_FIXTURE_AGENT_DIR).toBeUndefined();
            },
          );
        },
        tilde ? "split" : "home",
      );
    },
  );

  it.each(["before detection", "after detection"])(
    "keeps rehearsal state-root sources confined when an ancestor symlink escapes %s",
    async (timing) => {
      const fixture = await makeFixture("storage");
      const externalParent = path.join(fixture.homeDir, ".openclaw", "agent");
      const externalBinary = path.join(externalParent, "bin/fd");
      writeFile(externalBinary, "uncopied SDK binary");
      const copiedParent = path.join(fixture.stateDir, "agent");
      const symlinkKind = process.platform === "win32" ? "junction" : "dir";
      if (timing === "before detection") {
        fs.symlinkSync(externalParent, copiedParent, symlinkKind);
      } else {
        writeFile(path.join(copiedParent, "bin/fd"), "copied SDK binary");
      }
      const env = {
        ...fixture.env,
        ...buildUpdateRehearsalPathEnv(fixture.stateDir),
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_SERVICE_REPAIR_POLICY: "external",
        OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
        OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
        OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
      };
      const detected = await detectLegacyStateMigrations(
        migrationOptions(
          { agents: { entries: { main: {} } }, plugins: { enabled: false } },
          env,
          fixture.stateDir,
        ),
      );
      if (timing === "after detection") {
        fs.renameSync(copiedParent, path.join(fixture.stateDir, "saved-sdk-home"));
        fs.symlinkSync(externalParent, copiedParent, symlinkKind);
      }

      const result = await migrateLegacyAgentDir(detected, () => 1234);

      expect(fs.existsSync(externalBinary)).toBe(true);
      expect(fs.readFileSync(externalBinary, "utf8")).toBe("uncopied SDK binary");
      expect([...detected.warnings, ...result.warnings].length).toBeGreaterThan(0);
      const canonicalDir = path.join(fixture.stateDir, "agents/main/agent");
      expect(fs.existsSync(path.join(canonicalDir, ".legacy-agent-dir-migration.json"))).toBe(
        false,
      );
      expect(
        resolveInstallAgentDir(
          {},
          {
            env,
            homedir: () => fixture.stateDir,
          },
        ).directory.dir,
      ).toBe(canonicalDir);
    },
  );

  it("binds WAL-backed shared-auth and meeting-transcript inputs as SQLite", async () => {
    const fixture = await makeFixture("storage");
    const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
    fs.writeFileSync(fixture.configPath, `${JSON.stringify(cfg)}\n`);
    const agentDatabasePath = path.join(
      fixture.stateDir,
      "agents/main/agent/openclaw-agent.sqlite",
    );
    const stateDatabasePath = resolveOpenClawStateSqlitePath(fixture.env);
    openOpenClawStateDatabase({ env: fixture.env });
    openOpenClawAgentDatabase({
      agentId: "main",
      env: fixture.env,
      path: agentDatabasePath,
    });
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    const agentDatabase = new DatabaseSync(agentDatabasePath);
    const stateDatabase = new DatabaseSync(stateDatabasePath);
    let plan: LegacyStateMigrationPlan;
    try {
      for (const database of [agentDatabase, stateDatabase]) {
        database.exec(
          "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; PRAGMA wal_checkpoint(TRUNCATE);",
        );
      }
      agentDatabase
        .prepare(
          "INSERT INTO auth_profile_store (store_key, store_json, updated_at) VALUES (?, ?, ?)",
        )
        .run(
          "primary",
          JSON.stringify({
            version: 1,
            profiles: {
              "openai:wal": { type: "api_key", provider: "openai", key: "wal-key" },
            },
          }),
          1,
        );
      const historicalSlug = `meeting-${"x".repeat(2200)}`;
      const sourceJson = JSON.stringify({ providerId: "manual-transcript", channelId: "room" });
      executeSqliteQuerySync(
        stateDatabase,
        meetingTranscriptDb(stateDatabase)
          .insertInto("meeting_transcript_sessions")
          .values({
            session_id: "wal-meeting",
            started_at: "2026-09-03T00:00:00.000Z",
            selector: `2026-09-03/${historicalSlug}`,
            export_key: `2026-09-03/${historicalSlug}`,
            session_slug: historicalSlug,
            provider_id: "manual-transcript",
            source_json: sourceJson,
            ...deriveMeetingTranscriptSessionColumns(sourceJson, null),
            created_at_ms: 1,
            updated_at_ms: 1,
          }),
      );
      expect(fs.existsSync(`${agentDatabasePath}-wal`)).toBe(true);
      expect(fs.existsSync(`${stateDatabasePath}-wal`)).toBe(true);

      plan = await fixture.plan();
    } finally {
      agentDatabase.close();
      stateDatabase.close();
    }
    const sharedAuthPlan = byId(plan.steps, "shared-auth-store");
    const meetingPlan = byId(plan.steps, "meeting-transcripts");
    expect(sharedAuthPlan).toMatchObject({
      requiredness: "conditional",
      source: [{ kind: "sqlite", path: agentDatabasePath }],
    });
    expect(meetingPlan).toMatchObject({ requiredness: "required" });
    expect(meetingPlan?.source).toContainEqual({ kind: "sqlite", path: stateDatabasePath });

    const result = await fixture.migrate(cfg);
    expect(byId(result.stepReceipts, "shared-auth-store")).toMatchObject({
      outcome: "completed",
      source: sharedAuthPlan?.source,
      requiredness: "conditional",
    });
    expect(byId(result.stepReceipts, "meeting-transcripts")).toMatchObject({
      outcome: "completed",
      source: meetingPlan?.source,
    });
  });

  it.each(["agent", "worktree"] as const)(
    "plans %s owners through state-schema repair",
    async (owner) => {
      const fixture = await makeFixture("storage");
      const stateDatabase = openOpenClawStateDatabase({ env: fixture.env });
      const agentDatabasePath = path.join(
        fixture.stateDir,
        "agents/legacy/agent/openclaw-agent.sqlite",
      );
      if (owner === "agent") {
        fs.writeFileSync(
          fixture.configPath,
          JSON.stringify({
            agents: { entries: { legacy: {} } },
            plugins: { entries: { "candidate-plugin": { enabled: true } } },
          }),
        );
        stateDatabase.db
          .prepare(`INSERT INTO agent_databases (
      agent_id, path, schema_version, last_seen_at, size_bytes
    ) VALUES (?, ?, ?, ?, ?)`)
          .run("legacy", agentDatabasePath, 1, 1, null);
      } else {
        stateDatabase.db
          .prepare(`
        INSERT INTO worktrees (
          id, repo_fingerprint, repo_root, path, branch, base_ref, owner_kind,
          created_at, last_active_at, provisioned_paths_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `)
          .run(
            "legacy-after-schema",
            "legacy-fingerprint",
            fixture.root,
            path.join(fixture.stateDir, "worktrees", "legacy-after-schema"),
            "openclaw/legacy-after-schema",
            "HEAD",
            "session",
            1,
            1,
          );
      }
      const stateDatabasePath = stateDatabase.path;
      closeOpenClawStateDatabaseForTest();
      {
        using legacy = new DatabaseSync(stateDatabasePath);
        legacy.exec(
          owner === "agent"
            ? "PRAGMA user_version = 8; UPDATE schema_meta SET schema_version = 8;"
            : "PRAGMA user_version = 1;",
        );
      }

      const plan = await fixture.plan();

      expect(plan.steps[0]).toMatchObject({ id: "state-schema", requiredness: "required" });
      if (owner === "agent") {
        expect(byId(plan.steps, "agent-migration-targets")?.refusal).toBeUndefined();
        expect(byId(plan.steps, "media-persistence")?.source).toContainEqual({
          kind: "sqlite",
          path: agentDatabasePath,
        });
      } else {
        expect(byId(plan.steps, "managed-worktrees")).toMatchObject({
          source: [
            { kind: "sqlite", path: stateDatabasePath },
            { kind: "owner", id: "core:managed-worktree:legacy-after-schema" },
          ],
          requiredness: "required",
        });
      }
    },
  );
});
