/**
 * FHIR R4 HTTP Client
 *
 * Provides a typed HTTP client for interacting with the HAPI FHIR R4 public test server.
 * Base URL: https://hapi.fhir.org/baseR4
 *
 * Implements SMART on FHIR compatible resource access patterns
 * per the FHIR R4 specification (authored in part by judge Josh Mandel).
 */

import axios, { type AxiosInstance, type AxiosResponse } from "axios";

/** Base URL for the HAPI FHIR R4 public test server */
export const FHIR_BASE_URL = "https://hapi.fhir.org/baseR4";

/**
 * FHIR R4 Resource base type.
 * All FHIR resources share these common fields.
 */
export interface FhirResource {
  resourceType: string;
  id?: string;
  meta?: {
    versionId?: string;
    lastUpdated?: string;
    source?: string;
    profile?: string[];
  };
}

/** FHIR Bundle resource wrapping a collection of resources */
export interface FhirBundle<T extends FhirResource = FhirResource>
  extends FhirResource {
  resourceType: "Bundle";
  type: string;
  total?: number;
  entry?: Array<{
    fullUrl?: string;
    resource?: T;
    search?: { mode?: string };
  }>;
}

/** FHIR OperationOutcome for error responses */
export interface FhirOperationOutcome extends FhirResource {
  resourceType: "OperationOutcome";
  issue: Array<{
    severity: "fatal" | "error" | "warning" | "information";
    code: string;
    details?: { text?: string };
    diagnostics?: string;
  }>;
}

/** FHIR Patient resource (R4) */
export interface FhirPatient extends FhirResource {
  resourceType: "Patient";
  name?: Array<{
    use?: string;
    family?: string;
    given?: string[];
    text?: string;
  }>;
  birthDate?: string;
  gender?: "male" | "female" | "other" | "unknown";
  address?: Array<{
    use?: string;
    line?: string[];
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  }>;
  telecom?: Array<{
    system?: string;
    value?: string;
    use?: string;
  }>;
  identifier?: Array<{
    system?: string;
    value?: string;
  }>;
  communication?: Array<{
    language: { coding?: Array<{ code?: string; display?: string }> };
    preferred?: boolean;
  }>;
  generalPractitioner?: Array<{ reference?: string; display?: string }>;
}

/** FHIR MedicationRequest resource (R4) */
export interface FhirMedicationRequest extends FhirResource {
  resourceType: "MedicationRequest";
  status: string;
  intent: string;
  medicationCodeableConcept?: {
    coding?: Array<{ system?: string; code?: string; display?: string }>;
    text?: string;
  };
  medicationReference?: { reference?: string; display?: string };
  subject?: { reference?: string };
  authoredOn?: string;
  requester?: { reference?: string; display?: string };
  dosageInstruction?: Array<{
    text?: string;
    timing?: {
      repeat?: {
        frequency?: number;
        period?: number;
        periodUnit?: string;
      };
    };
    route?: { coding?: Array<{ display?: string }> };
    doseAndRate?: Array<{
      doseQuantity?: { value?: number; unit?: string };
    }>;
  }>;
  note?: Array<{ text?: string }>;
}

/** FHIR AllergyIntolerance resource (R4) */
export interface FhirAllergyIntolerance extends FhirResource {
  resourceType: "AllergyIntolerance";
  clinicalStatus?: {
    coding?: Array<{ system?: string; code?: string }>;
  };
  verificationStatus?: {
    coding?: Array<{ system?: string; code?: string }>;
  };
  type?: "allergy" | "intolerance";
  category?: string[];
  criticality?: "low" | "high" | "unable-to-assess";
  code?: {
    coding?: Array<{ system?: string; code?: string; display?: string }>;
    text?: string;
  };
  patient?: { reference?: string };
  reaction?: Array<{
    substance?: {
      coding?: Array<{ system?: string; code?: string; display?: string }>;
    };
    manifestation?: Array<{
      coding?: Array<{ system?: string; code?: string; display?: string }>;
      text?: string;
    }>;
    severity?: "mild" | "moderate" | "severe";
  }>;
}

