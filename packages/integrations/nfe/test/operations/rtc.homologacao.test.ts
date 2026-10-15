/**
 * Live SEFAZ-SP homologação **Reforma Tributária (IBS/CBS/IS)** round-trip.
 *
 * Emits a real CRT=1 (Simples Nacional) NF-e carrying the NT 2025.002 RTC
 * groups (item `IBSCBS` + total `IBSCBSTot`) against SEFAZ-SP homologação and
 * asserts SEFAZ accepts it (`cStat=100`). The whole point is the empirical
 * "vai passar?" check that offline XSD validation can't give.
 *
 * Why this can pass TODAY (2026): in homologação the IBS/CBS/IS groups are
 * **facultativos** for CRT=1 until 2027-01-04, so SEFAZ accepts them when the
 * structure is valid. The vendored `DFeTiposBasicos_v1.00.xsd` already carries
 * the RTC layout (no schema drift).
 *
 * **Codes vs rates** — the fixture's CST `000` / cClassTrib `000001` is a row of
 * the vendored Anexo III table (`@delfrance/schemas` `CCLASSTRIB_TABELA`, #333);
 * the alíquotas are the documented 2025–2026 test rates (IBS 0,1% / CBS 0,9%).
 * The test logs the real `cStat` + `xMotivo` before asserting, so a rejection
 * names exactly what to refine — 1020/1023/1024 (CST/cClassTrib), 1026/1037
 * (alíquota), 1022 (grupo incompleto), or 1041/1091/1104 (totais).
 *
 * Drives the **real builder path** — the fixture stamps `configuracaoIBSCBS`
 * and emits with `{ emitRtc: true }`, so `buildImpostoXml` / `buildTotalXml`
 * produce the actual wire (this validates production code end-to-end, not
 * hand-assembled XML). The per-filial production flag stays off; `emitRtc` is
 * set explicitly only on this test path.
 *
 * Skipped automatically unless `NFE_CERT_BASE64`/`NFE_CERT_PATH` +
 * `NFE_CERT_PASSWORD` + `NFE_TEST_IE` are set (fail-loud in CI). Run locally:
 *
 *   pnpm --filter @delfrance/integrations-nfe test rtc.homologacao
 *
 * **Nota de débito (#330)** — a second case emits finNFe=6 / tpNFDebito=06
 * (pagamento antecipado) with the item carrying IBS/CBS ALONE (RV B25-80: no
 * ICMS, PIS or COFINS on a nota de crédito/débito). A third emits tpNFDebito=05
 * (transferência de crédito na sucessão): cClassTrib 800001 (CST 800) with the
 * `gTransfCred` adjustment group and no `gIBSCBS` — the empirical check of how
 * #330 part 3 read the NT. Same posture as the first: advisory on PR/push,
 * fatal on `workflow_dispatch`.
 *
 * **Devolução (#1683)** — a 2-line origin saída, then two devoluções that
 * reference it: by NFref alone with the RTC OFF (pinned at 321 — VC02-14 does
 * not skip non-RTC notas) and per item with the RTC on (100).
 *
 * **serie lane**: this test runs on **serie=4** (`SEFAZ_HOM_RTC_SERIE`) — full
 * lane registry in `../helpers/homologacao-seed.ts`. SEFAZ keys persistence on
 * serie, so it never collides with the other live suites at the (CNPJ, serie,
 * tpAmb, tpEmis, nNF) key.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';
import {
  FIN_NFE_OPERACAO,
  MODO_GRUPOS_IMPOSTO,
  TP_NF_DEBITO,
  cClassTribDoTipo,
  grupoDeAjusteDoTipo,
  modoGruposImposto,
} from '@delfrance/schemas';

import { buildHomologacaoFixture, impostoCsosn102ComRtc } from '../helpers/homologacao-fixture';
import { resolveProtocol } from '../helpers/resolve-protocol';
import { descreverSefaz, logSefaz } from '../helpers/sefaz-log';
import { seedNNF, SEFAZ_HOM_RTC_SERIE } from '../helpers/homologacao-seed';
import {
  assertCertNotExpired,
  hasNFeCertEnv,
  loadCertificateFromEnv,
  type NFeCertificate,
} from '../../src/cert';
import { assertNotConsumoIndevido } from '../../src/state';
import { getEndpoints } from '../../src/endpoints';
import { generateNFe } from '../../src/generator';
import { signNFe } from '../../src/sign';
import { createSefazAgent, type SefazCall } from '../../src/soap';
import { autorizarLote } from '../../src/operations/index';

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDORED_CHAIN = resolve(HERE, '..', '..', 'ca', 'sefaz-sp-homologacao.pem');

// IE registered for the cert's CNPJ at the state SEFAZ — REQUIRED (rejection
// 209 otherwise); no algorithmic fallback, set `NFE_TEST_IE` in `.env.local`.
const TEST_IE = process.env.NFE_TEST_IE;

const hasFullCreds = hasNFeCertEnv() && Boolean(TEST_IE);

// Local run without credentials → skip cleanly; CI fails loud in beforeAll.
const describeOrSkip = !hasFullCreds && !process.env.CI ? describe.skip : describe;

// Parse the PFX once so the fixture can read the emit CNPJ (rejection 213).
const TEST_CERT = hasFullCreds ? loadCertificateFromEnv() : null;

/** Read the vendored SEFAZ TLS chain (created by `pnpm fetch:sefaz-ca`). */
function readVendoredCA(): string | undefined {
  const caPath =
    process.env.NFE_TLS_CA_PATH ?? (existsSync(VENDORED_CHAIN) ? VENDORED_CHAIN : undefined);
  return caPath ? readFileSync(caPath, 'utf8') : undefined;
}

