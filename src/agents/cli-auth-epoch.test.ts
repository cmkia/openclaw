import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createAuthProfileStoreFixture } from "./auth-profiles/credential-fixtures.test-support.js";
import { updateAuthProfileStoreWithLock } from "./auth-profiles/store-runtime.js";
import type {
  AuthProfileCredential,
  AuthProfileStore,
  OAuthCredential,
} from "./auth-profiles/types.js";
import {
  resolveCliAuthBindingFingerprint,
  resolveCliAuthEpoch,
  resolveCliRuntimeOwnerFingerprint,
} from "./cli-auth-epoch.js";
import {
  resetCliAuthEpochTestDeps,
  setCliAuthEpochTestDeps,
} from "./cli-auth-epoch.test-support.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";

function oauth<Provider extends string>(
  provider: Provider,
  overrides: Partial<Omit<OAuthCredential, "provider">> = {},
): OAuthCredential & { provider: Provider } {
  return {
    type: "oauth",
    access: "access-a",
    refresh: "refresh-a",
    expires: 1,
    ...overrides,
    provider,
  };
}

function profileEpoch(
  authProfileId: string,
  overrides: Partial<Parameters<typeof resolveCliAuthEpoch>[0]> = {},
) {
  return resolveCliAuthEpoch({ provider: "google-gemini-cli", authProfileId, ...overrides });
}

function useProfileStore(store: AuthProfileStore) {
  setCliAuthEpochTestDeps({
    readGeminiCliCredentialsCached: () => null,
    loadAuthProfileStoreForRuntime: () => store,
  });
}

function ownerFingerprint(
  config: OpenClawConfig,
  overrides: Partial<Parameters<typeof resolveCliRuntimeOwnerFingerprint>[0]> = {},
) {
  return resolveCliRuntimeOwnerFingerprint({
    provider: "claude-cli",
    config,
    agentId: "openclaw",
    ...overrides,
  });
}

function expectEpochs(...epochs: Array<string | undefined>) {
  for (const epoch of epochs) {
    expect(typeof epoch).toBe("string");
    expect(epoch).toMatch(/^[a-f0-9]{64}$/);
  }
}

const tempDirs: string[] = [];
function tempDir(label: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), label));
  tempDirs.push(dir);
  return dir;
}

