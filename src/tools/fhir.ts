/**
 * FHIR MCP Tools
 *
 * Implements MCP tool handlers for FHIR R4 resource retrieval:
 * - get_patient_summary
 * - get_active_medications
 * - get_allergies
 * - get_active_conditions
 * - get_recent_labs
 *
 * Uses SHARP context extension spec (https://www.sharponmcp.com) for patient
 * context propagation across tool calls.
 */

import { z } from "zod";
import {
  fhirClient,
  type FhirPatient,
  type FhirMedicationRequest,
  type FhirAllergyIntolerance,
  type FhirCondition,
  type FhirObservation,
} from "../utils/fhir-client.js";

// ─── Input schemas ────────────────────────────────────────────────────────────

export const PatientIdSchema = z.object({
  patient_id: z
    .string()
    .min(1)
    .describe("FHIR Patient resource ID on the HAPI FHIR R4 server"),
});

// ─── SHARP context helpers ────────────────────────────────────────────────────

/**
 * Builds a SHARP (Shareable Health Agent Resource Protocol) context object
 * for embedding patient context in tool responses.
 *
 * SHARP ensures downstream agents/tools receive patient identity without
 * requiring re-authentication. See https://www.sharponmcp.com
 */
export function buildSharpContext(
  patientId: string,
  additionalContext?: Record<string, unknown>
) {
  return {
    sharp: {
      version: "1.0",
      resourceType: "Patient",
      resourceId: patientId,
      fhirBaseUrl: "https://hapi.fhir.org/baseR4",
      timestamp: new Date().toISOString(),
      ...additionalContext,
    },
  };
}

// ─── Helper utilities ─────────────────────────────────────────────────────────

/**
 * Extracts the primary human name from a FHIR Patient resource.
 */
function extractPatientName(patient: FhirPatient): string {
  const official = patient.name?.find((n) => n.use === "official");
  const name = official ?? patient.name?.[0];
  if (!name) return "Unknown";

  if (name.text) return name.text;

  const given = name.given?.join(" ") ?? "";
  const family = name.family ?? "";
  return [given, family].filter(Boolean).join(" ") || "Unknown";
}

/**
 * Calculates patient age from birth date string (FHIR date format: YYYY-MM-DD).
 */
function calculateAge(birthDate?: string): number | null {
  if (!birthDate) return null;
  const birth = new Date(birthDate);
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const monthDiff = today.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
    age--;
  }
  return age;
}

/**
 * Extracts the display text from a FHIR CodeableConcept.
 */
function codeableConceptText(
  concept?: FhirMedicationRequest["medicationCodeableConcept"]
): string {
  if (!concept) return "Unknown medication";
  if (concept.text) return concept.text;
  return (
    concept.coding?.find((c) => c.display)?.display ?? "Unknown medication"
  );
}

// ─── Tool handlers ────────────────────────────────────────────────────────────

/**
 * Retrieves a structured summary of a FHIR Patient resource.
 *
 * @param input - Validated tool input containing patient_id
 */
export async function getPatientSummary(
  input: z.infer<typeof PatientIdSchema>
) {
  const { patient_id } = input;

  let patient: FhirPatient;
  try {
    patient = await fhirClient.getResource<FhirPatient>("Patient", patient_id);
  } catch (err) {
    return {
      error: `Failed to fetch patient ${patient_id}: ${err instanceof Error ? err.message : String(err)}`,
      patient_id,
      ...buildSharpContext(patient_id),
    };
  }

  const name = extractPatientName(patient);
  const age = calculateAge(patient.birthDate);
  const gender = patient.gender ?? "unknown";

  const address = patient.address?.[0];
  const addressStr = address
    ? [
        address.line?.join(", "),
        address.city,
        address.state,
        address.postalCode,
      ]
        .filter(Boolean)
        .join(", ")
    : undefined;

  const phone = patient.telecom?.find((t) => t.system === "phone")?.value;
  const email = patient.telecom?.find((t) => t.system === "email")?.value;

  const language = patient.communication?.find((c) => c.preferred)?.language
    .coding?.[0]?.display;

  return {
    patient_id,
    name,
    birth_date: patient.birthDate,
    age,
    gender,
    address: addressStr,
    phone,
    email,
    preferred_language: language,
    general_practitioner: patient.generalPractitioner?.[0]?.display,
    fhir_last_updated: patient.meta?.lastUpdated,
    ...buildSharpContext(patient_id, { patientName: name, patientAge: age }),
  };
}

/**
 * Retrieves active medication requests for a patient.
 * Returns a list of medications with dosage and prescriber information.
 *
 * @param input - Validated tool input containing patient_id
 */