/**
 * Sign, send (indSinc=1) and resolve one fixture; returns SEFAZ's verdict and
 * the chave, so a later case can reference the nota (#1683). The chave embeds
 * the emitente CNPJ: it may reach the public log only through `logSefaz` /
 * `descreverSefaz`, which mask it.
 */
async function emitir(
  fixture: ReturnType<typeof buildHomologacaoFixture>,
  rotulo: string,
): Promise<{ cStat: string; xMotivo: string; chave: string }> {
  const out = generateNFe(fixture);
  const autorizacaoCall = buildCall(getEndpoints('SP', 'homologacao').NfeAutorizacao, TEST_CERT!);
  const consReciCall = buildCall(getEndpoints('SP', 'homologacao').NfeRetAutorizacao, TEST_CERT!);
  const signedXml = signNFe(out.nfeXml, autorizacaoCall.cert);

  const ret = await autorizarLote(autorizacaoCall, {
    idLote: out.chave.slice(-15),
    NFe: [signedXml],
    indSinc: '1',
  });
  assertNotConsumoIndevido(ret, `${rotulo}/autorizarLote`);
  logSefaz(`${rotulo} lote`, ret);
  const prot = await resolveProtocol(ret, consReciCall);
  if (prot) assertNotConsumoIndevido(prot.infProt, `${rotulo}/protNFe`);
  const cStat = prot?.infProt.cStat ?? ret.cStat;
  const xMotivo = prot?.infProt.xMotivo ?? ret.xMotivo;
  logSefaz(`${rotulo} protNFe`, { cStat, xMotivo });
  return { cStat, xMotivo, chave: out.chave };
}

/** Build the typed SefazCall context for one operation URL (tpAmb=2). */
function buildCall(url: string, cert: NFeCertificate): SefazCall {
  assertCertNotExpired(cert);
  const agent = createSefazAgent(cert, { ca: readVendoredCA() });
  return { url, cert, agent, tpAmb: '2', timeoutMs: 60_000 };
}