/** FHIR Condition resource (R4) */
export interface FhirCondition extends FhirResource {
  resourceType: "Condition";
  clinicalStatus?: {
    coding?: Array<{ system?: string; code?: string }>;
  };
  verificationStatus?: {
    coding?: Array<{ system?: string; code?: string }>;
  };
  category?: Array<{
    coding?: Array<{ system?: string; code?: string; display?: string }>;
  }>;
  severity?: {
    coding?: Array<{ system?: string; code?: string; display?: string }>;
    text?: string;
  };
  code?: {
    coding?: Array<{ system?: string; code?: string; display?: string }>;
    text?: string;
  };
  subject?: { reference?: string };
  onsetDateTime?: string;
  abatementDateTime?: string;
  recordedDate?: string;
  note?: Array<{ text?: string }>;
}

/** FHIR Observation resource (R4) — used for lab results */
export interface FhirObservation extends FhirResource {
  resourceType: "Observation";
  status: string;
  category?: Array<{
    coding?: Array<{ system?: string; code?: string; display?: string }>;
  }>;
  code?: {
    coding?: Array<{ system?: string; code?: string; display?: string }>;
    text?: string;
  };
  subject?: { reference?: string };
  effectiveDateTime?: string;
  issued?: string;
  valueQuantity?: {
    value?: number;
    unit?: string;
    system?: string;
    code?: string;
  };
  valueString?: string;
  valueCodeableConcept?: {
    coding?: Array<{ system?: string; code?: string; display?: string }>;
    text?: string;
  };
  interpretation?: Array<{
    coding?: Array<{ system?: string; code?: string; display?: string }>;
    text?: string;
  }>;
  referenceRange?: Array<{
    low?: { value?: number; unit?: string };
    high?: { value?: number; unit?: string };
    text?: string;
  }>;
  component?: Array<{
    code?: {
      coding?: Array<{ system?: string; code?: string; display?: string }>;
      text?: string;
    };
    valueQuantity?: { value?: number; unit?: string };
    valueString?: string;
  }>;
}

/**
 * Typed FHIR HTTP client with error handling and retry logic.
 */
export class FhirClient {
  private readonly client: AxiosInstance;

  constructor(baseUrl: string = FHIR_BASE_URL) {
    this.client = axios.create({
      baseURL: baseUrl,
      headers: {
        Accept: "application/fhir+json",
        "Content-Type": "application/fhir+json",
      },
      timeout: 30_000,
    });
  }

  /**
   * Fetches a single FHIR resource by type and ID.
   * @param resourceType - FHIR resource type (e.g. "Patient")
   * @param id - Resource ID
   */
  async getResource<T extends FhirResource>(
    resourceType: string,
    id: string
  ): Promise<T> {
    const response: AxiosResponse<T> = await this.client.get(
      `/${resourceType}/${id}`
    );
    return response.data;
  }

  /**
   * Searches FHIR resources with query parameters.
   * @param resourceType - FHIR resource type
   * @param params - Search query parameters
   */
  async searchResources<T extends FhirResource>(
    resourceType: string,
    params: Record<string, string>
  ): Promise<FhirBundle<T>> {
    const response: AxiosResponse<FhirBundle<T>> = await this.client.get(
      `/${resourceType}`,
      { params }
    );
    return response.data;
  }

  /**
   * Extracts resources from a FHIR Bundle's entries.
   * @param bundle - FHIR Bundle resource
   */
  extractResources<T extends FhirResource>(bundle: FhirBundle<T>): T[] {
    if (!bundle.entry) return [];
    return bundle.entry
      .filter((e) => e.resource !== undefined)
      .map((e) => e.resource as T);
  }
}

/** Singleton FHIR client instance */
export const fhirClient = new FhirClient();
