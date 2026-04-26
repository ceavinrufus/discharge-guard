/**
 * Discharge Summary Generation Tool
 *
 * Orchestrates all FHIR data retrieval tools and drug interaction checking
 * to produce two structured outputs:
 *
 * 1. PCP Handoff Note — A clinical summary for the primary care provider,
 *    structured in SOAP-like format with medication safety flags.
 *
 * 2. Patient Safety Card — A plain-language medication guide for the patient,
 *    appropriate for a 6th-grade reading level (AHRQ recommendation).
 *    Includes pediatric-appropriate language when applicable (CHOP standard).
 *
 * Designed to reduce the ~1-in-5 patient discharge medication error rate
 * and prevent adverse drug events (ADEs) that cost $21B/year in the US.
 */

import { z } from "zod";
import { Request } from "express";
import { getPatientSummary, getActiveMedications, getAllergies, getActiveConditions, getRecentLabs, buildSharpContext } from "./fhir.js";
import { checkDrugInteractions } from "./drugs.js";

// ─── Input schema ─────────────────────────────────────────────────────────────

export const GenerateDischargeSummarySchema = z.object({
  patient_id: z
    .string()
    .min(1)
    .describe("FHIR Patient resource ID on the HAPI FHIR R4 server"),
  include_patient_card: z
    .boolean()
    .optional()
    .default(true)
    .describe("Whether to include a plain-language patient safety card"),
  include_pcp_note: z
    .boolean()
    .optional()
    .default(true)
    .describe("Whether to include the PCP handoff note"),
});

// ─── Type helpers ─────────────────────────────────────────────────────────────

interface MedicationInfo {
  name: string;
  dosage_text?: string;
  dose?: string;
  route?: string;
}

// ─── Tool handler ─────────────────────────────────────────────────────────────

/**
 * Generates a comprehensive discharge summary by orchestrating all data sources.
 *
 * Parallel data collection strategy:
 * - Patient demographics, medications, allergies, conditions, and labs are
 *   fetched concurrently to minimize latency.
 * - Drug interactions are checked after medications are retrieved.
 *
 * @param input - Validated input with patient_id and output format flags
 */
