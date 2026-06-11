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

/**
 * Contingency authorizers (MOC Anexo III). `svc-an` / `svc-rs` are the two
 * SEFAZ Virtual de Contingência environments (Ato COTEPE 39/2012 binds each
 * UF to exactly one); `an` is the Ambiente Nacional, which receives only the
 * EPEC evento (tpEvento 110140).
 */
export type ContingencyAuthorizer = 'svc-an' | 'svc-rs' | 'an';

/**
 * SVC service URLs. SVC offers Autorização / RetAutorização / Consulta /
 * StatusServiço / Cancelamento (via RecepcaoEvento) — it does **not** offer
 * Inutilização or CC-e, hence no `NfeInutilizacao` key: code that tries to
 * inutilizar via SVC must not typecheck.
 */
export type SvcServiceUrls = Omit<NfeServiceUrls, 'NfeInutilizacao'>;

/** Ambiente Nacional — EPEC drop-box only. */
export interface AnServiceUrls {
  /** RecepcaoEvento4 — receives the EPEC evento (110140). */
  readonly RecepcaoEvento: string;
}

// SVC-AN lives on the `sefazvirtual.fazenda.gov.br` hosts (the AN's SEFAZ
// Virtual infrastructure) — the portal's "Sefaz Virtual de Contingência
// Ambiente Nacional" table, re-checked 2026-06-11. The legacy
// `svc.fazenda.gov.br` hosts inherited from the Flutter table are
// decommissioned (NXDOMAIN on public resolvers). The portal also lists
// NfeInutilizacao on SVC-AN, but `SvcServiceUrls` deliberately omits it:
// number ranges belong to the home SEFAZ, so inutilização via SVC must not
// typecheck. The produção URLs follow the portal pattern and answer probes;
// still, run a status check against them before relying on SVC-AN in a real
// produção contingency.
const SVC_AN_ENDPOINTS: Record<Ambiente, SvcServiceUrls> = {
  producao: {
    NfeAutorizacao: 'https://www.sefazvirtual.fazenda.gov.br/NFeAutorizacao4/NFeAutorizacao4.asmx',
    NfeRetAutorizacao:
      'https://www.sefazvirtual.fazenda.gov.br/NFeRetAutorizacao4/NFeRetAutorizacao4.asmx',
    NfeConsultaProtocolo:
      'https://www.sefazvirtual.fazenda.gov.br/NFeConsultaProtocolo4/NFeConsultaProtocolo4.asmx',
    NfeStatusServico:
      'https://www.sefazvirtual.fazenda.gov.br/NFeStatusServico4/NFeStatusServico4.asmx',
    RecepcaoEvento:
      'https://www.sefazvirtual.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx',
  },
  homologacao: {
    NfeAutorizacao: 'https://hom.sefazvirtual.fazenda.gov.br/NFeAutorizacao4/NFeAutorizacao4.asmx',
    NfeRetAutorizacao:
      'https://hom.sefazvirtual.fazenda.gov.br/NFeRetAutorizacao4/NFeRetAutorizacao4.asmx',
    NfeConsultaProtocolo:
      'https://hom.sefazvirtual.fazenda.gov.br/NFeConsultaProtocolo4/NFeConsultaProtocolo4.asmx',
    NfeStatusServico:
      'https://hom.sefazvirtual.fazenda.gov.br/NFeStatusServico4/NFeStatusServico4.asmx',
    RecepcaoEvento:
      'https://hom.sefazvirtual.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx',
  },
};

const SVC_RS_ENDPOINTS: Record<Ambiente, SvcServiceUrls> = {
  producao: {
    NfeAutorizacao: 'https://nfe.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
    NfeRetAutorizacao: 'https://nfe.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx',
    NfeConsultaProtocolo: 'https://nfe.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx',
    NfeStatusServico: 'https://nfe.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx',
    RecepcaoEvento: 'https://nfe.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx',
  },
  homologacao: {
    NfeAutorizacao: 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
    NfeRetAutorizacao:
      'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx',
    NfeConsultaProtocolo: 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx',
    NfeStatusServico:
      'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx',
    RecepcaoEvento: 'https://nfe-homologacao.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx',
  },
};

const AN_ENDPOINTS: Record<Ambiente, AnServiceUrls> = {
  producao: {
    RecepcaoEvento: 'https://www.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx',
  },
  homologacao: {
    RecepcaoEvento: 'https://hom1.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx',
  },
};

/**
 * UF → SVC environment (Ato COTEPE 39/2012; mirrored from
 * `.old/packages/nfe_client/lib/src/enderecos{,_homologacao}.dart` — PI
 * appears only in the legacy homologação file; we keep the union and treat
 * the Ato COTEPE as the authority to re-check on divergence).
 */
const SVC_AN_UFS: ReadonlySet<string> = new Set([
  'AC',
  'AL',
  'AP',
  'CE',
  'DF',
  'ES',
  'MG',
  'PA',
  'PB',
  'RJ',
  'RN',
  'RO',
  'RR',
  'RS',
  'SC',
  'SE',
  'SP',
  'TO',
]);

const SVC_RS_UFS: ReadonlySet<string> = new Set([
  'AM',
  'BA',
  'GO',
  'MA',
  'MS',
  'MT',
  'PE',
  'PI',
  'PR',
]);

export class NFeEndpointError extends Error {
  constructor(uf: string) {
    super(`No NF-e endpoint table for UF '${uf}'. Phase A wires SP only.`);
    this.name = 'NFeEndpointError';
  }
}

export class NFeContingencyEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NFeContingencyEndpointError';
  }
}

/** Resolve which SVC environment serves a UF when its home SEFAZ is down. */
export function svcAuthorizerForUF(uf: string): 'svc-an' | 'svc-rs' {
  const upper = uf.toUpperCase();
  if (SVC_AN_UFS.has(upper)) return 'svc-an';
  if (SVC_RS_UFS.has(upper)) return 'svc-rs';
  throw new NFeContingencyEndpointError(`No SVC mapping for UF '${uf}'.`);
}

/** Resolve the SVC web-service URLs for an authorizer + ambiente. */
export function getSvcEndpoints(
  authorizer: 'svc-an' | 'svc-rs',
  ambiente: Ambiente,
): SvcServiceUrls {
  return authorizer === 'svc-an' ? SVC_AN_ENDPOINTS[ambiente] : SVC_RS_ENDPOINTS[ambiente];
}

/** Resolve the Ambiente Nacional URLs (EPEC evento drop-box). */
export function getAnEndpoints(ambiente: Ambiente): AnServiceUrls {
  return AN_ENDPOINTS[ambiente];
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
