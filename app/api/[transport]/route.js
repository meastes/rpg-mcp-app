import { createMcpHandler } from "mcp-handler";
import { registerRpgTools } from "../../../server/mcp.js";

const handler = createMcpHandler(
  (server) => {
    registerRpgTools(server);
  },
  { name: "ttrpg-mcp", version: "0.1.0" },
  { basePath: "/api" }
);

export const runtime = "nodejs";

export { handler as GET, handler as POST, handler as DELETE };
