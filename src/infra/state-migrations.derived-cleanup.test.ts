import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  coercePluginDoctorContractModule,
  type PluginDoctorContractModule,
} from "../plugins/doctor-contract-module.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import * as fsSafe from "./fs-safe.js";
import {
  createLegacyStateMigrationStepReceipt,
  throwIfDoctorStateMigrationRefused,
} from "./state-migrations.messages.js";
import { createPluginDoctorStateMigrationContext } from "./state-migrations.plugin-doctor-context.js";

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  vi.restoreAllMocks();
  await tempDirs.cleanup();
});

it("continues Doctor when Memory Wiki compiled-cache cleanup fails", async () => {
  const pluginId = "memory-wiki";
  const migrationId = "memory-wiki-compiled-cache-file-cleanup";
  const { stateMigrations } = coercePluginDoctorContractModule(
    await vi.importActual<PluginDoctorContractModule>(
      path.resolve("extensions", pluginId, "doctor-contract-api.ts"),
    ),
  );
  const stateDir = await tempDirs.make("openclaw-derived-cleanup-");
  const vaultRoot = path.join(stateDir, "vault");
  const artifactPath = path.join(vaultRoot, ".openclaw-wiki", "cache", "agent-digest.json");
  const artifactText = "rebuildable artifact\n";
  await fs.mkdir(path.dirname(artifactPath), { recursive: true });
  await fs.writeFile(artifactPath, artifactText);
  const config: OpenClawConfig = {
    plugins: { entries: { "memory-wiki": { config: { vault: { path: vaultRoot } } } } },
  };
  const env = { ...process.env, HOME: stateDir, OPENCLAW_STATE_DIR: stateDir };
  const params = {
    config,
    env,
    stateDir,
    oauthDir: path.join(stateDir, "credentials"),
    context: createPluginDoctorStateMigrationContext({ pluginId, env, config }),
  };
  const migration = expectDefined(
    stateMigrations?.find((entry) => entry.id === migrationId),
    migrationId,
  );
  const removalError = new Error("synthetic cleanup permission denied");
  const openRoot = fsSafe.root;
  vi.spyOn(fsSafe, "root").mockImplementation(async (rootPath, defaults) => {
    const root = await openRoot(rootPath, defaults);
    if (rootPath === vaultRoot) {
      vi.spyOn(root, "remove").mockRejectedValue(removalError);
    }
    return root;
  });

  const receipt = createLegacyStateMigrationStepReceipt(
    {
      id: migrationId,
      phase: "final",
      source: [{ kind: "path", path: artifactPath }],
      target: [],
      requiredness: "required",
      reversibility: "not-applicable",
    },
    await migration.migrateLegacyState(params),
  );

  await expect(fs.readFile(artifactPath, "utf8")).resolves.toBe(artifactText);
  const warnings = receipt.warnings.join("\n");
  expect(warnings).toContain("rebuildable Memory Wiki compiled cache");
  expect(warnings).toContain(removalError.message);
  expect(() => throwIfDoctorStateMigrationRefused([receipt])).not.toThrow();
  expect(receipt.outcome).toBe("warning");
  expect(warnings).toContain("openclaw doctor --fix");

  vi.restoreAllMocks();
  expect((await migration.migrateLegacyState(params)).warnings).toEqual([]);
  await expect(fs.stat(artifactPath)).rejects.toMatchObject({ code: "ENOENT" });
});
