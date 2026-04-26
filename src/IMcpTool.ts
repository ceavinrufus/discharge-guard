import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Request } from "express";

export interface IMcpTool {
  registerTool: (server: McpServer, req: Request | undefined) => void;
}
