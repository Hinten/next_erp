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
 * Pre-flight: `consultarStatusServico` — if SEFAZ-SP is paralisado
 * (cStat 108/109) the test self-skips with a console warning rather
 * than failing (an upstream outage isn't our regression).
 *
 * The test hand-builds a complete `GeneratorInput` so it has **no
 * Firestore dependency** and stays library-level. `numeracao` is derived
 * from `Date.now() & 0xFFFF` so reruns don't collide on the natural key
 * (~65k unique nNF values per minute, well above CI cadence).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { assertCertNotExpired, loadCertificateFromEnv } from '../../src/cert';
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
  consultarStatusServico,
} from '../../src/operations/index';

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDORED_CHAIN = resolve(HERE, '..', '..', 'ca', 'sefaz-sp-homologacao.pem');

const hasCert =
  (Boolean(process.env.NFE_CERT_PATH) || Boolean(process.env.NFE_CERT_BASE64)) &&
  process.env.NFE_CERT_PASSWORD != null;

// IE (Inscrição Estadual) is a state-level registration; ICP-Brasil
// A1 certs are federal and do not carry it. SEFAZ rejects with
// cStat=209 ("IE do emitente inválida") when the IE in the XML
// doesn't match the IE registered for the cert's CNPJ at the state
// SEFAZ — there's no algorithmic way to derive one from the other,
// so the maintainer must set `NFE_TEST_IE` in `.env.local` to the
// real IE issued for the company that owns the loaded A1 cert.
// See `apps/nfe/.env.example`.
const TEST_IE = process.env.NFE_TEST_IE;

const hasFullCreds = hasCert && Boolean(TEST_IE);

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
    serie: 1,
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
      // IE comes from NFE_TEST_IE — must be the IE registered at the
      // state SEFAZ for the same CNPJ that signs the cert (rejection
      // 209 fires otherwise). describeOrSkip already short-circuits
      // when TEST_IE is absent.
      ie: TEST_IE!,
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

/** Build the typed SefazCall context for one operation URL. */
function buildCall(url: string): SefazCall {
  const cert = loadCertificateFromEnv();
  assertCertNotExpired(cert);
  const agent = createSefazAgent(cert, { ca: readVendoredCA() });
  return { url, cert, agent, tpAmb: '2', timeoutMs: 60_000 };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeOrSkip('SEFAZ-SP homologação — live emission round-trip', () => {
  it(
    'generate → sign → autorizarLote (indSinc=1) → assert protNFe.cStat=100',
    async () => {
      // Pre-flight reachability — fail LOUDLY if SEFAZ is paralisado.
      // We intentionally don't self-skip on 108/109: silently green
      // builds in a SEFAZ outage are the worst possible signal for a
      // fiscal pipeline. The test fails, we wait, we rerun when SEFAZ
      // is back. (Pulled the prior self-skip — too risky.)
      const statusCall = buildCall(getEndpoints('SP', 'homologacao').NfeStatusServico);
      const status = await consultarStatusServico(statusCall, { cUF: '35' });
      expect(status.cStat).toBe('107');

      // Build a one-shot NF-e with a fresh nNF so we don't trip duplicidade.
      const numeracao = 1_000_000 + (Date.now() & 0xffff);
      const fixture = buildFixture(numeracao);
      const out = generateNFe(fixture);

      const signedXml = signNFe(out.nfeXml, statusCall.cert);
      expect(signedXml).toContain(`Id="NFe${out.chave}"`);

      const autorizacaoCall = buildCall(
        getEndpoints('SP', 'homologacao').NfeAutorizacao,
      );
      // indSinc='1' so SEFAZ processes synchronously and returns the
      // protNFe inline — keeps the test fast (no poll needed in the
      // happy path) and matches Phase A's one-NF-e-per-lote shape.
      const ret = await autorizarLote(autorizacaoCall, {
        idLote: out.chave.slice(-15),
        NFe: [signedXml],
        indSinc: '1',
      });

      // eslint-disable-next-line no-console
      console.log(
        `[autorizarLote] cStat=${ret.cStat} xMotivo="${ret.xMotivo}" chave=${out.chave}`,
      );

      const prot = await resolveProtocol(ret, autorizacaoCall);
      expect(prot, `no protNFe surfaced (lote cStat=${ret.cStat} ${ret.xMotivo})`).toBeDefined();
      // eslint-disable-next-line no-console
      console.log(
        `[protNFe] cStat=${prot!.infProt.cStat} xMotivo="${prot!.infProt.xMotivo}" nProt=${prot!.infProt.nProt}`,
      );
      expect(prot!.infProt.chNFe).toBe(out.chave);
      expect(prot!.infProt.cStat).toBe('100');
    },
    120_000,
  );

  it(
    'duplicidade recovery — second emission returns 204, consSitNFe resolves to original 100',
    async () => {
      // Same posture as the happy-path test: paralisado is a hard fail,
      // not a silent skip.
      const statusCall = buildCall(getEndpoints('SP', 'homologacao').NfeStatusServico);
      const status = await consultarStatusServico(statusCall, { cUF: '35' });
      expect(status.cStat).toBe('107');

      // Throttle before exercising another emission to stay well below
      // SEFAZ's cStat=656 ("Consumo Indevido") threshold.
      await new Promise((r) => setTimeout(r, 1000));

      const numeracao = 1_000_000 + ((Date.now() + 1) & 0xffff);
      const fixture = buildFixture(numeracao);
      const out = generateNFe(fixture);
      const signedXml = signNFe(out.nfeXml, statusCall.cert);

      const autorizacaoCall = buildCall(
        getEndpoints('SP', 'homologacao').NfeAutorizacao,
      );

      // 1st submission — must succeed.
      const first = await autorizarLote(autorizacaoCall, {
        idLote: out.chave.slice(-15),
        NFe: [signedXml],
        indSinc: '1',
      });
      const firstProt = await resolveProtocol(first, autorizacaoCall);
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
      // eslint-disable-next-line no-console
      console.log(
        `[duplicidade lote2] cStat=${second.cStat} xMotivo="${second.xMotivo}"`,
      );
      const secondProt = await resolveProtocol(second, autorizacaoCall);
      const dupCStat = secondProt?.infProt.cStat ?? second.cStat;
      expect(['204', '539']).toContain(dupCStat);

      // Recovery query — proves the original 100 + nProt are still
      // resolvable by chave. This is the exact path the orchestrator's
      // anti-loss recovery uses when a SOAP response goes missing.
      await new Promise((r) => setTimeout(r, 1000));
      const consultaCall = buildCall(
        getEndpoints('SP', 'homologacao').NfeConsultaProtocolo,
      );
      const sit = await consultarSituacaoNFe(consultaCall, { chave: out.chave });
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
