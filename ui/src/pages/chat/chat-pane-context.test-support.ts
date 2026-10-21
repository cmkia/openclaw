import { onTestFinished } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createApplicationTheme } from "../../app/bootstrap-theme.ts";
import { createChatAttachmentHandoff } from "../../app/chat-attachment-handoff.ts";
import { createChatSubmissions } from "../../app/chat-submissions.ts";
import { createConnectionBootstrapCoordinator } from "../../app/connection-bootstrap.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { loadSettings } from "../../app/settings.ts";
import { createAgentIdentityCapability } from "../../lib/agents/identity.ts";
import { createAgentCapability } from "../../lib/agents/index.ts";
import { createSessionCapability, type SessionCapability } from "../../lib/sessions/index.ts";
import { ControlUiPluginRuntime } from "../../plugins/control-ui-runtime.ts";
import { createNavigationPreferencesFixture } from "../../test-helpers/application-context.ts";

export type FixtureContextServices =
  | "theme"
  | "agentIdentity"
  | "agents"
  | "sessions"
  | "plugins"
  | "connectionBootstrap"
  | "chatAttachmentHandoff";

export function withLiveCapabilities(
  context: Omit<ApplicationContext, FixtureContextServices> & { sessions?: SessionCapability },
): ApplicationContext {
  const chatAttachmentHandoff = createChatAttachmentHandoff(context.gateway);
  const connectionBootstrap = createConnectionBootstrapCoordinator();
  const synchronizeBootstrap = (snapshot: ApplicationContext["gateway"]["snapshot"]) =>
    connectionBootstrap.synchronize({
      client: snapshot.client,
      connected: snapshot.phase === "connected",
    });
  synchronizeBootstrap(context.gateway.snapshot);
  const stopBootstrap = context.gateway.subscribe(synchronizeBootstrap);
  const theme = createApplicationTheme(
    loadSettings(context.gateway.connection.gatewayUrl),
    context.gateway,
  );
  const agents = createAgentCapability(context.gateway);
  const sessions =
    context.sessions ??
    createSessionCapability(context.gateway, context.agentSelection, { connectionBootstrap });
  const plugins = new ControlUiPluginRuntime(() => applicationContext);
  onTestFinished(() => {
    plugins.dispose();
    stopBootstrap();
    chatAttachmentHandoff.dispose();
    connectionBootstrap.reset();
    if (!context.sessions) {
      sessions.dispose();
    }
    agents.dispose();
    theme.dispose();
  });
  const applicationContext: ApplicationContext = {
    ...context,
    chatAttachmentHandoff,
    connectionBootstrap,
    navigation: createNavigationPreferencesFixture(),
    theme,
    agents,
    sessions,
    plugins,
    agentIdentity: createAgentIdentityCapability(context.gateway),
  };
  return applicationContext;
}

export function createInitializationContext(client?: GatewayBrowserClient): ApplicationContext {
  return withLiveCapabilities({
    basePath: "",
    gateway: {
      snapshot: {
        client: client ?? null,
        phase: client ? "connected" : "stopped",
        offlineStable: false,
        hello: null,
        canvasPluginSurfaceUrl: null,
        assistantAgentId: null,
        sessionKey: "",
        lastError: null,
        lastErrorCode: null,
      },
      subscribe: () => () => {},
      subscribeEvents: () => () => {},
      connection: {
        gatewayUrl: loadSettings().gatewayUrl,
        token: "",
        bootstrapToken: "",
        password: "",
      },
    },
    config: {
      subscribe: () => () => {},
      current: {
        assistantIdentity: {
          agentId: null,
          name: "Assistant",
          avatar: null,
          avatarStatus: null,
          avatarReason: null,
        },
        serverVersion: null,
        embedSandboxMode: "strict",
        allowExternalEmbedUrls: false,
        terminalEnabled: false,
      },
    },
    agentSelection: {
      state: { selectedId: "main" },
      subscribe: () => () => {},
    },
    runtimeConfig: {
      state: { configNeedsApply: false, configSnapshot: null },
      ensureLoaded: async () => undefined,
      subscribe: () => () => {},
    },
    placementStartup: {
      get: () => null,
      hasPendingTurn: () => false,
      retry: () => undefined,
      pause: () => undefined,
      subscribe: () => () => {},
    },
    navigate: () => undefined,
    chatSubmissions: createChatSubmissions(),
  } as unknown as Omit<ApplicationContext, FixtureContextServices>);
}
