import { createRpgMcpHandler } from "../create-rpg-mcp-handler.js";

const handler = createRpgMcpHandler("");

export const runtime = "nodejs";

export { handler as GET, handler as POST, handler as DELETE };
