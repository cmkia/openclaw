import { execFile } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { readFile, realpath, open, mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { validateManifest } from "./manifest.mjs";
import { renderPresentation } from "./render.mjs";

const execute = promisify(execFile);
const keyFile = process.env.PRESENTATIONS_API_KEY_FILE;
if (!keyFile) throw new Error("Set PRESENTATIONS_API_KEY_FILE to a mounted tenant secret.");
const apiKey = (await readFile(keyFile, "utf8")).trim();
if (!apiKey) throw new Error("The presentations tenant secret must not be empty.");
const digest = (value) => createHash("sha256").update(value).digest();
const authHash = digest(`Bearer ${apiKey}`);
const workspace = await realpath(process.env.WORKSPACE_DIR || "/home/node/.openclaw/workspace");
const validator = fileURLToPath(new URL("./validate.py", import.meta.url));
let busy = false;

function inside(candidate) {
  const relative = path.relative(workspace, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Use a file or directory inside this tenant's workspace.");
  }
  return candidate;
}

async function readInput(value, extension, maxBytes) {
  const resolved = inside(await realpath(inside(path.resolve(workspace, value))));
  if (path.extname(resolved).toLowerCase() !== extension) {
    throw new Error(`Input must be a ${extension} file inside the workspace.`);
  }
  const handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (process.platform === "linux") inside(await realpath(`/proc/self/fd/${handle.fd}`));
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes)
      throw new Error(`Input must be a regular file of at most ${maxBytes} bytes.`);
    const buffer = await handle.readFile();
    if (buffer.length > maxBytes) throw new Error(`Input exceeds the ${maxBytes} byte limit.`);
    return { resolved, buffer };
  } finally {
    await handle.close();
  }
}

async function reserveDirectory(value) {
  const candidate = inside(path.resolve(workspace, value));
  let ancestor = path.dirname(candidate);
  for (;;) {
    try {
      inside(await realpath(ancestor));
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      ancestor = path.dirname(ancestor);
    }
  }
  await mkdir(path.dirname(candidate), { recursive: true });
  const parent = inside(await realpath(path.dirname(candidate)));
  const output = path.join(parent, path.basename(candidate));
  try {
    await mkdir(output);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(
        "Output directory already exists. Choose a new directory to preserve previous files.",
      );
    }
    throw error;
  }
  return output;
}

function reply(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

async function exclusive(operation) {
  if (busy)
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: "Presentations is busy. Let the current operation finish before retrying.",
        },
      ],
    };
  busy = true;
  try {
    return reply(await operation());
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
          text: `Presentations failed: ${detail}. Correct the manifest or workspace path and retry in a new output directory.`,
        },
      ],
    };
  } finally {
    busy = false;
  }
}

function createMcpServer() {
  const server = new McpServer({ name: "openclaw-private-presentations", version: "1.0.0" });
  server.registerTool(
    "presentations_render",
    {
      description:
        "Create an editable PPTX, PDF preview and slide PNGs from a version 1 JSON manifest in this tenant workspace. Read the apresentacoes-erika skill for layouts and manifest examples. Images must already be local PNG/JPEG files; use Magnific separately. Includes structural checks; inspect the returned PNGs before delivering. Existing output directories are never overwritten.",
      inputSchema: {
        manifestPath: z
          .string()
          .min(1)
          .describe(
            "Workspace JSON file with title and slides, for example presentations/my-lecture/manifest.json.",
          ),
        outputDirectory: z
          .string()
          .min(1)
          .optional()
          .describe(
            "New directory inside the workspace. Defaults to presentations/exports/<unique-id>.",
          ),
      },
    },
    (args) =>
      exclusive(async () => {
        const source = await readInput(args.manifestPath, ".json", 2 * 1024 * 1024);
        const manifest = validateManifest(JSON.parse(source.buffer.toString("utf8")));
        const output = await reserveDirectory(
          args.outputDirectory || `presentations/exports/${randomUUID()}`,
        );
        try {
          const result = await renderPresentation({ manifest, workspace, outputDir: output });
          const relative = (value) =>
            value
              ? path
                  .relative(workspace, inside(path.resolve(value)))
                  .split(path.sep)
                  .join("/")
              : undefined;
          return {
            ...result,
            workspaceRelative: {
              pptx: relative(result.pptx),
              pdf: relative(result.pdf),
              pngs: result.pngs.map(relative),
              validation: relative(result.validation),
            },
          };
        } catch (error) {
          // Only this invocation's exclusively reserved directory is eligible for cleanup.
          await rm(output, { recursive: true, force: true });
          throw error;
        }
      }),
  );
  server.registerTool(
    "presentations_check",
    {
      description:
        "Check the OOXML package structure of an existing PPTX inside this tenant workspace, including slide relationships, charts, notes and embedded media. Read-only. Does not verify medical facts, image accuracy, visual layout or opening in Microsoft PowerPoint.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        presentationPath: z
          .string()
          .min(1)
          .describe("Existing .pptx path inside the shared workspace."),
      },
    },
    (args) =>
      exclusive(async () => {
        const source = await readInput(args.presentationPath, ".pptx", 200 * 1024 * 1024);
        const scratch = await mkdtemp(path.join(tmpdir(), "presentation-check-"));
        try {
          // The validator reads a captured descriptor's bytes, never a reopened caller-controlled path.
          const snapshot = path.join(scratch, "presentation.pptx");
          await writeFile(snapshot, source.buffer, { flag: "wx", mode: 0o600 });
          const result = await execute("python3", [validator, snapshot], {
            timeout: 120000,
            maxBuffer: 2 * 1024 * 1024,
          });
          return JSON.parse(result.stdout);
        } catch (error) {
          if (error.stdout) {
            try {
              return JSON.parse(error.stdout);
            } catch {
              /* A process failure without a JSON report uses the normal actionable error. */
            }
          }
          throw new Error(
            "Package validation did not produce a report. Check that the file is a supported PPTX.",
          );
        } finally {
          await rm(scratch, { recursive: true, force: true });
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
  if (!timingSafeEqual(digest(req.headers.authorization || ""), authHash)) {
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
    if (!res.headersSent) res.writeHead(500).end("MCP request failed. Check its format and retry.");
  }
});
httpServer.requestTimeout = 600000;
httpServer.listen(8080, "0.0.0.0", () =>
  console.log("Private presentations MCP listening on :8080/mcp"),
);