export async function generateDischargeSummary(
  input: z.infer<typeof GenerateDischargeSummarySchema>,
  req?: Request | undefined
) {
  const { patient_id, include_patient_card, include_pcp_note } = input;
  const generatedAt = new Date().toISOString();

  // ── Phase 1: Parallel FHIR data collection ──────────────────────────────────
  const [patientResult, medicationsResult, allergiesResult, conditionsResult, labsResult] =
    await Promise.allSettled([
      getPatientSummary({ patient_id }, req),
      getActiveMedications({ patient_id }, req),
      getAllergies({ patient_id }, req),
      getActiveConditions({ patient_id }, req),
      getRecentLabs({ patient_id }, req),
    ]);

  const patient =
    patientResult.status === "fulfilled"
      ? (patientResult.value as Record<string, unknown>)
      : null;
  const medications =
    medicationsResult.status === "fulfilled" ? medicationsResult.value : null;
  const allergies =
    allergiesResult.status === "fulfilled" ? allergiesResult.value : null;
  const conditions =
    conditionsResult.status === "fulfilled" ? conditionsResult.value : null;
  const labs = labsResult.status === "fulfilled" ? labsResult.value : null;

  // ── Phase 2: Drug interaction check ─────────────────────────────────────────
  const medNames = (medications?.medications ?? [])
    .map((m: MedicationInfo) => m.name)
    .filter((name: string) => name && name !== "Unknown medication");

  let interactionResult = null;
  if (medNames.length >= 2) {
    try {
      interactionResult = await checkDrugInteractions({
        drug_names: medNames,
      });
    } catch {
      // Non-fatal: proceed without interaction data
    }
  }

  // ── Phase 3: Safety flag analysis ───────────────────────────────────────────
  const safetyFlags = buildSafetyFlags({
    medications: medications?.medications ?? [],
    allergies: allergies?.drug_allergies ?? [],
    interactions: interactionResult,
    abnormalLabs: labs?.abnormal_labs ?? [],
    patientAge: (patient?.age as number | undefined) ?? null,
  });

  // ── Phase 4: Generate outputs ────────────────────────────────────────────────
  const outputs: Record<string, unknown> = {
    patient_id,
    generated_at: generatedAt,
    data_sources: {
      fhir_server: "https://hapi.fhir.org/baseR4",
      drug_interactions: "NLM RxNav (https://rxnav.nlm.nih.gov)",
      standard: "FHIR R4 (HL7)",
    },
    patient_summary: patient,
    medication_count: medications?.total ?? 0,
    allergy_count: allergies?.total ?? 0,
    condition_count: conditions?.total ?? 0,
    lab_count: labs?.total ?? 0,
    safety_flags: safetyFlags,
    interaction_summary: interactionResult
      ? {
          risk_level: interactionResult.overall_risk_level,
          risk_summary: interactionResult.risk_summary,
          interaction_count: interactionResult.interaction_count,
          high_severity_count: interactionResult.high_severity_count,
        }
      : { note: "Drug interaction check skipped (fewer than 2 medications)" },
    raw_data: {
      medications: medications?.medications ?? [],
      allergies: allergies?.allergies ?? [],
      conditions: conditions?.conditions ?? [],
      labs: labs?.labs ?? [],
      drug_interactions: interactionResult?.interactions ?? [],
    },
    ...buildSharpContext(patient_id, {
      summaryGeneratedAt: generatedAt,
      medicationCount: medications?.total ?? 0,
      interactionRisk: interactionResult?.overall_risk_level ?? "NOT_CHECKED",
    }),
  };

  if (include_pcp_note) {
    outputs.pcp_handoff_note = generatePcpNote({
      patient,
      medications: medications?.medications ?? [],
      allergies: allergies?.allergies ?? [],
      conditions: conditions?.conditions ?? [],
      labs: labs?.labs ?? [],
      abnormalLabs: labs?.abnormal_labs ?? [],
      interactions: interactionResult,
      safetyFlags,
      generatedAt,
    });
  }

  if (include_patient_card) {
    outputs.patient_safety_card = generatePatientCard({
      patient,
      medications: medications?.medications ?? [],
      allergies: allergies?.drug_allergies ?? [],
      interactions: interactionResult,
      patientAge: (patient?.age as number | undefined) ?? null,
    });
  }

  return outputs;
}

// ─── Safety flag builder ──────────────────────────────────────────────────────

interface SafetyFlagInput {
  medications: Array<MedicationInfo & { name: string }>;
  allergies: Array<{ substance: string; criticality?: string }>;
  interactions: { overall_risk_level: string; interactions: Array<{ drug1: string; drug2: string; severity: string; description: string }> } | null;
  abnormalLabs: Array<{ name: string; value?: string | number; unit?: string; interpretation?: string }>;
  patientAge: number | null;
}

function buildSafetyFlags(input: SafetyFlagInput) {
  const flags: Array<{
    type: string;
    severity: "critical" | "warning" | "info";
    message: string;
  }> = [];

  // Drug interaction flags
  if (input.interactions?.overall_risk_level === "HIGH") {
    for (const interaction of input.interactions.interactions.filter(
      (i) => i.severity === "high"
    )) {
      flags.push({
        type: "DRUG_INTERACTION",
        severity: "critical",
        message: `HIGH severity interaction: ${interaction.drug1} + ${interaction.drug2}. ${interaction.description}`,
      });
    }
  } else if (input.interactions?.overall_risk_level === "MODERATE") {
    for (const interaction of input.interactions.interactions.filter(
      (i) => i.severity === "moderate"
    )) {
      flags.push({
        type: "DRUG_INTERACTION",
        severity: "warning",
        message: `Moderate interaction: ${interaction.drug1} + ${interaction.drug2}. ${interaction.description}`,
      });
    }
  }

  // Allergy flags
  for (const allergy of input.allergies.filter(
    (a) => a.criticality === "high"
  )) {
    flags.push({
      type: "DRUG_ALLERGY",
      severity: "critical",
      message: `HIGH criticality drug allergy: ${allergy.substance}. Verify no prescribed medications contain this substance.`,
    });
  }

  // Abnormal lab flags
  for (const lab of input.abnormalLabs) {
    flags.push({
      type: "ABNORMAL_LAB",
      severity: "warning",
      message: `Abnormal lab: ${lab.name} = ${lab.value ?? "?"} ${lab.unit ?? ""} (${lab.interpretation ?? "abnormal"})`,
    });
  }

  // Polypharmacy flag (≥5 medications is a recognized risk factor)
  if (input.medications.length >= 5) {
    flags.push({
      type: "POLYPHARMACY",
      severity: "warning",
      message: `Polypharmacy alert: Patient has ${input.medications.length} active medications. ` +
        `Consider medication reconciliation review.`,
    });
  }

  // Pediatric flag
  if (input.patientAge !== null && input.patientAge < 18) {
    flags.push({
      type: "PEDIATRIC_PATIENT",
      severity: "info",
      message: `Pediatric patient (age ${input.patientAge}). Verify weight-based dosing and ` +
        `age-appropriate formulations per CHOP/AAP guidelines.`,
    });
  }

  return {
    total: flags.length,
    critical_count: flags.filter((f) => f.severity === "critical").length,
    warning_count: flags.filter((f) => f.severity === "warning").length,
    flags,
  };
}

