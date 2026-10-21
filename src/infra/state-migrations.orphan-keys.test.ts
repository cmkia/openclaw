import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import {
  migrateOrphanedSessionKeys,
  resolveSessionStoreOwnership,
} from "./state-migrations.session-store.js";

const listPluginDoctorSessionStoreAgentIdsMock = vi.hoisted(() => vi.fn((): string[] => []));

vi.mock("../plugins/doctor-contract-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/doctor-contract-registry.js")>();
  return {
    ...actual,
    listPluginDoctorSessionStoreAgentIds: listPluginDoctorSessionStoreAgentIdsMock,
  };
});

function writeStore(storePath: string, store: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(store));
}

function readStore(storePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(storePath, "utf-8"));
}

function expectStore(storePath: string, present: Record<string, string>, absent: string[] = []) {
  const store = readStore(storePath);
  for (const [key, sessionId] of Object.entries(present)) {
    expect(store[key]).toMatchObject({ sessionId });
  }
  for (const key of absent) {
    expect(store[key]).toBeUndefined();
  }
}

const entry = (id: string, updatedAt: number) => ({ sessionId: id, updatedAt });

function fixtureConfig(
  store?: string,
  agents = ["ops"],
  session: OpenClawConfig["session"] = {},
  pluginOwner = false,
): OpenClawConfig {
  return {
    session: { mainKey: "work", store, ...session },
    agents: { entries: Object.fromEntries(agents.map((id) => [id, {}])) },
    ...(pluginOwner && {
      plugins: { entries: { "voice-call": { config: { agentId: "voice" } } } },
    }),
  };
}
const OPS_WORK_CONFIG = fixtureConfig();
async function migrateFixtureState(
  stateDir: string,
  cfg: OpenClawConfig = OPS_WORK_CONFIG,
  additionalAgentIds?: readonly string[],
) {
  return migrateOrphanedSessionKeys({
    cfg,
    env: { OPENCLAW_STATE_DIR: stateDir },
    additionalAgentIds,
    legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
  });
}

