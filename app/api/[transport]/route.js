import { createRpgMcpHandler } from "../../create-rpg-mcp-handler.js";

const handler = createRpgMcpHandler("/api");

export const runtime = "nodejs";

export { handler as GET, handler as POST, handler as DELETE };