// ─── PCP Handoff Note generator ───────────────────────────────────────────────

interface PcpNoteInput {
  patient: Record<string, unknown> | null;
  medications: Array<MedicationInfo & { name: string; authored_on?: string; prescriber?: string }>;
  allergies: Array<{ substance: string; criticality?: string; reactions?: Array<{ manifestations?: string[] }> }>;
  conditions: Array<{ name: string; onset_date?: string; severity?: string }>;
  labs: Array<{ name: string; value?: string | number; unit?: string; effective_date?: string; is_abnormal?: boolean }>;
  abnormalLabs: Array<{ name: string; value?: string | number; unit?: string; interpretation?: string }>;
  interactions: { overall_risk_level: string; risk_summary: string; interactions: Array<{ drug1: string; drug2: string; severity: string; description: string }> } | null;
  safetyFlags: { flags: Array<{ severity: string; message: string }> };
  generatedAt: string;
}

function generatePcpNote(input: PcpNoteInput): string {
  const p = input.patient ?? {};
  const patientName = (p.name as string) ?? "Unknown Patient";
  const patientDob = (p.birth_date as string) ?? "Unknown";
  const patientAge = (p.age as number | null) ?? null;
  const gender = (p.gender as string) ?? "Unknown";

  const lines: string[] = [
    "═══════════════════════════════════════════════════════════════",
    "                    DISCHARGE HANDOFF NOTE",
    "             Generated by DischargeGuard MCP Server",
    "═══════════════════════════════════════════════════════════════",
    "",
    `Date/Time: ${new Date(input.generatedAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC`,
    `Patient: ${patientName}`,
    `DOB: ${patientDob}${patientAge !== null ? ` (Age: ${patientAge})` : ""}`,
    `Gender: ${gender}`,
    "",
    "───────────────────────────────────────────────────────────────",
    "MEDICATION SAFETY SUMMARY",
    "───────────────────────────────────────────────────────────────",
  ];

  // Safety flags section
  const criticalFlags = input.safetyFlags.flags.filter(
    (f) => f.severity === "critical"
  );
  const warningFlags = input.safetyFlags.flags.filter(
    (f) => f.severity === "warning"
  );

  if (criticalFlags.length > 0) {
    lines.push("⚠️  CRITICAL ALERTS:");
    for (const flag of criticalFlags) {
      lines.push(`   • ${flag.message}`);
    }
    lines.push("");
  }

  if (warningFlags.length > 0) {
    lines.push("⚡ WARNINGS:");
    for (const flag of warningFlags) {
      lines.push(`   • ${flag.message}`);
    }
    lines.push("");
  }

  if (criticalFlags.length === 0 && warningFlags.length === 0) {
    lines.push("✅ No critical medication safety alerts identified.");
    lines.push("");
  }

  // Drug interactions
  lines.push("───────────────────────────────────────────────────────────────");
  lines.push("DRUG INTERACTION ASSESSMENT");
  lines.push("───────────────────────────────────────────────────────────────");

  if (input.interactions) {
    lines.push(`Risk Level: ${input.interactions.overall_risk_level}`);
    lines.push(input.interactions.risk_summary);
    if (input.interactions.interactions.length > 0) {
      lines.push("");
      lines.push("Identified interactions:");
      for (const interaction of input.interactions.interactions) {
        lines.push(
          `  [${interaction.severity.toUpperCase()}] ${interaction.drug1} ↔ ${interaction.drug2}`
        );
        lines.push(`    ${interaction.description}`);
      }
    }
  } else {
    lines.push("Drug interaction check not performed (insufficient medications).");
  }

  lines.push("");
  lines.push("───────────────────────────────────────────────────────────────");
  lines.push("ACTIVE MEDICATIONS");
  lines.push("───────────────────────────────────────────────────────────────");

  if (input.medications.length === 0) {
    lines.push("No active medications on record.");
  } else {
    for (const med of input.medications) {
      lines.push(`• ${med.name}`);
      if (med.dosage_text) lines.push(`    Dosage: ${med.dosage_text}`);
      if (med.dose && med.route) lines.push(`    ${med.dose} via ${med.route}`);
      else if (med.dose) lines.push(`    Dose: ${med.dose}`);
      if (med.prescriber) lines.push(`    Prescribed by: ${med.prescriber}`);
      if (med.authored_on) lines.push(`    Date: ${med.authored_on}`);
    }
  }

  lines.push("");
  lines.push("───────────────────────────────────────────────────────────────");
  lines.push("ALLERGIES & INTOLERANCES");
  lines.push("───────────────────────────────────────────────────────────────");

  if (input.allergies.length === 0) {
    lines.push("NKDA (No Known Drug Allergies)");
  } else {
    for (const allergy of input.allergies) {
      const reactions = allergy.reactions
        ?.flatMap((r) => r.manifestations ?? [])
        .join(", ");
      lines.push(
        `• ${allergy.substance} [${(allergy.criticality ?? "unknown").toUpperCase()} criticality]`
      );
      if (reactions) lines.push(`    Reaction: ${reactions}`);
    }
  }

  lines.push("");
  lines.push("───────────────────────────────────────────────────────────────");
  lines.push("ACTIVE CONDITIONS");
  lines.push("───────────────────────────────────────────────────────────────");

  if (input.conditions.length === 0) {
    lines.push("No active conditions on record.");
  } else {
    for (const cond of input.conditions) {
      lines.push(`• ${cond.name}`);
      if (cond.severity) lines.push(`    Severity: ${cond.severity}`);
      if (cond.onset_date) lines.push(`    Onset: ${cond.onset_date}`);
    }
  }

  lines.push("");
  lines.push("───────────────────────────────────────────────────────────────");
  lines.push("RECENT LABORATORY RESULTS");
  lines.push("───────────────────────────────────────────────────────────────");

  if (input.labs.length === 0) {
    lines.push("No recent laboratory results available.");
  } else {
    for (const lab of input.labs) {
      const abnormalMarker = lab.is_abnormal ? " ⚠️ ABNORMAL" : "";
      lines.push(
        `• ${lab.name}: ${lab.value ?? "N/A"} ${lab.unit ?? ""}${abnormalMarker}`
      );
      if (lab.effective_date) lines.push(`    Date: ${lab.effective_date}`);
    }
  }

  lines.push("");
  lines.push("───────────────────────────────────────────────────────────────");
  lines.push("RECOMMENDED FOLLOW-UP ACTIONS");
  lines.push("───────────────────────────────────────────────────────────────");
  lines.push("1. Review and reconcile all medications listed above");
  lines.push("2. Confirm patient understanding of new medication regimen");
  lines.push("3. Schedule follow-up within 7 days per discharge protocol");
  if (input.abnormalLabs.length > 0) {
    lines.push(`4. Follow up on ${input.abnormalLabs.length} abnormal lab result(s)`);
  }
  if (criticalFlags.length > 0) {
    lines.push("5. ⚠️  Address critical medication safety alerts before discharge");
  }

  lines.push("");
  lines.push("───────────────────────────────────────────────────────────────");
  lines.push("Data Sources: HAPI FHIR R4 | NLM RxNav | NLM RxNorm");
  lines.push("Generated by: DischargeGuard MCP Server");
  lines.push("SHARP Context: Patient context propagated via SHARP v1.0 spec");
  lines.push("═══════════════════════════════════════════════════════════════");

  return lines.join("\n");
}

