/**
 * Shared `GeneratorInput` fixture for the live homologação suites
 * (`emission.homologacao.test.ts`, `svc.homologacao.test.ts`).
 *
 * Single-item CSOSN 102 NF-e. **Stress-tested free-text fields**:
 * marketplaces frequently ship fiscally-dirty data into address / razão
 * social / complemento fields (accents, `@#%$[]{}` etc.) — the fixture
 * intentionally seeds those shapes so every live round-trip proves the
 * sanitizer cleans them well enough for SEFAZ to accept the XML.
 *
 * Callers pass their own `serie` lane (see `homologacao-seed.ts` for the
 * lane registry) and a fresh `numeracao` per emission. `contingencia`
 * stamps tpEmis 6/7 + the B28/B29 pair for the SVC suite; omitting it
 * produces a normal tpEmis=1 NF-e.
 */
import {
  buildImpostoXml,
  buildPagXml,
  buildTotalXml,
  buildTranspXml,
  aggregateTotals,
  type Imposto,
} from '../../src/tribute';
import {
  IE_SENTINELA,
  IND_INTERMED_OPERACAO,
  IND_PRES_OPERACAO,
  ORIGEM,
  TIPO_CLIENTE,
  UF_SIGLA,
} from '@delfrance/schemas';

import type { GeneratorInput } from '../../src/generator';

/**
 * Hand-built CSOSN 102 fixture — the minimum SN posture the tribute engine
 * builds. Default `PIS NT` + `COFINS NT` (CST 07) are stamped by the engine
 * itself when `configuracaoPIS` / `configuracaoCOFINS` are absent.
 */
export function impostoCsosn102(): Imposto {
  return {
    origem: ORIGEM.nacional,
    cfop: '5102',
    cfopInterestadual: '6102',
    NCM: '61099000',
    unidade: 'UN',
    configuracaoICMS: {
      crt: '1',
      csosn: '102',
    },
    configuracaoPIS: null,
    configuracaoCOFINS: null,
  };
}

/**
 * CSOSN 102 + a **Reforma Tributária (IBS/CBS/IS)** "tributação integral"
 * config (NT 2025.002) for the live RTC homologação test.
 *
 * **CST `000` + cClassTrib `000001` = "tributação integral"** (IBS/CBS apply
 * normally, no benefit; the first 3 digits of cClassTrib mirror the CST). This
 * is the generic full-taxation code — Simples Nacional has no specific code yet
 * (the fields are facultativos for CRT=1 until 2027-01-04). An earlier run with
 * the non-existent `000000` returned cStat=1023 ("Classificação Tributária do
 * IBS/CBS inexistente"); `000001` is the real Anexo III code. The alíquotas are
 * the documented 2025–2026 test rates (IBS 0,1% / CBS 0,9%). If SEFAZ still
 * rejects (1024 incompatible / 1026 alíquota), refine from the `xMotivo`.
 */
export function impostoCsosn102ComRtc(): Imposto {
  return {
    ...impostoCsosn102(),
    configuracaoIBSCBS: {
      CST: '000',
      cClassTrib: '000001',
      pIBSUF: 0.1,
      pIBSMun: 0,
      pCBS: 0.9,
    },
  };
}

/** `YYYY-MM-DD` for now + `days` — keeps date-bearing fixture fields evergreen. */
function isoDatePlusDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

export interface HomologacaoFixtureOpts {
  /** Fresh `nNF` per emission — draw from `seedNNF()` and increment. */
  readonly numeracao: number;
  /** The caller's serie lane — see the registry in `homologacao-seed.ts`. */
  readonly serie: number;
  /**
   * Emit CNPJ — MUST come from the loaded A1 cert. SEFAZ enforces "first 8
   * digits of emit CNPJ must match cert CNPJ-base" (rejection 213).
   */
  readonly cnpj: string;
  /**
   * IE registered at the state SEFAZ for the cert's CNPJ (`NFE_TEST_IE`) —
   * rejection 209 fires otherwise.
   */
  readonly ie: string;
  /**
   * SVC contingency stamp: tpEmis 6/7 + the B28/B29 pair. The generator
   * enforces dhCont presence and xJust 15–255 chars post-sanitization.
   */
  readonly contingencia?: {
    readonly tpEmis: 6 | 7;
    readonly dhCont: Date;
    readonly xJust: string;
  };
  /** Override the default CSOSN-102 imposto (e.g. the RTC variant). */
  readonly imposto?: Imposto;
  /** Emit the Reforma Tributária (IBS/CBS/IS) item + total groups. */
  readonly emitRtc?: boolean;
}