describeOrSkip('SEFAZ-SP homologação — Reforma Tributária (IBS/CBS/IS) emission', () => {
  beforeAll(() => {
    if (!hasFullCreds) {
      throw new Error(
        'Live RTC homologação test requires real credentials. Missing one of: ' +
          'NFE_CERT_PATH|NFE_CERT_BASE64 + NFE_CERT_PASSWORD, NFE_TEST_IE. ' +
          'Refusing to skip a fiscal live lane silently.',
      );
    }
  });

  it('emits a CRT=1 NF-e with IBS/CBS groups — SEFAZ accepts (cStat=100)', async () => {
    const numeracao = seedNNF();
    const fixture = buildHomologacaoFixture({
      numeracao,
      serie: SEFAZ_HOM_RTC_SERIE,
      cnpj: TEST_CERT!.cnpj,
      ie: TEST_IE!,
      imposto: impostoCsosn102ComRtc(),
      emitRtc: true,
    });
    const { cStat, xMotivo } = await emitir(fixture, 'rtc');
    // Targets cStat=100. On a rejection the log above names the exact
    // code/alíquota to refine (1020/1023/1024/1026/...).
    //
    // ⚠️ The assertion message goes through `descreverSefaz` too: a vitest
    // message lands in the CI ANNOTATION, which is as public as the log.
    expect(
      cStat,
      `SEFAZ rejected the RTC NF-e — ${descreverSefaz('rtc protNFe', { cStat, xMotivo })}`,
    ).toBe('100');
  }, 180_000);

  it('emits a nota de débito 06 (pagamento antecipado), IBS/CBS only — SEFAZ accepts (cStat=100)', async () => {
    const fixture = buildHomologacaoFixture({
      numeracao: seedNNF(),
      serie: SEFAZ_HOM_RTC_SERIE,
      cnpj: TEST_CERT!.cnpj,
      ie: TEST_IE!,
      imposto: impostoCsosn102ComRtc(),
      emitRtc: true,
      grupos: MODO_GRUPOS_IMPOSTO.somenteIbsCbs,
      operacao: {
        naturezaDaOperacao: 'Nota de debito - pagamento antecipado',
        finNFe: FIN_NFE_OPERACAO.debito,
        tpNFDebito: TP_NF_DEBITO.pagamentoAntecipado,
      },
    });
    const { cStat, xMotivo } = await emitir(fixture, 'rtc-debito');
    // A rejection names the rule to refine: 1001 (a forbidden group), 1009/1139
    // (the tipo), 1162 (tpNF), 1200/1202 (cClassTrib × tipo).
    expect(
      cStat,
      `SEFAZ rejected the nota de débito — ${descreverSefaz('rtc-debito protNFe', { cStat, xMotivo })}`,
    ).toBe('100');
  }, 180_000);

  it('emits a nota de débito 05 (transferência de crédito na sucessão) with gTransfCred — SEFAZ accepts (cStat=100)', async () => {
    // The tipo decides classification, group and mode — the same shared
    // functions apps/nfe derives them with (`ajusteDoItem`, `modoGruposFor`).
    const tipo = {
      finNFe: FIN_NFE_OPERACAO.debito,
      tpNFDebito: TP_NF_DEBITO.transferenciaCreditoSucessao,
      tpNFCredito: null,
    };
    const fixture = buildHomologacaoFixture({
      numeracao: seedNNF(),
      serie: SEFAZ_HOM_RTC_SERIE,
      cnpj: TEST_CERT!.cnpj,
      ie: TEST_IE!,
      imposto: impostoCsosn102ComRtc(),
      emitRtc: true,
      grupos: modoGruposImposto(tipo),
      operacao: {
        naturezaDaOperacao: 'Nota de debito - transferencia de credito',
        finNFe: tipo.finNFe,
        tpNFDebito: tipo.tpNFDebito,
      },
      ajuste: {
        cClassTrib: cClassTribDoTipo(tipo)!,
        grupo: grupoDeAjusteDoTipo(tipo)!,
        vIBS: 1.5,
        vCBS: 13.5,
        competApur: null,
      },
    });
    const { cStat, xMotivo } = await emitir(fixture, 'rtc-debito05');
    // A rejection names what the v1.40/v1.51 reading got wrong: 1131/1132
    // (gTransfCred vs the CST 800 indicator), 1133/1168 (finalidade / tipo),
    // 1129 (amounts), 1021 (a gIBSCBS the CST forbids), 1200/1202 (cClassTrib).
    expect(
      cStat,
      `SEFAZ rejected the nota de débito 05 — ${descreverSefaz('rtc-debito05 protNFe', { cStat, xMotivo })}`,
    ).toBe('100');
  }, 180_000);
});

