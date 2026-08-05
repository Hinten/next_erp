/**
 * SEFAZ web-service endpoints, keyed by UF and ambiente.
 *
 * Full normal-mode coverage, all 27 UFs. Ten UFs run their own dedicated
 * authorizer host — AM, BA, GO, MG, MS, MT, PE, PR, RS, SP. The remaining
 * 17 delegate to a shared authorizer: MA to SVAN (Sefaz Virtual Ambiente
 * Nacional — same physical host as the SVC-AN contingency authorizer below,
 * but a distinct normal-mode role), and the other 16
 * (AC/AL/AP/CE/DF/ES/PA/PB/PI/RJ/RN/RO/RR/SC/SE/TO) to SVRS (same host as
 * the SVC-RS contingency authorizer). URLs sourced 2026-08-05 from the
 * official SEFAZ webServices portal (`nfe.fazenda.gov.br/portal/webServices.aspx`)
 * — **not** ported verbatim from `.old/packages/nfe_client/lib/src/enderecos.dart`,
 * whose `GO_NFe` class points at a Minas Gerais host (copy-paste bug) and whose
 * `MG` entry is stale (legacy lumps MG into the SVRS default branch; MG has run
 * its own dedicated host for some time).
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
  /**
   * NFeConsultaCadastro4 — query a taxpayer's IE registry by CNPJ. **Optional**:
   * not every UF offers Consulta Cadastro, so this key is absent for those.
   * `getConsultaCadastroEndpoint` resolves it (or `null` when unsupported).
   */
  readonly NfeConsultaCadastro?: string;
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
      // SP's consulta cadastro lives at `cadconsultacadastro4.asmx` (note the
      // `cad` prefix) — NOT `nfeconsultacadastro4.asmx`.
      NfeConsultaCadastro: 'https://nfe.fazenda.sp.gov.br/ws/cadconsultacadastro4.asmx',
    },
    homologacao: {
      NfeAutorizacao: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeautorizacao4.asmx',
      NfeRetAutorizacao: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nferetautorizacao4.asmx',
      NfeConsultaProtocolo:
        'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeconsultaprotocolo4.asmx',
      NfeStatusServico: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfestatusservico4.asmx',
      NfeInutilizacao: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeinutilizacao4.asmx',
      RecepcaoEvento: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nferecepcaoevento4.asmx',
      NfeConsultaCadastro: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/cadconsultacadastro4.asmx',
    },
  },
  AM: {
    producao: {
      NfeAutorizacao: 'https://nfe.sefaz.am.gov.br/services2/services/NfeAutorizacao4',
      NfeRetAutorizacao: 'https://nfe.sefaz.am.gov.br/services2/services/NfeRetAutorizacao4',
      NfeConsultaProtocolo: 'https://nfe.sefaz.am.gov.br/services2/services/NfeConsulta4',
      NfeStatusServico: 'https://nfe.sefaz.am.gov.br/services2/services/NfeStatusServico4',
      NfeInutilizacao: 'https://nfe.sefaz.am.gov.br/services2/services/NfeInutilizacao4',
      RecepcaoEvento: 'https://nfe.sefaz.am.gov.br/services2/services/RecepcaoEvento4',
      // AM offers no Consulta Cadastro service (empty in the SEFAZ portal
      // table) — key deliberately omitted, matching SVAN and SVC-AN.
    },
    homologacao: {
      NfeAutorizacao: 'https://homnfe.sefaz.am.gov.br/services2/services/NfeAutorizacao4',
      NfeRetAutorizacao: 'https://homnfe.sefaz.am.gov.br/services2/services/NfeRetAutorizacao4',
      NfeConsultaProtocolo: 'https://homnfe.sefaz.am.gov.br/services2/services/NfeConsulta4',
      NfeStatusServico: 'https://homnfe.sefaz.am.gov.br/services2/services/NfeStatusServico4',
      NfeInutilizacao: 'https://homnfe.sefaz.am.gov.br/services2/services/NfeInutilizacao4',
      RecepcaoEvento: 'https://homnfe.sefaz.am.gov.br/services2/services/RecepcaoEvento4',
    },
  },
  BA: {
    producao: {
      NfeAutorizacao:
        'https://nfe.sefaz.ba.gov.br/webservices/NFeAutorizacao4/NFeAutorizacao4.asmx',
      NfeRetAutorizacao:
        'https://nfe.sefaz.ba.gov.br/webservices/NFeRetAutorizacao4/NFeRetAutorizacao4.asmx',
      NfeConsultaProtocolo:
        'https://nfe.sefaz.ba.gov.br/webservices/NFeConsultaProtocolo4/NFeConsultaProtocolo4.asmx',
      NfeStatusServico:
        'https://nfe.sefaz.ba.gov.br/webservices/NFeStatusServico4/NFeStatusServico4.asmx',
      NfeInutilizacao:
        'https://nfe.sefaz.ba.gov.br/webservices/NFeInutilizacao4/NFeInutilizacao4.asmx',
      RecepcaoEvento:
        'https://nfe.sefaz.ba.gov.br/webservices/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx',
      NfeConsultaCadastro:
        'https://nfe.sefaz.ba.gov.br/webservices/CadConsultaCadastro4/CadConsultaCadastro4.asmx',
    },
    homologacao: {
      NfeAutorizacao:
        'https://hnfe.sefaz.ba.gov.br/webservices/NFeAutorizacao4/NFeAutorizacao4.asmx',
      NfeRetAutorizacao:
        'https://hnfe.sefaz.ba.gov.br/webservices/NFeRetAutorizacao4/NFeRetAutorizacao4.asmx',
      NfeConsultaProtocolo:
        'https://hnfe.sefaz.ba.gov.br/webservices/NFeConsultaProtocolo4/NFeConsultaProtocolo4.asmx',
      NfeStatusServico:
        'https://hnfe.sefaz.ba.gov.br/webservices/NFeStatusServico4/NFeStatusServico4.asmx',
      NfeInutilizacao:
        'https://hnfe.sefaz.ba.gov.br/webservices/NFeInutilizacao4/NFeInutilizacao4.asmx',
      RecepcaoEvento:
        'https://hnfe.sefaz.ba.gov.br/webservices/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx',
      NfeConsultaCadastro:
        'https://hnfe.sefaz.ba.gov.br/webservices/CadConsultaCadastro4/CadConsultaCadastro4.asmx',
    },
  },
  // ⚠️ Do NOT port `.old`'s `GO_NFe` class — every URL in it points at a
  // Minas Gerais host (nfe.fazenda.mg.gov.br), an unnoticed copy-paste bug
  // with no test coverage. These are GO's real hosts, independently sourced.
  GO: {
    producao: {
      NfeAutorizacao: 'https://nfe.sefaz.go.gov.br/nfe/services/NFeAutorizacao4',
      NfeRetAutorizacao: 'https://nfe.sefaz.go.gov.br/nfe/services/NFeRetAutorizacao4',
      NfeConsultaProtocolo: 'https://nfe.sefaz.go.gov.br/nfe/services/NFeConsultaProtocolo4',
      NfeStatusServico: 'https://nfe.sefaz.go.gov.br/nfe/services/NFeStatusServico4',
      NfeInutilizacao: 'https://nfe.sefaz.go.gov.br/nfe/services/NFeInutilizacao4',
      RecepcaoEvento: 'https://nfe.sefaz.go.gov.br/nfe/services/NFeRecepcaoEvento4',
      NfeConsultaCadastro: 'https://nfe.sefaz.go.gov.br/nfe/services/CadConsultaCadastro4',
    },
    homologacao: {
      NfeAutorizacao: 'https://homolog.sefaz.go.gov.br/nfe/services/NFeAutorizacao4',
      NfeRetAutorizacao: 'https://homolog.sefaz.go.gov.br/nfe/services/NFeRetAutorizacao4',
      NfeConsultaProtocolo: 'https://homolog.sefaz.go.gov.br/nfe/services/NFeConsultaProtocolo4',
      NfeStatusServico: 'https://homolog.sefaz.go.gov.br/nfe/services/NFeStatusServico4',
      NfeInutilizacao: 'https://homolog.sefaz.go.gov.br/nfe/services/NFeInutilizacao4',
      RecepcaoEvento: 'https://homolog.sefaz.go.gov.br/nfe/services/NFeRecepcaoEvento4',
      NfeConsultaCadastro: 'https://homolog.sefaz.go.gov.br/nfe/services/CadConsultaCadastro4',
    },
  },
  // MG runs its own dedicated host today — do NOT trust `.old`'s SVRS
  // default-branch placement for MG; re-derived independently per the issue.
  MG: {
    producao: {
      NfeAutorizacao: 'https://nfe.fazenda.mg.gov.br/nfe2/services/NFeAutorizacao4',
      NfeRetAutorizacao: 'https://nfe.fazenda.mg.gov.br/nfe2/services/NFeRetAutorizacao4',
      NfeConsultaProtocolo: 'https://nfe.fazenda.mg.gov.br/nfe2/services/NFeConsultaProtocolo4',
      NfeStatusServico: 'https://nfe.fazenda.mg.gov.br/nfe2/services/NFeStatusServico4',
      NfeInutilizacao: 'https://nfe.fazenda.mg.gov.br/nfe2/services/NFeInutilizacao4',
      RecepcaoEvento: 'https://nfe.fazenda.mg.gov.br/nfe2/services/NFeRecepcaoEvento4',
      NfeConsultaCadastro: 'https://nfe.fazenda.mg.gov.br/nfe2/services/CadConsultaCadastro4',
    },
    homologacao: {
      NfeAutorizacao: 'https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeAutorizacao4',
      NfeRetAutorizacao: 'https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeRetAutorizacao4',
      NfeConsultaProtocolo: 'https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeConsultaProtocolo4',
      NfeStatusServico: 'https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeStatusServico4',
      NfeInutilizacao: 'https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeInutilizacao4',
      RecepcaoEvento: 'https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeRecepcaoEvento4',
      NfeConsultaCadastro: 'https://hnfe.fazenda.mg.gov.br/nfe2/services/CadConsultaCadastro4',
    },
  },
  MS: {
    producao: {
      NfeAutorizacao: 'https://nfe.sefaz.ms.gov.br/ws/NFeAutorizacao4',
      NfeRetAutorizacao: 'https://nfe.sefaz.ms.gov.br/ws/NFeRetAutorizacao4',
      NfeConsultaProtocolo: 'https://nfe.sefaz.ms.gov.br/ws/NFeConsultaProtocolo4',
      NfeStatusServico: 'https://nfe.sefaz.ms.gov.br/ws/NFeStatusServico4',
      NfeInutilizacao: 'https://nfe.sefaz.ms.gov.br/ws/NFeInutilizacao4',
      RecepcaoEvento: 'https://nfe.sefaz.ms.gov.br/ws/NFeRecepcaoEvento4',
      NfeConsultaCadastro: 'https://nfe.sefaz.ms.gov.br/ws/CadConsultaCadastro4',
    },
    homologacao: {
      NfeAutorizacao: 'https://hom.nfe.sefaz.ms.gov.br/ws/NFeAutorizacao4',
      NfeRetAutorizacao: 'https://hom.nfe.sefaz.ms.gov.br/ws/NFeRetAutorizacao4',
      NfeConsultaProtocolo: 'https://hom.nfe.sefaz.ms.gov.br/ws/NFeConsultaProtocolo4',
      NfeStatusServico: 'https://hom.nfe.sefaz.ms.gov.br/ws/NFeStatusServico4',
      NfeInutilizacao: 'https://hom.nfe.sefaz.ms.gov.br/ws/NFeInutilizacao4',
      RecepcaoEvento: 'https://hom.nfe.sefaz.ms.gov.br/ws/NFeRecepcaoEvento4',
      NfeConsultaCadastro: 'https://hom.nfe.sefaz.ms.gov.br/ws/CadConsultaCadastro4',
    },
  },
  MT: {
    producao: {
      NfeAutorizacao: 'https://nfe.sefaz.mt.gov.br/nfews/v2/services/NfeAutorizacao4',
      NfeRetAutorizacao: 'https://nfe.sefaz.mt.gov.br/nfews/v2/services/NfeRetAutorizacao4',
      NfeConsultaProtocolo: 'https://nfe.sefaz.mt.gov.br/nfews/v2/services/NfeConsulta4',
      NfeStatusServico: 'https://nfe.sefaz.mt.gov.br/nfews/v2/services/NfeStatusServico4',
      NfeInutilizacao: 'https://nfe.sefaz.mt.gov.br/nfews/v2/services/NfeInutilizacao4',
      RecepcaoEvento: 'https://nfe.sefaz.mt.gov.br/nfews/v2/services/RecepcaoEvento4',
      NfeConsultaCadastro: 'https://nfe.sefaz.mt.gov.br/nfews/v2/services/CadConsultaCadastro4',
    },
    homologacao: {
      NfeAutorizacao: 'https://homologacao.sefaz.mt.gov.br/nfews/v2/services/NfeAutorizacao4',
      NfeRetAutorizacao: 'https://homologacao.sefaz.mt.gov.br/nfews/v2/services/NfeRetAutorizacao4',
      NfeConsultaProtocolo: 'https://homologacao.sefaz.mt.gov.br/nfews/v2/services/NfeConsulta4',
      NfeStatusServico: 'https://homologacao.sefaz.mt.gov.br/nfews/v2/services/NfeStatusServico4',
      NfeInutilizacao: 'https://homologacao.sefaz.mt.gov.br/nfews/v2/services/NfeInutilizacao4',
      RecepcaoEvento: 'https://homologacao.sefaz.mt.gov.br/nfews/v2/services/RecepcaoEvento4',
      NfeConsultaCadastro:
        'https://homologacao.sefaz.mt.gov.br/nfews/v2/services/CadConsultaCadastro4',
    },
  },
  PE: {
    producao: {
      NfeAutorizacao: 'https://nfe.sefaz.pe.gov.br/nfe-service/services/NFeAutorizacao4',
      NfeRetAutorizacao: 'https://nfe.sefaz.pe.gov.br/nfe-service/services/NFeRetAutorizacao4',
      NfeConsultaProtocolo:
        'https://nfe.sefaz.pe.gov.br/nfe-service/services/NFeConsultaProtocolo4',
      NfeStatusServico: 'https://nfe.sefaz.pe.gov.br/nfe-service/services/NFeStatusServico4',
      NfeInutilizacao: 'https://nfe.sefaz.pe.gov.br/nfe-service/services/NFeInutilizacao4',
      RecepcaoEvento: 'https://nfe.sefaz.pe.gov.br/nfe-service/services/NFeRecepcaoEvento4',
      NfeConsultaCadastro: 'https://nfe.sefaz.pe.gov.br/nfe-service/services/CadConsultaCadastro4',
    },
    homologacao: {
      NfeAutorizacao: 'https://nfehomolog.sefaz.pe.gov.br/nfe-service/services/NFeAutorizacao4',
      NfeRetAutorizacao:
        'https://nfehomolog.sefaz.pe.gov.br/nfe-service/services/NFeRetAutorizacao4',
      NfeConsultaProtocolo:
        'https://nfehomolog.sefaz.pe.gov.br/nfe-service/services/NFeConsultaProtocolo4',
      NfeStatusServico: 'https://nfehomolog.sefaz.pe.gov.br/nfe-service/services/NFeStatusServico4',
      NfeInutilizacao: 'https://nfehomolog.sefaz.pe.gov.br/nfe-service/services/NFeInutilizacao4',
      RecepcaoEvento: 'https://nfehomolog.sefaz.pe.gov.br/nfe-service/services/NFeRecepcaoEvento4',
      NfeConsultaCadastro:
        'https://nfehomolog.sefaz.pe.gov.br/nfe-service/services/CadConsultaCadastro4',
    },
  },
  PR: {
    producao: {
      NfeAutorizacao: 'https://nfe.sefa.pr.gov.br/nfe/NFeAutorizacao4',
      NfeRetAutorizacao: 'https://nfe.sefa.pr.gov.br/nfe/NFeRetAutorizacao4',
      NfeConsultaProtocolo: 'https://nfe.sefa.pr.gov.br/nfe/NFeConsultaProtocolo4',
      NfeStatusServico: 'https://nfe.sefa.pr.gov.br/nfe/NFeStatusServico4',
      NfeInutilizacao: 'https://nfe.sefa.pr.gov.br/nfe/NFeInutilizacao4',
      RecepcaoEvento: 'https://nfe.sefa.pr.gov.br/nfe/NFeRecepcaoEvento4',
      NfeConsultaCadastro: 'https://nfe.sefa.pr.gov.br/nfe/CadConsultaCadastro4',
    },
    homologacao: {
      NfeAutorizacao: 'https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeAutorizacao4',
      NfeRetAutorizacao: 'https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeRetAutorizacao4',
      NfeConsultaProtocolo: 'https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeConsultaProtocolo4',
      NfeStatusServico: 'https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeStatusServico4',
      NfeInutilizacao: 'https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeInutilizacao4',
      RecepcaoEvento: 'https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeRecepcaoEvento4',
      NfeConsultaCadastro: 'https://homologacao.nfe.sefa.pr.gov.br/nfe/CadConsultaCadastro4',
    },
  },
  // RS's own host — distinct from `nfe.svrs.rs.gov.br` (the SVRS *shared*
  // authorizer other UFs delegate to, and RS's own SVC-RS contingency host).
  // Consulta Cadastro is the one service RS itself does NOT host: even RS's
  // own normal-mode table points it at `cad.svrs.rs.gov.br`.
  RS: {
    producao: {
      NfeAutorizacao: 'https://nfe.sefazrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
      NfeRetAutorizacao:
        'https://nfe.sefazrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx',
      NfeConsultaProtocolo: 'https://nfe.sefazrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx',
      NfeStatusServico: 'https://nfe.sefazrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx',
      NfeInutilizacao: 'https://nfe.sefazrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx',
      RecepcaoEvento: 'https://nfe.sefazrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx',
      NfeConsultaCadastro:
        'https://cad.svrs.rs.gov.br/ws/cadconsultacadastro/cadconsultacadastro4.asmx',
    },
    homologacao: {
      NfeAutorizacao:
        'https://nfe-homologacao.sefazrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
      NfeRetAutorizacao:
        'https://nfe-homologacao.sefazrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx',
      NfeConsultaProtocolo:
        'https://nfe-homologacao.sefazrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx',
      NfeStatusServico:
        'https://nfe-homologacao.sefazrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx',
      NfeInutilizacao:
        'https://nfe-homologacao.sefazrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx',
      RecepcaoEvento:
        'https://nfe-homologacao.sefazrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx',
      NfeConsultaCadastro:
        'https://cad-homologacao.svrs.rs.gov.br/ws/cadconsultacadastro/cadconsultacadastro4.asmx',
    },
  },
};

