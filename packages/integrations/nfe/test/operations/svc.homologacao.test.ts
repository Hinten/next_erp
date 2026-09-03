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
 * workflow_dispatch. A scheduled FATAL run (self-alerting) lives in
 * nfe-epec-scheduled.yml's `svc-live` job (weekly, Mondays 06:00 UTC —
 * issue #146); a SERPRO hiccup on the PR path never blocks a merge.
 *
 * **serie lane**: this suite owns **serie=3** (registry in
 * `../helpers/homologacao-seed.ts`); `numeracao` comes from `seedNNF()`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
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
//
// ⚠️ That degradation is ADVISORY-RUN ONLY. On workflow_dispatch/schedule the
// SVC-RS fatal-run gate below turns an absent chain into a FAILURE: a run whose
// whole purpose is to verify SVC must not report green having skipped it.
const hasSvcRsChain = existsSync(SVC_RS_CHAIN);

// Same credential posture as emission.homologacao.test.ts — see the
// NFE_TEST_IE rationale there (state IE is not derivable from the cert).
const TEST_IE = process.env.NFE_TEST_IE;
const hasFullCreds = hasNFeCertEnv() && Boolean(TEST_IE);

// Local run without credentials → skip cleanly. In CI the beforeAll
// throw below still fails loud on missing secrets.
const describeOrSkip = !hasFullCreds && !process.env.CI ? describe.skip : describe;

const TEST_CERT = hasFullCreds ? loadCertificateFromEnv() : null;

/** Read a vendored SVC TLS chain (created by `pnpm fetch:sefaz-ca --uf=SVC-AN|SVC-RS`). */
function readVendoredCA(chainPath: string): string | undefined {
  return existsSync(chainPath) ? readFileSync(chainPath, 'utf8') : undefined;
}

/** Typed SefazCall against one SVC URL — `tpAmb: '2'` always (homologação only). */
function buildSvcCall(url: string, cert: NFeCertificate, chainPath: string): SefazCall {
  assertCertNotExpired(cert);
  const agent = createSefazAgent(cert, { ca: readVendoredCA(chainPath) });
  return { url, cert, agent, tpAmb: '2', timeoutMs: 60_000 };
}

/**
 * Fast TCP reachability probe. SERPRO's SVC hosts intermittently TCP-hang from
 * CI runners — when one is unreachable, skip its SOAP tests in ~5s instead of
 * letting each call sit out the 60s `timeoutMs` (#337).
 *
 * **Posture-aware** (review on #345): on **advisory** runs (pull_request/push)
 * an unreachable host SKIPS its tests (keeps PRs fast). On **fatal** runs
 * (workflow_dispatch / schedule — the "verify SVC" runs) it must NOT skip-green:
 * the SVC-AN fatal-run gate (below) FAILS FAST in ~5s instead, so a dispatch run
 * can't pass without actually proving SVC-AN transport.
 */
