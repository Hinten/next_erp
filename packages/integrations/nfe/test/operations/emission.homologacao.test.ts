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
 * The fixture is a complete hand-built `GeneratorInput` (shared with the
 * SVC suite via `../helpers/homologacao-fixture.ts`) so the test has **no
 * Firestore dependency** and stays library-level. `numeracao` comes
 * from `seedNNF()` in `../helpers/homologacao-seed.ts` — see that file
 * for the cross-CI-run collision-avoidance rationale (high-zone +
 * Date.now()-based offset over ~500M slots).
 *
 * **serie lane**: this test runs on **serie=2** — full lane registry in
 * `../helpers/homologacao-seed.ts`. SEFAZ keys persistence on serie, so
 * the live suites can never collide at the (CNPJ, serie, tpAmb, tpEmis,
 * nNF) key.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { buildHomologacaoFixture } from '../helpers/homologacao-fixture';
import { resolveProtocol } from '../helpers/resolve-protocol';
import { seedNNF } from '../helpers/homologacao-seed';
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
import { autorizarLote, consultarSituacaoNFe } from '../../src/operations/index';

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDORED_CHAIN = resolve(HERE, '..', '..', 'ca', 'sefaz-sp-homologacao.pem');

// IE (Inscrição Estadual) is a state-level registration; ICP-Brasil
// A1 certs are federal and do not carry it. SEFAZ rejects with
// cStat=209 ("IE do emitente inválida") when the IE in the XML
// doesn't match the IE registered for the cert's CNPJ at the state
// SEFAZ — there's no algorithmic way to derive one from the other,
// so the maintainer must set `NFE_TEST_IE` in `.env.local` to the
// real IE issued for the company that owns the loaded A1 cert.
// See `apps/nfe/.env.example`.
//
// `NFE_TEST_IE` is REQUIRED — there is no placeholder fallback. A bogus
// IE only ever earns a guaranteed cStat=209, so when it (or the cert)
// is unset the suite throws (see `beforeAll`) rather than emitting
// garbage or silently skipping a fiscal live lane.
const TEST_IE = process.env.NFE_TEST_IE;

const hasFullCreds = hasNFeCertEnv() && Boolean(TEST_IE);

// Local run without credentials → skip cleanly (a dev checkout without
// .env.local must not fail `pnpm turbo run test`). In CI the beforeAll
// throw below still fails loud on missing secrets.
const describeOrSkip = !hasFullCreds && !process.env.CI ? describe.skip : describe;

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
 * Build the shared homologação fixture on THIS suite's lane.
 *
 * serie=2 is the library test's lane; serie=1 belongs to the orchestrator
 * test at apps/nfe/test/lib/nfe/orchestrator.homologacao.test.ts and
 * serie=3 to the SVC suite (svc.homologacao.test.ts). Keeping the lanes
 * split eliminates the cross-test (CNPJ, serie, tpAmb, tpEmis, nNF)
 * collision that would otherwise surface as cStat=539 ("duplicidade") on
 * whichever runs second at SEFAZ.
 *
 * CNPJ comes from the loaded A1 cert (rejection 213 otherwise); IE from
 * NFE_TEST_IE (rejection 209 otherwise). The non-null assertions are
 * sound: this helper is only reachable inside `describeOrSkip`, whose
 * `beforeAll` throws when either is missing.
 */
function buildFixture(numeracao: number) {
  return buildHomologacaoFixture({
    numeracao,
    serie: 2,
    cnpj: TEST_CERT!.cnpj,
    ie: TEST_IE!,
  });
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
  // Only reachable in CI (locally the suite skips via describeOrSkip):
  // fail loud on missing secrets — never report green with zero coverage.
  beforeAll(() => {
    if (!hasFullCreds) {
      throw new Error(
        'Live homologação test requires real credentials. Missing one of: ' +
          'NFE_CERT_PATH|NFE_CERT_BASE64 + NFE_CERT_PASSWORD, NFE_TEST_IE. ' +
          'Refusing to skip a fiscal live lane silently.',
      );
    }
  });

  // NOTE: the previous "generate → sign → autorizarLote (indSinc=1) →
  // cStat=100" happy-path test was removed when the orchestrator-level
  // homologação test (`apps/nfe/test/lib/nfe/orchestrator.homologacao.test.ts`)
  // landed in PR-γ — that test covers the same library call chain
  // through `emitirPedido` plus the Firestore persistence layer. The
  // duplicidade test below stays because it pins the consSitNFe
  // recovery contract the orchestrator's anti-loss path depends on
  // (see `recoverFrom539` in `apps/nfe/lib/nfe/orchestrator.ts`).
  it('duplicidade recovery — second emission returns 204, consSitNFe resolves to original 100', async () => {
    // SEFAZ status pre-flight intentionally removed — the ci-nfe.yml
    // "SEFAZ-SP HOM status gate" step runs operations.homologacao
    // immediately before this test and short-circuits the whole job
    // on cStat ≠ 107/108/109, so re-pinging the status endpoint here
    // would just feed the 656 throttle for no extra signal.
    const numeracao = seedNNF();
    const fixture = buildFixture(numeracao);
    const out = generateNFe(fixture);

    const autorizacaoCall = buildCall(getEndpoints('SP', 'homologacao').NfeAutorizacao, TEST_CERT!);
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
    console.log(`[duplicidade lote2] cStat=${second.cStat} xMotivo="${second.xMotivo}"`);
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
  }, 180_000);
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
