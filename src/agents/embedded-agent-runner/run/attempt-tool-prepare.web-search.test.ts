import path from "node:path";
import { afterAll, afterEach, assert, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.entry.js";
import { SessionWorkStartInvalidatedError } from "../../../config/sessions/work-start-error.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "../../../plugin-sdk/plugin-test-contracts.js";
import { withServer } from "../../../plugin-sdk/test-env.js";
import { loadPluginManifestRegistryCore } from "../../../plugins/manifest-registry.js";
import { withPluginRuntimeRegistryScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { resolveBundledExplicitWebSearchProvidersFromPublicArtifacts } from "../../../plugins/web-provider-public-artifacts.explicit.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { createWebSearchTestProvider } from "../../../test-utils/web-provider-runtime.test-helpers.js";
import {
  createAdmittedRunOperatorAuthority,
  prepareSystemAgentRunAdmission,
} from "../../admitted-run-context.js";
import { wrapToolWithBeforeToolCallHook } from "../../agent-tools.before-tool-call.js";
import type { AnyAgentTool } from "../../agent-tools.types.js";
import { persistAuthProfileBatch } from "../../auth-profiles/upsert-with-lock.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { createWebSearchTool } from "../../tools/web-search.js";
import { createAttemptSetupFixture } from "./attempt-setup.test-support.js";
import { getHoisted, resetEmbeddedAttemptHarness } from "./attempt-spawn-workspace.test-support.js";
import { prepareEmbeddedAttemptToolBase } from "./attempt-tool-prepare.js";
import type { EmbeddedRunAttemptInternalParams } from "./internal-params.js";

const { createOpenClawCodingToolsMock: codingTools } = getHoisted();
beforeEach(() => resetEmbeddedAttemptHarness());
afterEach(() => vi.restoreAllMocks());

async function createFixture(
  overrides: Partial<EmbeddedRunAttemptInternalParams> = {},
  authority?: Parameters<typeof prepareSystemAgentRunAdmission>[5],
  runAbortController = new AbortController(),
) {
  await using resources = new AsyncDisposableStack();
  const config = overrides.config ?? { tools: { codeMode: false, toolSearch: { enabled: false } } };
  const admission = prepareSystemAgentRunAdmission(
    config,
    overrides.runId ?? "attribution",
    "main",
    "test",
    undefined,
    authority,
  );
  resources.defer(() => admission.close());
  const provider = overrides.provider ?? "anthropic";
  const native = provider === "openai";
  const attempt = {
    config,
    runId: "attribution",
    sessionId: "attribution",
    sessionKey: "agent:main:attribution",
    modelId: "test-model",
    provider,
    model: makeProviderModelFixture({
      id: "test-model",
      provider,
      api: native ? "openai-responses" : "anthropic-messages",
      baseUrl: native ? "https://api.openai.com/v1" : "https://api.anthropic.com",
    }),
    authProfileStore: { version: 1, profiles: {} },
    admittedRunContext: await admission.admit("embedded"),
    ...overrides,
  } as EmbeddedRunAttemptInternalParams;
  const result = await prepareEmbeddedAttemptToolBase({
    attempt,
    agentDir: attempt.agentDir ?? "/tmp/attribution-agent",
    setup: createAttemptSetupFixture({ sandboxSessionKey: attempt.sessionKey! }),
    markCoreToolStage: () => {},
    onYield: async () => {},
    runAbortController,
    runTrace: { traceId: "1234567890abcdef1234567890abcdef" },
    skillUsagePaths: [],
    skillsSnapshot: undefined,
    codeModeSkills: [],
    toolSearchCatalogExecutor: async () => ({ content: [], details: {} }),
  });
  resources.defer(() => result.toolSurfaceRuntime.cleanup());
  resources.defer(() => result.releaseTools("test-complete"));
  const lifetime = resources.move();
  return { attempt, result, admission, [Symbol.asyncDispose]: () => lifetime.disposeAsync() };
}

let state: OpenClawTestState;
let storePath: string;
const dashboardSessionKey = "agent:main:dashboard:search-guidance";
const childSessionKey = "agent:main:dashboard:search-denied-child";

beforeAll(async () => {
  state = await createOpenClawTestState({
    label: "prepared-search-guidance",
    scenario: "minimal",
  });
  storePath = path.join(state.sessionsDir(), "sessions.json");
  await replaceSessionEntry(
    { storePath, sessionKey: dashboardSessionKey },
    { sessionId: "search-guidance", updatedAt: 1 },
  );
  await replaceSessionEntry(
    { storePath, sessionKey: childSessionKey },
    {
      sessionId: "search-denied-child",
      updatedAt: 1,
      spawnDepth: 1,
      spawnedBy: dashboardSessionKey,
      inheritedToolPolicyVersion: 1,
      inheritedToolDeny: ["web_search"],
    },
  );
});
afterAll(async () => await state?.cleanup());
it.each(
  (["built-in", "catalog"] as const).flatMap((surface) =>
    (["retired source", "capture invalidated"] as const).map((outcome) => ({ surface, outcome })),
  ),
)(
  "aborts $surface tools before parameter preparation or effects ($outcome)",
  async ({ surface, outcome }) => {
    const authority = createAdmittedRunOperatorAuthority({
      profileId: "reviewer-caller",
      scopes: [],
      assertCurrent() {},
    });
    const skillsSnapshot = {
      prompt: "",
      skills: [
        {
          name: "autoreview",
          source: { filePath: "/managed/autoreview/SKILL.md", fileHost: "gateway" as const },
        },
      ],
    };
    const entered = createDeferred();
    const baseline = createDeferred();
    const runAbortController = new AbortController();
    const failure = new SessionWorkStartInvalidatedError("capture invalidated");
    const prepare = vi.fn(async (params: unknown) => params);
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const fixtureTool: AnyAgentTool = {
      ...createStubTool("write"),
      prepareBeforeToolCallParams: prepare,
      execute,
    };
    let pending: ReturnType<AnyAgentTool["execute"]> | undefined;
    // Built-ins must use the factory-forwarded callback, not the catalog hook path.
    codingTools.mockImplementation((options) =>
      surface === "built-in"
        ? [
            wrapToolWithBeforeToolCallHook(fixtureTool, {
              awaitSessionDiffBaseline: options?.awaitSessionDiffBaseline,
            }),
          ]
        : [],
    );
    await using fixture = await createFixture(
      {
        skillsSnapshot,
        awaitSessionDiffBaseline: async () => {
          entered.resolve();
          await baseline.promise;
        },
      },
      authority,
      runAbortController,
    );
    const { result, admission } = fixture;
    try {
      const builtInOptions = codingTools.mock.calls[0]?.[0];
      expect(builtInOptions?.pluginExecutionAuthority).toBe(authority);
      expect(builtInOptions?.pluginExecutionSkillsSnapshot).toBe(skillsSnapshot);
      expect(() => builtInOptions?.assertInvocationCurrent?.()).not.toThrow();
      expect(builtInOptions?.awaitSessionDiffBaseline).toBe(
        result.toolHookContext.awaitSessionDiffBaseline,
      );
      const tool =
        surface === "built-in"
          ? result.toolsRaw[0]
          : wrapToolWithBeforeToolCallHook(fixtureTool, result.toolHookContext);
      assert(tool);
      pending = tool.execute(`${surface}-attribution`, {});
      await awaitGateBeforeSettlement(
        entered.promise,
        pending,
        `${surface} tool bypassed attribution`,
      );
      expect([prepare.mock.calls, execute.mock.calls]).toEqual([[], []]);
      if (outcome === "retired source") {
        admission.close();
        baseline.resolve();
      } else {
        baseline.reject(failure);
      }
      await expect(pending).rejects.toThrow();
      expect(runAbortController.signal.aborted).toBe(true);
      expect(() => builtInOptions?.assertInvocationCurrent?.()).toThrow();
      if (outcome === "capture invalidated") {
        expect(runAbortController.signal.reason).toBe(failure);
      }
      expect([prepare.mock.calls, execute.mock.calls]).toEqual([[], []]);
    } finally {
      baseline.resolve();
      await pending?.catch(() => undefined);
    }
  },
);

it.each([
  { name: "ordinary unconfigured", expected: true },
  { name: "dashboard unconfigured", dashboard: true, expected: true },
  { name: "configured", configured: true, expected: false },
  { name: "policy denied", deny: true, expected: false },
  { name: "inherited dashboard policy denied", inheritedDeny: true, expected: false },
  { name: "globally disabled", disabled: true, expected: false },
  { name: "session disabled", sessionDisabled: true, expected: false },
  { name: "native OpenAI", native: true, expected: false },
])("keeps the actual callback truthful for $name and clears it on rebuild", async (scenario) => {
  const config: OpenClawConfig = {
    session: { store: storePath },
    tools: {
      codeMode: false,
      toolSearch: { enabled: false },
      ...(scenario.deny ? { deny: ["web_search"] } : {}),
      ...(scenario.disabled ? { web: { search: { enabled: false } } } : {}),
    },
  };
  codingTools.mockImplementation((options) => {
    options?.onWebSearchConfiguration?.(scenario.configured === true);
    return [];
  });
  // Invoke the real callback after dashboard metadata preparation, without a Gateway projection.
  await using fixture = await createFixture({
    config,
    runId: "search-guidance",
    sessionId: scenario.inheritedDeny ? "search-denied-child" : "search-guidance",
    sessionKey: scenario.inheritedDeny
      ? childSessionKey
      : scenario.dashboard
        ? dashboardSessionKey
        : "agent:main:search-guidance",
    agentDir: state.agentDir(),
    provider: scenario.native ? "openai" : "anthropic",
    toolOverrides: scenario.sessionDisabled ? { webSearch: false } : undefined,
  });
  const { result, attempt } = fixture;
  expect(codingTools).toHaveBeenCalledTimes(1);
  expect(result.webSearchUnconfigured).toBe(scenario.expected);
  // A disabled factory never reports configuration, so rebuild must clear the old fact.
  codingTools.mockImplementation(() => []);
  attempt.toolOverrides = { webSearch: false };
  await result.refreshPermissionMode(null, () => {});
  expect(result.webSearchUnconfigured).toBe(false);
  expect(codingTools).toHaveBeenCalledTimes(2);
});

it.each(["clawrouter", "other-provider"])(
  "shares the attempt account only with its matching auth owner (%s)",
  async (authProviderId) => {
    const config: OpenClawConfig = {
      tools: {
        codeMode: false,
        toolSearch: { enabled: false },
        web: { search: { provider: "clawrouter-tavily" } },
      },
      plugins: { entries: { clawrouter: { enabled: true } } },
    };
    const registry = createPluginRegistryFixture(config);
    registerVirtualTestPlugin({
      ...registry,
      id: "clawrouter",
      name: "ClawRouter",
      contracts: { webSearchProviders: ["clawrouter-tavily"] },
      register(api) {
        api.registerWebSearchProvider(
          createWebSearchTestProvider({
            id: "clawrouter-tavily",
            pluginId: "clawrouter",
            credentialPath: "",
            requiresCredential: false,
            authProviderId,
            createTool: (ctx) => ({
              description: "Selected account fixture",
              parameters: {},
              execute: async () => ({
                results: [
                  {
                    title: ctx.authProfile?.profileId ?? "independent account",
                    url: ctx.authProfile?.baseUrl ?? "https://independent.example",
                  },
                ],
              }),
            }),
          }),
        );
      },
    });
    // Only unrelated tool construction is isolated; execute the real core web tool and registry.
    codingTools.mockImplementation((options) => {
      const tool = createWebSearchTool(options);
      return tool ? [tool] : [];
    });
    await withPluginRuntimeRegistryScope(registry.registry.registry, async () => {
      await using fixture = await createFixture({
        config,
        agentDir: state.agentDir(),
        provider: "clawrouter",
        authProfileId: "clawrouter:automation-fixture",
        authProfileIdSource: "user",
        model: makeProviderModelFixture({
          id: "test-model",
          api: "openai-responses",
          provider: "clawrouter",
          baseUrl: "https://selected-router.example/v1",
        }),
      });
      const tool = fixture.result.toolsRaw.find((entry) => entry.name === "web_search");
      assert(tool);
      await expect(tool.execute("selected-account", { query: "synthetic" })).resolves.toMatchObject(
        {
          details: {
            results: [
              {
                title: expect.stringContaining(
                  authProviderId === "clawrouter"
                    ? "clawrouter:automation-fixture"
                    : "independent account",
                ),
                url:
                  authProviderId === "clawrouter"
                    ? "https://selected-router.example/v1"
                    : "https://independent.example/",
              },
            ],
          },
        },
      );
    });
  },
);

it.each([
  {
    api: "anthropic-messages" as const,
    route: "/v1/native/anthropic",
    modelId: "anthropic/claude-fixture",
  },
  {
    api: "google-generative-ai" as const,
    route: "/v1/native/google/v1beta",
    modelId: "google/gemini-fixture",
  },
])(
  "searches with the selected attempt account on the $api native route",
  async ({ api, route, modelId }) => {
    const native = resolveBundledExplicitWebSearchProvidersFromPublicArtifacts({
      onlyPluginIds: ["clawrouter"],
      manifestRecords: loadPluginManifestRegistryCore().plugins,
    })?.find((provider) => provider.id === "clawrouter-tavily");
    assert(native);
    const seen: Array<{ path: string | undefined; auth: string | undefined }> = [];
    await withServer(
      (request, response) => {
        seen.push({ path: request.url, auth: request.headers.authorization });
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify(
            request.url === "/v1/catalog"
              ? {
                  version: "clawrouter.client-catalog.v1",
                  providers: [
                    {
                      id: "tavily",
                      allowed: true,
                      executable: true,
                      nativeBaseUrl: "/v1/native/tavily",
                      routes: [
                        {
                          path: "/search",
                          methods: ["POST"],
                          requestFormat: "tavily.search",
                          responseFormat: "tavily.search",
                        },
                      ],
                      models: [
                        { id: "tavily/search", upstream: "search", capabilities: ["web.search"] },
                      ],
                    },
                  ],
                }
              : {
                  results: [
                    {
                      title: "Native source",
                      content: "Evidence",
                      url: "https://example.com/native",
                    },
                  ],
                },
          ),
        );
      },
      async (origin) => {
        const profileId = "clawrouter:native-attempt-fixture";
        await persistAuthProfileBatch({
          profiles: [
            {
              profileId: "clawrouter:default-fixture",
              credential: {
                type: "api_key",
                provider: "clawrouter",
                key: "synthetic-default-native-key",
              },
            },
            {
              profileId,
              credential: {
                type: "api_key",
                provider: "clawrouter",
                key: "synthetic-selected-native-key",
              },
            },
          ],
          order: { clawrouter: ["clawrouter:default-fixture", profileId] },
        });
        const config: OpenClawConfig = {
          tools: {
            codeMode: false,
            toolSearch: { enabled: false },
            web: { search: { provider: "clawrouter-tavily" } },
          },
          plugins: { entries: { clawrouter: { enabled: true } } },
          models: {
            providers: {
              clawrouter: {
                baseUrl: origin + "/v1",
                models: [],
                request: { allowPrivateNetwork: true },
              },
            },
          },
          auth: {
            profiles: {
              [profileId]: { provider: "clawrouter", mode: "api_key" },
              "clawrouter:default-fixture": { provider: "clawrouter", mode: "api_key" },
            },
            order: { clawrouter: ["clawrouter:default-fixture", profileId] },
          },
        };
        const registry = createPluginRegistryFixture(config);
        registerVirtualTestPlugin({
          ...registry,
          id: "clawrouter",
          name: "ClawRouter",
          contracts: { webSearchProviders: ["clawrouter-tavily"] },
          register(plugin) {
            plugin.registerWebSearchProvider(native);
          },
        });
        // Isolate unrelated coding tools, not preparation, provider selection, auth, or transport.
        codingTools.mockImplementation((options) => {
          const tool = createWebSearchTool(options);
          return tool ? [tool] : [];
        });
        for (const key of [
          "CLAWROUTER_API_KEY",
          "HTTP_PROXY",
          "HTTPS_PROXY",
          "ALL_PROXY",
          "http_proxy",
          "https_proxy",
          "all_proxy",
        ]) {
          vi.stubEnv(key, "");
        }
        try {
          await withPluginRuntimeRegistryScope(registry.registry.registry, async () => {
            await using fixture = await createFixture({
              config,
              agentDir: state.agentDir(),
              provider: "clawrouter",
              modelId,
              authProfileId: profileId,
              authProfileIdSource: "user",
              model: makeProviderModelFixture({
                id: modelId,
                provider: "clawrouter",
                api,
                baseUrl: origin + route,
              }),
            });
            const tool = fixture.result.toolsRaw.find((entry) => entry.name === "web_search");
            assert(tool);
            await expect(
              tool.execute("native-attempt-search", { query: "native citation" }),
            ).resolves.toMatchObject({
              details: {
                provider: "clawrouter-tavily",
                results: [{ url: "https://example.com/native" }],
              },
            });
          });
        } finally {
          vi.unstubAllEnvs();
        }
        expect(seen).toEqual([
          { path: "/v1/catalog", auth: "Bearer synthetic-selected-native-key" },
          { path: "/v1/native/tavily/search", auth: "Bearer synthetic-selected-native-key" },
        ]);
      },
    );
  },
);