// ─── Patient Safety Card generator ───────────────────────────────────────────

interface PatientCardInput {
  patient: Record<string, unknown> | null;
  medications: Array<MedicationInfo & { name: string }>;
  allergies: Array<{ substance: string }>;
  interactions: { interactions: Array<{ drug1: string; drug2: string; severity: string }> } | null;
  patientAge: number | null;
}

function generatePatientCard(input: PatientCardInput): string {
  const patientName = (input.patient?.name as string) ?? "Patient";
  const isChild = input.patientAge !== null && input.patientAge < 18;

  const lines: string[] = [
    "╔═══════════════════════════════════════════════════════════════╗",
    "║            YOUR MEDICATION SAFETY CARD                       ║",
    "║                  From Your Care Team                         ║",
    "╚═══════════════════════════════════════════════════════════════╝",
    "",
    `Dear ${isChild ? `Caregiver of ` : ""}${patientName},`,
    "",
    "This card lists your medications and important safety information.",
    "Keep this card with you and show it to ALL your doctors and pharmacists.",
    "",
  ];

  if (isChild) {
    lines.push(
      "📋 PEDIATRIC NOTE: Dosing is based on your child's weight and age."
    );
    lines.push(
      "   Contact your pediatrician before changing any medication dose."
    );
    lines.push("");
  }

  // Medications section
  lines.push("💊 YOUR MEDICATIONS");
  lines.push("─".repeat(63));

  if (input.medications.length === 0) {
    lines.push("No medications were prescribed at discharge.");
  } else {
    for (let i = 0; i < input.medications.length; i++) {
      const med = input.medications[i];
      lines.push(`${i + 1}. ${med.name}`);
      if (med.dosage_text) {
        lines.push(`   How to take it: ${med.dosage_text}`);
      } else if (med.dose) {
        lines.push(`   Dose: ${med.dose}`);
      }
      lines.push("");
    }
  }

  // Drug allergies
  if (input.allergies.length > 0) {
    lines.push("🚫 YOUR DRUG ALLERGIES — ALWAYS TELL YOUR DOCTOR");
    lines.push("─".repeat(63));
    for (const allergy of input.allergies) {
      lines.push(`   • ${allergy.substance}`);
    }
    lines.push("");
  }

  // Interaction warnings (patient-friendly)
  const seriousInteractions = input.interactions?.interactions.filter(
    (i) => i.severity === "high" || i.severity === "moderate"
  ) ?? [];

  if (seriousInteractions.length > 0) {
    lines.push("⚠️  IMPORTANT: MEDICATION WARNINGS");
    lines.push("─".repeat(63));
    lines.push(
      "Some of your medications may interact. Your doctor knows about this."
    );
    lines.push("Watch for these problems and call your doctor right away if");
    lines.push("you feel worse or have new symptoms.");
    lines.push("");
    for (const interaction of seriousInteractions) {
      lines.push(`   • ${interaction.drug1} and ${interaction.drug2} may interact.`);
    }
    lines.push("");
  }

  // General safety tips
  lines.push("✅ MEDICATION SAFETY TIPS");
  lines.push("─".repeat(63));
  lines.push("• Take all medications exactly as prescribed.");
  lines.push("• Do not stop medications without talking to your doctor.");
  lines.push("• Tell all your doctors about ALL medications you take,");
  lines.push("  including vitamins, supplements, and over-the-counter drugs.");
  lines.push("• Keep medications away from children.");
  lines.push("• Store medications at room temperature unless told otherwise.");
  lines.push("");

  // Emergency contacts
  lines.push("📞 IMPORTANT PHONE NUMBERS");
  lines.push("─".repeat(63));
  lines.push("• Your doctor's office:    ___________________________");
  lines.push("• Your pharmacy:           ___________________________");
  lines.push("• If you have a problem with your medication, call your");
  lines.push("  doctor or go to the nearest emergency room.");
  lines.push("• Poison Control Center:   1-800-222-1222");
  lines.push("");
  lines.push("─".repeat(63));
  lines.push("DischargeGuard | Protecting patients at every discharge");

  return lines.join("\n");
}
