import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveConfigForRead } from "../config/io.read-helpers.js";
import { setConfigResolutionFacts } from "../config/resolution-facts.js";
import { resolveGatewayCredentialsWithSecretInputs } from "./credentials-secret-inputs.js";
import {
  resolveGatewayCredentialsFromConfig,
  resolveGatewayCredentialsFromValues,
} from "./credentials.js";

type ResolveFromConfigInput = Parameters<typeof resolveGatewayCredentialsFromConfig>[0];
type GatewayConfig = NonNullable<OpenClawConfig["gateway"]>;
type ResolveFromConfigOverrides = Partial<Omit<ResolveFromConfigInput, "cfg">>;

const DEFAULT_GATEWAY_AUTH = { token: "config-token", password: "config-password" }; // pragma: allowlist secret
const DEFAULT_REMOTE_AUTH = { token: "remote-token", password: "remote-password" }; // pragma: allowlist secret
const DEFAULT_GATEWAY_ENV = {
  OPENCLAW_GATEWAY_TOKEN: "env-token",
  OPENCLAW_GATEWAY_PASSWORD: "env-password", // pragma: allowlist secret
} as NodeJS.ProcessEnv;
const EMPTY_GATEWAY_ENV = {} as NodeJS.ProcessEnv;

function envSecretRef(id: string) {
  return { source: "env", provider: "default", id } as const;
}

function gatewayConfig(gateway: GatewayConfig, secretProvider = false): OpenClawConfig {
  return {
    gateway,
    ...(secretProvider && { secrets: { providers: { default: { source: "env" as const } } } }),
  };
}

function authoredConfig(authored: string, env: NodeJS.ProcessEnv, mode?: "local") {
  const read = resolveConfigForRead(
    { gateway: { ...(mode && { mode }), auth: { mode: "token", token: authored } } },
    env,
  );
  const config = read.resolvedConfigRaw as OpenClawConfig;
  setConfigResolutionFacts(config, read.resolutionFacts);
  return config;
}

function resolveGatewayCredentialsFor(
  gateway: GatewayConfig,
  overrides: ResolveFromConfigOverrides = {},
  secretProvider = false,
) {
  return resolveGatewayCredentialsFromConfig({
    cfg: gatewayConfig(gateway, secretProvider),
    env: DEFAULT_GATEWAY_ENV,
    ...overrides,
  });
}

function resolveLocalGatewayCredentials(gateway: GatewayConfig) {
  return resolveGatewayCredentialsFor({ mode: "local", ...gateway }, { env: EMPTY_GATEWAY_ENV });
}

function resolveRemoteGatewayCredentials(
  remote: GatewayConfig["remote"] = {},
  overrides: ResolveFromConfigOverrides = {},
  auth: GatewayConfig["auth"] = {},
  secretProvider = true,
) {
  return resolveGatewayCredentialsFor(
    { mode: "remote", remote: { url: "wss://gateway.example", ...remote }, auth },
    { env: EMPTY_GATEWAY_ENV, ...overrides },
    secretProvider,
  );
}

const ENV_AUTH = { token: "env-token", password: "env-password" }; // pragma: allowlist secret
const NO_AUTH = { token: undefined, password: undefined };
const TRUSTED_PROXY_PASSWORD = "local-trusted-proxy-password"; // pragma: allowlist secret

function resolveLocalModeWithUnresolvedPassword(mode: "none" | "trusted-proxy") {
  return resolveGatewayCredentialsFor(
    {
      mode: "local",
      auth: { mode, password: envSecretRef("MISSING_GATEWAY_PASSWORD") },
    },
    { env: EMPTY_GATEWAY_ENV },
    true,
  );
}

