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
 * **Best-guess codes** — the Anexo III cClassTrib/CST tables aren't vendored,
 * so the fixture (`impostoCsosn102ComRtc`) uses placeholders + the documented
 * 2025–2026 test alíquotas (IBS 0,1% / CBS 0,9%). The **first run is
 * exploratory**: this test logs the real `cStat` + `xMotivo` before asserting,
 * so a rejection names exactly what to refine — likely 1020/1023/1024
 * (CST/cClassTrib), 1026/1037 (alíquota), 1022 (grupo incompleto), or
 * 1041/1091/1104 (totais).
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
 * **serie lane**: this test runs on **serie=4** (`SEFAZ_HOM_RTC_SERIE`) — full
 * lane registry in `../helpers/homologacao-seed.ts`. SEFAZ keys persistence on
 * serie, so it never collides with the other live suites at the (CNPJ, serie,
 * tpAmb, tpEmis, nNF) key.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

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
    const out = generateNFe(fixture);

    const autorizacaoCall = buildCall(getEndpoints('SP', 'homologacao').NfeAutorizacao, TEST_CERT!);
    const consReciCall = buildCall(getEndpoints('SP', 'homologacao').NfeRetAutorizacao, TEST_CERT!);
    const signedXml = signNFe(out.nfeXml, autorizacaoCall.cert);

    const ret = await autorizarLote(autorizacaoCall, {
      idLote: out.chave.slice(-15),
      NFe: [signedXml],
      indSinc: '1',
    });
    assertNotConsumoIndevido(ret, 'rtc/autorizarLote');
    logSefaz('rtc lote', ret);
    const prot = await resolveProtocol(ret, consReciCall);
    if (prot) assertNotConsumoIndevido(prot.infProt, 'rtc/protNFe');
    const cStat = prot?.infProt.cStat ?? ret.cStat;
    const xMotivo = prot?.infProt.xMotivo ?? ret.xMotivo;
    logSefaz('rtc protNFe', { cStat, xMotivo });
    // The best-guess codes target cStat=100. On a first-run rejection the log
    // above names the exact code/alíquota to refine (1020/1023/1024/1026/...).
    //
    // ⚠️ The assertion message goes through `descreverSefaz` too: a vitest
    // message lands in the CI ANNOTATION, which is as public as the log.
    expect(
      cStat,
      `SEFAZ rejected the RTC NF-e — ${descreverSefaz('rtc protNFe', { cStat, xMotivo })}`,
    ).toBe('100');
  }, 180_000);
});
