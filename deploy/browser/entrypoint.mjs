import { spawn } from "node:child_process";
import http from "node:http";

const upstream = { hostname: "127.0.0.1", port: 9223 };
const sockets = new Set();
let stopping = false;
let exitCode = 0;

const browser = spawn(
  "/usr/bin/chromium",
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=9223",
    "--user-data-dir=/home/node/.config/chromium",
    "about:blank",
  ],
  { stdio: "inherit" },
);

function upstreamOptions(request) {
  return {
    ...upstream,
    method: request.method,
    path: request.url,
    // Chromium rejects Docker service names in Host, even on a private network.
    headers: { ...request.headers, host: "127.0.0.1:9223" },
  };
}

function unavailable(response) {
  if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
  response.end("Browser unavailable. Check the browser container logs.\n");
}

const server = http.createServer((request, response) => {
  const outgoing = http.request(upstreamOptions(request), (incoming) => {
    if (incoming.headers["content-type"]?.includes("application/json")) {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("end", () => {
        // Discovery must advertise the endpoint reachable from the CDP client,
        // rather than Chromium's container-local loopback socket.
        const body = Buffer.concat(chunks)
          .toString()
          .replaceAll("ws://127.0.0.1:9223/", `ws://${request.headers.host}/`);
        response.writeHead(incoming.statusCode, {
          ...incoming.headers,
          "content-length": Buffer.byteLength(body),
        });
        response.end(body);
      });
    } else {
      response.writeHead(incoming.statusCode, incoming.headers);
      incoming.pipe(response);
    }
    incoming.on("error", () => response.destroy());
  });
  outgoing.on("error", () => unavailable(response));
  request.on("aborted", () => outgoing.destroy());
  request.pipe(outgoing);
});

server.on("upgrade", (request, socket, head) => {
  const outgoing = http.request(upstreamOptions(request));
  outgoing.on("upgrade", (response, peer, peerHead) => {
    socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`);
    for (let index = 0; index < response.rawHeaders.length; index += 2) {
      socket.write(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`);
    }
    socket.write("\r\n");
    if (peerHead.length) socket.write(peerHead);
    if (head.length) peer.write(head);
    socket.on("error", () => peer.destroy());
    peer.on("error", () => socket.destroy());
    socket.on("close", () => peer.destroy());
    peer.on("close", () => socket.destroy());
    socket.pipe(peer).pipe(socket);
  });
  outgoing.on("response", (response) => {
    socket.end(
      `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\nConnection: close\r\n\r\n`,
    );
    response.resume();
  });
  outgoing.on("error", () => socket.destroy());
  socket.on("error", () => outgoing.destroy());
  outgoing.end();
});

server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});

function stop(code) {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  server.close();
  // Allow Chromium to flush its persistent profile before the container exits.
  browser.kill("SIGTERM");
  setTimeout(() => browser.kill("SIGKILL"), 25_000).unref();
}

process.on("SIGTERM", () => stop(0));
process.on("SIGINT", () => stop(0));
server.on("error", (error) => {
  console.error("Browser proxy failed:", error.message);
  stop(1);
});
browser.on("error", (error) => {
  console.error("Chromium failed to start:", error.message);
  stop(1);
});
browser.on("close", (code, signal) => {
  if (!stopping) console.error(`Chromium exited unexpectedly (${signal ?? code}).`);
  for (const socket of sockets) socket.destroy();
  process.exit(stopping ? exitCode : 1);
});

server.listen(9222, "0.0.0.0");
