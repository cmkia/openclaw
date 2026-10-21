import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { persistAuthProfileBatch } from "../agents/auth-profiles/upsert-with-lock.js";
import { createWebSearchTool } from "../agents/tools/web-search.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  acquireCronInferenceAuthorization,
  captureCronInferenceBinding,
} from "../cron/inference-binding.runtime.js";
import { loadCronJobsStore, saveCronJobsStore } from "../cron/store.js";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "../plugin-sdk/plugin-test-contracts.js";
import { withServer } from "../plugin-sdk/test-env.js";
import { loadPluginManifestRegistryCore } from "../plugins/manifest-registry.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { resolveBundledExplicitWebSearchProvidersFromPublicArtifacts } from "../plugins/web-provider-public-artifacts.explicit.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createWebSearchTestProvider } from "../test-utils/web-provider-runtime.test-helpers.js";

beforeEach(() => {
  vi.stubEnv("CLAWROUTER_API_KEY", "");
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ]) {
    vi.stubEnv(key, "");
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
});

it("keeps a persisted automation profile and endpoint when another ClawRouter profile is default", async () => {
  const manifestRecords = loadPluginManifestRegistryCore().plugins;
  const native = resolveBundledExplicitWebSearchProvidersFromPublicArtifacts({
    onlyPluginIds: ["clawrouter"],
    manifestRecords,
  })?.find((provider) => provider.id === "clawrouter-tavily");
  expect(native).toBeDefined();
  const paths: string[] = [];
  const authorization: Array<string | undefined> = [];
  let denied = false;
  await withServer(
    (request, response) => {
      paths.push(request.url!);
      authorization.push(request.headers.authorization);
      response.setHeader("content-type", "application/json");
      if (request.url === "/v1/catalog") {
        response.end(
          JSON.stringify({
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
                models: [{ id: "tavily/search", upstream: "search", capabilities: ["web.search"] }],
              },
            ],
          }),
        );
      } else {
        response.statusCode = denied ? 402 : 200;
        response.end(
          JSON.stringify(
            denied
              ? { error: { message: "budget denied" } }
              : {
                  results: [
                    { title: "source", content: "citation", url: "https://example.com/citation" },
                  ],
                },
          ),
        );
      }
    },
    async (origin) => {
      await withOpenClawTestState({ label: "clawrouter-native-tavily-caller" }, async (state) => {
        const agentDir = state.agentDir();
        const authStore = {
          version: 1,
          order: { clawrouter: ["clawrouter:default-fixture", "clawrouter:automation-fixture"] },
          profiles: {
            "clawrouter:default-fixture": {
              type: "api_key" as const,
              provider: "clawrouter",
              key: "synthetic-default-router-key",
            },
            "clawrouter:automation-fixture": {
              type: "api_key" as const,
              provider: "clawrouter",
              key: "synthetic-router-key",
            },
          },
        };
        // Persist both accounts, with the other account first in the normal selection order.
        await persistAuthProfileBatch({
          profiles: Object.entries(authStore.profiles).map(([profileId, credential]) => ({
            profileId,
            credential,
          })),
          order: authStore.order,
        });
        const config: OpenClawConfig = {
          auth: {
            profiles: {
              "clawrouter:default-fixture": { provider: "clawrouter", mode: "api_key" },
              "clawrouter:automation-fixture": { provider: "clawrouter", mode: "api_key" },
            },
            order: authStore.order,
          },
          agents: {
            entries: { main: { agentDir } },
            defaults: { model: "clawrouter/fixture-model" },
          },
          tools: { web: { search: { provider: "clawrouter-tavily" } } },
          models: {
            providers: {
              clawrouter: {
                baseUrl: origin + "/v1",
                models: [],
                request: { allowPrivateNetwork: true },
              },
            },
          },
          plugins: { entries: { clawrouter: { enabled: true } } },
        };
        const fixture = createPluginRegistryFixture(config);
        const alternate = vi.fn(async () => ({ results: [] }));
        registerVirtualTestPlugin({
          ...fixture,
          id: "clawrouter",
          name: "ClawRouter",
          contracts: { webSearchProviders: ["clawrouter-tavily"] },
          register(api) {
            api.registerWebSearchProvider(native!);
          },
        });
        registerVirtualTestPlugin({
          ...fixture,
          id: "fixture-alternate",
          name: "Alternate",
          contracts: { webSearchProviders: ["alternate"] },
          register(api) {
            api.registerWebSearchProvider(
              createWebSearchTestProvider({
                id: "alternate",
                pluginId: "fixture-alternate",
                credentialPath: "",
                requiresCredential: false,
                createTool: () => ({
                  description: "alternate",
                  parameters: {},
                  execute: alternate,
                }),
              }),
            );
          },
        });
        // Capture and reload the scheduler-owned binding, not a provider-entry API-key alias.
        const binding = await captureCronInferenceBinding({
          cfg: config,
          agentId: "main",
          model: "clawrouter/fixture-model@clawrouter:automation-fixture",
        });
        expect(binding?.profileId).toBe("clawrouter:automation-fixture");
        if (!binding) {
          throw new Error("Missing automation binding");
        }
        const storePath = state.statePath("cron", "jobs.json");
        await saveCronJobsStore(storePath, {
          version: 1,
          jobs: [
            {
              id: "native-tavily",
              name: "Native Tavily",
              enabled: true,
              createdAtMs: 1,
              updatedAtMs: 1,
              schedule: { kind: "every", everyMs: 60_000 },
              sessionTarget: "isolated",
              wakeMode: "now",
              payload: { kind: "agentTurn", message: "synthetic search" },
              state: {},
              inferenceBinding: binding,
            },
          ],
        });
        const savedBinding = (await loadCronJobsStore(storePath)).jobs[0]?.inferenceBinding;
        expect(savedBinding).toEqual(binding);
        if (!savedBinding) {
          throw new Error("Persisted automation binding was lost");
        }
        const authority = await acquireCronInferenceAuthorization({
          binding: savedBinding,
          cfg: config,
          agentDir,
        });
        try {
          const search = (profileId?: string, baseUrl = origin + "/v1", signal?: AbortSignal) =>
            withPluginRuntimeRegistryScope(fixture.registry.registry, async () => {
              authority.assertCurrent();
              const tool = createWebSearchTool({
                config,
                agentDir,
                modelProvider: savedBinding.provider,
                modelAuthProfileId: profileId,
                modelBaseUrl: baseUrl,
              });
              if (!tool) {
                throw new Error("Missing web_search tool");
              }
              return await tool.execute("automation-search", { query: "native citation" }, signal);
            });
          // The competing default is usable; the selected automation must not inherit it.
          await expect(search()).resolves.toMatchObject({
            details: {
              provider: "clawrouter-tavily",
              results: [{ url: "https://example.com/citation" }],
            },
          });
          await expect(search(savedBinding.profileId)).resolves.toMatchObject({
            details: {
              provider: "clawrouter-tavily",
              results: [{ url: "https://example.com/citation" }],
            },
          });
          expect(authorization.slice(-2)).toEqual([
            "Bearer synthetic-router-key",
            "Bearer synthetic-router-key",
          ]);
          denied = true;
          await expect(search(savedBinding.profileId)).resolves.toMatchObject({
            details: { error: "provider_error", message: expect.stringContaining("402") },
          });
          // A later route change cannot send the standing account to a different endpoint.
          const callsBeforeRouteChange = paths.length;
          for (const selectedUrl of [
            "https://other-router.example/v1",
            "https://other-router.example/v1/native/anthropic",
            origin.replace("://", "://user:pass@") + "/v1/native/anthropic",
            origin + "/v1/native/google/v1beta?token=bad",
            origin + "/v1/native/anthropic#fragment",
          ]) {
            await expect(search(savedBinding.profileId, selectedUrl)).resolves.toMatchObject({
              details: { error: "provider_error" },
            });
          }
          expect(paths).toHaveLength(callsBeforeRouteChange);
          const cancelled = new AbortController();
          cancelled.abort(new Error("cancel selected automation"));
          await expect(
            search(savedBinding.profileId, origin + "/v1", cancelled.signal),
          ).rejects.toThrow("cancel selected automation");
          expect(paths).toHaveLength(callsBeforeRouteChange);
        } finally {
          authority.dispose();
        }
        expect(alternate).not.toHaveBeenCalled();
        expect(authorization).toEqual([
          "Bearer synthetic-default-router-key",
          "Bearer synthetic-default-router-key",
          ...Array.from({ length: 4 }, () => "Bearer synthetic-router-key"),
        ]);
        expect(paths).toEqual([
          "/v1/catalog",
          "/v1/native/tavily/search",
          "/v1/catalog",
          "/v1/native/tavily/search",
          "/v1/catalog",
          "/v1/native/tavily/search",
        ]);
      });
    },
  );
});
