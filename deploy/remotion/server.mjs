import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, realpath, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { bundle } from "@remotion/bundler";
import { getCompositions, renderMedia, selectComposition } from "@remotion/renderer";
import { z } from "zod";

const keyFile = process.env.REMOTION_API_KEY_FILE;
if (!keyFile) throw new Error("Set REMOTION_API_KEY_FILE to the mounted tenant secret file.");
const apiKey = (await readFile(keyFile, "utf8")).trim();
if (!apiKey) throw new Error("REMOTION_API_KEY_FILE must contain a nonempty tenant secret.");
const hash = (value) => createHash("sha256").update(value).digest();
const keyHash = hash(`Bearer ${apiKey}`);
const workspace = await realpath(process.env.WORKSPACE_DIR || "/home/node/.openclaw/workspace");
const serviceModules = fileURLToPath(new URL("node_modules", import.meta.url));
const chromiumOptions = { enableMultiProcessOnLinux: true };
let busy = false;

function withinWorkspace(candidate) {
  const relative = path.relative(workspace, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Use a path inside the shared tenant workspace.");
  }
  return candidate;
}

async function entryFile(value) {
  const resolved = withinWorkspace(await realpath(withinWorkspace(path.resolve(workspace, value))));
  if (!(await stat(resolved)).isFile())
    throw new Error("entryPoint must name a project source file.");
  return resolved;
}

async function outputFile(value) {
  const candidate = withinWorkspace(path.resolve(workspace, value));
  if (path.extname(candidate).toLowerCase() !== ".mp4") {
    throw new Error("outputPath must end in .mp4; this service renders H.264 MP4 files.");
  }
  // Resolve the existing ancestor before creating folders, including mounted symlinks.
  let ancestor = path.dirname(candidate);
  for (;;) {
    try {
      withinWorkspace(await realpath(ancestor));
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      ancestor = path.dirname(ancestor);
    }
  }
  await mkdir(path.dirname(candidate), { recursive: true });
  const parent = withinWorkspace(await realpath(path.dirname(candidate)));
  const resolved = path.join(parent, path.basename(candidate));
  // Exclusive reservation rejects existing files and final-component symlinks.
  const handle = await open(resolved, "wx");
  await handle.close();
  return resolved;
}

const sourceSchema = {
  entryPoint: z
    .string()
    .min(1)
    .describe(
      "Project entry file inside the shared workspace, for example videos/demo/index.tsx. It must call registerRoot().",
    ),
  inputProps: z
    .record(z.string(), z.unknown())
    .default({})
    .describe("JSON props passed to composition metadata and rendering."),
};

function response(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

async function runProject({ entryPoint, inputProps }, operation) {
  if (busy)
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: "Remotion is busy. Wait for the current request to finish, then retry.",
        },
      ],
    };
  busy = true;
  let bundled;
  try {
    const entry = await entryFile(entryPoint);
    bundled = await bundle({
      entryPoint: entry,
      rootDir: path.dirname(entry),
      enableCaching: false,
      webpackOverride: (config) => ({
        ...config,
        resolve: {
          ...config.resolve,
          modules: [serviceModules, ...(config.resolve?.modules || ["node_modules"])],
        },
      }),
    });
    return response(await operation(bundled, inputProps));
  } catch (error) {
    const detail = String(error instanceof Error ? error.message : error).replaceAll(
      apiKey,
      "[redacted]",
    );
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Remotion failed: ${detail}. Check the workspace project and input props, then retry.`,
        },
      ],
    };
  } finally {
    try {
      if (bundled) await rm(bundled, { recursive: true, force: true });
    } finally {
      busy = false;
    }
  }
}

function createMcpServer() {
  const server = new McpServer({ name: "openclaw-private-remotion", version: "1.0.0" });
  server.registerTool(
    "get_compositions",
    {
      description:
        "Bundle a Remotion project written in the shared OpenClaw workspace and list its compositions. Write the source files with OpenClaw workspace tools first. React and Remotion are already installed in the service.",
      inputSchema: sourceSchema,
    },
    (args) =>
      runProject(args, async (serveUrl, inputProps) => {
        const compositions = await getCompositions(serveUrl, { inputProps, chromiumOptions });
        return {
          compositions: compositions.map(({ id, width, height, fps, durationInFrames }) => ({
            id,
            width,
            height,
            fps,
            durationInFrames,
          })),
        };
      }),
  );
  server.registerTool(
    "render_media",
    {
      description:
        "Render a workspace Remotion composition as H.264 MP4. Returns a path visible to the OpenClaw gateway in the shared workspace. One request runs at a time. Existing output files are never overwritten.",
      inputSchema: {
        ...sourceSchema,
        compositionId: z.string().min(1),
        outputPath: z
          .string()
          .min(1)
          .optional()
          .describe("New .mp4 file inside the workspace; defaults to renders/<unique-id>.mp4."),
      },
    },
    (args) =>
      runProject(args, async (serveUrl, inputProps) => {
        const composition = await selectComposition({
          serveUrl,
          id: args.compositionId,
          inputProps,
          chromiumOptions,
        });
        const output = await outputFile(args.outputPath || `renders/${randomUUID()}.mp4`);
        try {
          await renderMedia({
            composition,
            serveUrl,
            inputProps,
            codec: "h264",
            outputLocation: output,
            chromiumOptions,
            concurrency: 1,
          });
          return {
            outputPath: output,
            workspaceRelativePath: path.relative(workspace, output),
            bytes: (await stat(output)).size,
          };
        } catch (error) {
          await rm(output, { force: true });
          throw error;
        }
      }),
  );
  return server;
}

const httpServer = createServer(async (req, res) => {
  if (req.url === "/healthz" && req.method === "GET") {
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ status: "ok", busy }));
    return;
  }
  if (req.url !== "/mcp") {
    res.writeHead(404).end("Not found");
    return;
  }
  if (!timingSafeEqual(hash(req.headers.authorization || ""), keyHash)) {
    res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end("Unauthorized");
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST" }).end("Use a Streamable HTTP MCP POST request.");
    return;
  }
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch {
    if (!res.headersSent)
      res.writeHead(500).end("MCP request failed. Check the request format and retry.");
  }
});
httpServer.listen(8080, "0.0.0.0", () =>
  console.log("Private Remotion MCP listening on :8080/mcp"),
);
