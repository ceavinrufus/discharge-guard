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
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import * as tools from "./tools/index.js";
import { IMcpTool } from "./IMcpTool.js";

const isHttp = process.env.PORT !== undefined || process.env.MCP_TRANSPORT === "http";

if (!isHttp) {
  // ── Stdio mode (Claude Desktop, opencode) ──────────────────────────────────
  const server = new McpServer({ name: "discharge-guard", version: "1.0.0" });

  for (const tool of Object.values<IMcpTool>(tools)) {
    tool.registerTool(server, undefined);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(JSON.stringify({ status: "started", transport: "stdio" }) + "\n");

} else {
  // ── HTTP mode (Prompt Opinion, Railway, ngrok) ────────────────────────────
  const app = express();
  app.use(cors());
  app.use(express.json());

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
      process.stderr.write("MCP error: " + String(error) + "\n");
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
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
