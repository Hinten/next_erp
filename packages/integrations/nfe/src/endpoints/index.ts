/**
 * SEFAZ web-service endpoints, keyed by UF and ambiente.
 *
 * Phase A wires **SP** — the homologação round-trip target. Remaining UFs and
 * the SVRS / SVAN authorizers used by other states are a Phase A follow-up
 * (mechanical data entry from `.old/packages/nfe_client/lib/src/enderecos*`);
 * the `NfeServiceUrls` shape and `getEndpoints` resolver are the contract.
 */

export type Ambiente = 'producao' | 'homologacao';

/** SEFAZ web-service URLs for one authorizer + environment. */
export interface NfeServiceUrls {
  /** NfeAutorizacao4 — send an NF-e lote. */
  readonly NfeAutorizacao: string;
  /** NfeRetAutorizacao4 — poll a lote by nRec. */
  readonly NfeRetAutorizacao: string;
  /** NfeConsultaProtocolo4 — query one NF-e by chave. */
  readonly NfeConsultaProtocolo: string;
  /** NfeStatusServico4 — service availability. */
  readonly NfeStatusServico: string;
  /** NfeInutilizacao4 — void a number range (Phase B). */
  readonly NfeInutilizacao: string;
  /** RecepcaoEvento4 — cancelamento / CCe / EPEC (Phase B/C). */
  readonly RecepcaoEvento: string;
}

const ENDPOINTS: Partial<Record<string, Record<Ambiente, NfeServiceUrls>>> = {
  SP: {
    producao: {
      NfeAutorizacao: 'https://nfe.fazenda.sp.gov.br/ws/nfeautorizacao4.asmx',
      NfeRetAutorizacao: 'https://nfe.fazenda.sp.gov.br/ws/nferetautorizacao4.asmx',
      NfeConsultaProtocolo: 'https://nfe.fazenda.sp.gov.br/ws/nfeconsultaprotocolo4.asmx',
      NfeStatusServico: 'https://nfe.fazenda.sp.gov.br/ws/nfestatusservico4.asmx',
      NfeInutilizacao: 'https://nfe.fazenda.sp.gov.br/ws/nfeinutilizacao4.asmx',
      RecepcaoEvento: 'https://nfe.fazenda.sp.gov.br/ws/nferecepcaoevento4.asmx',
    },
    homologacao: {
      NfeAutorizacao: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeautorizacao4.asmx',
      NfeRetAutorizacao: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nferetautorizacao4.asmx',
      NfeConsultaProtocolo:
        'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeconsultaprotocolo4.asmx',
      NfeStatusServico: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfestatusservico4.asmx',
      NfeInutilizacao: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeinutilizacao4.asmx',
      RecepcaoEvento: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nferecepcaoevento4.asmx',
    },
  },
};

export class NFeEndpointError extends Error {
  constructor(uf: string) {
    super(`No NF-e endpoint table for UF '${uf}'. Phase A wires SP only.`);
    this.name = 'NFeEndpointError';
  }
}

/** Resolve the SEFAZ web-service URLs for a UF + ambiente. */
export function getEndpoints(uf: string, ambiente: Ambiente): NfeServiceUrls {
  const table = ENDPOINTS[uf.toUpperCase()];
  if (!table) throw new NFeEndpointError(uf);
  return table[ambiente];
}

/** UFs with an endpoint table wired today. */
export function supportedUFs(): string[] {
  return Object.keys(ENDPOINTS);
}