/**
 * Devolução references (NT 2025.002 v1.51 VC02-14, cStat 321, #1683) — pinned
 * from what a one-time probe measured on 2026-10-07 (run 37629331453): NFref
 * alone draws 321 WITH OR WITHOUT the Reforma Tributária, and item references
 * are authorized (100). The RTC-OFF item-reference shape — the one this ERP
 * emits for a filial without the RTC — runs end to end, FATAL, in
 * `apps/nfe`'s orchestrator suite; these pin the two edges around it.
 *
 * Every devolução here is interstate (RJ destinatário, CFOP 2202): 1.202 sits
 * on the old B25-70 exemption list, so an NFref-only devolução carrying it
 * could pass for the wrong reason, and the 321 pin would stop meaning anything.
 */
describeOrSkip('SEFAZ-SP homologação — devolução references per item (VC02-14, #1683)', () => {
  let nNF = 0;
  let chaveOrigem: string | undefined;

  beforeAll(() => {
    if (!hasFullCreds) {
      throw new Error(
        'Live devolução test requires real credentials. Missing one of: ' +
          'NFE_CERT_PATH|NFE_CERT_BASE64 + NFE_CERT_PASSWORD, NFE_TEST_IE. ' +
          'Refusing to skip a fiscal live lane silently.',
      );
    }
    nNF = seedNNF();
  });

  /** A devolução of line 1 of the origin, referenced at note or item level. */
  function devolucao(rtc: boolean, referencia: 'nota' | 'item') {
    return buildHomologacaoFixture({
      numeracao: nNF++,
      serie: SEFAZ_HOM_RTC_SERIE,
      cnpj: TEST_CERT!.cnpj,
      ie: TEST_IE!,
      devolucao: true,
      ...(rtc ? { imposto: impostoCsosn102ComRtc(), emitRtc: true } : {}),
      itens: [
        {
          cProd: 'SKU-A',
          vUnCom: 1500,
          ...(referencia === 'item'
            ? { dfeReferenciado: { chaveAcesso: chaveOrigem!, nItem: 1 } }
            : {}),
        },
      ],
      ...(referencia === 'nota' ? { chNFeReferenciadas: [chaveOrigem!] } : {}),
    });
  }

  it('emits the 2-line origin saída the devoluções reference (cStat=100)', async () => {
    const { cStat, xMotivo, chave } = await emitir(
      buildHomologacaoFixture({
        numeracao: nNF++,
        serie: SEFAZ_HOM_RTC_SERIE,
        cnpj: TEST_CERT!.cnpj,
        ie: TEST_IE!,
        itens: [
          { cProd: 'SKU-A', vUnCom: 1500 },
          { cProd: 'SKU-B', vUnCom: 700 },
        ],
      }),
      'devolucao-origem',
    );
    expect(
      cStat,
      `SEFAZ rejected the origin saída — ${descreverSefaz('devolucao-origem protNFe', { cStat, xMotivo })}`,
    ).toBe('100');
    chaveOrigem = chave;
  }, 180_000);

  it('refuses a devolução referencing by NFref alone even WITHOUT the Reforma Tributária (cStat=321)', async () => {
    expect(chaveOrigem, 'the origin saída was not authorized').toBeDefined();
    const { cStat, xMotivo } = await emitir(devolucao(false, 'nota'), 'devolucao-nfref');
    // If this turns 100, SEFAZ relaxed VC02-14 for non-RTC notas: the ERP's
    // unconditional rule (`violacoesDaReferenciaDaDevolucao`) is then stricter
    // than SEFAZ — still safe, but worth re-reading the NT.
    expect(
      cStat,
      `SEFAZ no longer refuses an NFref-only devolução — ${descreverSefaz('devolucao-nfref protNFe', { cStat, xMotivo })}`,
    ).toBe('321');
  }, 180_000);

  it('authorizes a devolução referencing the origin per item, with the Reforma Tributária (cStat=100)', async () => {
    expect(chaveOrigem, 'the origin saída was not authorized').toBeDefined();
    const { cStat, xMotivo } = await emitir(devolucao(true, 'item'), 'devolucao-item-rtc');
    expect(
      cStat,
      `SEFAZ rejected the item-referenced devolução — ${descreverSefaz('devolucao-item-rtc protNFe', { cStat, xMotivo })}`,
    ).toBe('100');
  }, 180_000);
});