export async function getActiveMedications(
  input: z.infer<typeof PatientIdSchema>
) {
  const { patient_id } = input;

  let medications: FhirMedicationRequest[] = [];
  let fetchError: string | undefined;

  try {
    const bundle = await fhirClient.searchResources<FhirMedicationRequest>(
      "MedicationRequest",
      { patient: patient_id, status: "active", _count: "50" }
    );
    medications = fhirClient.extractResources(bundle);
  } catch (err) {
    fetchError = `Failed to fetch medications: ${err instanceof Error ? err.message : String(err)}`;
  }

  const formattedMeds = medications.map((med) => {
    const name = med.medicationCodeableConcept
      ? codeableConceptText(med.medicationCodeableConcept)
      : med.medicationReference?.display ?? "Unknown medication";

    const dosageText = med.dosageInstruction?.[0]?.text;
    const route =
      med.dosageInstruction?.[0]?.route?.coding?.[0]?.display;
    const doseQty =
      med.dosageInstruction?.[0]?.doseAndRate?.[0]?.doseQuantity;
    const dose = doseQty
      ? `${doseQty.value} ${doseQty.unit}`
      : undefined;

    const rxcodes = med.medicationCodeableConcept?.coding?.filter(
      (c) => c.system === "http://www.nlm.nih.gov/research/umls/rxnorm"
    );

    return {
      id: med.id,
      name,
      status: med.status,
      authored_on: med.authoredOn,
      dosage_text: dosageText,
      dose,
      route,
      prescriber: med.requester?.display,
      rxnorm_codes: rxcodes?.map((c) => ({ code: c.code, display: c.display })),
      notes: med.note?.map((n) => n.text).join("; "),
    };
  });

  return {
    patient_id,
    total: formattedMeds.length,
    medications: formattedMeds,
    ...(fetchError ? { error: fetchError } : {}),
    ...buildSharpContext(patient_id, {
      medicationCount: formattedMeds.length,
      medicationNames: formattedMeds.map((m) => m.name),
    }),
  };
}

/**
 * Retrieves allergy and intolerance records for a patient.
 *
 * @param input - Validated tool input containing patient_id
 */
export async function getAllergies(input: z.infer<typeof PatientIdSchema>) {
  const { patient_id } = input;

  let allergies: FhirAllergyIntolerance[] = [];
  let fetchError: string | undefined;

  try {
    const bundle = await fhirClient.searchResources<FhirAllergyIntolerance>(
      "AllergyIntolerance",
      { patient: patient_id, _count: "50" }
    );
    allergies = fhirClient.extractResources(bundle);
  } catch (err) {
    fetchError = `Failed to fetch allergies: ${err instanceof Error ? err.message : String(err)}`;
  }

  const formattedAllergies = allergies.map((allergy) => {
    const substance =
      allergy.code?.text ??
      allergy.code?.coding?.[0]?.display ??
      "Unknown substance";

    const reactions = allergy.reaction?.map((r) => ({
      substance:
        r.substance?.coding?.[0]?.display ?? r.substance?.coding?.[0]?.code,
      manifestations: r.manifestation?.map(
        (m) => m.text ?? m.coding?.[0]?.display ?? "Unknown"
      ),
      severity: r.severity,
    }));

    return {
      id: allergy.id,
      substance,
      type: allergy.type,
      category: allergy.category,
      criticality: allergy.criticality,
      clinical_status:
        allergy.clinicalStatus?.coding?.[0]?.code ?? "unknown",
      verification_status:
        allergy.verificationStatus?.coding?.[0]?.code ?? "unknown",
      reactions,
    };
  });

  // Flag drug allergies separately for medication safety
  const drugAllergies = formattedAllergies.filter((a) =>
    a.category?.includes("medication")
  );

  return {
    patient_id,
    total: formattedAllergies.length,
    drug_allergies_count: drugAllergies.length,
    allergies: formattedAllergies,
    drug_allergies: drugAllergies,
    ...(fetchError ? { error: fetchError } : {}),
    ...buildSharpContext(patient_id, {
      allergyCount: formattedAllergies.length,
      drugAllergySubstances: drugAllergies.map((a) => a.substance),
    }),
  };
}

/**
 * Retrieves active clinical conditions for a patient.
 *
 * @param input - Validated tool input containing patient_id
 */
