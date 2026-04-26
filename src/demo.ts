/**
 * DischargeGuard Demo Script
 *
 * Demonstrates all MCP tools by running them against a real HAPI FHIR patient.
 *
 * Usage:
 *   npm run build && node dist/demo.js <patient_id>
 *
 * Recommended demo patient (10 active medications):
 *   node dist/demo.js 131284056
 */

import {
  getPatientSummary,
  getActiveMedications,
  getAllergies,
  getActiveConditions,
  getRecentLabs,
} from "./tools/fhir.js";
import { checkDrugInteractions } from "./tools/drugs.js";

const SEP = "─".repeat(60);

function header(title: string): void {
  console.log(`\n${SEP}`);
  console.log(`  ${title}`);
  console.log(SEP);
}

async function runDemo(patientId: string): Promise<void> {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  DischargeGuard MCP Server — Demo`);
  console.log(`  Patient ID: ${patientId}`);
  console.log(`${"═".repeat(60)}`);

  // ── 1. Patient Summary ──────────────────────────────────────────────────────
  header("TOOL: get_patient_summary");
  try {
    const summary = await getPatientSummary({ patient_id: patientId });
    if ("error" in summary && summary.error) {
      console.error("ERROR:", summary.error);
    } else {
      const s = summary as Exclude<typeof summary, { error: string }>;
      console.log(`Name:     ${s.name}`);
      console.log(`DOB:      ${s.birth_date}  (Age: ${s.age})`);
      console.log(`Gender:   ${s.gender}`);
      if (s.preferred_language) console.log(`Language: ${s.preferred_language}`);
      if (s.general_practitioner) console.log(`GP:       ${s.general_practitioner}`);
    }
  } catch (err) {
    console.error("ERROR:", err instanceof Error ? err.message : err);
  }

  // ── 2. Active Medications ───────────────────────────────────────────────────
  header("TOOL: get_active_medications");
  let drugNames: string[] = [];
  try {
    const meds = await getActiveMedications({ patient_id: patientId });
    console.log(`Active medication count: ${meds.total}`);
    if (meds.total >= 5) {
      console.log(`⚠️  POLYPHARMACY: Patient is on ${meds.total} medications — review recommended`);
    }
    console.log("\nMedications:");
    for (const med of meds.medications) {
      console.log(`  • ${med.name}`);
      if (med.dosage_text) console.log(`    Dosage: ${med.dosage_text}`);
    }
    drugNames = meds.medications.map((m) => m.name).filter(Boolean).slice(0, 8);
  } catch (err) {
    console.error("ERROR:", err instanceof Error ? err.message : err);
  }

  // ── 3. Allergies ────────────────────────────────────────────────────────────
  header("TOOL: get_allergies");
  try {
    const allergies = await getAllergies({ patient_id: patientId });
    console.log(`Allergy count: ${allergies.total}`);
    if (allergies.drug_allergies_count > 0) {
      console.log(`⚠️  Drug allergies: ${allergies.drug_allergies_count}`);
    }
    for (const a of allergies.allergies.slice(0, 5)) {
      console.log(`  • ${a.substance} (criticality: ${a.criticality ?? "unknown"})`);
    }
    if (allergies.total > 5) console.log(`  ... and ${allergies.total - 5} more`);
  } catch (err) {
    console.error("ERROR:", err instanceof Error ? err.message : err);
  }

  // ── 4. Active Conditions ─────────────────────────────────────────────────
  header("TOOL: get_active_conditions");
  try {
    const conditions = await getActiveConditions({ patient_id: patientId });
    console.log(`Active condition count: ${conditions.total}`);
    for (const c of conditions.conditions.slice(0, 6)) {
      console.log(`  • ${c.name}`);
    }
    if (conditions.total > 6) console.log(`  ... and ${conditions.total - 6} more`);
  } catch (err) {
    console.error("ERROR:", err instanceof Error ? err.message : err);
  }

  // ── 5. Recent Labs ──────────────────────────────────────────────────────────
  header("TOOL: get_recent_labs");
  try {
    const labs = await getRecentLabs({ patient_id: patientId });
    console.log(`Lab results returned: ${labs.total}`);
    if (labs.abnormal_count > 0) console.log(`⚠️  Abnormal results: ${labs.abnormal_count}`);
    for (const lab of labs.labs.slice(0, 6)) {
      const flag = lab.is_abnormal ? ` [${lab.interpretation}]` : "";
      console.log(`  • ${lab.name}: ${lab.value ?? "N/A"} ${lab.unit ?? ""}${flag}`);
    }
  } catch (err) {
    console.error("ERROR:", err instanceof Error ? err.message : err);
  }

  // ── 6. Drug Interactions ─────────────────────────────────────────────────
  if (drugNames.length >= 2) {
    header("TOOL: check_drug_interactions");
    console.log(`Checking interactions for: ${drugNames.join(", ")}`);
    try {
      const result = await checkDrugInteractions({ drug_names: drugNames });
      console.log(`\nOverall risk: ${result.overall_risk_level}`);
      console.log(result.risk_summary);
      const resolved = result.checked_drugs.filter((d) => d.resolved).length;
      console.log(`\nResolved drugs: ${resolved}/${drugNames.length}`);
      if (result.unresolvable_drugs.length > 0) {
        console.log(`Unresolvable: ${result.unresolvable_drugs.join(", ")}`);
      }
      if (result.interaction_count > 0) {
        console.log(`\nInteractions found (${result.interaction_count}):`);
        for (const ix of result.interactions.slice(0, 5)) {
          console.log(`  [${ix.severity.toUpperCase()}] ${ix.drug1} ↔ ${ix.drug2}`);
          console.log(`    ${ix.description.slice(0, 150)}...`);
        }
      }
    } catch (err) {
      console.error("ERROR:", err instanceof Error ? err.message : err);
    }
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log("  Demo complete.");
  console.log(`${"═".repeat(60)}\n`);
}

// ── Entry point ──────────────────────────────────────────────────────────────

const patientId = process.argv[2] ?? "131284056";
runDemo(patientId).catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
