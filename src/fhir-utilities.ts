import { Request } from "express";
import { FhirContext } from "./fhir-context.js";
import * as jose from "jose";
import { McpConstants } from "./mcp-constants.js";

export const FhirUtilities = {
  getFhirContext: (req: Request): FhirContext | null => {
    try {
      const headers = req.headers;
      if (!headers) return null;
      const url = headers[McpConstants.FhirServerUrlHeaderName]?.toString();
      if (!url) return null;
      const token = headers[McpConstants.FhirAccessTokenHeaderName]?.toString();
      return { url, token };
    } catch {
      return null;
    }
  },

  getPatientIdIfContextExists: (req: Request): string | null => {
    try {
      const fhirToken =
        req.headers?.[McpConstants.FhirAccessTokenHeaderName]?.toString();

      if (fhirToken) {
        try {
          const claims = jose.decodeJwt(fhirToken);
          if (claims["patient"]) return claims["patient"]?.toString() ?? null;
        } catch {
          // token not JWT, fall through
        }
      }

      return req.headers?.[McpConstants.PatientIdHeaderName]?.toString() ?? null;
    } catch {
      return null;
    }
  },
};