/**
 * SVRS (Sefaz Virtual Rio Grande do Sul) — the shared normal-mode authorizer
 * for the 16 UFs with no dedicated host of their own. Same physical host as
 * the SVC-RS contingency authorizer (`SVC_RS_ENDPOINTS` below); NfeConsultaCadastro
 * lives on the sibling `cad(.-homologacao)?.svrs.rs.gov.br` host, same as RS's own
 * table above.
 */
const SVRS_NORMAL_ENDPOINTS: Record<Ambiente, NfeServiceUrls> = {
  producao: {
    NfeAutorizacao: 'https://nfe.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
    NfeRetAutorizacao: 'https://nfe.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx',
    NfeConsultaProtocolo: 'https://nfe.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx',
    NfeStatusServico: 'https://nfe.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx',
    NfeInutilizacao: 'https://nfe.svrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx',
    RecepcaoEvento: 'https://nfe.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx',
    NfeConsultaCadastro:
      'https://cad.svrs.rs.gov.br/ws/cadconsultacadastro/cadconsultacadastro4.asmx',
  },
  homologacao: {
    NfeAutorizacao: 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
    NfeRetAutorizacao:
      'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx',
    NfeConsultaProtocolo: 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx',
    NfeStatusServico:
      'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx',
    NfeInutilizacao:
      'https://nfe-homologacao.svrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx',
    RecepcaoEvento: 'https://nfe-homologacao.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx',
    NfeConsultaCadastro:
      'https://cad-homologacao.svrs.rs.gov.br/ws/cadconsultacadastro/cadconsultacadastro4.asmx',
  },
};

