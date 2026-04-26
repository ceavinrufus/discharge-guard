#!/usr/bin/env node
/**
 * DischargeGuard MCP Server
 *
 * Prevents medication errors at hospital discharge.
 * Built for the Agents Assemble Hackathon — Prompt Opinion platform.
 *
 * Tools:
 *   get_patient_summary        — FHIR Patient demographics
 *   get_active_medications     — Active MedicationRequests
 *   get_allergies              — AllergyIntolerance records
 *   get_active_conditions      — Active Conditions/diagnoses
 *   get_recent_labs            — Recent lab Observations
 *   check_drug_interactions    — OpenFDA drug interaction check
 *   generate_discharge_summary — Full PCP handoff + patient safety card
 */

import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import * as tools from "./tools/index.js";
import { IMcpTool } from "./IMcpTool.js";

// ─── Transport selection ──────────────────────────────────────────────────────

const isHttp = process.env.PORT !== undefined || process.env.MCP_TRANSPORT === "http";

if (!isHttp) {
  // ── Stdio mode (Claude Desktop, opencode) ──────────────────────────────────
  const { McpServer: _McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const server = new _McpServer({ name: "discharge-guard", version: "1.0.0" });

  // Register all tools with undefined req (no FHIR context in stdio mode)
  for (const tool of Object.values<IMcpTool>(tools)) {
    tool.registerTool(server, undefined as unknown as express.Request);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(JSON.stringify({ status: "started", transport: "stdio" }) + "\n");

} else {
  // ── HTTP mode (Prompt Opinion, Railway) ───────────────────────────────────
  const env = process.env["PO_ENV"]?.toString();
  const allowedHosts: string[] = ["localhost", "127.0.0.1"];

  switch (env) {
    case "dev":
      allowedHosts.push("ts.fhir-mcp.dev.promptopinion.ai");
      break;
    case "prod":
      allowedHosts.push("ts.fhir-mcp.promptopinion.ai");
      break;
  }

  const app = createMcpExpressApp({ host: "0.0.0.0", allowedHosts });
  app.use(cors());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", server: "discharge-guard", version: "1.0.0", tools: Object.keys(tools) });
  });

  app.post("/mcp", async (req, res) => {
    try {
      const server = new McpServer(
        { name: "discharge-guard", version: "1.0.0" },
        {
          capabilities: {
            extensions: {
              "ai.promptopinion/fhir-context": {
                scopes: [
                  { name: "patient/Patient.rs", required: true },
                  { name: "offline_access" },
                  { name: "patient/MedicationRequest.rs" },
                  { name: "patient/AllergyIntolerance.rs" },
                  { name: "patient/Condition.rs" },
                  { name: "patient/Observation.rs" },
                ],
              },
            },
          },
        }
      );

      for (const tool of Object.values<IMcpTool>(tools)) {
        tool.registerTool(server, req);
      }

      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

      res.on("close", () => {
        transport.close();
        server.close();
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP request error:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  const port = parseInt(process.env.PORT ?? "3001", 10);
  app.listen(port, () => {
    process.stderr.write(JSON.stringify({ status: "started", transport: "http", port }) + "\n");
  });
}