/** Build a complete single-item `GeneratorInput` against homologação. */
export function buildHomologacaoFixture(opts: HomologacaoFixtureOpts): GeneratorInput {
  const imposto = opts.imposto ?? impostoCsosn102();
  const emitRtc = opts.emitRtc === true;
  const item = {
    nItem: 1,
    // xProd flows through sanitizeNFeText — accents + restricted chars
    // here exercise the per-item sanitization path.
    cProd: 'SKU-A',
    cEAN: 'SEM GTIN',
    xProd: 'Mercadoria com acentuação — ÁÉÍÓÚ@#$%',
    NCM: '61099000',
    CFOP: '5102',
    uCom: 'UN',
    qCom: 1,
    vUnCom: 1500,
    vProd: 1500,
    cEANTrib: 'SEM GTIN',
    uTrib: 'UN',
    qTrib: 1,
    vUnTrib: 1500,
    impostoXml: buildImpostoXml(imposto, { vProd: 1500 }, { emitRtc }),
  } as const;

  const totals = aggregateTotals([{ item: { vProd: 1500 }, imposto }], {}, { emitRtc });

  return {
    ambiente: 'homologacao',
    numeracao: opts.numeracao,
    serie: opts.serie,
    dhEmi: new Date(),
    ...(opts.contingencia
      ? {
          tpEmis: opts.contingencia.tpEmis,
          dhCont: opts.contingencia.dhCont,
          xJust: opts.contingencia.xJust,
        }
      : {}),
    filial: {
      cnpj: opts.cnpj,
      // razão social often arrives from cadastro with stray symbols + accents.
      razaoSocial: 'EMPRESA HOMOLOGAÇÃO & CIA. LTDA — ME [@#$%]',
      fantasia: null,
      cnae: null,
      ie: opts.ie,
      iest: null,
      imun: null,
      sede: {
        idExterno: null,
        // Endereço fields go through sanitizeNFeText (acentos stripped,
        // restricted chars dropped). Real marketplace data routinely
        // contains `Nº`, `°`, accentuated bairros, and stray symbols.
        logradouro: 'Rua das Açucenas Nº 1234 — Bloco A',
        numero: '1',
        bairro: 'Vila São João',
        complemento: 'Sala 12 — Andar 3º [@] $%',
        cep: '01001000',
        codigoMunicipio: '3550308',
        cidade: 'São Paulo',
        estado: UF_SIGLA.SP,
        cPais: '1058',
        pais: 'BRASIL',
        nome: null,
        cpf_cnpj: null,
        rg: null,
        ie: null,
        imun: null,
        email: null,
        telefone: null,
        timestamp: null,
      },
    },
    operacao: {
      nome: 'Venda',
      naturezaDaOperacao: 'Venda de mercadoria',
      tipo: 1,
      ehServico: false,
      ehExterior: false,
      // The fixture's cliente carries the NAO CONTRIBUINTE sentinel, so
      // `buildDest` stamps indIEDest='9' (não contribuinte). SEFAZ rule
      // 696 then demands indFinal='1' — i.e. the operation must be
      // marked as final-consumer. Flipping this to `true` satisfies
      // the cross-field consistency check and matches the semantics
      // of the fixture (a marketplace-style sale to an end consumer
      // without state inscription).
      ehConsumidorFinal: true,
      padrao: false,
      ativo: true,
      movimentaEstoque: true,
      movimentaIndisponivelEstoque: true,
      ehFiscal: true,
      finNFe: 1,
      indPres: IND_PRES_OPERACAO.naoPresencialInternet,
      // indIntermed='1' means the sale was brokered by a marketplace.
      // Pairs with the `infIntermed` block below (CNPJ + seller's
      // store ID on the marketplace). SEFAZ NT 2020.006.
      indIntermed: IND_INTERMED_OPERACAO.plataformaTerceiros,
      cfop: '5102',
      cfopInterestadual: '6102',
      NCM: '61099000',
      CEST: '2803800',
      unidade: 'UN',
      infCpl: null,
    },
    cliente: {
      tipo: TIPO_CLIENTE.pessoaJuridica,
      // dest.xNome is replaced by the homologação literal — cliente.nome
      // here exists only for completeness; sanitization is exercised by
      // the address fields above.
      nome: 'CLIENTE HOMOLOGACAO',
      cpf_cnpj: '99999999000191',
      idEstrangeiro: null,
      // The NAO CONTRIBUINTE sentinel rather than `null`. Both now reach
      // indIEDest='9', but the sentinel says explicitly what this fixture
      // MEANS — a marketplace sale to an end consumer without state
      // inscription — instead of relying on the ladder's default for an
      // unclassified cliente. It also makes every live homologação
      // round-trip prove the sentinel never reaches the signed XML.
      ie: IE_SENTINELA.naoContribuinte,
      imun: null,
      isUF: null,
      email: null,
      telefone: null,
      observacoesInternas: null,
      timestamp: null,
      nome_embedding: null,
      telefone_embedding: null,
      userCliente: null,
      idMercadoLivre: null,
    },
    enderecoDest: {
      idExterno: null,
      logradouro: 'Avenida Brigadeiro Faria Lima — Nº 500',
      numero: '100',
      bairro: 'Jardim Paulistano (zona oeste)',
      complemento: 'Apto 101 — Bloco B [acentos: éáí] @$%',
      cep: '01001000',
      codigoMunicipio: '3550308',
      cidade: 'São Paulo',
      estado: UF_SIGLA.SP,
      cPais: '1058',
      pais: 'BRASIL',
      nome: null,
      cpf_cnpj: null,
      rg: null,
      ie: null,
      imun: null,
      email: null,
      telefone: null,
      timestamp: null,
    },
    itens: [item],
    totalXml: buildTotalXml(totals),
    // Exercise the optional <transporta> block (carrier disclosure).
    // modFrete='0' = CIF (frete contratado pelo Remetente) — the
    // sender contracts a third-party carrier. modes 3/4 ("transporte
    // próprio") would force the transporta CNPJ-base to match the
    // emit/dest CNPJ-base (rejection 846), which doesn't make sense
    // when a marketplace order uses a third-party carrier.
    transpXml: buildTranspXml({
      modFrete: '0',
      transporta: {
        CNPJ: '99999999000191',
        xNome: 'TRANSPORTADORA HOMOLOGACAO LTDA',
        IE: 'ISENTO',
        xEnder: 'Avenida das Cargas 100',
        xMun: 'Sao Paulo',
        UF: 'SP',
      },
    }),
    pagXml: buildPagXml([
      {
        tPag: '17',
        vPag: 1500,
        // SEFAZ rejects PIX with cStat=391 when the <card> block is
        // absent; tpIntegra='2' (standalone — the marketplace / PSP
        // is the acquirer, not an integrated POS) plus the PSP CNPJ
        // satisfies the rule. Real production callers would pass
        // the actual acquirer CNPJ; the placeholder works in HOM.
        card: { tpIntegra: '2', CNPJ: '99999999000191' },
      },
    ]),
    // <infIntermed> — required when indIntermed='1'. CNPJ is the
    // marketplace's, idCadIntTran is the seller's store id on that
    // marketplace. Both fake here for HOM smoke; production reads
    // these from Pedido.intermediador (Phase D wiring).
    infIntermed: {
      CNPJ: '99999999000191',
      idCadIntTran: 'SELLER-HOMOLOGACAO-001',
    },
    // <cobr> — billing structure (fatura + duplicatas). Even though
    // this fixture pays via PIX (single tPag='17' of R$1500), shipping
    // a <cobr> alongside is structurally legal and exercises the typed
    // cobr builder end-to-end against live SEFAZ. vLiq + sum of
    // dup.vDup must match the pag.vPag total or SEFAZ rejects with a
    // cross-field cStat — here we use a single duplicata of 1500.00
    // to keep the math trivial. dVenc is derived (emission + 30 days):
    // SEFAZ rejects a duplicata that falls due before dhEmi, so a
    // hard-coded date would turn into a time bomb for the live suites.
    cobr: {
      fat: {
        nFat: 'FAT-HOMOLOG-001',
        vOrig: '1500.00',
        vDesc: '0.00',
        vLiq: '1500.00',
      },
      dup: [{ nDup: '001', dVenc: isoDatePlusDays(30), vDup: '1500.00' }],
    },
    // <infAdic.infCpl> — fiscal complementary text shown on the
    // DANFE. Marketplaces typically inject order ID + buyer name
    // here. Free-text, sanitized by the generator (≤5000 chars).
    infAdic: {
      infCpl:
        'Pedido marketplace #ML-HOMOLOG-001 — comprador: CLIENTE HOMOLOGACAO. ' +
        'Mercadoria sem valor fiscal — emitida em ambiente de homologacao.',
    },
  };
}