describe("resolveGatewayCredentialsFromConfig", () => {
  const explicitAuth = { token: "explicit-token", password: "explicit-password" }; // pragma: allowlist secret
  it.each([
    ["prefers explicit auth", { explicitAuth }, explicitAuth],
    ["isolates CLI URL overrides", { urlOverride: "wss://example.com" }, {}],
    [
      "uses env auth for env URL overrides",
      { urlOverride: "wss://example.com", urlOverrideSource: "env" },
      ENV_AUTH,
    ],
  ] satisfies [string, ResolveFromConfigOverrides, object][])(
    "%s",
    (_name, overrides, expected) => {
      expect(resolveGatewayCredentialsFor({ auth: DEFAULT_GATEWAY_AUTH }, overrides)).toStrictEqual(
        expected,
      );
    },
  );

  it.each([
    ["keeps env ahead of remote fallback", DEFAULT_GATEWAY_ENV, ENV_AUTH],
    ["falls back to remote when local auth is missing", EMPTY_GATEWAY_ENV, DEFAULT_REMOTE_AUTH],
  ])("%s", (_name, env, expected) => {
    expect(
      resolveGatewayCredentialsFor(
        { mode: "local", auth: {}, remote: DEFAULT_REMOTE_AUTH },
        { env },
      ),
    ).toEqual(expected);
  });

  it.each(["token", "password"] as const)(
    "fails closed when local %s SecretRef is unresolved and remote fallback exists",
    (credential) => {
      expect(() =>
        resolveGatewayCredentialsFor(
          {
            mode: "local",
            auth: {
              mode: credential,
              [credential]: envSecretRef(`MISSING_LOCAL_${credential.toUpperCase()}`),
            },
            remote: { [credential]: `remote-${credential}` },
          },
          { env: EMPTY_GATEWAY_ENV },
          true,
        ),
      ).toThrow(`gateway.auth.${credential}`);
    },
  );

  it("fails closed on env-template local tokens in the synchronous resolver", () => {
    expect(() =>
      resolveGatewayCredentialsFor(
        {
          mode: "local",
          auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" },
        },
        { env: { OPENCLAW_GATEWAY_TOKEN: "env-token" } },
      ),
    ).toThrow("gateway.auth.token");
  });

  it("ignores unresolved local password ref when local auth mode is none", () => {
    const resolved = resolveLocalModeWithUnresolvedPassword("none");
    expect(resolved).toEqual(NO_AUTH);
  });

  it("throws when trusted-proxy local password SecretRef cannot resolve", () => {
    expect(() => resolveLocalModeWithUnresolvedPassword("trusted-proxy")).toThrow(
      "gateway.auth.password",
    );
  });

  it.each([undefined, TRUSTED_PROXY_PASSWORD])(
    "uses only local trusted-proxy password (%s)",
    (password) => {
      expect(
        resolveLocalGatewayCredentials({
          auth: { mode: "trusted-proxy", password },
          ...(password === undefined && { remote: { password: DEFAULT_REMOTE_AUTH.password } }),
        }),
      ).toEqual({ token: undefined, password });
    },
  );

  it("supports remote-only token fallback for strict remote override call sites", () => {
    const resolved = resolveRemoteGatewayCredentials(
      {},
      {
        env: { OPENCLAW_GATEWAY_TOKEN: "env-token" },
        remoteTokenFallback: "remote-only",
      },
      { token: "local-token" },
      false,
    );
    expect(resolved.token).toBeUndefined();
  });

  it.each(["token", "password"] as const)(
    "throws when remote %s auth relies on an unresolved SecretRef",
    (credential) => {
      expect(() =>
        resolveRemoteGatewayCredentials(
          { [credential]: envSecretRef(`MISSING_REMOTE_${credential.toUpperCase()}`) },
          credential === "token"
            ? { remoteTokenFallback: "remote-only" }
            : { remotePasswordFallback: "remote-only" }, // pragma: allowlist secret
        ),
      ).toThrow(`gateway.remote.${credential}`);
    },
  );

  const missingLocalToken = { mode: "token", token: envSecretRef("MISSING_LOCAL_TOKEN") } as const;

  it("ignores unresolved local token ref in remote-only mode when local auth mode is token", () => {
    const resolved = resolveRemoteGatewayCredentials(
      {},
      {
        remoteTokenFallback: "remote-only",
        remotePasswordFallback: "remote-only", // pragma: allowlist secret
      },
      missingLocalToken,
    );
    expect(resolved).toEqual(NO_AUTH);
  });

  it("throws for unresolved local token ref in remote mode when local fallback is enabled", () => {
    expect(() =>
      resolveRemoteGatewayCredentials(
        {},
        {
          remoteTokenFallback: "remote-env-local",
          remotePasswordFallback: "remote-only", // pragma: allowlist secret
        },
        missingLocalToken,
      ),
    ).toThrow("gateway.auth.token");
  });

  it("uses remote password when remote token ref is unresolved", () => {
    const resolved = resolveRemoteGatewayCredentials({
      token: envSecretRef("MISSING_REMOTE_TOKEN"),
      password: "remote-password", // pragma: allowlist secret
    });
    expect(resolved).toEqual({
      token: undefined,
      password: "remote-password", // pragma: allowlist secret
    });
  });

  it.each([
    { name: "unresolved bare shorthand", authored: "$MISSING", env: {}, expected: null },
    {
      name: "substituted braced-looking literal",
      authored: "${SOURCE}",
      env: { SOURCE: "${OTHER}" },
      expected: "${OTHER}",
    },
  ])(
    "classifies gateway credentials from authored provenance: $name",
    ({ authored, env, expected }) => {
      const cfg = authoredConfig(authored, env);
      const resolve = () => resolveGatewayCredentialsFromConfig({ cfg, env: EMPTY_GATEWAY_ENV });

      if (expected === null) {
        expect(resolve).toThrow("gateway.auth.token");
        return;
      }
      expect(resolve()).toEqual({
        token: expected,
        password: undefined,
      });
    },
  );
});

