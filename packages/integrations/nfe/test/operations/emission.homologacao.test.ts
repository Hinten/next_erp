/**
 * Live SEFAZ-SP homologação **emission** round-trip.
 *
 * Skipped automatically unless `NFE_CERT_BASE64` + `NFE_CERT_PASSWORD` are
 * set. Run locally with:
 *
 *   $env:NFE_CERT_BASE64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("path-to.pfx"))
 *   $env:NFE_CERT_PASSWORD = "your-pfx-password"
 *   pnpm --filter @delfrance/integrations-nfe test emission.homologacao
 *
 * Proves the **full Phase A stack** issues an NF-e SEFAZ accepts:
 *
 *   generateNFe (incl. tribute engine fixture)
 *     → signNFe (XMLDSig over <infNFe>)
 *       → autorizarLote (mTLS + XSD-gated POST, indSinc='1')
 *         → assert retEnviNFe.protNFe.infProt.cStat === '100'
 *
 * Sub-test 2 — **duplicidade recovery**: resubmit the same signed NF-e;
 * SEFAZ replies with `cStat=204` ("Duplicidade de NF-e"). The recovery
 * flow then calls `consultarSituacaoNFe(chave)` which must surface the
 * original `protNFe.infProt.cStat=100`. This is the contract the
 * orchestrator's anti-loss path relies on.
 *
 * SEFAZ-status pre-flight lives in `ci-nfe.yml`'s "SEFAZ-SP HOM
 * status gate" step (runs `operations.homologacao.test.ts` once,
 * before any emission). This file no longer pings the status endpoint
 * itself — each CI run makes a single status call total instead of
 * one per emission test, keeping us well below the cStat=656
 * ("Consumo Indevido") throttle. Locally, mirror the gate posture by
 * running `pnpm --filter @delfrance/integrations-nfe test
 * operations.homologacao` before this suite.
 *
 * The test hand-builds a complete `GeneratorInput` so it has **no
 * Firestore dependency** and stays library-level. `numeracao` comes
 * from `seedNNF()` in `../helpers/homologacao-seed.ts` — see that file
 * for the cross-CI-run collision-avoidance rationale (high-zone +
 * Date.now()-based offset over ~500M slots).
 *
 * **serie lane**: this test runs on **serie=2**; the orchestrator test
 * at `apps/nfe/test/lib/nfe/orchestrator.homologacao.test.ts` owns
 * serie=1. SEFAZ keys persistence on serie, so the two test paths can
 * never collide at the (CNPJ, serie, tpAmb, tpEmis, nNF) key.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { seedNNF } from '../helpers/homologacao-seed';
import {
  assertCertNotExpired,
  hasNFeCertEnv,
  loadCertificateFromEnv,
  type NFeCertificate,
} from '../../src/cert';
import { assertNotConsumoIndevido } from '../../src/state';
import { getEndpoints } from '../../src/endpoints';
import { generateNFe, type GeneratorInput } from '../../src/generator';
import { signNFe } from '../../src/sign';
import { createSefazAgent, type SefazCall } from '../../src/soap';
import {
  buildImpostoXml,
  buildPagXml,
  buildTotalXml,
  buildTranspXml,
  aggregateTotals,
  type Imposto,
} from '../../src/tribute';
import type { TProtNFe } from '../../src/types/nfe-schema';
import {
  autorizarLote,
  consultarLote,
  consultarSituacaoNFe,
} from '../../src/operations/index';

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDORED_CHAIN = resolve(HERE, '..', '..', 'ca', 'sefaz-sp-homologacao.pem');

// IE (Inscrição Estadual) is a state-level registration; ICP-Brasil
// A1 certs are federal and do not carry it. SEFAZ rejects with
// cStat=209 ("IE do emitente inválida") when the IE in the XML
// doesn't match the IE registered for the cert's CNPJ at the state
// SEFAZ — there's no algorithmic way to derive one from the other,
// so the maintainer should set `NFE_TEST_IE` in `.env.local` to the
// real IE issued for the company that owns the loaded A1 cert.
// See `apps/nfe/.env.example`.
//
// When `NFE_TEST_IE` is unset, fall back to a 12-digit placeholder.
// This supports the self-signed cert experiment (Phase 2 of the
// `rosy-nibbling-wand` plan): probe SEFAZ-SP HOM with no IE secret
// configured and see whether the response tells us we need one
// (cStat=209) or not.
const TEST_IE = process.env.NFE_TEST_IE ?? '111111111111';

const hasFullCreds = hasNFeCertEnv() && Boolean(TEST_IE);

const describeOrSkip = hasFullCreds ? describe : describe.skip;

// Load the cert once when env vars are set so the fixture can read its
// CNPJ. SEFAZ rejection 213 (CNPJ-Base do Emitente difere do CNPJ-Base
// do Certificado Digital) fires whenever the emit CNPJ's first 8 digits
// don't match the cert's — wiring the fixture to the cert eliminates
// that failure mode regardless of which valid A1 PFX is loaded.
const TEST_CERT = hasFullCreds ? loadCertificateFromEnv() : null;

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Hand-built CSOSN 102 fixture — the minimum SN posture the tribute engine
 * builds. Default `PIS NT` + `COFINS NT` (CST 07) are stamped by the engine
 * itself when `configuracaoPIS` / `configuracaoCOFINS` are absent.
 */
