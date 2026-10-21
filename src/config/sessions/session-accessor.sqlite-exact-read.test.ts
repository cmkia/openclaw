import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as sqliteQueries from "../../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase as openDatabase,
  runOpenClawAgentWriteTransaction as writeTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import {
  listSessionEntriesReadOnly as listEntries,
  loadExactSessionEntryReadOnly as readEntry,
  replaceSessionEntrySync as putEntry,
} from "./session-accessor.js";
import {
  prepareExactSessionEntryRowReads as readRows,
  readSessionChildEntriesInDatabase as readChildren,
} from "./session-accessor.sqlite-entry-read.js";
import { recordSessionParticipant as recordParticipant } from "./session-accessor.sqlite-participants.native.js";
import { ensureTranscriptSessionRoot } from "./session-accessor.sqlite-transcript-state.js";
import { assertCapturedSessionEntryReadSource } from "./session-entry-read-source.js";

const autoTempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function fixture() {
  const env = { OPENCLAW_STATE_DIR: autoTempDirs.make("openclaw-exact-read-") };
  return { agentId: "main", env };
}

const sessionFixture = (sessionId: string) => ({
  ...fixture(),
  sessionKey: `agent:main:${sessionId}`,
});

const sessionEntry = (sessionId: string, label?: string) => ({
  sessionId,
  updatedAt: 1,
  ...(label === undefined ? {} : { label }),
});

