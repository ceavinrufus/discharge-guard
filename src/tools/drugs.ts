/**
 * Drug Interaction MCP Tools
 *
 * Implements the check_drug_interactions MCP tool.
 * Workflow:
 *   1. Accept a list of drug names
 *   2. Resolve each name to an RxCUI via NLM RxNorm
 *   3. Check interactions via NLM RxNav
 *   4. Return structured results with severity classification
 *
 * Severity levels follow the NLM interaction severity vocabulary.
 */

import { z } from "zod";
import { drugClient } from "../utils/drug-client.js";

// ─── Input schema ─────────────────────────────────────────────────────────────

export const CheckDrugInteractionsSchema = z.object({
  drug_names: z
    .array(z.string().min(1))
    .min(2)
    .describe(
      "List of drug names (brand or generic) to check for interactions. Minimum 2 drugs required."
    ),
});

// ─── Tool handler ─────────────────────────────────────────────────────────────

/**
 * Checks drug-drug interactions for a list of medication names.
 *
 * Steps:
 * 1. Normalize each drug name to an RxCUI via NLM RxNorm API
 * 2. Submit resolved RxCUIs to NLM RxNav interaction checker
 * 3. Return interactions ranked by severity
 *
 * Note: Drugs that cannot be resolved to an RxCUI are listed as
 * "unresolvable" — this may indicate misspelling, compound drugs,
 * or drugs not in RxNorm (e.g., herbal supplements).
 *
 * @param input - Validated input containing drug_names array
 */
export async function checkDrugInteractions(
  input: z.infer<typeof CheckDrugInteractionsSchema>
) {
  const { drug_names } = input;

  const result = await drugClient.checkDrugInteractions(drug_names);

  // Sort interactions by severity (high → moderate → low → unknown)
  const severityOrder = { high: 0, moderate: 1, low: 2, unknown: 3 };
  const sortedInteractions = [...result.interactions].sort(
    (a, b) =>
      (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3)
  );

  const highSeverityCount = sortedInteractions.filter(
    (i) => i.severity === "high"
  ).length;
  const moderateSeverityCount = sortedInteractions.filter(
    (i) => i.severity === "moderate"
  ).length;

  // Build clinical risk summary
  const riskLevel =
    highSeverityCount > 0
      ? "HIGH"
      : moderateSeverityCount > 0
        ? "MODERATE"
        : sortedInteractions.length > 0
          ? "LOW"
          : "NONE";

  const riskSummary = buildRiskSummary(riskLevel, sortedInteractions.length);

  return {
    checked_drugs: result.drugs.map((d) => ({
      name: d.name,
      rxcui: d.rxcui,
      resolved: d.normalized,
    })),
    unresolvable_drugs: result.unresolvableDrugs,
    interaction_count: sortedInteractions.length,
    high_severity_count: highSeverityCount,
    moderate_severity_count: moderateSeverityCount,
    overall_risk_level: riskLevel,
    risk_summary: riskSummary,
    interactions: sortedInteractions,
    checked_at: result.checkedAt,
    data_source: "NLM RxNav Drug Interactions API (https://rxnav.nlm.nih.gov)",
  };
}

/**
 * Builds a human-readable risk summary for clinical decision support.
 */
function buildRiskSummary(
  riskLevel: string,
  interactionCount: number
): string {
  switch (riskLevel) {
    case "HIGH":
      return (
        `⚠️  HIGH RISK: ${interactionCount} drug interaction(s) detected, ` +
        `including at least one HIGH severity interaction. ` +
        `Immediate clinical review required before discharge. ` +
        `Consider contacting pharmacist or adjusting medication regimen.`
      );
    case "MODERATE":
      return (
        `⚡ MODERATE RISK: ${interactionCount} drug interaction(s) detected. ` +
        `Clinical review recommended. Monitor patient closely after discharge ` +
        `and counsel on potential adverse effects.`
      );
    case "LOW":
      return (
        `ℹ️  LOW RISK: ${interactionCount} minor drug interaction(s) detected. ` +
        `Standard monitoring applies. Include interaction information in patient education.`
      );
    default:
      return `✅ No clinically significant drug interactions detected among the checked medications.`;
  }
}
