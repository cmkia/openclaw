import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { gatewayAuthTokenCommand } from "./gateway-auth-token.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  resolveCommandSecretRefsViaGateway: vi.fn(),
  isTerminalInteractive: vi.fn(() => true),
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

vi.mock("../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: mocks.resolveCommandSecretRefsViaGateway,
}));

vi.mock("../cli/terminal-interactivity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/terminal-interactivity.js")>()),
  isTerminalInteractive: mocks.isTerminalInteractive,
}));

afterEach(() => vi.unstubAllEnvs());

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
  writeJson: vi.fn(),
  writeStdout: vi.fn(),
};

const tokenRef = { source: "env", provider: "default", id: "GATEWAY_TOKEN" } as const;
const tokenConfig = { gateway: { auth: { mode: "token", token: tokenRef } } } as const;
function setConfig(sourceConfig: OpenClawConfig) {
  mocks.readConfigFileSnapshot.mockResolvedValue({ valid: true, sourceConfig, config: {} });
}
function setResolvedConfig(resolvedConfig: OpenClawConfig) {
  mocks.resolveCommandSecretRefsViaGateway.mockResolvedValue({
    resolvedConfig,
    diagnostics: [],
    targetStatesByPath: { "gateway.auth.token": "resolved_gateway" },
    hadUnresolvedTargets: false,
  });
}
async function expectRefusal(message: string, env: NodeJS.ProcessEnv = {}) {
  Object.entries(env).forEach(([name, value]) => vi.stubEnv(name, value));
  await expect(gatewayAuthTokenCommand(runtime)).rejects.toThrow(message);
  expect(mocks.resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
  expect(runtime.writeStdout).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", undefined);
  vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", undefined);
  setConfig(tokenConfig);
  setResolvedConfig({ gateway: { auth: { mode: "token", token: "resolved-value" } } });
});

it("prints only the resolved token for an interactive operator", async () => {
  vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "environment-value");

  await gatewayAuthTokenCommand(runtime);

  expect(mocks.resolveCommandSecretRefsViaGateway).toHaveBeenCalledWith({
    config: tokenConfig,
    commandName: "gateway auth-token",
    targetIds: new Set(["gateway.auth.token"]),
    mode: "enforce_resolved",
    allowedPaths: new Set(["gateway.auth.token"]),
  });
  expect(runtime.writeStdout).toHaveBeenCalledWith("resolved-value\n");
  expect(runtime.log).not.toHaveBeenCalled();
  expect(runtime.error).not.toHaveBeenCalled();
});

it("refuses non-interactive output before reading config or secrets", async () => {
  mocks.isTerminalInteractive.mockReturnValueOnce(false);
  await expect(gatewayAuthTokenCommand(runtime)).rejects.toThrow("outside an interactive terminal");

  expect(mocks.readConfigFileSnapshot).not.toHaveBeenCalled();
  expect(mocks.resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
  expect(runtime.writeStdout).not.toHaveBeenCalled();
});

it.each<{ setup: () => void; message: string }>([
  {
    setup: () =>
      setResolvedConfig({ gateway: { auth: { mode: "token", token: "__OPENCLAW_REDACTED__" } } }),
    message: "openclaw doctor --fix",
  },
  {
    setup: () => {
      const config: OpenClawConfig = { gateway: { auth: { mode: "token" } } };
      setConfig(config);
      setResolvedConfig(config);
    },
    message: "openclaw doctor --generate-gateway-token",
  },
  {
    setup: () => {
      mocks.resolveCommandSecretRefsViaGateway.mockRejectedValue(
        new Error("gateway.auth.token SecretRef is unresolved"),
      );
      vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "ambient-fallback");
    },
    message: "gateway.auth.token SecretRef is unresolved",
  },
])("does not reveal invalid or missing credentials: $message", async ({ setup, message }) => {
  setup();
  await expect(gatewayAuthTokenCommand(runtime)).rejects.toThrow(message);
  expect(runtime.writeStdout).not.toHaveBeenCalled();
});

it.each<{ config: OpenClawConfig; message: string; env?: NodeJS.ProcessEnv }>([
  {
    config: {
      gateway: {
        auth: { mode: "trusted-proxy", token: "stale-token", password: "active-password" },
      },
    },
    message: "Gateway auth mode is trusted-proxy",
  },
  {
    config: { gateway: { auth: { token: "candidate-token", password: "candidate-password" } } },
    message: "gateway.auth.mode",
  },
  {
    config: { gateway: { auth: { token: "inactive-token" } } },
    message: "Gateway auth mode is password",
    env: { OPENCLAW_GATEWAY_PASSWORD: "active-password" },
  },
  {
    config: { gateway: { mode: "remote", auth: { mode: "token", token: "stale-local-token" } } },
    message: "must run on the Gateway host",
  },
])("refuses credential disclosure: $message", async ({ config, message, env }) => {
  setConfig(config);
  await expectRefusal(message, env);
});