function tcpReachable(url: string, timeoutMs = 5_000): Promise<boolean> {
  return new Promise((resolveProbe) => {
    let settled = false;
    const { hostname, port } = new URL(url);
    const sock = netConnect({ host: hostname, port: Number(port) || 443 });
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolveProbe(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

// Probe only in CI with creds — locally the suite already skips via
// describeOrSkip, so don't pay the probe (and keep local behaviour unchanged).
const probeSvc = hasFullCreds && Boolean(process.env.CI);
const svcAnReachable = probeSvc
  ? await tcpReachable(getSvcEndpoints('svc-an', 'homologacao').NfeStatusServico)
  : true;
const svcRsReachable = probeSvc
  ? await tcpReachable(getSvcEndpoints('svc-rs', 'homologacao').NfeStatusServico)
  : true;
// The SVC lane is FATAL on workflow_dispatch/schedule and ADVISORY on
// pull_request/push (mirrors ci-nfe.yml's `continue-on-error`). On a fatal run
// an unreachable SVC-AN must fail fast (the gate test below), not skip-green.
const isFatalRun =
  process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' ||
  process.env.GITHUB_EVENT_NAME === 'schedule';
if (probeSvc && !svcAnReachable && !isFatalRun) {
  console.warn(
    '::warning::SVC-AN host unreachable from this runner — skipping SVC-AN SOAP tests (advisory, #337).',
  );
}
if (probeSvc && !svcRsReachable && !isFatalRun) {
  console.warn(
    '::warning::SVC-RS host unreachable from this runner — skipping the SVC-RS test (advisory, #337).',
  );
}

describeOrSkip('SVC contingency — live homologação round-trips (SVC-AN + SVC-RS)', () => {
  // Reached in CI, and locally too whenever credentials are present: fail loud
  // on missing secrets — never report green with zero coverage.
  //
  // ⚠️ NOT "CI only". `vitest.config.ts` hoists the repo-root `.env.local` into
  // `test.env`, so on a developer machine set up for live testing `hasFullCreds`
  // is TRUE and `describeOrSkip` does NOT skip — a plain `vitest run` on this
  // file transmits at SEFAZ homologação. (It fails at transport first if
  // `packages/integrations/nfe/ca/` is empty, since the chains are fetched by
  // ci-nfe.yml, not committed — but do not rely on that.) The accurate rule is
  // the one at `describeOrSkip`: skipping needs NO credentials, not "not CI".
  beforeAll(() => {
    if (!hasFullCreds) {
      throw new Error(
        'Live SVC homologação test requires real credentials. Missing one of: ' +
          'NFE_CERT_PATH|NFE_CERT_BASE64 + NFE_CERT_PASSWORD, NFE_TEST_IE. ' +
          'Refusing to skip a fiscal live lane silently.',
      );
    }
  });

  // Fatal-run gate (#345 review): on workflow_dispatch/schedule the SVC lane is
  // fatal, so an unreachable SVC-AN must FAIL here (in ~5s, from the probe)
  // rather than silently skip — otherwise a "verify SVC" dispatch run could go
  // green without proving SVC-AN transport. Skipped on advisory PR/push runs.
  it.skipIf(!isFatalRun)('SVC-AN is reachable from the runner (fatal-run gate)', () => {
    expect(
      svcAnReachable,
      'SVC-AN host unreachable from this runner on a FATAL run (workflow_dispatch/schedule) — ' +
        'cannot prove SVC-AN transport. Re-run when SERPRO is reachable.',
    ).toBe(true);
  });

  // The SVC-RS half had NO such gate (#1247 gap (a)), and it is the half that
  // needs one most: it self-skipped on BOTH scheduled runs it has ever had, and
  // the one time it ran it was by luck (the chain fetch recovered the ICP root
  // from a sibling bundle). Two things hid that. The `skipIf` below takes either
  // an unreachable host or a missing chain, and the two `::warning::` emitters
  // above are themselves suppressed by `!isFatalRun` — so on a FATAL run an
  // absent SVC-RS produced no warning AND no failure, just a green job that had
  // proven nothing about half of what this lane tracks. Same shape as the
  // silent-pass class root `CLAUDE.md` is built to prevent.
  //
  // Split into two assertions on purpose: "SVRS is down" and "our chain-fetch
  // step degraded" are different failures with different fixes, and the message
  // has to say which. Both stay advisory-run-silent — this whole test is gated
  // on `isFatalRun`, so PR/push keeps its fast skip.
  it.skipIf(!isFatalRun)('SVC-RS is reachable from the runner (fatal-run gate)', () => {
    expect(
      hasSvcRsChain,
      `SVC-RS chain absent (${SVC_RS_CHAIN}) on a FATAL run (workflow_dispatch/schedule) — ` +
        'the ci-nfe.yml chain-refresh step degraded to a warning, so SVC-RS transport ' +
        'cannot be proven. Re-run, or fix the chain fetch.',
    ).toBe(true);
    expect(
      svcRsReachable,
      'SVC-RS host unreachable from this runner on a FATAL run (workflow_dispatch/schedule) — ' +
        'cannot prove SVC-RS transport. Re-run when SVRS is reachable.',
    ).toBe(true);
  });

  it.skipIf(!svcAnReachable)(
    'SVC-AN status answers for the issuer cUF (pre-flight)',
    async () => {
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
    },
    45_000,
  );

  // ⚠️ SKIPPED pending #1471 — a deliberate, TEMPORARY pause, not a deletion.
  // Flip to `false` to restore the test exactly as it was; nothing else changes.
  //
  // SVC-AN rejects this emission with `cStat=178` ("CNPJ do Emitente não
  // cadastrado na Receita Federal"). The cause is NOT here: in the same CI run
  // the same certificate and CNPJ are AUTHORIZED by SEFAZ-SP (`cStat=100`), so
  // the issuer is plainly registered and it is SVC-AN's own cadastro replica
  // that intermittently disagrees. It flaps — a pass is a clean `100` — which is
  // why this is a pause and not a fix. Nothing in this repo can fix it;
  // registering the CNPJ on the SVC-AN side is an external step (#1471).
  //
  // ⚠️ What the skip COSTS, stated so the next reviewer can weigh it: this is
  // the ONLY test that proves SVC-AN AUTHORIZES, and its body also carries the
  // consSitNFe recovery-lane assertions (the path `processar-pendentes` uses for
  // stuck tpEmis-6 docs). While it is skipped this lane proves SVC-AN TRANSPORT
  // (the status pre-flight above, `107`) and nothing about authorization.
  //
  // ⚠️ It also silences `[SVC-AN protNFe] cStat=… xMotivo=…`, the only signal
  // that would say when the cadastro heals. The `::warning::` below is the
  // replacement — this suite must not report green while staying silent about a
  // test it is no longer running (root `CLAUDE.md`, and the whole ci-lanes
  // design). Unskipping is the review this is waiting for.
  //
  // ⚠️ When restoring it, do NOT print a raw `xMotivo`: SEFAZ embeds the
  // emitente's CNPJ in this rejection's text, so logging it verbatim puts that
  // number in a public Actions log. Redact before printing.
  const SKIP_SVC_AN_EMISSAO_1471 = true;
  if (SKIP_SVC_AN_EMISSAO_1471 && process.env.CI) {
    console.warn(
      '::warning::SVC-AN emission test is SKIPPED (#1471) — SVC-AN answers cStat=178 ' +
        '"CNPJ do Emitente não cadastrado" while SEFAZ-SP authorizes the same issuer. ' +
        'SVC-AN AUTHORIZATION is UNPROVEN on this run; only transport is. Flip ' +
        'SKIP_SVC_AN_EMISSAO_1471 in svc.homologacao.test.ts to re-check.',
    );
  }
  it.skipIf(SKIP_SVC_AN_EMISSAO_1471 || !svcAnReachable)(
    'native SVC-AN emission — tpEmis=6 NF-e is AUTHORIZED (cStat=100)',
    async () => {
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
      // ⚠️ Log the protNFe's OWN cStat + xMotivo BEFORE asserting. The lote line
      // above only says the BATCH was processed (104); when SEFAZ refuses the
      // note itself the motive lives here and nowhere else, and a bare
      // `expect(prot?.infProt.cStat).toBe('100')` discards it. That is how a
      // rejection reached a dead end twice — cStat=999 (#1247) and the
      // uncatalogued cStat=178 — with the one string that would have settled
      // either never printed. `rtc.homologacao.test.ts` already learned this;
      // same shape here.
      const cStat = prot?.infProt.cStat ?? ret.cStat;
      const xMotivo = prot?.infProt.xMotivo ?? ret.xMotivo;
      // `cMsg`/`xMsg` are SEFAZ's supplementary-detail fields, absent on a normal
      // response — so appending them only when present costs the usual line
      // nothing and is exactly what an uncatalogued code needs.
      const detalhe = prot?.infProt.xMsg
        ? ` cMsg=${prot.infProt.cMsg ?? '-'} xMsg="${prot.infProt.xMsg}"`
        : '';
      // eslint-disable-next-line no-console
      console.log(`[SVC-AN protNFe] cStat=${cStat} xMotivo="${xMotivo}"${detalhe}`);
      // The `?? ret.*` fallback also covers `prot === undefined`: resolveProtocol
      // has four paths that return it with no explanation, and the bare optional
      // chain turned every one into `expected undefined to be '100'`.
      expect(cStat, `SEFAZ rejected the SVC-AN NF-e: cStat=${cStat} — "${xMotivo}"`).toBe('100');
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
      // Same omission one assertion later — `xMotivo` added to match
      // `emission.homologacao.test.ts`'s consSitNFe line.
      // eslint-disable-next-line no-console
      console.log(
        `[SVC-AN consSitNFe] cStat=${sit.cStat} xMotivo="${sit.xMotivo}" prot.cStat=${sit.protNFe?.infProt.cStat}`,
      );
      expect(sit.chNFe).toBe(out.chave);
      expect(sit.protNFe?.infProt.cStat).toBe('100');
      expect(sit.protNFe?.infProt.nProt).toBe(prot!.infProt.nProt);
    },
    180_000,
  );

  it.skipIf(!hasSvcRsChain || !svcRsReachable)(
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
