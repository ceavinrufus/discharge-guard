/**
 * Drug Information HTTP Client
 *
 * Provides typed access to:
 * - NLM RxNorm API: drug name → RxCUI normalization
 * - OpenFDA Drug Labels API: drug label information + interaction text
 *
 * All APIs are free and require no authentication.
 *
 * Note: The NLM RxNav /interaction/list.json endpoint returns 404 and has been
 * replaced with OpenFDA drug label text for interaction information.
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
 * OpenFDA drug label API response shape.
 */
interface FdaLabelResponse {
  results?: Array<{
    openfda?: {
      brand_name?: string[];
      generic_name?: string[];
    };
    warnings?: string[];
    warnings_and_cautions?: string[];
    contraindications?: string[];
    adverse_reactions?: string[];
    drug_interactions?: string[];
    dosage_and_administration?: string[];
    dosage_and_administration_table?: string[];
  }>;
}

/**
 * Drug information client wrapping RxNorm and OpenFDA APIs.
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
   * Fetches the OpenFDA drug label for a given drug name and extracts
   * the drug_interactions field text.
   *
   * @param drugName - Drug name (brand or generic)
   */
  async getInteractionTextForDrug(drugName: string): Promise<string | null> {
    try {
      // Try brand name first, then generic name
      for (const searchField of ["openfda.brand_name", "openfda.generic_name"]) {
        const response = await this.fdaClient.get<FdaLabelResponse>(
          "/drug/label.json",
          {
            params: {
              search: `${searchField}:"${drugName}"`,
              limit: 1,
            },
          }
        );

        const result = response.data?.results?.[0];
        if (result?.drug_interactions?.[0]) {
          return result.drug_interactions[0];
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Checks drug-drug interactions by fetching OpenFDA drug label texts
   * for each drug and combining them into interaction findings.
   *
   * @param drugNames - List of drug names to check
   */
  async checkDrugInteractions(
    drugNames: string[]
  ): Promise<InteractionCheckResult> {
    const drugs = await this.resolveMultipleRxCuis(drugNames);
    const unresolvable = drugs
      .filter((d) => d.rxcui === null)
      .map((d) => d.name);

    // Fetch OpenFDA interaction text for each drug in parallel
    const interactionTexts = await Promise.allSettled(
      drugNames.map(async (name) => ({
        name,
        text: await this.getInteractionTextForDrug(name),
      }))
    );

    const interactions: DrugInteraction[] = [];

    for (const settled of interactionTexts) {
      if (settled.status !== "fulfilled" || !settled.value.text) continue;

      const { name, text } = settled.value;
      const lowerText = text.toLowerCase();

      // Check if any of the other drugs in the list are mentioned in this
      // drug's interaction text — if so, create a pairwise interaction entry
      for (const otherDrug of drugNames) {
        if (otherDrug === name) continue;
        if (lowerText.includes(otherDrug.toLowerCase())) {
          const severity = this.inferSeverityFromText(lowerText);

          // Avoid duplicate pairs
          const alreadyAdded = interactions.some(
            (i) =>
              (i.drug1 === name && i.drug2 === otherDrug) ||
              (i.drug1 === otherDrug && i.drug2 === name)
          );

          if (!alreadyAdded) {
            interactions.push({
              drug1: name,
              drug2: otherDrug,
              severity,
              description: this.truncateInteractionText(text),
              sourceUrl: `https://api.fda.gov/drug/label.json?search=openfda.brand_name:"${encodeURIComponent(name)}"&limit=1`,
            });
          }
        }
      }

      // If no specific pair match, add a general entry noting this drug
      // has interaction warnings relevant to the regimen
      const hasPairMatch = interactions.some(
        (i) => i.drug1 === name || i.drug2 === name
      );
      if (!hasPairMatch && text.length > 20) {
        interactions.push({
          drug1: name,
          drug2: "other medications in regimen",
          severity: this.inferSeverityFromText(lowerText),
          description: this.truncateInteractionText(text),
          sourceUrl: `https://api.fda.gov/drug/label.json?search=openfda.brand_name:"${encodeURIComponent(name)}"&limit=1`,
        });
      }
    }

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
      const response = await this.fdaClient.get<FdaLabelResponse>(
        "/drug/label.json",
        {
          params: {
            search: `openfda.brand_name:"${brandName}"`,
            limit: 1,
          },
        }
      );

      const result = response.data?.results?.[0];
      if (!result) return null;

      return {
        brandName: result.openfda?.brand_name ?? [],
        genericName: result.openfda?.generic_name ?? [],
        warnings: result.warnings ?? result.warnings_and_cautions ?? [],
        contraindications: result.contraindications ?? [],
        adverseReactions: result.adverse_reactions ?? [],
        drugInteractions: result.drug_interactions ?? [],
        dosageAndAdministration:
          result.dosage_and_administration ??
          result.dosage_and_administration_table ??
          [],
      };
    } catch {
      return null;
    }
  }

  /**
   * Infers interaction severity from language in the interaction text.
   */
  private inferSeverityFromText(text: string): InteractionSeverity {
    const highKeywords = [
      "contraindicated", "avoid", "serious", "severe", "life-threatening",
      "fatal", "do not use", "major", "significant increase",
    ];
    const moderateKeywords = [
      "monitor", "caution", "moderate", "may increase", "may decrease",
      "adjust dose", "consider", "use with caution",
    ];
    const lowKeywords = ["minor", "minimal", "unlikely", "small"];

    for (const kw of highKeywords) {
      if (text.includes(kw)) return "high";
    }
    for (const kw of moderateKeywords) {
      if (text.includes(kw)) return "moderate";
    }
    for (const kw of lowKeywords) {
      if (text.includes(kw)) return "low";
    }
    return "unknown";
  }

  /**
   * Truncates long interaction text for display, preserving complete sentences.
   */
  private truncateInteractionText(text: string, maxLength = 500): string {
    if (text.length <= maxLength) return text;
    const truncated = text.slice(0, maxLength);
    const lastPeriod = truncated.lastIndexOf(".");
    return lastPeriod > 100
      ? truncated.slice(0, lastPeriod + 1) + " [truncated]"
      : truncated + "... [truncated]";
  }
}

/** Singleton drug client instance */
export const drugClient = new DrugClient();