describe("resolveCliAuthEpoch", () => {
  afterEach(() => {
    resetCliAuthEpochTestDeps();
    cliBackendsTesting.resetDepsForTest();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined when no local or auth-profile credentials exist", async () => {
    setCliAuthEpochTestDeps({
      readCodexCliCredentialsCached: () => null,
      readGeminiCliCredentialsCached: () => null,
      loadAuthProfileStoreForRuntime: () => createAuthProfileStoreFixture({}),
    });

    await expect(
      resolveCliAuthEpoch({ provider: "claude-cli", authProfileId: "anthropic:work" }),
    ).resolves.toBeUndefined();
    await expect(profileEpoch("google:work")).resolves.toBeUndefined();
  });

  it("loads auth-profile epochs from the selected agent directory", async () => {
    const agentDirs = ["/agents/work/agent", "/agents/personal/agent"];
    const stores: Record<string, AuthProfileStore> = Object.fromEntries(
      agentDirs.map((agentDir) => [
        agentDir,
        createAuthProfileStoreFixture({
          "google-gemini-cli:default": oauth("google-gemini-cli", {
            email: `${agentDir}@example.test`,
            projectId: agentDir,
          }),
        }),
      ]),
    );
    const loadAuthProfileStoreForRuntime = vi.fn(
      (agentDir?: string) => stores[agentDir ?? ""] ?? { version: 1, profiles: {} },
    );
    setCliAuthEpochTestDeps({
      readGeminiCliCredentialsCached: () => null,
      loadAuthProfileStoreForRuntime,
    });

    const [work, personal] = await Promise.all(
      agentDirs.map((agentDir) =>
        profileEpoch("google-gemini-cli:default", {
          agentDir,
          skipLocalCredential: true,
        }),
      ),
    );
    expectEpochs(work, personal);
    expect(work).not.toBe(personal);
    for (const agentDir of agentDirs) {
      expect(loadAuthProfileStoreForRuntime).toHaveBeenCalledWith(agentDir, {
        readOnly: true,
        allowKeychainPrompt: false,
      });
    }
  });

  it("separates Gemini CLI OAuth profile epochs by profile id", async () => {
    const identity = {
      email: "user@example.test",
      accountId: "google-account-1",
      projectId: "project-1",
    };
    const store: AuthProfileStore = createAuthProfileStoreFixture({
      "google-gemini-cli:primary": oauth("google-gemini-cli", identity),
      "google-gemini-cli:renamed": oauth("google-gemini-cli", identity),
    });
    useProfileStore(store);
    const epoch = (name: string) =>
      profileEpoch(`google-gemini-cli:${name}`, {
        agentDir: "/agents/main/agent",
        skipLocalCredential: true,
      });
    const primary = await epoch("primary");
    store.profiles["google-gemini-cli:primary"] = oauth("google-gemini-cli", {
      ...identity,
      access: "access-b",
      refresh: "refresh-b",
      expires: 2,
    });
    expectEpochs(primary);
    expect(await epoch("primary")).toBe(primary);
    expect(await epoch("renamed")).not.toBe(primary);
  });

  it("keeps strict CLI bindings stable for a known OAuth principal", async () => {
    const credential = oauth("codex-cli", { accountId: "account-1" });
    setCliAuthEpochTestDeps({
      readCodexCliCredentialsCached: () => credential,
    });

    const first = await resolveCliAuthBindingFingerprint({ provider: "codex-cli", config: {} });
    Object.assign(credential, { access: "access-b", refresh: "refresh-b" });
    const second = await resolveCliAuthBindingFingerprint({ provider: "codex-cli", config: {} });

    expect(second).toBe(first);
  });

  it("fingerprints the materialized value selected for a profile SecretRef", async () => {
    const profileId = "google-gemini-cli:work";
    const credential = {
      type: "api_key" as const,
      provider: "google-gemini-cli",
      keyRef: { source: "file" as const, provider: "vault", id: "/gemini/work" },
    };
    setCliAuthEpochTestDeps({
      ensureAuthProfileStore: () => createAuthProfileStoreFixture({ [profileId]: credential }),
    });
    const params = {
      provider: "google-gemini-cli",
      config: {},
      authProfileId: profileId,
      skipLocalCredential: true,
    };
    await expect(resolveCliAuthBindingFingerprint(params)).resolves.toBeUndefined();
    const bindingFor = (apiKey: string) =>
      resolveCliAuthBindingFingerprint({
        ...params,
        resolvedAuth: { apiKey, profileId, source: `profile:${profileId}`, mode: "api-key" },
      });
    const first = await bindingFor("materialized-a");
    const second = await bindingFor("materialized-b");

    expectEpochs(first, second);
    expect(second).not.toBe(first);
  });

  it("excludes unused ambient CLI auth from profile-owned bindings", async () => {
    let localAccess = "local-access-a";
    const profileStore: AuthProfileStore = createAuthProfileStoreFixture({
      "google-gemini-cli:work": oauth("google-gemini-cli", {
        access: "profile-access",
        refresh: "profile-refresh",
        accountId: "profile-account",
      }),
    });
    setCliAuthEpochTestDeps({
      readGeminiCliCredentialsCached: () =>
        oauth("google-gemini-cli", {
          access: localAccess,
          refresh: `refresh-${localAccess}`,
        }),
      ensureAuthProfileStore: () => profileStore,
    });

    const params = {
      provider: "google-gemini-cli",
      config: {},
      authProfileId: "google-gemini-cli:work",
      skipLocalCredential: true,
    };
    const first = await resolveCliAuthBindingFingerprint(params);
    localAccess = "local-access-b";
    const second = await resolveCliAuthBindingFingerprint(params);

    expect(second).toBe(first);
  });

  it("reads strict credential bindings off-thread and observes an in-process replacement", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const profileId = "fixture:binding";
      await state.writeAuthProfiles({
        version: 1,
        profiles: {
          [profileId]: { type: "api_key", provider: "fixture", key: "synthetic-first" },
        },
      });
      const params = {
        provider: "fixture",
        config: {},
        agentDir: state.agentDir(),
        authProfileId: profileId,
        skipLocalCredential: true,
      };
      const observation = observeHostDataSql();
      let first: string | undefined;
      try {
        first = await resolveCliAuthBindingFingerprint(params);
        expect(
          observation.queries.filter((sql) => /\bauth_profile_(?:store|state)\b/iu.test(sql)),
        ).toEqual([]);
      } finally {
        observation.restore();
      }
      expectEpochs(first);
      const updated = await updateAuthProfileStoreWithLock({
        agentDir: state.agentDir(),
        saveOptions: { filterExternalAuthProfiles: false, syncExternalCli: false },
        updater(store) {
          store.profiles[profileId] = {
            type: "api_key",
            provider: "fixture",
            key: "synthetic-replacement",
          };
          return true;
        },
      });
      expect(updated).not.toBeNull();
      const second = await resolveCliAuthBindingFingerprint(params);
      expectEpochs(second);
      expect(second).not.toBe(first);
    });
  });

  it("keeps identity-less oauth auth-profile epochs scoped to the profile id", async () => {
    const store: AuthProfileStore = createAuthProfileStoreFixture({
      "anthropic:work": oauth("anthropic", {}),
      "anthropic:personal": oauth("anthropic", {
        access: "access-b",
        refresh: "refresh-b",
        expires: 2,
      }),
    });
    useProfileStore(store);

    const first = await profileEpoch("anthropic:work");
    const second = await profileEpoch("anthropic:personal");

    expectEpochs(first, second);
    expect(second).not.toBe(first);
  });

  type Token = Extract<AuthProfileCredential, { type: "token" }>;
  it.each([
    [
      "ref-backed token rotation",
      {
        email: "user@example.com",
        tokenRef: { source: "env", provider: "default", id: "ANTHROPIC_TOKEN" },
      },
      { token: "token-b" },
      false,
    ],
    ["token-only replacement", {}, { token: "token-b" }, true],
    [
      "email identity replacement",
      { email: "user-a@example.com" },
      { email: "user-b@example.com" },
      true,
    ],
  ] satisfies Array<[string, Partial<Token>, Partial<Token>, boolean]>)(
    "tracks %s",
    async (_name, fields, replacement, changes) => {
      const profileId = "anthropic:work";
      const credential: Extract<AuthProfileCredential, { type: "token" }> = {
        type: "token",
        provider: "anthropic",
        token: "token-a",
        displayName: "Work",
        ...fields,
      };
      useProfileStore(createAuthProfileStoreFixture({ [profileId]: credential }));
      const first = await profileEpoch(profileId);
      Object.assign(credential, replacement);
      const second = await profileEpoch(profileId);
      expectEpochs(first, second);
      expect(second === first).toBe(!changes);
    },
  );

  it("mixes local codex and auth-profile state", async () => {
    const local = oauth("openai", {
      access: "local-access-a",
      refresh: "local-refresh-a",
      accountId: "acct-1",
    });
    const profile = oauth("openai", {
      access: "profile-access",
      refresh: "profile-refresh-a",
      email: "user-a@example.com",
    });
    setCliAuthEpochTestDeps({
      readCodexCliCredentialsCached: () => local,
      loadAuthProfileStoreForRuntime: () =>
        createAuthProfileStoreFixture({ "openai:work": profile }),
    });

    const resolve = () =>
      resolveCliAuthEpoch({
        provider: "codex-cli",
        authProfileId: "openai:work",
      });
    let previous = await resolve();
    expectEpochs(previous);
    for (const [credential, replacement, changes] of [
      [local, { access: "local-access-b" }, false],
      [local, { refresh: "local-refresh-b" }, false],
      [profile, { refresh: "profile-refresh-b" }, false],
      [local, { accountId: "acct-2" }, true],
      [profile, { email: "user-b@example.com" }, true],
    ] satisfies Array<[OAuthCredential, Partial<OAuthCredential>, boolean]>) {
      Object.assign(credential, replacement);
      const next = await resolve();
      expectEpochs(next);
      expect(next === previous).toBe(!changes);
      previous = next;
    }
  });

  function cliConfig(command: string): OpenClawConfig {
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [
        {
          id: "claude-cli",
          pluginId: "anthropic",
          config: { command },
          runtimeArtifact: {
            kind: "bundled-package-tree",
            packageName: "@fixture/claude-cli",
            entrypoint: "command",
            nativeExecutableNames: ["claude", "claude.exe"],
          },
        },
      ],
    });
    return {};
  }

  function copyNativeExecutable(filePath: string, source = process.execPath): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.copyFileSync(source, filePath);
    fs.chmodSync(filePath, 0o755);
  }

  function nativeUtility(name: "true" | "false"): string {
    for (const candidate of [`/usr/bin/${name}`, `/bin/${name}`]) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return process.execPath;
  }

  it("attests an opaque CLI backend owner without reading credential material", async () => {
    setCliAuthEpochTestDeps({
      ensureAuthProfileStore: () => ({ version: 1, profiles: {} }),
    });

    const dir = tempDir("openclaw-cli-owner-native-");
    const executable = path.join(dir, "claude");
    copyNativeExecutable(executable);
    const config = cliConfig(executable);
    const fingerprint = await ownerFingerprint(config);

    expectEpochs(fingerprint);
    await expect(
      ownerFingerprint(config, { runtimeOwnerId: "replacement-backend" }),
    ).resolves.toBeUndefined();
  });

  it.each(["PATH selection", "in-place replacement"])(
    "changes an opaque owner after %s",
    async (change) => {
      const dir = tempDir("openclaw-cli-owner-change-");
      const executable = path.join(dir, "first", "claude");
      const replacement =
        change === "PATH selection" ? path.join(dir, "second", "claude") : executable;
      copyNativeExecutable(executable, nativeUtility("true"));
      const config = cliConfig(change === "PATH selection" ? "claude" : executable);
      const fingerprint = (target: string) =>
        ownerFingerprint(config, { env: { PATH: path.dirname(target) } });
      const first = await fingerprint(executable);
      copyNativeExecutable(replacement, nativeUtility("false"));
      if (nativeUtility("true") === nativeUtility("false")) {
        fs.appendFileSync(replacement, "replacement");
      }
      const second = await fingerprint(replacement);
      expectEpochs(first, second);
      expect(second).not.toBe(first);
    },
  );

  it("refuses a cwd-relative executable as a persistent opaque owner", async () => {
    const dir = tempDir("openclaw-cli-owner-relative-");
    copyNativeExecutable(path.join(dir, "claude"), nativeUtility("true"));
    await expect(ownerFingerprint(cliConfig("./claude"), { cwd: dir })).resolves.toBeUndefined();
  });

  it("does not collapse a missing explicit CLI profile to ambient authority", async () => {
    setCliAuthEpochTestDeps({
      ensureAuthProfileStore: () => ({ version: 1, profiles: {} }),
    });

    await expect(
      ownerFingerprint(cliConfig(process.execPath), { authProfileId: "anthropic:missing" }),
    ).resolves.toBeUndefined();
  });
});
