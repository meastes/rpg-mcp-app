import { createServer } from "node:http";
import { MCP_PATH, handleMcpRequest } from "./mcp.js";

const port = Number(process.env.PORT ?? 8787);

const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end("Missing URL");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/plain" }).end("TTRPG MCP server");
    return;
  }

  if (url.pathname === MCP_PATH) {
    await handleMcpRequest(req, res);
    return;
  }

  res.writeHead(404).end("Not Found");
});

httpServer.listen(port, () => {
  console.log(`TTRPG MCP server listening on http://localhost:${port}${MCP_PATH}`);
});
