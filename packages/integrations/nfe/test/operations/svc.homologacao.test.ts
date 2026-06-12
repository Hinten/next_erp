/**
 * Live **SVC contingency** round-trips — homologação ONLY (issue #129).
 *
 * Skipped automatically unless `NFE_CERT_BASE64` + `NFE_CERT_PASSWORD` +
 * `NFE_TEST_IE` are set. Run locally with the same env as
 * `emission.homologacao.test.ts`:
 *
 *   pnpm --filter @delfrance/integrations-nfe test svc.homologacao
 *
 * What this file pins (first live-proven by hand on 2026-06-11):
 *
 *   1. SVC-AN status — the `hom.sefazvirtual.fazenda.gov.br` endpoints
 *      answer the typed status pipeline for SP's cUF. SVC-AN is
 *      permanently live in homologação (not gated on a declared outage).
 *   2. **Native SVC-AN emission** — a tpEmis=6 NF-e (B28/B29 stamped,
 *      chave digit 35 = '6') is AUTHORIZED by SVC-AN (cStat=100,
 *      verAplic `SVC_AN_*`). This is the lane a real SP outage uses.
 *   3. SVC-AN consulta — `consSitNFe(chave)` at the SVC resolves the
 *      authorization. This is the exact recovery path
 *      `processar-pendentes` uses for stuck tpEmis-6 docs.
 *   4. SVC-RS off-binding status → **cStat=410** ("UF não atendida") —
 *      proves the SVC-RS transport + TLS chain end-to-end without
 *      burning numeração. This replaces the removed
 *      `NFE_SVC_AUTHORIZER_OVERRIDE` knob (#126): the knob existed only
 *      so the *orchestrator* could reach the off-binding SVC; at the
 *      library level we just build the call against SVC-RS directly.
 *      Self-skips (loudly) when the SVC-RS chain isn't vendored — see
 *      the `hasSvcRsChain` note below.
 *
 * **Homologação-only, by construction**: every URL comes from
 * `getSvcEndpoints(<authorizer>, 'homologacao')` — the produção table is
 * never referenced — and every `SefazCall` carries `tpAmb: '2'` (the
 * pipeline's `assertSafeTpAmb` additionally rejects tpAmb='1' without
 * `NFE_ALLOW_PRODUCAO`). The fixture's `ambiente` is `'homologacao'`.
 *
 * These status checks deliberately do NOT live in ci-nfe.yml's "status
 * gate" step: an SVC outage must fail only this suite, never block the
 * SP emission suites. SVC-AN/SVC-RS are separate infrastructures from
 * SEFAZ-SP, so the extra status calls don't feed SP's cStat=656 throttle.
 *
 * **CI posture**: SERPRO's hosts are intermittently unreachable from
 * GitHub-hosted runners (TCP-level, so client certs don't help), so
 * ci-nfe.yml runs this suite in its own step — ADVISORY on
 * pull_request/push (failure → workflow warning) and FATAL on
 * workflow_dispatch. A scheduled fatal run (self-alerting) is deferred
 * to the EPEC scheduled workflow; a SERPRO hiccup never blocks a merge.
 *
 * **serie lane**: this suite owns **serie=3** (registry in
 * `../helpers/homologacao-seed.ts`); `numeracao` comes from `seedNNF()`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { buildHomologacaoFixture } from '../helpers/homologacao-fixture';
import { resolveProtocol } from '../helpers/resolve-protocol';
import { SEFAZ_HOM_SVC_SERIE, seedNNF } from '../helpers/homologacao-seed';
import {
  assertCertNotExpired,
  hasNFeCertEnv,
  loadCertificateFromEnv,
  type NFeCertificate,
} from '../../src/cert';
import { assertNotConsumoIndevido } from '../../src/state';
import { getSvcEndpoints } from '../../src/endpoints';
import { generateNFe } from '../../src/generator';
import { signNFe } from '../../src/sign';
import { createSefazAgent, type SefazCall } from '../../src/soap';
import {
  autorizarLote,
  consultarSituacaoNFe,
  consultarStatusServico,
} from '../../src/operations/index';

const HERE = dirname(fileURLToPath(import.meta.url));
const SVC_AN_CHAIN = resolve(HERE, '..', '..', 'ca', 'sefaz-svc-an-homologacao.pem');
const SVC_RS_CHAIN = resolve(HERE, '..', '..', 'ca', 'sefaz-svc-rs-homologacao.pem');

// SVRS intermittently RESETs certless TLS handshakes, so the ci-nfe.yml
// chain-refresh step lets the SVC-RS fetch degrade to a workflow warning
// instead of failing the whole live lane. When that happened, the chain
// file is absent and the 410 transport test below self-skips — loudly on
// both sides (workflow ::warning:: + the skip in the vitest report). The
// SVC-AN lane (SP's real contingency authorizer) never degrades.
const hasSvcRsChain = existsSync(SVC_RS_CHAIN);

// Same credential posture as emission.homologacao.test.ts — see the
// NFE_TEST_IE rationale there (state IE is not derivable from the cert).
const TEST_IE = process.env.NFE_TEST_IE;
const hasFullCreds = hasNFeCertEnv() && Boolean(TEST_IE);

// Local run without credentials → skip cleanly. In CI the beforeAll
// throw below still fails loud on missing secrets.
const describeOrSkip = !hasFullCreds && !process.env.CI ? describe.skip : describe;

const TEST_CERT = hasFullCreds ? loadCertificateFromEnv() : null;

/** Read a vendored SVC TLS chain (created by `pnpm fetch:sefaz-ca -- --uf=SVC-AN|SVC-RS`). */
function readVendoredCA(chainPath: string): string | undefined {
  return existsSync(chainPath) ? readFileSync(chainPath, 'utf8') : undefined;
}