describe("migrateOrphanedSessionKeys", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let tmpDir: string;
  let stateDir: string;
  const standardPath = (agent = "ops") =>
    path.join(stateDir, "agents", agent, "sessions", "sessions.json");
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    tmpDir = tempDirs.make("orphan-keys-test-");
    stateDir = path.join(tmpDir, ".openclaw");
    fs.mkdirSync(stateDir, { recursive: true });
    listPluginDoctorSessionStoreAgentIdsMock.mockReset();
    listPluginDoctorSessionStoreAgentIdsMock.mockReturnValue([]);
  });

  it("distinguishes large adjacent inodes before planning store aliases", async () => {
    const configuredStorePath = path.join(tmpDir, "configured-sessions.json");
    const targetStorePath = standardPath("voice");
    writeStore(configuredStorePath, {});
    writeStore(targetStorePath, {});
    const cfg = fixtureConfig(configuredStorePath, ["ops"], { mainKey: undefined });
    const realStatSync = fs.statSync.bind(fs);
    const largeInodes = new Map([
      [configuredStorePath, 72057594037932382n],
      [targetStorePath, 72057594037932383n],
    ]);
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation(((
      candidate: Parameters<typeof fs.statSync>[0],
      options?: { bigint?: boolean },
    ) => {
      const resolvedPath = path.resolve(candidate.toString());
      const inode = largeInodes.get(resolvedPath);
      const useBigInt = options?.bigint === true;
      const stat = useBigInt ? realStatSync(candidate, { bigint: true }) : realStatSync(candidate);
      if (inode === undefined) {
        return stat;
      }
      return new Proxy(stat, {
        get(target, property, receiver) {
          if (property === "dev") {
            return useBigInt ? 2n : 2;
          }
          if (property === "ino") {
            return useBigInt ? inode : Number(inode);
          }
          return Reflect.get(target, property, receiver);
        },
      });
    }) as typeof fs.statSync);

    const ownership = resolveSessionStoreOwnership({
      cfg,
      env: { OPENCLAW_STATE_DIR: stateDir },
      stateDir,
      targetAgentId: "voice",
      pluginSessionStoreAgentIds: ["voice"],
    });
    expect(statSpy).toHaveBeenCalledWith(configuredStorePath, { bigint: true });
    expect(statSpy).toHaveBeenCalledWith(targetStorePath, { bigint: true });

    expect(ownership).toEqual({
      preserveAmbiguousKeys: false,
      preserveForeignMainAliases: false,
      targetStoreAliases: {
        hasDistinctAliases: false,
        hasFinalSymlink: false,
        hasUnresolvedIdentity: false,
      },
    });
  });

  it.each([
    { scope: undefined, canonicalMainKey: "agent:voice:main" },
    { scope: "global" as const, canonicalMainKey: "global" },
  ])(
    "preserves opaque foreign main aliases in plugin-owned $scope stores",
    async ({ scope, canonicalMainKey }) => {
      const storeTemplate = path.join(tmpDir, "stores", "{agentId}", "sessions.json");
      const voiceStorePath = path.join(tmpDir, "stores", "voice", "sessions.json");
      writeStore(voiceStorePath, {
        "agent:main:main": entry("explicit-foreign", 3000),
        [canonicalMainKey]: entry("voice-main", 1000),
        "voice:15550001111": entry("legacy-voice", 2000),
      });
      const cfg = fixtureConfig(storeTemplate, ["main"], { mainKey: undefined, scope }, true);

      const result = await migrateFixtureState(stateDir, cfg, ["voice"]);

      expectStore(
        voiceStorePath,
        {
          "agent:main:main": "explicit-foreign",
          [canonicalMainKey]: "voice-main",
          "agent:voice:voice:15550001111": "legacy-voice",
        },
        ["voice:15550001111"],
      );
      expect(result.changes).toHaveLength(1);
      expect(result.warnings).toHaveLength(1);
    },
  );

  it("warns from a readable alias when the configured path identity is inaccessible", async () => {
    const configuredStorePath = path.join(tmpDir, "configured-sessions.json");
    writeStore(configuredStorePath, {});
    const standardStorePath = standardPath("voice");
    writeStore(standardStorePath, {
      "voice:15550001111": entry("legacy-voice", 1000),
    });
    const cfg = fixtureConfig(configuredStorePath, ["ops"], { mainKey: undefined });
    const realStatSync = fs.statSync.bind(fs);
    vi.spyOn(fs, "statSync").mockImplementation((candidate) => {
      if (path.resolve(candidate.toString()) === configuredStorePath) {
        throw Object.assign(new Error("inaccessible store"), { code: "EACCES" });
      }
      return realStatSync(candidate);
    });

    const result = await migrateFixtureState(stateDir, cfg, ["voice"]);

    expect(result.changes).toHaveLength(0);
    expect(result.warnings).toEqual([
      `Deferred session key migration for ${standardStorePath}; filesystem identity could not be established for every configured store path. Restore path access or configure one canonical session.store path, then rerun openclaw doctor --fix`,
    ]);
    expectStore(standardStorePath, { "voice:15550001111": "legacy-voice" });
  });

  it("defers migration through a final-component store symlink", async () => {
    const standardStorePath = standardPath("voice");
    writeStore(standardStorePath, {
      "agent:voice::matrix:channel:!room:example.org": entry("malformed-owner", 2000),
      "voice:15550001111": entry("legacy-voice", 1000),
    });
    const configuredStorePath = path.join(tmpDir, "configured-sessions.json");
    fs.symlinkSync(standardStorePath, configuredStorePath);
    const cfg = fixtureConfig(configuredStorePath, ["ops"], { mainKey: undefined }, true);

    const result = await migrateFixtureState(stateDir, cfg, ["voice"]);

    expect(result.changes).toHaveLength(0);
    expect(result.warnings).toEqual([
      `Deferred migration of 2 ambiguous session key(s) in aliased store ${configuredStorePath}; remove filesystem aliases or configure one canonical session.store path, then rerun openclaw doctor --fix`,
    ]);
    expect(fs.lstatSync(configuredStorePath).isSymbolicLink()).toBe(true);
    expectStore(standardStorePath, {
      "agent:voice::matrix:channel:!room:example.org": "malformed-owner",
    });
  });

  it("defers an unambiguous rewrite through a singleton final symlink", async () => {
    const outsideStorePath = path.join(tmpDir, "outside-sessions.json");
    writeStore(outsideStorePath, {
      "agent:main:main": entry("outside-global", 1000),
    });
    const storePath = standardPath("main");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.symlinkSync(outsideStorePath, storePath);
    const cfg = { session: { scope: "global" } } as OpenClawConfig;

    const result = await migrateFixtureState(stateDir, cfg);

    expect(result.changes).toHaveLength(0);
    expect(result.warnings).toEqual([
      `Deferred session key migration in final-component symlink store ${storePath}; configure one canonical session.store path, then rerun openclaw doctor --fix`,
    ]);
    expect(fs.lstatSync(storePath).isSymbolicLink()).toBe(true);
    expectStore(outsideStorePath, { "agent:main:main": "outside-global" });
  });

  it("defers global main aliases across hard-linked store paths", async () => {
    const standardStorePath = standardPath("main");
    writeStore(standardStorePath, {
      "agent:main:main": entry("legacy-global", 1000),
    });
    const configuredStorePath = path.join(tmpDir, "configured-sessions.json");
    fs.linkSync(standardStorePath, configuredStorePath);
    const cfg = fixtureConfig(configuredStorePath, ["main"], {
      mainKey: undefined,
      scope: "global",
    });

    const result = await migrateFixtureState(stateDir, cfg);

    for (const storePath of [configuredStorePath, standardStorePath]) {
      expectStore(storePath, { "agent:main:main": "legacy-global" }, ["global"]);
    }
    expect(result.changes).toHaveLength(0);
    expect(result.warnings).toEqual([
      `Deferred session key migration in aliased store ${configuredStorePath}; atomic replacement cannot update distinct filesystem aliases as one operation. Remove filesystem aliases or configure one canonical session.store path, then rerun openclaw doctor --fix`,
    ]);
  });

  it("preserves the exact bytes of commented JSON5 with trailing commas", async () => {
    const raw = `// operator-authored session history\n{\n  'agent:ops:work': { sessionId: 'abc-123', updatedAt: 1000, },\n}\n`;
    const storePath = standardPath();
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, raw);

    expect(await migrateFixtureState(stateDir)).toEqual({ changes: [], warnings: [] });
    expect(fs.readFileSync(storePath, "utf-8")).toBe(raw);
  });

  it("checks missing agent stores without comparing every earlier path", async () => {
    const agentCount = 100;
    const cfg = {
      session: { store: path.join(tmpDir, "stores", "{agentId}", "sessions.json") },
      agents: {
        entries: Object.fromEntries(
          Array.from({ length: agentCount }, (_, index) => [`agent-${index}`, {}]),
        ),
      },
    } as OpenClawConfig;
    const statSpy = vi.spyOn(fs, "statSync");

    expect(await migrateFixtureState(stateDir, cfg)).toEqual({ changes: [], warnings: [] });
    const storeProbes = statSpy.mock.calls.filter(([candidate]) =>
      candidate.toString().endsWith("sessions.json"),
    );
    expect(storeProbes).toHaveLength(agentCount);
  });

  it("does not prepare channel migration surfaces without a legacy store", async () => {
    const prepareLegacySessionSurfaces = vi.fn(() => EMPTY_LEGACY_SESSION_SURFACES);

    const result = await migrateOrphanedSessionKeys({
      cfg: OPS_WORK_CONFIG,
      env: { OPENCLAW_STATE_DIR: stateDir },
      legacySessionSurfaces: prepareLegacySessionSurfaces,
    });

    expect(result).toEqual({ changes: [], warnings: [] });
    expect(prepareLegacySessionSurfaces).not.toHaveBeenCalled();
  });

  // The destination is an explicit oracle, not obtained from the migration under test.
  type Rewrite = [source: string, target: string | null, id: string, updatedAt?: number];
  it.each<{
    name: string;
    rows: Rewrite[];
    shared?: boolean;
    main?: boolean;
    config?: OpenClawConfig;
    changes?: number;
    warnings?: number;
    absent?: string[];
    rerun?: boolean;
  }>([
    {
      name: "promotes newer legacy voice sessions",
      main: true,
      rows: [
        ["voice:15550001111", "agent:main:voice:15550001111", "legacy-voice", 2000],
        ["agent:main:voice:15550001111", null, "stale-canonical"],
      ],
    },
    {
      name: "keeps newest entries and canonical ties in both orders",
      rows: [
        ["agent:main:main", null, "old-orphan", 500],
        ["agent:ops:work", "agent:ops:work", "current", 2000],
        ["agent:ops:TIE-ONE", null, "noncanonical-earlier"],
        ["agent:ops:tie-one", "agent:ops:tie-one", "canonical-later"],
        ["agent:ops:tie-two", "agent:ops:tie-two", "canonical-earlier"],
        ["agent:ops:TIE-TWO", null, "noncanonical-later"],
      ],
    },
    {
      name: "preserves shared default-main ownership",
      shared: true,
      warnings: 1,
      absent: ["agent:main:work"],
      rows: [
        ["agent:main:main", "agent:main:main", "main-session", 2000],
        ["agent:ops:work", "agent:ops:work", "ops-session"],
      ],
    },
    {
      name: "canonicalizes shared global aliases",
      shared: true,
      config: { session: { scope: "global" } },
      changes: 1,
      warnings: 0,
      rows: [
        ["global", null, "stale-global"],
        ["main", null, "bare-main", 2000],
        ["agent:main:main", null, "legacy-main", 3000],
        ["agent:main:work", "global", "fresh-main", 4000],
      ],
    },
    {
      name: "canonicalizes shared non-main owners",
      shared: true,
      config: { agents: { entries: { ops: {}, research: {} } } },
      changes: 1,
      warnings: 0,
      rows: [
        ["agent:ops:main", "agent:ops:work", "ops-session"],
        ["agent:research:main", "agent:research:work", "research-session", 2000],
      ],
    },
    {
      name: "uses the persisted shared-store owner",
      shared: true,
      warnings: 0,
      config: {
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "ops" } },
          entries: { main: {}, ops: {} },
        },
      },
      rows: [["voice:15550001111", "agent:ops:voice:15550001111", "legacy-voice", 2000]],
    },
    {
      name: "preserves prototype keys while migrating siblings",
      shared: true,
      changes: 1,
      warnings: 1,
      rows: [
        ["__proto__", "__proto__", "prototype-session"],
        ["agent:ops:main", "agent:ops:work", "ops-session", 2000],
      ],
    },
    {
      name: "canonicalizes mixed-case aliases once",
      changes: 1,
      rerun: true,
      rows: [["Agent:OPS:MAIN", "agent:ops:work", "ops-session", 2000]],
    },
    {
      name: "leaves default main unchanged",
      main: true,
      changes: 0,
      rows: [["agent:main:main", "agent:main:main", "abc-123"]],
    },
  ])("$name", async ({ rows, shared, main, config, changes, warnings, absent = [], rerun }) => {
    const file = shared
      ? path.join(tmpDir, "shared-sessions.json")
      : main
        ? standardPath("main")
        : standardPath();
    writeStore(
      file,
      Object.fromEntries(rows.map(([key, , id, time = 1000]) => [key, entry(id, time)] as const)),
    );
    const base: OpenClawConfig = main
      ? {}
      : shared
        ? fixtureConfig(file, ["main", "ops"])
        : OPS_WORK_CONFIG;
    const cfg = { ...base, ...config, session: { ...base.session, ...config?.session } };
    const result = await migrateFixtureState(stateDir, cfg);
    const present = Object.fromEntries(
      rows.flatMap(([, target, id]) => (target === null ? [] : [[target, id] as const])),
    );
    const removed = rows.map(([key]) => key).filter((key) => !Object.hasOwn(present, key));
    expectStore(file, present, [...removed, ...absent]);
    if (Object.hasOwn(present, "__proto__")) {
      expect(Object.hasOwn(readStore(file), "__proto__")).toBe(true);
    }
    if (changes !== undefined) {
      expect(result.changes).toHaveLength(changes);
    }
    if (warnings !== undefined) {
      expect(result.warnings).toHaveLength(warnings);
    }
    if (rerun) {
      expect(await migrateFixtureState(stateDir, cfg)).toEqual({ changes: [], warnings: [] });
    }
  });

  it("does not guess the owner of raw keys in shared multi-agent stores", async () => {
    const sharedStorePath = path.join(tmpDir, "shared-sessions.json");
    writeStore(sharedStorePath, {
      "voice:15550001111": entry("legacy-voice", 2000),
      "agent:ops:work": entry("ops-session", 1000),
    });

    const result = await migrateFixtureState(
      stateDir,
      fixtureConfig(sharedStorePath, ["main", "ops"]),
    );

    expectStore(sharedStorePath, { "voice:15550001111": "legacy-voice" }, [
      "agent:main:voice:15550001111",
      "agent:ops:voice:15550001111",
    ]);
    expect(result.warnings).toContain(
      `Preserved 1 ambiguous session key(s) in potentially shared store ${sharedStorePath}`,
    );
  });
});
