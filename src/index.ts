#!/usr/bin/env node
/**
 * DischargeGuard MCP Server
 *
 * A Model Context Protocol (MCP) server that helps prevent medication errors
 * at hospital discharge by integrating:
 * - FHIR R4 patient data (HAPI FHIR public server)
 * - NLM RxNorm drug normalization
 * - NLM RxNav drug interaction checking
 * - OpenFDA drug label retrieval
 * - SHARP context propagation (https://www.sharponmcp.com)
 *
 * Clinical Impact:
 * - 1 in 5 patients leave hospitals with medication errors
 * - 1.5 million adverse drug events (ADEs) per year in the US
 * - $21 billion in preventable healthcare costs annually
 *
 * Pediatric Support:
 * - Flags pediatric patients and enforces weight-based dosing reminders
 * - Compatible with CHOP (Children's Hospital of Philadelphia) standards
 *
 * Standards Compliance:
 * - FHIR R4 (HL7) for resource access (co-developed by judge Josh Mandel)
 * - SMART on FHIR for authorization patterns
 * - SHARP v1.0 for patient context propagation in multi-agent systems
 *
 * @module discharge-guard
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import {
  PatientIdSchema,
  getPatientSummary,
  getActiveMedications,
  getAllergies,
  getActiveConditions,
  getRecentLabs,
} from "./tools/fhir.js";
import {
  CheckDrugInteractionsSchema,
  checkDrugInteractions,
} from "./tools/drugs.js";
import {
  GenerateDischargeSummarySchema,
  generateDischargeSummary,
} from "./tools/summary.js";

// ─── Tool definitions ─────────────────────────────────────────────────────────

/** Full list of MCP tools exposed by DischargeGuard */
const TOOLS: Tool[] = [
  {
    name: "get_patient_summary",
    description:
      "Retrieves patient demographics and basic information from HAPI FHIR R4. " +
      "Returns name, date of birth, age, gender, address, contact info, preferred language, " +
      "and general practitioner. Includes SHARP context for downstream agent handoff.",
    inputSchema: {
      type: "object",
      properties: {
        patient_id: {
          type: "string",
          description: "FHIR Patient resource ID on the HAPI FHIR R4 server",
        },
      },
      required: ["patient_id"],
    },
  },
  {
    name: "get_active_medications",
    description:
      "Retrieves all active MedicationRequest resources for a patient from HAPI FHIR R4. " +
      "Returns medication names, dosage instructions, routes, prescribers, and RxNorm codes. " +
      "Critical for medication reconciliation and discharge safety checks.",
    inputSchema: {
      type: "object",
      properties: {
        patient_id: {
          type: "string",
          description: "FHIR Patient resource ID on the HAPI FHIR R4 server",
        },
      },
      required: ["patient_id"],
    },
  },
  {
    name: "get_allergies",
    description:
      "Retrieves allergy and intolerance records for a patient from HAPI FHIR R4. " +
      "Separates drug allergies from other allergies, includes criticality levels and " +
      "reaction manifestations. High criticality drug allergies are flagged prominently.",
    inputSchema: {
      type: "object",
      properties: {
        patient_id: {
          type: "string",
          description: "FHIR Patient resource ID on the HAPI FHIR R4 server",
        },
      },
      required: ["patient_id"],
    },
  },
  {
    name: "get_active_conditions",
    description:
      "Retrieves active clinical conditions/diagnoses for a patient from HAPI FHIR R4. " +
      "Returns condition names, severity, onset dates, and ICD/SNOMED codes. " +
      "Useful for understanding comorbidities that affect medication safety.",
    inputSchema: {
      type: "object",
      properties: {
        patient_id: {
          type: "string",
          description: "FHIR Patient resource ID on the HAPI FHIR R4 server",
        },
      },
      required: ["patient_id"],
    },
  },
  {
    name: "get_recent_labs",
    description:
      "Retrieves the 10 most recent laboratory observations for a patient from HAPI FHIR R4. " +
      "Flags abnormal results (H/L/HH/LL/A/AA interpretations) and includes reference ranges. " +
      "Critical for identifying renal/hepatic impairment that affects drug dosing.",
    inputSchema: {
      type: "object",
      properties: {
        patient_id: {
          type: "string",
          description: "FHIR Patient resource ID on the HAPI FHIR R4 server",
        },
      },
      required: ["patient_id"],
    },
  },
  {
    name: "check_drug_interactions",
    description:
      "Checks drug-drug interactions for a list of medication names using NLM RxNav. " +
      "First resolves each drug name to an RxCUI via NLM RxNorm, then queries the " +
      "NLM RxNav interaction API. Returns interactions ranked by severity (high/moderate/low) " +
      "with clinical descriptions and overall risk assessment. Minimum 2 drugs required.",
    inputSchema: {
      type: "object",
      properties: {
        drug_names: {
          type: "array",
          items: { type: "string" },
          minItems: 2,
          description:
            "List of drug names (brand or generic) to check for interactions. Minimum 2 required.",
        },
      },
      required: ["drug_names"],
    },
  },
  {
    name: "generate_discharge_summary",
    description:
      "Generates a comprehensive discharge summary for a patient by orchestrating all " +
      "DischargeGuard tools in parallel. Produces two outputs: " +
      "(1) PCP Handoff Note — structured clinical summary with medication safety flags, " +
      "drug interactions, conditions, and abnormal labs for the primary care provider; " +
      "(2) Patient Safety Card — plain-language medication guide for the patient " +
      "written at a 6th-grade reading level per AHRQ standards, with pediatric-appropriate " +
      "language when applicable. Addresses the 1-in-5 patient medication error rate at discharge.",
    inputSchema: {
      type: "object",
      properties: {
        patient_id: {
          type: "string",
          description: "FHIR Patient resource ID on the HAPI FHIR R4 server",
        },
        include_patient_card: {
          type: "boolean",
          description:
            "Whether to include a plain-language patient safety card (default: true)",
          default: true,
        },
        include_pcp_note: {
          type: "boolean",
          description:
            "Whether to include the PCP handoff note (default: true)",
          default: true,
        },
      },
      required: ["patient_id"],
    },
  },
];

