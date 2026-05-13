import type { InvoiceProvider } from '@delfrance/core/plugins';

/**
 * NFe (Nota Fiscal Eletrônica) plugin scaffold.
 *
 * Status: contracts only. Concrete implementation depends on the
 * outcomes of Phase 0 spikes 0004 (XSD→TS), 0005 (XML signing),
 * 0006 (SOAP transport), 0007 (BR-pronto package survey). Once those
 * land, this package wraps either a single npm BR package (if survey
 * picks one) or composes the layers from the validated libs.
 *
 * Cert handling lives in a sub-module (server-only) so the client
 * bundle never pulls in PFX/P12 parsing code. To be added with the
 * concrete implementation.
 */
export interface NFeConfig {
  /** SEFAZ environment. 'producao' or 'homologacao'. */
  ambiente: 'producao' | 'homologacao';
  /** UF of the issuer (e.g. 'SP'). Drives which webservice URL is used. */
  uf: string;
  /** Path or env-var name for the A1 certificate (PFX). Server-only. */
  certPath?: string;
  /** Cert password. Read from Cloud Secret Manager in production. */
  certPasswordEnvVar?: string;
}

export class NFeNotConfiguredError extends Error {
  constructor() {
    super('NFe plugin not configured. Spike outcomes pending — see ADR 0004–0008.');
    this.name = 'NFeNotConfiguredError';
  }
}

/**
 * Returns an InvoiceProvider implementation. Today this throws on every
 * call; once the concrete impl lands it issues NFe payloads against the
 * configured SEFAZ environment.
 */
export function createNFeProvider(_config: NFeConfig): InvoiceProvider {
  return {
    id: 'nfe',
    issue: async (_orderId: string) => {
      throw new NFeNotConfiguredError();
    },
  };
}