function impostoCsosn102(): Imposto {
  return {
    origem: '0',
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
 * Build a `GeneratorInput` for a single-item CSOSN 102 NF-e against
 * SEFAZ-SP homologação. Caller passes the unique `numeracao` so each
 * sub-test gets a fresh chave (≠ duplicidade collision with itself).
 *
 * **Stress-tested free-text fields.** Marketplaces frequently ship
 * fiscally-dirty data into address / razão social / complemento fields
 * (accents, `@#%$[]{}` etc.). The fixture intentionally seeds those
 * shapes so the live round-trip proves the sanitizer cleans them well
 * enough for SEFAZ to accept the resulting XML.
 */
function buildFixture(numeracao: number): GeneratorInput {
  const imposto = impostoCsosn102();
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
    impostoXml: buildImpostoXml(imposto, { vProd: 1500 }),
  } as const;

  const totals = aggregateTotals([{ item: { vProd: 1500 }, imposto }]);

  return {
    ambiente: 'homologacao',
    numeracao,
    // serie=2 is the library test's lane; serie=1 belongs to the
    // orchestrator test at apps/nfe/test/lib/nfe/orchestrator.homologacao.test.ts.
    // Keeping the lanes split eliminates the cross-test (CNPJ, serie,
    // tpAmb, tpEmis, nNF) collision that would otherwise surface as
    // cStat=539 ("duplicidade") on whichever runs second at SEFAZ.
    serie: 2,
    dhEmi: new Date(),
    filial: {
      // CNPJ comes from the loaded A1 cert — SEFAZ enforces "first 8
      // digits of emit CNPJ must match cert CNPJ-base" (rejection 213).
      // The non-null assertion is sound: this fixture is only reachable
      // inside `describeOrSkip`, which short-circuits when `hasCert`
      // (and therefore TEST_CERT) is false.
      cnpj: TEST_CERT!.cnpj,
      // razão social often arrives from cadastro with stray symbols + accents.
      razaoSocial: 'EMPRESA HOMOLOGAÇÃO & CIA. LTDA — ME [@#$%]',
      fantasia: null,
      cnae: null,
      // IE comes from NFE_TEST_IE — should be the IE registered at the
      // state SEFAZ for the same CNPJ that signs the cert (rejection
      // 209 fires otherwise). Falls back to a 12-digit placeholder
      // when the env var is unset (self-signed Phase 2 probe).
      ie: TEST_IE,
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
        estado: 'SP',
        cPais: '1058',
        pais: 'BRASIL',
        nome: null,
        cpf_cnpj: null,
        rg: null,
        ie: null,
        imun: null,
        email: null,
        telefone: null,
      },
    },
    operacao: {
      nome: 'Venda',
      naturezaDaOperacao: 'Venda de mercadoria',
      tipo: 1,
      ehServico: false,
      ehExterior: false,
      // The fixture's cliente has no IE (cliente.ie is null), so
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
      indPres: '2',
      // indIntermed='1' means the sale was brokered by a marketplace.
      // Pairs with the `infIntermed` block below (CNPJ + seller's
      // store ID on the marketplace). SEFAZ NT 2020.006.
      indIntermed: '1',
      cfop: '5102',
      cfopInterestadual: '6102',
      NCM: '61099000',
      CEST: '2803800',
      unidade: 'UN',
      infCpl: null,
    },
    cliente: {
      tipo: '1',
      // dest.xNome is replaced by the homologação literal — cliente.nome
      // here exists only for completeness; sanitization is exercised by
      // the address fields above.
      nome: 'CLIENTE HOMOLOGACAO',
      cpf_cnpj: '99999999000191',
      idEstrangeiro: null,
      ie: null,
      imun: null,
      isUF: null,
      email: null,
      telefone: null,
      observacoesInternas: null,
      timestamp: null,
      nome_embedding: null,
      telefone_embedding: null,
      userCliente: null,
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
      estado: 'SP',
      cPais: '1058',
      pais: 'BRASIL',
      nome: null,
      cpf_cnpj: null,
      rg: null,
      ie: null,
      imun: null,
      email: null,
      telefone: null,
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
    // a <cobr> alongside is structurally legal and exercises the new
    // typed cobr builder end-to-end against live SEFAZ. vLiq + sum of
    // dup.vDup must match the pag.vPag total or SEFAZ rejects with a
    // cross-field cStat — here we use a single duplicata of 1500.00
    // to keep the math trivial.
    cobr: {
      fat: {
        nFat: 'FAT-HOMOLOG-001',
        vOrig: '1500.00',
        vDesc: '0.00',
        vLiq: '1500.00',
      },
      dup: [{ nDup: '001', dVenc: '2026-06-20', vDup: '1500.00' }],
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

/** Read the vendored SEFAZ TLS chain (created by `pnpm fetch:sefaz-ca`). */
function readVendoredCA(): string | undefined {
  const caPath =
    process.env.NFE_TLS_CA_PATH ?? (existsSync(VENDORED_CHAIN) ? VENDORED_CHAIN : undefined);
  return caPath ? readFileSync(caPath, 'utf8') : undefined;
}

/**
 * Build the typed SefazCall context for one operation URL.
 *
 * Takes the cert as a parameter so the test file parses the PFX exactly
 * once (via the top-level `TEST_CERT`) instead of re-parsing on every
 * SOAP call. Each parse fires `loadCertificateFromEnv`'s audit log line —
 * one per file is the right shape.
 */
function buildCall(url: string, cert: NFeCertificate): SefazCall {
  assertCertNotExpired(cert);
  const agent = createSefazAgent(cert, { ca: readVendoredCA() });
  return { url, cert, agent, tpAmb: '2', timeoutMs: 60_000 };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeOrSkip('SEFAZ-SP homologação — library duplicidade-recovery contract', () => {
  // NOTE: the previous "generate → sign → autorizarLote (indSinc=1) →
  // cStat=100" happy-path test was removed when the orchestrator-level
  // homologação test (`apps/nfe/test/lib/nfe/orchestrator.homologacao.test.ts`)
  // landed in PR-γ — that test covers the same library call chain
  // through `emitirPedido` plus the Firestore persistence layer. The
  // duplicidade test below stays because it pins the consSitNFe
  // recovery contract the orchestrator's anti-loss path depends on
  // (see `recoverFrom539` in `apps/nfe/lib/nfe/orchestrator.ts`).
  it(
    'duplicidade recovery — second emission returns 204, consSitNFe resolves to original 100',
    async () => {
      // SEFAZ status pre-flight intentionally removed — the ci-nfe.yml
      // "SEFAZ-SP HOM status gate" step runs operations.homologacao
      // immediately before this test and short-circuits the whole job
      // on cStat ≠ 107/108/109, so re-pinging the status endpoint here
      // would just feed the 656 throttle for no extra signal.
      const numeracao = seedNNF();
      const fixture = buildFixture(numeracao);
      const out = generateNFe(fixture);

      const autorizacaoCall = buildCall(
        getEndpoints('SP', 'homologacao').NfeAutorizacao,
        TEST_CERT!,
      );
      const signedXml = signNFe(out.nfeXml, autorizacaoCall.cert);

      // 1st submission — must succeed.
      const first = await autorizarLote(autorizacaoCall, {
        idLote: out.chave.slice(-15),
        NFe: [signedXml],
        indSinc: '1',
      });
      assertNotConsumoIndevido(first, 'duplicidade/autorizarLote#1');
      const firstProt = await resolveProtocol(first, autorizacaoCall);
      if (firstProt) assertNotConsumoIndevido(firstProt.infProt, 'duplicidade/protNFe#1');
      expect(firstProt?.infProt.cStat).toBe('100');
      const firstNProt = firstProt!.infProt.nProt;

      // Throttle between identical-payload submissions.
      await new Promise((r) => setTimeout(r, 1000));

      // 2nd submission — same chave, expect cStat=204 (Duplicidade).
      // SEFAZ surfaces 204 either at the lote level OR inside protNFe
      // depending on lot composition; accept either as long as the
      // chave is rejected as duplicate.
      const second = await autorizarLote(autorizacaoCall, {
        idLote: out.chave.slice(-15),
        NFe: [signedXml],
        indSinc: '1',
      });
      assertNotConsumoIndevido(second, 'duplicidade/autorizarLote#2');
      // eslint-disable-next-line no-console
      console.log(
        `[duplicidade lote2] cStat=${second.cStat} xMotivo="${second.xMotivo}"`,
      );
      const secondProt = await resolveProtocol(second, autorizacaoCall);
      if (secondProt) assertNotConsumoIndevido(secondProt.infProt, 'duplicidade/protNFe#2');
      const dupCStat = secondProt?.infProt.cStat ?? second.cStat;
      expect(['204', '539']).toContain(dupCStat);

      // Recovery query — proves the original 100 + nProt are still
      // resolvable by chave. This is the exact path the orchestrator's
      // anti-loss recovery uses when a SOAP response goes missing.
      await new Promise((r) => setTimeout(r, 1000));
      const consultaCall = buildCall(
        getEndpoints('SP', 'homologacao').NfeConsultaProtocolo,
        TEST_CERT!,
      );
      const sit = await consultarSituacaoNFe(consultaCall, { chave: out.chave });
      assertNotConsumoIndevido(sit, 'duplicidade/consSitNFe');
      // eslint-disable-next-line no-console
      console.log(
        `[consSitNFe] cStat=${sit.cStat} xMotivo="${sit.xMotivo}" prot.cStat=${sit.protNFe?.infProt.cStat}`,
      );
      // SEFAZ retConsSitNFe.cStat=100 means "consulta atendida"; the
      // **inner** protNFe.infProt.cStat is the actual NF-e status.
      expect(sit.chNFe).toBe(out.chave);
      expect(sit.protNFe?.infProt.cStat).toBe('100');
      expect(sit.protNFe?.infProt.nProt).toBe(firstNProt);
    },
    180_000,
  );

});

/**
 * Coerce a retEnviNFe (sync or async) down to the inner protNFe.
 *
 * - `cStat=104` (Lote processado) → `ret.protNFe` is set inline.
 * - `cStat=103` (Lote recebido) → poll `consultarLote` for the protNFe.
 * - `cStat=100` (rare for autorizarLote) → return ret as-is, no protNFe.
 * - anything else (denial, signature error, etc.) → return undefined so
 *   the caller surfaces the lote-level message.
 */
async function resolveProtocol(
  ret: { cStat: string; xMotivo: string; protNFe?: TProtNFe; infRec?: { nRec: string } },
  call: SefazCall,
): Promise<TProtNFe | undefined> {
  if (ret.protNFe) return ret.protNFe;
  if (ret.cStat !== '103') return undefined;
  if (!ret.infRec?.nRec) return undefined;
  // Bounded poll: 8 × 5s = 40s ceiling. SEFAZ's SLA: 95% within 3 min;
  // homologação typically replies in 1–3 polls.
  for (let attempt = 0; attempt < 8; attempt++) {
    await new Promise((r) => setTimeout(r, 5_000));
    const poll = await consultarLote(call, { nRec: ret.infRec.nRec });
    assertNotConsumoIndevido(poll, `consultarLote/attempt=${attempt + 1}`);
    // eslint-disable-next-line no-console
    console.log(
      `[consultarLote attempt=${attempt + 1}] cStat=${poll.cStat} xMotivo="${poll.xMotivo}"`,
    );
    if (poll.cStat === '105') continue; // ainda em processamento
    if (poll.protNFe && poll.protNFe[0]) return poll.protNFe[0];
    return undefined;
  }
  return undefined;
}
