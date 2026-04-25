/**
 * Drug Information HTTP Client
 *
 * Provides typed access to:
 * - NLM RxNorm API: drug name → RxCUI normalization
 * - NLM RxNav Drug Interactions API: multi-drug interaction checking
 * - OpenFDA Drug Labels API: detailed drug label information
 *
 * All APIs are free and require no authentication.
 */

import axios, { type AxiosInstance } from "axios";

/** NLM RxNorm API base URL */
const RXNORM_BASE_URL = "https://rxnav.nlm.nih.gov/REST";

/** OpenFDA API base URL */
const OPENFDA_BASE_URL = "https://api.fda.gov";

/** Severity levels for drug interactions */
export type InteractionSeverity = "high" | "moderate" | "low" | "unknown";

/** A single drug identified by name and RxCUI */
export interface DrugIdentifier {
  name: string;
  rxcui: string | null;
  normalized: boolean;
}

/** A single drug-drug interaction pair */
export interface DrugInteraction {
  drug1: string;
  drug2: string;
  severity: InteractionSeverity;
  description: string;
  sourceUrl?: string;
}

/** Result of a multi-drug interaction check */
export interface InteractionCheckResult {
  drugs: DrugIdentifier[];
  interactions: DrugInteraction[];
  unresolvableDrugs: string[];
  checkedAt: string;
}

/** OpenFDA drug label result */
export interface FdaDrugLabel {
  brandName: string[];
  genericName: string[];
  warnings: string[];
  contraindications: string[];
  adverseReactions: string[];
  drugInteractions: string[];
  dosageAndAdministration: string[];
}

/**
 * RxNorm API response shape for rxcui lookup.
 */
interface RxNormResponse {
  idGroup?: {
    rxnormId?: string[];
    name?: string;
  };
}

/**
 * RxNav interaction API response shape.
 */
interface RxNavInteractionResponse {
  fullInteractionTypeGroup?: Array<{
    sourceName?: string;
    fullInteractionType?: Array<{
      comment?: string;
      minConceptItem?: Array<{
        rxcui?: string;
        name?: string;
      }>;
      interactionPair?: Array<{
        interactionConcept?: Array<{
          minConceptItem?: { rxcui?: string; name?: string };
          sourceConceptItem?: { doseFormGroupName?: string; name?: string };
        }>;
        severity?: string;
        description?: string;
      }>;
    }>;
  }>;
}

/**
 * Drug information client wrapping RxNorm, RxNav, and OpenFDA APIs.
 */
export class DrugClient {
  private readonly rxnormClient: AxiosInstance;
  private readonly fdaClient: AxiosInstance;

  constructor() {
    this.rxnormClient = axios.create({
      baseURL: RXNORM_BASE_URL,
      headers: { Accept: "application/json" },
      timeout: 15_000,
    });

    this.fdaClient = axios.create({
      baseURL: OPENFDA_BASE_URL,
      headers: { Accept: "application/json" },
      timeout: 15_000,
    });
  }

