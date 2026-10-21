import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { endianness } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  registerSealedRuntimeProcessEntrypoint,
  resolveRuntimeProcessEntrypointUrl,
} from "./runtime-process-url.js";
import { planLegacyStateMigrationsReadOnly } from "./state-migrations.doctor.js";
import {
  captureLegacyStateSnapshotIdentity as captureIdentity,
  readLegacyStateMigrationPlanConfig,
} from "./state-migrations.plan.js";
import { createMigrationFixture } from "./state-migrations.shard-fixture.test-support.js";
import { captureLegacyStateSnapshotIdentityInProcess } from "./state-migrations.snapshot.worker.js";
import type { LegacyStateMigrationPlan } from "./state-migrations.types.js";

const tempDirs = createTrackedTempDirs();
const byteOrder = endianness();
const read32 = (buffer: Buffer, offset: number) => buffer[`readUInt32${byteOrder}`](offset);
const write32 = (buffer: Buffer, value: number, offset: number) =>
  buffer[`writeUInt32${byteOrder}`](value, offset);

const sha256 = (value: string | Buffer) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const durableHashes = (databasePath: string) =>
  ["", "-wal"].map((suffix) => sha256(fs.readFileSync(databasePath + suffix)));

function openWal(databasePath: string) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE planner_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO planner_probe(value) VALUES ('copied-state');
    `);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function copyWal(sourcePath: string, databasePath: string) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  for (const suffix of ["", "-wal"]) {
    fs.copyFileSync(`${sourcePath}${suffix}`, `${databasePath}${suffix}`);
  }
}

function requireDigest(plan: Awaited<ReturnType<typeof planLegacyStateMigrationsReadOnly>>) {
  const digest = plan.snapshot.stateDigest;
  if (!digest) {
    throw new Error("expected the copied state to have a bound digest");
  }
  return digest;
}

function writeWalIndexHeaderChecksum(header: Buffer): void {
  let first = 0;
  let second = 0;
  for (let offset = 0; offset < 40; offset += 8) {
    first = (first + read32(header, offset) + second) >>> 0;
    second = (second + read32(header, offset + 4) + first) >>> 0;
  }
  write32(header, first, 40);
  write32(header, second, 44);
}

let fixture: ReturnType<typeof createMigrationFixture>;
beforeEach(async () => {
  fixture = createMigrationFixture(await tempDirs.make("openclaw-migration-plan-identity-"));
});

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
  vi.restoreAllMocks();
});

it("defers the Workshop proposal export without touching copied proposal files", async () => {
  const draft = path.join(
    fixture.stateDir,
    "skill-workshop/proposals/retained-workshop-20260905-1234567890/PROPOSAL.md",
  );
  fs.mkdirSync(path.dirname(draft), { recursive: true });
  fs.writeFileSync(draft, "---\nname: retained\ndescription: Retained skill\n---\n");
  const before = await captureIdentity(fixture);

  const plan = await fixture.plan();
  expect(plan.steps.find((step) => step.id === "skill-workshop")).toMatchObject({
    outcome: "deferred",
    refusal: { code: "skill-workshop-planning-deferred" },
  });
  expect(await captureIdentity(fixture)).toEqual(before);
  expect(fs.readFileSync(draft, "utf8")).toContain("name: retained");
});

it.each([false, true])("plans without mutating WAL state (missing shm: %s)", async (missing) => {
  const databasePath = resolveOpenClawStateSqlitePath(fixture.env);
  const sourcePath = missing ? path.join(fixture.root, "wal-source.sqlite") : databasePath;
  using database = openWal(sourcePath);
  if (missing) {
    copyWal(sourcePath, databasePath);
  }
  const durableBefore = durableHashes(databasePath);
  const shmPath = `${databasePath}-shm`;
  const sharedMemoryBefore = missing ? undefined : sha256(fs.readFileSync(shmPath));
  const plan = await fixture.plan();
  expect(durableHashes(databasePath)).toEqual(durableBefore);
  expect(plan.refusal?.code).toBe("candidate-artifact-digest-required");
  if (missing) {
    expect(fs.existsSync(shmPath)).toBe(false);
  } else {
    expect(sha256(fs.readFileSync(shmPath))).toBe(sharedMemoryBefore);
    const stateDigest = requireDigest(plan);
    database.exec("INSERT INTO planner_probe(value) VALUES ('durable-change');");
    const stale = await fixture.plan({ snapshot: { ...plan.snapshot, stateDigest } });
    expect(stale).toMatchObject({
      mutationAllowed: false,
      outcome: "refused",
      refusal: { code: "snapshot-identity-mismatch" },
      steps: [],
    });
    expect(stale.snapshot.stateDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(stale.snapshot.stateDigest).not.toBe(stateDigest);
  }
});

it("continues binding ordinary copied-state files whose names end in -shm", async () => {
  const pairedPath = path.join(fixture.stateDir, "operator-notes");
  const similarlyNamedPath = `${pairedPath}-shm`;
  fs.writeFileSync(pairedPath, "not a SQLite database\n");
  fs.writeFileSync(similarlyNamedPath, "first\n");

  const first = await fixture.plan();
  const stateDigest = requireDigest(first);

  fs.writeFileSync(similarlyNamedPath, "second\n");
  const stale = await fixture.plan({ snapshot: { ...first.snapshot, stateDigest } });
  expect(stale.refusal?.code).toBe("snapshot-identity-mismatch");
});

it.each(["file", "directory"])("binds a fake %s at a SQLite shared-memory path", async (kind) => {
  const databasePath = resolveOpenClawStateSqlitePath(fixture.env);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE planner_probe (id INTEGER PRIMARY KEY);");
  database.close();
  const sharedMemoryPath = `${databasePath}-shm`;

  if (kind === "directory") {
    fs.mkdirSync(sharedMemoryPath);
  }
  const payloadPath =
    kind === "file" ? sharedMemoryPath : path.join(sharedMemoryPath, "operator-state");
  fs.writeFileSync(payloadPath, "not a wal-index\n");
  const before = await captureIdentity(fixture);
  fs.writeFileSync(payloadPath, "changed durable bytes\n");
  expect((await captureIdentity(fixture)).stateDigest).not.toBe(before.stateDigest);
});

it.each([false, true])("binds wal-index changes (forged structure: %s)", async (forged) => {
  const sourcePath = path.join(fixture.root, "wal-index-source.sqlite");
  using source = openWal(sourcePath);
  const databasePath = path.join(fixture.stateDir, "copied.sqlite");
  copyWal(sourcePath, databasePath);
  const index = Buffer.alloc(32_768, 0x5a);
  fs.readFileSync(`${source.location()}-shm`).copy(index, 0, 0, 48);
  if (forged) {
    index.writeUInt8(index.readUInt8(13) ^ 1, 13);
    index[`writeUInt16${byteOrder}`](1, 14);
    write32(index, 0xffff_ffff, 16);
    writeWalIndexHeaderChecksum(index);
  }
  index.copy(index, 48, 0, 48);
  const sharedMemoryPath = `${databasePath}-shm`;
  fs.writeFileSync(sharedMemoryPath, index);
  const before = await captureIdentity(fixture);
  if (forged) {
    write32(index, 0xffff_fffe, 16);
    writeWalIndexHeaderChecksum(index);
    index.copy(index, 48, 0, 48);
  } else {
    index.writeUInt8(index.readUInt8(200) ^ 0xff, 200);
  }
  fs.writeFileSync(sharedMemoryPath, index);
  const after = await captureIdentity(fixture);
  expect(after.stateDigest).not.toBe(before.stateDigest);
  if (forged) {
    index.writeUInt8(index.readUInt8(120) ^ 0xff, 120);
    index.writeUInt8(index.readUInt8(132) ^ 0xff, 132);
    fs.writeFileSync(sharedMemoryPath, index);
    const checkpoint = await captureIdentity(fixture);
    expect(checkpoint.stateDigest).not.toBe(after.stateDigest);
  }
});

const digest = expect.stringMatching(/^sha256:[0-9a-f]{64}$/u);
const changedConfig = '{"agents":{"defaults":{"workspace":"./changed"}}}\n';

function expectWarning(warnings: string[], message: string) {
  expect(warnings).toEqual([expect.stringContaining(message)]);
}

function expectBoundPlan(plan: LegacyStateMigrationPlan) {
  expect(plan.refusal?.code).toBe("candidate-artifact-digest-required");
  expect(plan.snapshot.stateDigest).toEqual(digest);
}

it("captures accepted config include identities larger than OS argument limits", async () => {
  const includeDir = path.join(fixture.root, "a".repeat(180), "b".repeat(180), "c".repeat(180));
  fs.mkdirSync(includeDir, { recursive: true });
  const paths = Array.from({ length: 2300 }, (_, index) => {
    const pathname = path.join(includeDir, `${index}.json`);
    fs.writeFileSync(pathname, "{}\n");
    return pathname;
  });
  fs.writeFileSync(
    fixture.configPath,
    JSON.stringify({ $include: paths.map((pathname) => path.relative(fixture.root, pathname)) }),
  );
  const config = await readLegacyStateMigrationPlanConfig(fixture);
  expect(config.warnings).toEqual([]);
  expect(config.configInputHashes?.includes).toHaveLength(paths.length);
  const params = {
    configPath: fixture.configPath,
    stateDir: fixture.stateDir,
    configInputHashes: config.configInputHashes,
  };
  expect(Buffer.byteLength(JSON.stringify(params))).toBeGreaterThan(1024 * 1024);

  const identity = await captureIdentity(params);

  expect(identity).toMatchObject({
    warnings: [],
    configDigest: config.rootDigest,
    stateDigest: digest,
  });
  fs.writeFileSync(path.join(includeDir, "0.json"), changedConfig);
  const changed = await captureIdentity(params);
  expect(changed.configDigest).toBeUndefined();
  expectWarning(changed.warnings, "Snapshot config input changed while planning:");
});

it("refuses unavailable snapshot workers without falling back to caller-process hashing", async () => {
  const original = resolveRuntimeProcessEntrypointUrl("stateMigrationSnapshot");
  registerSealedRuntimeProcessEntrypoint(
    "stateMigrationSnapshot",
    pathToFileURL(path.join(fixture.root, "missing-worker.js")),
  );
  try {
    const refused = await fixture.plan();
    expect(refused.refusal?.code).toBe("snapshot-identity-unavailable");
    expect(refused.snapshot.stateDigest).toBeUndefined();
    expect(refused.steps).toEqual([]);
    expectWarning(refused.warnings, "Could not bind copied snapshot:");
  } finally {
    registerSealedRuntimeProcessEntrypoint("stateMigrationSnapshot", original);
  }
  expectBoundPlan(await fixture.plan());
});

it("refuses an ordinary file replaced between tree inspection and open", async () => {
  const probePath = path.join(fixture.stateDir, "identity-probe.json");
  const originalPath = `${probePath}.original`;
  fs.writeFileSync(probePath, '{"value":"original"}\n');
  const realOpen = fs.promises.open.bind(fs.promises);
  let replacementTriggered = false;
  vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
    if (!replacementTriggered && path.resolve(String(args[0])) === probePath) {
      replacementTriggered = true;
      fs.renameSync(probePath, originalPath);
      fs.writeFileSync(probePath, '{"value":"replacement"}\n');
    }
    return realOpen(...args);
  });

  const identity = await captureLegacyStateSnapshotIdentityInProcess(fixture);
  expect(replacementTriggered).toBe(true);
  expect(identity.stateDigest).toBeUndefined();
  expectWarning(identity.warnings, `Snapshot file changed while opening: ${probePath}`);
});

it.each([
  ["DELETE", "held.sqlite"],
  ["WAL", "held.sqlite"],
  ["DELETE", "state/openclaw.sqlite"],
  ["WAL", "state/openclaw.sqlite"],
])(
  "preserves a caller-held %s read transaction on %s through the complete planner",
  async (journalMode, relativePath) => {
    const databasePath = path.join(fixture.stateDir, relativePath);
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    const compete = () => {
      const child = spawnSync(
        process.execPath,
        [
          "-e",
          `const { DatabaseSync } = require('node:sqlite');
           const database = new DatabaseSync(process.argv[1]);
           try {
             database.exec('PRAGMA busy_timeout=0;');
             if (process.argv[2] === 'WAL') {
               console.log(JSON.stringify({ blocked: database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy === 1 }));
             } else {
               database.exec('BEGIN EXCLUSIVE; ROLLBACK;');
               console.log(JSON.stringify({ blocked: false }));
             }
           } catch (error) {
             if (error.errcode !== 5) throw error;
             console.log(JSON.stringify({ blocked: true }));
           } finally { database.close(); }`,
          databasePath,
          journalMode,
        ],
        { encoding: "utf8" },
      );
      expect(child.error).toBeUndefined();
      expect(child.signal).toBeNull();
      expect(child.status, child.stderr).toBe(0);
      return JSON.parse(child.stdout);
    };
    try {
      database.exec(
        `PRAGMA journal_mode=${journalMode}; PRAGMA wal_autocheckpoint=0;
         CREATE TABLE held(value TEXT); INSERT INTO held VALUES ('original'); BEGIN;`,
      );
      expect(database.prepare("SELECT value FROM held").all()).toEqual([{ value: "original" }]);
      if (journalMode === "WAL") {
        using writer = new DatabaseSync(databasePath);
        writer.exec("INSERT INTO held VALUES ('later');");
      }
      expect(compete()).toEqual({ blocked: true });

      const plan = await fixture.plan();

      expectBoundPlan(plan);
      expect(compete()).toEqual({ blocked: true });
      expect(database.prepare("SELECT value FROM held").all()).toEqual([{ value: "original" }]);
    } finally {
      database.close();
    }
    expect(compete()).toEqual({ blocked: false });
  },
);

it("binds in-snapshot hard-link topology", async () => {
  const firstPath = path.join(fixture.stateDir, "first.json");
  const secondPath = path.join(fixture.stateDir, "second.json");
  fs.writeFileSync(firstPath, '{"value":"same"}\n');
  fs.writeFileSync(secondPath, '{"value":"same"}\n');
  const independent = await fixture.plan();

  fs.unlinkSync(secondPath);
  fs.linkSync(firstPath, secondPath);
  const linked = await fixture.plan();

  expect(independent.snapshot.stateDigest).toEqual(digest);
  expect(linked.snapshot.stateDigest).toEqual(digest);
  expect(linked.snapshot.stateDigest).not.toBe(independent.snapshot.stateDigest);
});

it("refuses a snapshot file with an unbound external hard link", async () => {
  const externalPath = path.join(fixture.root, "external.json");
  const linkedPath = path.join(fixture.stateDir, "linked.json");
  fs.writeFileSync(externalPath, '{"value":"shared"}\n');
  fs.linkSync(externalPath, linkedPath);

  const plan = await fixture.plan();

  expect(plan.snapshot.stateDigest).toBeUndefined();
  expectWarning(plan.warnings, `Snapshot file has links outside copied state: ${linkedPath}`);
});
