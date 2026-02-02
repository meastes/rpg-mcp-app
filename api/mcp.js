import { handleMcpRequest } from "../server/mcp.js";

export default async function handler(req, res) {
  return handleMcpRequest(req, res);
}