describe("exact SQLite session reads", () => {
  it("checks captured database birthtime even without an open owner handle", () => {
    const filename = path.join(
      autoTempDirs.make("openclaw-read-source-identity-"),
      "source.sqlite",
    );
    new DatabaseSync(filename).close();
    const identity = readDatabasePathIdentitySync(filename);
    const source = {
      agentId: "main",
      path: filename,
      databaseIdentity: identity.key.slice("file:".length),
      databaseBirthtime: identity.birthtime,
    };
    expect(() => assertCapturedSessionEntryReadSource(source)).not.toThrow();
    expect(() =>
      assertCapturedSessionEntryReadSource({
        ...source,
        databaseBirthtime: identity.birthtime === "0" ? "1" : "0",
      }),
    ).toThrow("file identity changed");
  });

  it.each(["cold", "warm"] as const)(
    "keeps the exact lookup coherent across a concurrent commit (%s)",
    (admission) => {
      const scope = sessionFixture("snapshot");
      const entry = sessionEntry("snapshot", "before");
      putEntry(scope, entry);
      const original = openDatabase(scope);
      closeOpenClawAgentDatabaseByPath(original.path);
      const database = openDatabase(scope);
      const read = (sessionKey = scope.sessionKey) => readEntry({ ...scope, sessionKey });
      if (admission !== "cold") {
        expect(read()?.entry.label).toBe("before");
        // Keep admission warm while evicting the target row so the race reaches SQL.
        expect(read("agent:main:missing")).toBeUndefined();
      }
      const sibling = openNodeSqliteDatabase(database.path);
      const nativeDb = requireNativeSqliteDatabase(database.db);
      sqliteQueries.clearNodeSqliteKyselyCacheForDatabase(nativeDb);
      const prepare = nativeDb.prepare.bind(nativeDb);
      let selectedInTransaction: boolean | undefined;
      const prepareSpy = vi.spyOn(nativeDb, "prepare").mockImplementation((sql) => {
        const statement = prepare(sql);
        if (
          selectedInTransaction === undefined &&
          /from "session_nodes"/i.test(sql) &&
          /where (?:"session_nodes"\.)?"session_key" (?:=|in) /i.test(sql)
        ) {
          selectedInTransaction = database.db.isTransaction;
          sibling
            .prepare(
              "UPDATE session_nodes SET entry_json = ?, label = 'after' WHERE session_key = ?",
            )
            .run(JSON.stringify({ ...entry, label: "after" }), scope.sessionKey);
          sibling
            .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
            .run(scope.sessionKey);
        }
        return statement;
      });
      try {
        expect(read()?.entry.label).toBe("after");
        expect(selectedInTransaction).toBe(false);
        expect(database.db.isTransaction).toBe(false);
        expect(read()?.entry.label).toBe("after");
      } finally {
        prepareSpy.mockRestore();
        sibling.close();
      }
    },
  );

  it.each(["current_session_id", "updated_at", "malformed", "delivery", "lineage"] as const)(
    "keeps per-key %s errors after an intervening list reload",
    (corruption) => {
      const scope = { ...fixture(), projection: "list" as const };
      const healthy = "agent:main:healthy";
      const broken = "agent:main:matrix:group:!room:example.org";
      for (const sessionKey of [healthy, broken]) {
        putEntry({ ...scope, sessionKey }, sessionEntry(sessionKey));
      }
      listEntries(scope);
      const database = openDatabase(scope);
      if (corruption === "lineage") {
        database.db
          .prepare("UPDATE session_nodes SET parent_session_key = ? WHERE session_key = ?")
          .run("agent:main:divergent", broken);
        const readRow = readRows(database, [healthy, broken], "list", "canonical");
        expect(readRow(healthy)?.entry.sessionId).toBe(healthy);
        expect(() => readRow(broken)).toThrow("invalid persisted session row");
        return;
      }
      if (corruption === "current_session_id" || corruption === "updated_at") {
        database.db
          .prepare(`UPDATE session_nodes SET ${corruption} = ? WHERE session_key = ?`)
          .run(corruption === "current_session_id" ? "mismatched" : 2, broken);
      } else {
        const json =
          corruption === "malformed"
            ? "{"
            : JSON.stringify({
                sessionId: broken,
                updatedAt: 1,
                delivery: {
                  kind: "external",
                  route: {
                    channel: "matrix",
                    accountId: "work",
                    target: { to: "!Room:example.org" },
                  },
                  context: { channel: "matrix", accountId: "work", to: "!Room:example.org" },
                  origin: { provider: "matrix", to: "!Room:example.org", accountId: "work" },
                },
              });
        database.db
          .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
          .run(json, broken);
      }
      if (corruption === "delivery") {
        expect(() => listEntries(scope)).toThrow(/non-canonical persisted row/);
      } else {
        listEntries(scope);
      }
      let originalError: unknown;
      try {
        readEntry({ ...scope, sessionKey: broken });
      } catch (error) {
        originalError = error;
      }
      expect(originalError).toMatchObject({ code: "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED" });
      const readRow = readRows(
        database,
        [healthy, broken, "agent:main:missing"],
        "list",
        "canonical",
      );
      expect(readRow(healthy)?.entry.sessionId).toBe(healthy);
      expect(readRow("agent:main:missing")).toBeUndefined();
      expect(() => readRow(broken)).toThrow(originalError);
    },
  );

  it("reads committed entries through the companion while the cached writer has a transaction", () => {
    const scope = sessionFixture("target");
    putEntry(scope, sessionEntry("target", "committed"));
    listEntries({ ...scope, projection: "list" });
    const read = () => readEntry({ ...scope, projection: "list" });
    writeTransaction((database) => {
      database.db
        .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
        .run(JSON.stringify(sessionEntry("target", "next")), scope.sessionKey);
      expect(read()).toMatchObject({ entry: { label: "committed" } });
    }, scope);
    expect(read()).toMatchObject({ entry: { label: "next" } });
  });

  it.each(["full", "list"] as const)(
    "preserves native key bindings in %s exact reads",
    (projection) => {
      const scope = fixture();
      const storedKey = "agent:main:replacement-\ufffd";
      putEntry({ ...scope, sessionKey: storedKey }, sessionEntry("replacement"));
      recordParticipant(
        { ...scope, sessionKey: storedKey },
        { identity: { type: "profile", id: "person" }, promptedAt: 1 },
      );
      const keys = [
        "agent:main:replacement-\ud800",
        "agent:main:replacement-\udc00",
        storedKey,
        "agent:main:replacement-\ud800",
      ];
      const expectedEntry = {
        sessionId: "replacement",
        participantCount: 1,
        participants: [{ identity: { type: "profile", id: "person" } }],
      };
      for (const sessionKey of keys) {
        expect(readEntry({ ...scope, sessionKey, projection })).toMatchObject({
          entry: expectedEntry,
        });
      }
    },
  );

  it.each(["entries", "participants"] as const)(
    "isolates native SQLite conversion errors in exact %s reads",
    (table) => {
      const scope = fixture();
      const keys = ["agent:main:before", "agent:main:broken", "agent:main:after"] as const;
      const retained = "agent:main:retained";
      for (const sessionKey of keys) {
        putEntry({ ...scope, sessionKey }, sessionEntry(sessionKey));
        recordParticipant(
          { ...scope, sessionKey },
          { identity: { type: "profile", id: sessionKey }, promptedAt: 1 },
        );
      }
      writeTransaction((database) => {
        ensureTranscriptSessionRoot(
          database,
          { ...scope, sessionKey: retained, sessionId: retained },
          1,
        );
      }, scope);
      for (const projection of ["full", "list"] as const) {
        for (const sessionKey of keys) {
          expect(readEntry({ ...scope, sessionKey, projection })?.entry.sessionId).toBe(sessionKey);
        }
      }
      const database = openDatabase(scope);
      for (const sessionKey of [keys[0], retained]) {
        database.db
          .prepare(
            "INSERT INTO board_tabs (session_key, tab_id, title, position, created_by, revision) VALUES (?, 'tab', 'Board', 0, 'user', 0)",
          )
          .run(sessionKey);
      }
      database.db
        .prepare(
          table === "entries"
            ? "UPDATE session_nodes SET updated_at = ? WHERE session_key = ?"
            : "UPDATE session_participants SET contribution_count = ? WHERE session_key = ?",
        )
        .run(9007199254740993n, keys[1]);
      for (const projection of ["full", "list"] as const) {
        let originalError: unknown;
        try {
          readEntry({ ...scope, sessionKey: keys[1], projection });
        } catch (error) {
          originalError = error;
        }
        expect(originalError).toMatchObject({ code: "ERR_OUT_OF_RANGE" });
        const readRow = readRows(database, [...keys, retained], projection, "canonical", {
          includeBoardPresence: true,
        });
        expect(readRow(keys[0])?.entry.sessionId).toBe(keys[0]);
        expect(readRow(keys[0])?.row.board_present).toBe(1);
        expect(() => readRow(keys[1])).toThrow(originalError);
        expect(readRow(keys[2])?.entry.sessionId).toBe(keys[2]);
        expect(readRow(keys[2])?.row.board_present).toBe(0);
        expect(readRow(retained)).toBeUndefined();
      }
    },
  );

  it("uses lineage indexes for direct child discovery with stale clustered statistics", () => {
    const scope = fixture();
    const parent = "agent:main:indexed-parent";
    const olderParent = (index: number) => `agent:main:older-parent-${index}`;
    const otherParent = olderParent(0);
    const childKey = (name: string) => `agent:main:child-${name}`;
    const seedEntry = (
      sessionId: string,
      lineage: { parentSessionKey?: string; spawnedBy?: string } = {},
    ) =>
      putEntry(
        { ...scope, sessionKey: `agent:main:${sessionId}` },
        { sessionId, updatedAt: 1, ...lineage },
      );
    writeTransaction(() => {
      for (let index = 0; index < 8; index += 1) {
        seedEntry(`older-parent-${index}`);
      }
      for (let index = 0; index < 438; index += 1) {
        seedEntry(`older-child-${index}`, {
          parentSessionKey: olderParent(index % 8),
          ...(index < 73 ? { spawnedBy: olderParent(index % 7) } : {}),
        });
      }
    }, scope);
    const database = openDatabase(scope);
    // Retained sessions cluster under a few parents. Analyze 446 rows before
    // new collectors and unrelated writes grow the store to 555 rows.
    database.db.exec("ANALYZE");
    const children = [
      ["z-parent", { parentSessionKey: parent, spawnedBy: otherParent }],
      ["a-spawn", { parentSessionKey: otherParent, spawnedBy: parent }],
      ["m-both", { parentSessionKey: parent, spawnedBy: parent }],
      ["b-parent", { parentSessionKey: parent }],
      ["y-spawn", { parentSessionKey: otherParent, spawnedBy: parent }],
      ["c-parent", { parentSessionKey: parent }],
      ["x-spawn", { parentSessionKey: otherParent, spawnedBy: parent }],
      ["d-parent", { parentSessionKey: parent }],
      ["w-spawn", { parentSessionKey: otherParent, spawnedBy: parent }],
    ] as const;
    writeTransaction(() => {
      seedEntry("indexed-parent", { parentSessionKey: parent, spawnedBy: parent });
      for (const [name, lineage] of children) {
        putEntry(
          { ...scope, sessionKey: childKey(name) },
          { sessionId: name, updatedAt: 1, ...lineage },
        );
      }
      for (let index = 0; index < 99; index += 1) {
        seedEntry(`later-unrelated-${index}`, {
          ...(index < 96 ? { parentSessionKey: olderParent(index % 8) } : {}),
          ...(index < 3 ? { spawnedBy: olderParent(index) } : {}),
        });
      }
    }, scope);
    const queries = vi.spyOn(sqliteQueries, "executeSqliteQuerySync");
    try {
      const result = readChildren(database, parent);
      const names = [
        "a-spawn",
        "b-parent",
        "c-parent",
        "d-parent",
        "m-both",
        "w-spawn",
        "x-spawn",
        "y-spawn",
        "z-parent",
      ];
      expect(
        result.map(({ sessionKey, entry }) => ({ sessionKey, sessionId: entry.sessionId })),
      ).toEqual(names.map((name) => ({ sessionKey: childKey(name), sessionId: name })));
      const childQueries = queries.mock.calls
        .map(([readDatabase, query]) => ({ readDatabase, ...query.compile() }))
        .filter(
          ({ sql }) => /"parent_session_key"\s+in/u.test(sql) && /"spawned_by"\s+in/u.test(sql),
        );
      expect(childQueries).toHaveLength(1);
      const childQuery = childQueries[0]!;
      const parameters = childQuery.parameters.map((parameter) => {
        if (typeof parameter !== "string") {
          throw new Error("Expected a string child-query binding");
        }
        return parameter;
      });
      if (!(childQuery.readDatabase instanceof DatabaseSync)) {
        throw new Error("Expected a SQLite connection for the query-plan assertion");
      }
      const plan = childQuery.readDatabase
        .prepare(`EXPLAIN QUERY PLAN ${childQuery.sql}`)
        .all(...parameters)
        .map(({ detail }) => detail);
      expect(plan).not.toContainEqual(expect.stringMatching(/\bSCAN session_nodes\b/u));
      for (const index of [
        "idx_agent_session_nodes_parent_session_key",
        "idx_agent_session_nodes_spawned_by",
      ]) {
        expect(plan).toContainEqual(
          expect.stringMatching(new RegExp(`\\bSEARCH\\b.*\\b${index}\\b`, "u")),
        );
      }
    } finally {
      queries.mockRestore();
    }
  });

  it.each(["full", "list"] as const)(
    "does not read malformed placeholder participants in %s exact and child reads",
    (projection) => {
      const scope = { ...fixture(), projection };
      const parent = "agent:main:parent";
      const healthy = "agent:main:healthy";
      const retained = "agent:main:retained";
      putEntry(
        { ...scope, sessionKey: healthy },
        { sessionId: healthy, updatedAt: 1, parentSessionKey: parent },
      );
      writeTransaction((database) => {
        ensureTranscriptSessionRoot(
          database,
          { ...scope, sessionKey: retained, sessionId: retained },
          1,
        );
      }, scope);
      const database = openDatabase(scope);
      database.db
        .prepare("UPDATE session_nodes SET parent_session_key = ? WHERE session_key = ?")
        .run(parent, retained);
      expect(readEntry({ ...scope, sessionKey: healthy })?.entry.sessionId).toBe(healthy);
      expect(readEntry({ ...scope, sessionKey: retained })).toBeUndefined();
      database.db
        .prepare(
          "INSERT INTO session_participants (session_key, identity_namespace, actor_id, contribution_count, first_prompted_at, last_prompted_at) VALUES (?, ?, ?, ?, 1, 1)",
        )
        .run(retained, "invalid namespace", "unused", 9007199254740993n);
      expect(readEntry({ ...scope, sessionKey: retained })).toBeUndefined();
      const readRow = readRows(database, [retained, healthy], projection, "canonical");
      expect(readRow(retained)).toBeUndefined();
      expect(readRow(healthy)?.entry.sessionId).toBe(healthy);
      expect(readChildren(database, parent, scope.projection)).toMatchObject([
        { sessionKey: healthy, entry: { sessionId: healthy } },
      ]);
    },
  );
});