describe("resolveGatewayCredentialsWithSecretInputs", () => {
  type Options = Partial<
    Omit<Parameters<typeof resolveGatewayCredentialsWithSecretInputs>[0], "config" | "env">
  >;
  const localAuth = { token: "local-token", password: "local-password" }; // pragma: allowlist secret
  const remoteConfig = (
    mode: "local" | "remote" = "remote",
    remote: GatewayConfig["remote"] = DEFAULT_REMOTE_AUTH,
  ) => gatewayConfig({ mode, auth: localAuth, remote: { url: "wss://remote.example", ...remote } });
  const remoteFirst: Options = {
    remoteTokenPrecedence: "remote-first",
    remotePasswordPrecedence: "remote-first", // pragma: allowlist secret
  };
  it.each([
    [
      "local env-first",
      gatewayConfig({ mode: "local", auth: DEFAULT_GATEWAY_AUTH }),
      { localPrecedence: "env-first" },
      ENV_AUTH,
    ],
    ["remote defaults", remoteConfig(), {}, { token: "remote-token", password: "env-password" }], // pragma: allowlist secret
    [
      "remote precedence overrides",
      remoteConfig(),
      { ...remoteFirst, remoteTokenPrecedence: "env-first" },
      { token: "env-token", password: "remote-password" },
    ], // pragma: allowlist secret
    [
      "remote-only fallback",
      remoteConfig("remote", { token: "remote-token" }),
      { remoteTokenFallback: "remote-only", remotePasswordFallback: "remote-only" },
      { token: "remote-token", password: undefined },
    ],
    [
      "remote mode override",
      remoteConfig("local"),
      { ...remoteFirst, modeOverride: "remote" },
      DEFAULT_REMOTE_AUTH,
    ],
  ] satisfies [string, OpenClawConfig, Options, { token?: string; password?: string }][])(
    "%s",
    async (_name, config, options, expected) => {
      await expect(
        resolveGatewayCredentialsWithSecretInputs({ config, env: DEFAULT_GATEWAY_ENV, ...options }),
      ).resolves.toEqual(expected);
    },
  );

  it.each([
    ["pending bare shorthand", "$SOURCE", {}, { SOURCE: "${OTHER}" }],
    ["substituted template-looking literal", "${SOURCE}", { SOURCE: "${OTHER}" }, {}],
  ] satisfies [string, string, NodeJS.ProcessEnv, NodeJS.ProcessEnv][])(
    "materializes authored provenance atomically: %s",
    async (_name, authored, readEnv, runtimeEnv) => {
      await expect(
        resolveGatewayCredentialsWithSecretInputs({
          config: authoredConfig(authored, readEnv, "local"),
          env: runtimeEnv,
        }),
      ).resolves.toEqual({ token: "${OTHER}", password: undefined });
    },
  );

  it.each([
    ["token", true],
    ["password", true],
    ["token", false],
    ["password", false],
  ] as const)(
    "resolves config-first %s only when available (%s)",
    async (credential, available) => {
      const id = `${available ? "CONFIG_FIRST" : "MISSING_CONFIG_FIRST"}_${credential.toUpperCase()}`;
      const ref = envSecretRef(id);
      const config = gatewayConfig(
        {
          mode: "local",
          auth: credential === "token" ? { token: ref } : { mode: "password", password: ref },
        },
        true,
      );
      const result = resolveGatewayCredentialsWithSecretInputs({
        config,
        env: {
          [`OPENCLAW_GATEWAY_${credential.toUpperCase()}`]: `env-${credential}`,
          ...(available && { [id]: `config-first-${credential}` }),
        },
      });
      if (available) {
        await expect(result).resolves.toEqual({
          ...NO_AUTH,
          [credential]: `config-first-${credential}`,
        });
      } else {
        await expect(result).rejects.toThrow(`gateway.auth.${credential}`);
      }
    },
  );
});

describe("resolveGatewayCredentialsFromValues", () => {
  it.each([
    ["prefers config", DEFAULT_GATEWAY_AUTH, DEFAULT_GATEWAY_ENV, DEFAULT_GATEWAY_AUTH],
    [
      "rejects unresolved placeholders",
      { token: "${OPENCLAW_GATEWAY_TOKEN}", password: "${OPENCLAW_GATEWAY_PASSWORD}" },
      EMPTY_GATEWAY_ENV,
      NO_AUTH,
    ],
  ])("%s", (_name, config, env, expected) => {
    expect(
      resolveGatewayCredentialsFromValues({
        configToken: config.token,
        configPassword: config.password,
        env,
        tokenPrecedence: "config-first",
        passwordPrecedence: "config-first", // pragma: allowlist secret
      }),
    ).toEqual(expected);
  });
});
