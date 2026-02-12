import { createMcpHandler } from "mcp-handler";
import { registerRpgTools } from "../server/mcp.js";

export function createRpgMcpHandler(basePath = "") {
  return createMcpHandler(
    (server) => {
      registerRpgTools(server);
    },
    { name: "ttrpg-mcp", version: "0.1.0" },
    { basePath }
  );
}