export async function getActiveConditions(
  input: z.infer<typeof PatientIdSchema>
) {
  const { patient_id } = input;

  let conditions: FhirCondition[] = [];
  let fetchError: string | undefined;

  try {
    const bundle = await fhirClient.searchResources<FhirCondition>(
      "Condition",
      {
        patient: patient_id,
        "clinical-status": "active",
        _count: "50",
      }
    );
    conditions = fhirClient.extractResources(bundle);
  } catch (err) {
    fetchError = `Failed to fetch conditions: ${err instanceof Error ? err.message : String(err)}`;
  }

  const formattedConditions = conditions.map((cond) => {
    const name =
      cond.code?.text ??
      cond.code?.coding?.find((c) => c.display)?.display ??
      "Unknown condition";

    const icdCodes = cond.code?.coding?.filter((c) =>
      c.system?.includes("icd")
    );

    const snomedCodes = cond.code?.coding?.filter((c) =>
      c.system?.includes("snomed")
    );

    return {
      id: cond.id,
      name,
      clinical_status: cond.clinicalStatus?.coding?.[0]?.code ?? "unknown",
      verification_status:
        cond.verificationStatus?.coding?.[0]?.code ?? "unknown",
      severity:
        cond.severity?.text ??
        cond.severity?.coding?.[0]?.display,
      onset_date: cond.onsetDateTime,
      recorded_date: cond.recordedDate,
      icd_codes: icdCodes?.map((c) => ({ code: c.code, display: c.display })),
      snomed_codes: snomedCodes?.map((c) => ({
        code: c.code,
        display: c.display,
      })),
      notes: cond.note?.map((n) => n.text).join("; "),
    };
  });

  return {
    patient_id,
    total: formattedConditions.length,
    conditions: formattedConditions,
    ...(fetchError ? { error: fetchError } : {}),
    ...buildSharpContext(patient_id, {
      conditionCount: formattedConditions.length,
      conditionNames: formattedConditions.map((c) => c.name),
    }),
  };
}

/**
 * Retrieves the 10 most recent laboratory observations for a patient.
 * Flags abnormal results based on interpretation codes.
 *
 * @param input - Validated tool input containing patient_id
 */
export async function getRecentLabs(input: z.infer<typeof PatientIdSchema>) {
  const { patient_id } = input;

  let labs: FhirObservation[] = [];
  let fetchError: string | undefined;

  try {
    const bundle = await fhirClient.searchResources<FhirObservation>(
      "Observation",
      {
        patient: patient_id,
        category: "laboratory",
        _sort: "-date",
        _count: "10",
      }
    );
    labs = fhirClient.extractResources(bundle);
  } catch (err) {
    fetchError = `Failed to fetch labs: ${err instanceof Error ? err.message : String(err)}`;
  }

  const formattedLabs = labs.map((obs) => {
    const name =
      obs.code?.text ??
      obs.code?.coding?.find((c) => c.display)?.display ??
      "Unknown test";

    let value: string | number | undefined;
    let unit: string | undefined;

    if (obs.valueQuantity) {
      value = obs.valueQuantity.value;
      unit = obs.valueQuantity.unit;
    } else if (obs.valueString) {
      value = obs.valueString;
    } else if (obs.valueCodeableConcept) {
      value =
        obs.valueCodeableConcept.text ??
        obs.valueCodeableConcept.coding?.[0]?.display;
    }

    const interpretationCode =
      obs.interpretation?.[0]?.coding?.[0]?.code ?? "";
    const isAbnormal = ["H", "L", "HH", "LL", "A", "AA", "CR", "CT"].includes(
      interpretationCode
    );

    const refRange = obs.referenceRange?.[0];
    const referenceRange = refRange
      ? (refRange.text ?? `${refRange.low?.value ?? "?"} - ${refRange.high?.value ?? "?"} ${refRange.high?.unit ?? ""}`)
      : undefined;

    return {
      id: obs.id,
      name,
      value,
      unit,
      interpretation: obs.interpretation?.[0]?.text ?? interpretationCode,
      is_abnormal: isAbnormal,
      reference_range: referenceRange,
      effective_date: obs.effectiveDateTime,
      status: obs.status,
      loinc_code: obs.code?.coding?.find((c) =>
        c.system?.includes("loinc")
      )?.code,
    };
  });

  const abnormalLabs = formattedLabs.filter((l) => l.is_abnormal);

  return {
    patient_id,
    total: formattedLabs.length,
    abnormal_count: abnormalLabs.length,
    labs: formattedLabs,
    abnormal_labs: abnormalLabs,
    ...(fetchError ? { error: fetchError } : {}),
    ...buildSharpContext(patient_id, {
      labCount: formattedLabs.length,
      abnormalLabCount: abnormalLabs.length,
      abnormalLabNames: abnormalLabs.map((l) => l.name),
    }),
  };
}