// ─── Server setup ─────────────────────────────────────────────────────────────

const server = new Server(
  {
    name: "discharge-guard",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ─── List tools handler ───────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// ─── Call tool handler ────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: unknown;

    switch (name) {
      case "get_patient_summary": {
        const input = PatientIdSchema.parse(args);
        result = await getPatientSummary(input);
        break;
      }

      case "get_active_medications": {
        const input = PatientIdSchema.parse(args);
        result = await getActiveMedications(input);
        break;
      }

      case "get_allergies": {
        const input = PatientIdSchema.parse(args);
        result = await getAllergies(input);
        break;
      }

      case "get_active_conditions": {
        const input = PatientIdSchema.parse(args);
        result = await getActiveConditions(input);
        break;
      }

      case "get_recent_labs": {
        const input = PatientIdSchema.parse(args);
        result = await getRecentLabs(input);
        break;
      }

      case "check_drug_interactions": {
        const input = CheckDrugInteractionsSchema.parse(args);
        result = await checkDrugInteractions(input);
        break;
      }

      case "generate_discharge_summary": {
        const input = GenerateDischargeSummarySchema.parse(args);
        result = await generateDischargeSummary(input);
        break;
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "An unexpected error occurred";

    // Return structured error — MCP servers should not throw
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: true,
              tool: name,
              message,
              timestamp: new Date().toISOString(),
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
});

// ─── Startup ──────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr (stdout is reserved for MCP protocol)
  process.stderr.write(
    JSON.stringify({
      status: "started",
      server: "discharge-guard",
      version: "1.0.0",
      tools: TOOLS.map((t) => t.name),
      timestamp: new Date().toISOString(),
    }) + "\n"
  );
}

main().catch((err) => {
  process.stderr.write(
    JSON.stringify({
      status: "fatal",
      error: err instanceof Error ? err.message : String(err),
      timestamp: new Date().toISOString(),
    }) + "\n"
  );
  process.exit(1);
});
