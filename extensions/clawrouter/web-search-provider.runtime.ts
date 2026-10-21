import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { buildTimeoutAbortSignal } from "openclaw/plugin-sdk/extension-shared";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowProviderError,
  createProviderCredentialMatcher,
  fetchWithProviderHttpGuard,
  readProviderJsonObjectResponse,
  resolveProviderHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-contract";
import { normalizeTavilySearchResponse } from "openclaw/plugin-sdk/provider-web-search-tavily";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeClawRouterRootUrl } from "./base-url.js";

function supportsSearch(catalog: Record<string, unknown>): boolean {
  return (
    catalog.version === "clawrouter.client-catalog.v1" &&
    Array.isArray(catalog.providers) &&
    catalog.providers.some(
      (provider: unknown) =>
        isRecord(provider) &&
        provider.id === "tavily" &&
        provider.allowed === true &&
        provider.executable === true &&
        provider.nativeBaseUrl === "/v1/native/tavily" &&
        Array.isArray(provider.routes) &&
        provider.routes.some(
          (route: unknown) =>
            isRecord(route) &&
            route.path === "/search" &&
            route.requestFormat === "tavily.search" &&
            route.responseFormat === "tavily.search" &&
            Array.isArray(route.methods) &&
            route.methods.includes("POST"),
        ) &&
        Array.isArray(provider.models) &&
        provider.models.some(
          (model: unknown) =>
            isRecord(model) &&
            model.id === "tavily/search" &&
            model.upstream === "search" &&
            Array.isArray(model.capabilities) &&
            model.capabilities.includes("web.search"),
        ),
    )
  );
}

export async function searchClawRouterTavily(params: {
  config?: OpenClawConfig;
  agentDir?: string;
  authProfile?: Parameters<WebSearchProviderPlugin["createTool"]>[0]["authProfile"];
  query: string;
  count: number;
  signal?: AbortSignal;
  assertCurrent?: () => void;
}): Promise<Record<string, unknown>> {
  const started = Date.now();
  const { signal, cleanup } = buildTimeoutAbortSignal({
    signal: params.signal,
    timeoutMs: (params.config?.tools?.web?.search?.timeoutSeconds ?? 30) * 1000,
    operation: "ClawRouter Tavily search",
  });
  const current = () => {
    signal?.throwIfAborted();
    params.assertCurrent?.();
  };
  try {
    current();
    const provider = params.config?.models?.providers?.clawrouter;
    const root = new URL(normalizeClawRouterRootUrl(provider?.baseUrl));
    if (
      !["http:", "https:"].includes(root.protocol) ||
      root.username ||
      root.password ||
      root.search ||
      root.hash
    ) {
      throw new Error(
        "ClawRouter search requires an HTTP(S) router base URL without credentials, query or fragment.",
      );
    }
    const baseUrl = root.href.endsWith("/") ? root.href.slice(0, -1) : root.href;
    // Native Claude/Gemini model URLs include a transport suffix, not a different router.
    // Only compare roots; keep the original selected route for locked-profile resolution.
    if (params.authProfile?.baseUrl) {
      const selected = new URL(params.authProfile.baseUrl);
      selected.pathname = selected.pathname.replace(/\/v1(?:\/native\/[^/]+(?:\/.*)?)?\/?$/u, "");
      if (
        selected.username ||
        selected.password ||
        selected.search ||
        selected.hash ||
        selected.href.replace(/\/$/u, "") !== baseUrl
      ) {
        throw new Error(
          "ClawRouter search endpoint changed for the selected account; explicitly select the account again.",
        );
      }
    }
    const auth = await resolveApiKeyForProvider({
      provider: "clawrouter",
      profileId: params.authProfile?.profileId,
      lockedProfile: Boolean(params.authProfile),
      modelBaseUrl: params.authProfile?.baseUrl,
      cfg: params.config,
      agentDir: params.agentDir,
      signal,
    });
    current();
    if (!auth.apiKey) {
      throw new Error("ClawRouter Tavily search requires a ClawRouter API key or auth profile.");
    }
    const overrides = sanitizeConfiguredModelProviderRequest({
      ...provider?.request,
      headers: { ...provider?.headers, ...provider?.request?.headers },
    });
    const request = resolveProviderHttpRequestConfig({
      provider: "clawrouter",
      capability: "other",
      transport: "http",
      baseUrl,
      defaultBaseUrl: baseUrl,
      request: overrides,
      defaultHeaders: {
        Authorization: "Bearer " + auth.apiKey,
        Accept: "application/json",
        "X-ClawRouter-Client": "openclaw",
        "X-Client-Source": "openclaw",
      },
    });
    const reflectsCredential = createProviderCredentialMatcher({
      headers: request.headers,
      request: overrides,
      configuredHeaderNames: Object.keys(provider?.headers ?? {}),
      defaultAuthHeader: "Authorization",
      defaultAuthPrefix: "Bearer ",
    });
    async function read(path: string, body?: Record<string, unknown>) {
      current();
      const headers = new Headers(request.headers);
      if (body) {
        headers.set("Content-Type", "application/json");
      }
      const { response, release } = await fetchWithProviderHttpGuard({
        url: baseUrl + path,
        signal,
        beforeRequest: current,
        maxRedirects: 0,
        policy: { allowPrivateNetwork: request.allowPrivateNetwork },
        dispatcherPolicy: request.dispatcherPolicy,
        init: { headers, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) },
      });
      try {
        await assertOkOrThrowProviderError(response, "ClawRouter Tavily search", {
          signal,
          requestHeaders: headers,
        });
        const payload = await readProviderJsonObjectResponse(response, "ClawRouter Tavily search", {
          maxBytes: 4_194_304,
          signal,
          requestHeaders: headers,
        });
        if (reflectsCredential(JSON.stringify(payload))) {
          throw new Error("ClawRouter Tavily search returned reflected request credentials.");
        }
        return payload;
      } finally {
        await response.body?.cancel().catch(() => undefined);
        await release();
      }
    }
    // Never cache grants or select a destination from discovery. The current key
    // qualifies this fixed native route; the service remains the budget/grant owner.
    const catalog = await read("/v1/catalog");
    current();
    if (!supportsSearch(catalog)) {
      throw new Error(
        "ClawRouter does not advertise executable native Tavily search for this credential.",
      );
    }
    const payload = await read("/v1/native/tavily/search", {
      query: params.query,
      max_results: params.count,
    });
    current();
    if (!Array.isArray(payload.results)) {
      throw new Error("ClawRouter Tavily search returned an invalid results payload.");
    }
    return normalizeTavilySearchResponse(payload, {
      query: params.query,
      count: params.count,
      provider: "clawrouter-tavily",
      tookMs: Date.now() - started,
    });
  } catch (error) {
    params.signal?.throwIfAborted();
    throw error;
  } finally {
    cleanup();
  }
}
