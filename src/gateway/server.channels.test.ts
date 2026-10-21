import { afterAll, beforeAll, expect, test } from "vitest";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import { setRegistry } from "./server.agent.gateway-server-agent.mocks.js";
import { createRegistry } from "./server.e2e-registry-helpers.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const defaultRegistry = createRegistry([
  {
    pluginId: "whatsapp",
    source: "test",
    plugin: {
      ...createChannelTestPluginBase({
        id: "whatsapp",
        label: "WhatsApp",
        config: { isConfigured: async () => false },
      }),
      gateway: { logoutAccount: async () => ({ cleared: false, envToken: false }) },
    },
  },
]);

let server: Awaited<ReturnType<typeof startServerWithClient>>["server"];
let ws: Awaited<ReturnType<typeof startServerWithClient>>["ws"];

beforeAll(async () => {
  setRegistry(defaultRegistry);
  const started = await startServerWithClient();
  server = started.server;
  ws = started.ws;
  await connectOk(ws);
});

afterAll(async () => {
  ws.close();
  await server.close();
});

test("channels.logout reports no session when missing", async () => {
  setRegistry(defaultRegistry);
  const res = await rpcReq<{ cleared?: boolean; channel?: string }>(ws, "channels.logout", {
    channel: "whatsapp",
  });
  expect(res).toMatchObject({ ok: true, payload: { channel: "whatsapp", cleared: false } });
});
