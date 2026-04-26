import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Request } from "express";
import { z } from "zod";
import { IMcpTool } from "../IMcpTool.js";
import { FhirUtilities } from "../fhir-utilities.js";
import { fhirClient } from "../utils/fhir-client.js";

class GetPatientSummaryTool implements IMcpTool {
  registerTool(server: McpServer, req: Request | undefined) {
    server.registerTool(
      "get_patient_summary",
      {
        description:
          "Retrieves patient demographics from FHIR R4. Returns name, DOB, age, gender, language, and GP. Includes SHARP context for agent handoff.",
        inputSchema: {
          patient_id: z
            .string()
            .describe("FHIR Patient resource ID. Optional if patient context exists.")
            .optional(),
        },
      },
      async ({ patient_id }) => {
        const id = patient_id ?? (FhirUtilities.getPatientIdIfContextExists(req as any) ? FhirUtilities.normalizePatientId(FhirUtilities.getPatientIdIfContextExists(req as any)!) : undefined);
        if (!id) return { content: [{ type: "text" as const, text: "patient_id required" }], isError: true };

        const { getPatientSummary } = await import("./fhir.js");
        const result = await getPatientSummary({ patient_id: id }, req as any);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      }
    );
  }
}

class GetActiveMedicationsTool implements IMcpTool {
  registerTool(server: McpServer, req: Request | undefined) {
    server.registerTool(
      "get_active_medications",
      {
        description:
          "Retrieves all active MedicationRequest resources for a patient from FHIR R4. Returns medication names, dosages, routes, and RxNorm codes.",
        inputSchema: {
          patient_id: z.string().optional(),
        },
      },
      async ({ patient_id }) => {
        const id = patient_id ?? (FhirUtilities.getPatientIdIfContextExists(req as any) ? FhirUtilities.normalizePatientId(FhirUtilities.getPatientIdIfContextExists(req as any)!) : undefined);
        if (!id) return { content: [{ type: "text" as const, text: "patient_id required" }], isError: true };

        const { getActiveMedications } = await import("./fhir.js");
        const result = await getActiveMedications({ patient_id: id }, req as any);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      }
    );
  }
}

class GetAllergiesTool implements IMcpTool {
  registerTool(server: McpServer, req: Request | undefined) {
    server.registerTool(
      "get_allergies",
      {
        description:
          "Retrieves allergy and intolerance records for a patient from FHIR R4. Flags high-criticality drug allergies.",
        inputSchema: {
          patient_id: z.string().optional(),
        },
      },
      async ({ patient_id }) => {
        const id = patient_id ?? (FhirUtilities.getPatientIdIfContextExists(req as any) ? FhirUtilities.normalizePatientId(FhirUtilities.getPatientIdIfContextExists(req as any)!) : undefined);
        if (!id) return { content: [{ type: "text" as const, text: "patient_id required" }], isError: true };

        const { getAllergies } = await import("./fhir.js");
        const result = await getAllergies({ patient_id: id }, req as any);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      }
    );
  }
}

class GetActiveConditionsTool implements IMcpTool {
  registerTool(server: McpServer, req: Request | undefined) {
    server.registerTool(
      "get_active_conditions",
      {
        description:
          "Retrieves active clinical conditions for a patient from FHIR R4. Returns diagnoses, severity, onset dates, and ICD/SNOMED codes.",
        inputSchema: {
          patient_id: z.string().optional(),
        },
      },
      async ({ patient_id }) => {
        const id = patient_id ?? (FhirUtilities.getPatientIdIfContextExists(req as any) ? FhirUtilities.normalizePatientId(FhirUtilities.getPatientIdIfContextExists(req as any)!) : undefined);
        if (!id) return { content: [{ type: "text" as const, text: "patient_id required" }], isError: true };

        const { getActiveConditions } = await import("./fhir.js");
        const result = await getActiveConditions({ patient_id: id }, req as any);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      }
    );
  }
}

class GetRecentLabsTool implements IMcpTool {
  registerTool(server: McpServer, req: Request | undefined) {
    server.registerTool(
      "get_recent_labs",
      {
        description:
          "Retrieves the 10 most recent lab observations for a patient from FHIR R4. Flags abnormal results.",
        inputSchema: {
          patient_id: z.string().optional(),
        },
      },
      async ({ patient_id }) => {
        const id = patient_id ?? (FhirUtilities.getPatientIdIfContextExists(req as any) ? FhirUtilities.normalizePatientId(FhirUtilities.getPatientIdIfContextExists(req as any)!) : undefined);
        if (!id) return { content: [{ type: "text" as const, text: "patient_id required" }], isError: true };

        const { getRecentLabs } = await import("./fhir.js");
        const result = await getRecentLabs({ patient_id: id }, req as any);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      }
    );
  }
}

class CheckDrugInteractionsTool implements IMcpTool {
  registerTool(server: McpServer, req: Request | undefined) {
    server.registerTool(
      "check_drug_interactions",
      {
        description:
          "Checks drug-drug interactions for a list of medications using OpenFDA label data. Returns interactions ranked by severity (HIGH/MODERATE/LOW).",
        inputSchema: {
          drug_names: z
            .array(z.string())
            .min(2)
            .describe("List of drug names to check. Minimum 2 required."),
        },
      },
      async ({ drug_names }) => {
        const { checkDrugInteractions } = await import("./drugs.js");
        const result = await checkDrugInteractions({ drug_names });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      }
    );
  }
}

class GenerateDischargeSummaryTool implements IMcpTool {
  registerTool(server: McpServer, req: Request | undefined) {
    server.registerTool(
      "generate_discharge_summary",
      {
        description:
          "Generates a comprehensive discharge safety summary. Produces a PCP handoff note and patient safety card. Addresses the 1-in-5 medication error rate at discharge.",
        inputSchema: {
          patient_id: z.string().optional(),
          include_patient_card: z.boolean().optional().default(true),
          include_pcp_note: z.boolean().optional().default(true),
        },
      },
      async ({ patient_id, include_patient_card, include_pcp_note }) => {
        const id = patient_id ?? (FhirUtilities.getPatientIdIfContextExists(req as any) ? FhirUtilities.normalizePatientId(FhirUtilities.getPatientIdIfContextExists(req as any)!) : undefined);
        if (!id) return { content: [{ type: "text" as const, text: "patient_id required" }], isError: true };

        const { generateDischargeSummary } = await import("./summary.js");
        const result = await generateDischargeSummary({
          patient_id: id,
          include_patient_card: include_patient_card ?? true,
          include_pcp_note: include_pcp_note ?? true,
        }, req as any);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      }
    );
  }
}

export const GetPatientSummaryToolInstance = new GetPatientSummaryTool();
export const GetActiveMedicationsToolInstance = new GetActiveMedicationsTool();
export const GetAllergiesToolInstance = new GetAllergiesTool();
export const GetActiveConditionsToolInstance = new GetActiveConditionsTool();
export const GetRecentLabsToolInstance = new GetRecentLabsTool();
export const CheckDrugInteractionsToolInstance = new CheckDrugInteractionsTool();
export const GenerateDischargeSummaryToolInstance = new GenerateDischargeSummaryTool();