/** The 16 UFs with no dedicated host, delegated to {@link SVRS_NORMAL_ENDPOINTS}. */
const SVRS_NORMAL_UFS: readonly string[] = [
  'AC',
  'AL',
  'AP',
  'CE',
  'DF',
  'ES',
  'PA',
  'PB',
  'PI',
  'RJ',
  'RN',
  'RO',
  'RR',
  'SC',
  'SE',
  'TO',
];

/**
 * SVAN (Sefaz Virtual Ambiente Nacional) — MA's normal-mode authorizer.
 * Same physical host as the SVC-AN contingency authorizer (`SVC_AN_ENDPOINTS`
 * below), a distinct role. No NfeConsultaCadastro (empty in the SEFAZ portal
 * table, like AM and SVC-AN).
 */
const SVAN_NORMAL_ENDPOINTS: Record<Ambiente, NfeServiceUrls> = {
  producao: {
    NfeAutorizacao: 'https://www.sefazvirtual.fazenda.gov.br/NFeAutorizacao4/NFeAutorizacao4.asmx',
    NfeRetAutorizacao:
      'https://www.sefazvirtual.fazenda.gov.br/NFeRetAutorizacao4/NFeRetAutorizacao4.asmx',
    NfeConsultaProtocolo:
      'https://www.sefazvirtual.fazenda.gov.br/NFeConsultaProtocolo4/NFeConsultaProtocolo4.asmx',
    NfeStatusServico:
      'https://www.sefazvirtual.fazenda.gov.br/NFeStatusServico4/NFeStatusServico4.asmx',
    NfeInutilizacao:
      'https://www.sefazvirtual.fazenda.gov.br/NFeInutilizacao4/NFeInutilizacao4.asmx',
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
    NfeInutilizacao:
      'https://hom.sefazvirtual.fazenda.gov.br/NFeInutilizacao4/NFeInutilizacao4.asmx',
    RecepcaoEvento:
      'https://hom.sefazvirtual.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx',
  },
};