/** Typed SefazCall against one SVC URL — `tpAmb: '2'` always (homologação only). */
function buildSvcCall(url: string, cert: NFeCertificate, chainPath: string): SefazCall {
  assertCertNotExpired(cert);
  const agent = createSefazAgent(cert, { ca: readVendoredCA(chainPath) });
  return { url, cert, agent, tpAmb: '2', timeoutMs: 60_000 };
}

describeOrSkip('SVC contingency — live homologação round-trips (SVC-AN + SVC-RS)', () => {
  // Only reachable in CI (locally the suite skips via describeOrSkip):
  // fail loud on missing secrets — never report green with zero coverage.
  beforeAll(() => {
    if (!hasFullCreds) {
      throw new Error(
        'Live SVC homologação test requires real credentials. Missing one of: ' +
          'NFE_CERT_PATH|NFE_CERT_BASE64 + NFE_CERT_PASSWORD, NFE_TEST_IE. ' +
          'Refusing to skip a fiscal live lane silently.',
      );
    }
  });

  it('SVC-AN status answers for the issuer cUF (pre-flight)', async () => {
    const call = buildSvcCall(
      getSvcEndpoints('svc-an', 'homologacao').NfeStatusServico,
      TEST_CERT!,
      SVC_AN_CHAIN,
    );
    const ret = await consultarStatusServico(call, { cUF: '35' });
    assertNotConsumoIndevido(ret, 'svc-an/statusServico');
    // eslint-disable-next-line no-console
    console.log(`[SVC-AN status] cStat=${ret.cStat} xMotivo="${ret.xMotivo}"`);
    expect(ret.tpAmb).toBe('2');
    // 107 = operating (the permanent homologação posture); 108/109 =
    // paralisado, 113/114 = SVC em desativação — non-failure outcomes
    // that still prove the transport + typed pipeline.
    expect(['107', '108', '109', '113', '114']).toContain(ret.cStat);
  }, 45_000);

  it('native SVC-AN emission — tpEmis=6 NF-e is AUTHORIZED (cStat=100)', async () => {
    const numeracao = seedNNF();
    const fixture = buildHomologacaoFixture({
      numeracao,
      serie: SEFAZ_HOM_SVC_SERIE,
      cnpj: TEST_CERT!.cnpj,
      ie: TEST_IE!,
      contingencia: {
        tpEmis: 6,
        // dhCont must precede dhEmi (the fixture stamps dhEmi = now).
        dhCont: new Date(Date.now() - 60_000),
        xJust: 'Teste automatizado de contingencia SVC em ambiente de homologacao',
      },
    });
    const out = generateNFe(fixture);
    // tpEmis is baked into the chave at index 34 — digit '6' = SVC-AN.
    expect(out.chave[34]).toBe('6');

    const endpoints = getSvcEndpoints('svc-an', 'homologacao');
    const autorizacaoCall = buildSvcCall(endpoints.NfeAutorizacao, TEST_CERT!, SVC_AN_CHAIN);
    const signedXml = signNFe(out.nfeXml, autorizacaoCall.cert);

    const ret = await autorizarLote(autorizacaoCall, {
      idLote: out.chave.slice(-15),
      NFe: [signedXml],
      indSinc: '1',
    });
    assertNotConsumoIndevido(ret, 'svc-an/autorizarLote');
    // eslint-disable-next-line no-console
    console.log(`[SVC-AN lote] cStat=${ret.cStat} xMotivo="${ret.xMotivo}"`);

    // SVC-AN answered sync (104 + inline protNFe) in the 2026-06-11 live
    // validation; resolveProtocol also covers a 103 → consReci fallback,
    // polled at the SVC's own RetAutorizacao.
    const retCall = buildSvcCall(endpoints.NfeRetAutorizacao, TEST_CERT!, SVC_AN_CHAIN);
    const prot = await resolveProtocol(ret, retCall);
    if (prot) assertNotConsumoIndevido(prot.infProt, 'svc-an/protNFe');
    expect(prot?.infProt.cStat).toBe('100');
    expect(prot?.infProt.chNFe).toBe(out.chave);
    expect(prot?.infProt.tpAmb).toBe('2');
    // The authorizer must be the SVC-AN itself, not a relay to SEFAZ-SP.
    expect(prot?.infProt.verAplic).toMatch(/^SVC_AN/);

    // Recovery lane: consSitNFe AT THE SVC resolves the authorization —
    // the exact path processar-pendentes uses for stuck tpEmis-6 docs.
    await new Promise((r) => setTimeout(r, 1000));
    const consultaCall = buildSvcCall(endpoints.NfeConsultaProtocolo, TEST_CERT!, SVC_AN_CHAIN);
    const sit = await consultarSituacaoNFe(consultaCall, { chave: out.chave });
    assertNotConsumoIndevido(sit, 'svc-an/consSitNFe');
    // eslint-disable-next-line no-console
    console.log(`[SVC-AN consSitNFe] cStat=${sit.cStat} prot.cStat=${sit.protNFe?.infProt.cStat}`);
    expect(sit.chNFe).toBe(out.chave);
    expect(sit.protNFe?.infProt.cStat).toBe('100');
    expect(sit.protNFe?.infProt.nProt).toBe(prot!.infProt.nProt);
  }, 180_000);

  it.skipIf(!hasSvcRsChain)(
    'SVC-RS off-binding status for SP → cStat=410 (transport proven, no numeração burned)',
    // retry once — a single mid-run SVRS reset shouldn't redden the lane.
    { timeout: 45_000, retry: 1 },
    async () => {
      const call = buildSvcCall(
        getSvcEndpoints('svc-rs', 'homologacao').NfeStatusServico,
        TEST_CERT!,
        SVC_RS_CHAIN,
      );
      const ret = await consultarStatusServico(call, { cUF: '35' });
      assertNotConsumoIndevido(ret, 'svc-rs/statusServico');
      // eslint-disable-next-line no-console
      console.log(`[SVC-RS status] cStat=${ret.cStat} xMotivo="${ret.xMotivo}"`);
      // SP is bound to SVC-AN (Ato COTEPE 39/2012), so SVC-RS answering
      // 410 "UF informada no campo cUF não é atendida pelo Web Service"
      // is the EXPECTED outcome — the round-trip itself (mTLS handshake,
      // XSD gates, typed parse) is what this test proves.
      expect(ret.tpAmb).toBe('2');
      expect(ret.cStat).toBe('410');
    },
  );
});