  /**
   * Resolves a drug name to its RxCUI using NLM RxNorm.
   * Returns null if the drug cannot be resolved.
   *
   * @param drugName - Common or brand name of the drug
   */
  async resolveRxCui(drugName: string): Promise<string | null> {
    try {
      const response = await this.rxnormClient.get<RxNormResponse>(
        "/rxcui.json",
        {
          params: { name: drugName, search: 1 },
        }
      );

      const rxnormIds = response.data?.idGroup?.rxnormId;
      if (rxnormIds && rxnormIds.length > 0) {
        return rxnormIds[0];
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Resolves multiple drug names to their RxCUIs in parallel.
   *
   * @param drugNames - Array of drug names to resolve
   */
  async resolveMultipleRxCuis(drugNames: string[]): Promise<DrugIdentifier[]> {
    const results = await Promise.allSettled(
      drugNames.map(async (name) => {
        const rxcui = await this.resolveRxCui(name);
        return {
          name,
          rxcui,
          normalized: rxcui !== null,
        } satisfies DrugIdentifier;
      })
    );

    return results.map((result, i) => {
      if (result.status === "fulfilled") return result.value;
      return { name: drugNames[i], rxcui: null, normalized: false };
    });
  }

  /**
   * Checks drug-drug interactions for a list of RxCUIs using NLM RxNav.
   * Requires at least 2 RxCUIs.
   *
   * @param rxcuis - Array of RxCUI strings to check
   */
  async checkInteractionsByRxCui(
    rxcuis: string[]
  ): Promise<DrugInteraction[]> {
    if (rxcuis.length < 2) return [];

    try {
      const response = await this.rxnormClient.get<RxNavInteractionResponse>(
        `/interaction/list.json`,
        {
          params: { rxcuis: rxcuis.join("+") },
        }
      );

      const interactions: DrugInteraction[] = [];
      const groups = response.data?.fullInteractionTypeGroup ?? [];

      for (const group of groups) {
        for (const type of group.fullInteractionType ?? []) {
          for (const pair of type.interactionPair ?? []) {
            const concepts = pair.interactionConcept ?? [];
            const drug1Name =
              concepts[0]?.minConceptItem?.name ??
              concepts[0]?.sourceConceptItem?.name ??
              "Unknown";
            const drug2Name =
              concepts[1]?.minConceptItem?.name ??
              concepts[1]?.sourceConceptItem?.name ??
              "Unknown";

            interactions.push({
              drug1: drug1Name,
              drug2: drug2Name,
              severity: this.parseSeverity(pair.severity),
              description:
                pair.description ??
                type.comment ??
                "No description available",
            });
          }
        }
      }

      return interactions;
    } catch {
      return [];
    }
  }

  /**
   * Full interaction check workflow: resolve names → get RxCUIs → check interactions.
   *
   * @param drugNames - List of drug names to check
   */
  async checkDrugInteractions(
    drugNames: string[]
  ): Promise<InteractionCheckResult> {
    const drugs = await this.resolveMultipleRxCuis(drugNames);
    const resolved = drugs.filter((d) => d.rxcui !== null);
    const unresolvable = drugs
      .filter((d) => d.rxcui === null)
      .map((d) => d.name);

    const rxcuis = resolved.map((d) => d.rxcui as string);
    const interactions = await this.checkInteractionsByRxCui(rxcuis);

    return {
      drugs,
      interactions,
      unresolvableDrugs: unresolvable,
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * Fetches drug label information from OpenFDA.
   *
   * @param brandName - Brand or generic name of the drug
   */
  async getDrugLabel(brandName: string): Promise<FdaDrugLabel | null> {
    try {
      const response = await this.fdaClient.get<{
        results?: Array<Record<string, string[] | undefined>>;
      }>("/drug/label.json", {
        params: {
          search: `openfda.brand_name:"${brandName}"`,
          limit: 1,
        },
      });

      const result = response.data?.results?.[0];
      if (!result) return null;

      return {
        brandName: result["openfda.brand_name"] ?? result["brand_name"] ?? [],
        genericName:
          result["openfda.generic_name"] ?? result["generic_name"] ?? [],
        warnings: result["warnings"] ?? result["warnings_and_cautions"] ?? [],
        contraindications: result["contraindications"] ?? [],
        adverseReactions: result["adverse_reactions"] ?? [],
        drugInteractions: result["drug_interactions"] ?? [],
        dosageAndAdministration:
          result["dosage_and_administration"] ??
          result["dosage_and_administration_table"] ??
          [],
      };
    } catch {
      return null;
    }
  }

  /**
   * Normalizes RxNav severity strings to typed enum values.
   */
  private parseSeverity(severity?: string): InteractionSeverity {
    const s = severity?.toLowerCase() ?? "";
    if (s.includes("high") || s.includes("major")) return "high";
    if (s.includes("moderate")) return "moderate";
    if (s.includes("low") || s.includes("minor")) return "low";
    return "unknown";
  }
}

/** Singleton drug client instance */
export const drugClient = new DrugClient();