for (const uf of SVRS_NORMAL_UFS) ENDPOINTS[uf] = SVRS_NORMAL_ENDPOINTS;
ENDPOINTS.MA = SVAN_NORMAL_ENDPOINTS;

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
 * inutilizar via SVC must not typecheck. `NfeConsultaCadastro` is likewise
 * excluded — Consulta Cadastro is a home-SEFAZ service, never an SVC one, so it
 * stays out of the `SefazService` keyspace that `sefazCallFor` addresses.
 */
export type SvcServiceUrls = Omit<NfeServiceUrls, 'NfeInutilizacao' | 'NfeConsultaCadastro'>;

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
    super(`No NF-e endpoint table for UF '${uf}'.`);
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

/**
 * Resolve the NFeConsultaCadastro4 URL for a UF + ambiente, or `null` when the
 * UF has no endpoint table wired OR does not offer Consulta Cadastro. Unlike
 * `getEndpoints`, this **never throws** for an unwired UF — Consulta Cadastro is
 * an advisory, best-effort lookup, so the route maps a `null` to a graceful
 * `supported:false` payload rather than a 5xx.
 */
export function getConsultaCadastroEndpoint(uf: string, ambiente: Ambiente): string | null {
  const table = ENDPOINTS[uf.toUpperCase()];
  if (!table) return null;
  return table[ambiente].NfeConsultaCadastro ?? null;
}

/** UFs with an endpoint table wired today. */
export function supportedUFs(): string[] {
  return Object.keys(ENDPOINTS);
}
