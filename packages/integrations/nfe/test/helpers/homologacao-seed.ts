/**
 * Shared collision-avoidance seeds for the SEFAZ-SP homologação live
 * tests. Both the library-level emission test
 * (`packages/integrations/nfe/test/operations/emission.homologacao.test.ts`)
 * and the orchestrator-level test
 * (`apps/nfe/test/lib/nfe/orchestrator.homologacao.test.ts`) draw their
 * starting `nNF` + `idLote` values from here so the two stay in lockstep.
 *
 * ## Why a shared test zone is needed
 *
 * SEFAZ persists per-(CNPJ, serie, tpAmb, tpEmis, nNF) **forever** in
 * homologação too — emitting nNF=42 once means nNF=42 cannot be emitted
 * with a different chave under that key tuple ever again (`cStat=539`).
 * The two homologação tests share a single test CNPJ (from the loaded
 * A1 cert) and the same `tpAmb=2` + `tpEmis=1`, so the only freely
 * separable axes are `serie` and `nNF`. This file owns the `nNF` story:
 *
 * - `serie` separation is the inter-test isolation contract. Registry:
 *   serie 1 = orchestrator (apps/nfe orchestrator.homologacao), serie 2 =
 *   library emission (emission.homologacao), serie 3 = SVC contingency
 *   (svc.homologacao, `SEFAZ_HOM_SVC_SERIE`), serie 4 = Reforma Tributária
 *   (rtc.homologacao, `SEFAZ_HOM_RTC_SERIE`), serie 9 = inutilização
 *   (`SEFAZ_HOM_INUT_SERIE`). See the companion comment in each test file.
 * - `nNF` seeding has to dodge collisions across CI runs of the *same*
 *   test, in the same serie. SEFAZ exposes **no** "query last nNF used"
 *   endpoint (the only NFeConsulta web services are
 *   `consultarStatusServico`, `consultarSituacaoNFe` by chave,
 *   `consultarLote` by nRec, and `autorizarLote`). Collision-avoidance is
 *   therefore wholly client-side.
 *
 * ## The high-zone strategy
 *
 * SEFAZ's NFe schema caps `nNF` at 9 digits (≤ 999,999,999). Real fiscal
 * flows start at 1 and grow over years; almost no real CNPJ has crossed
 * 100M. We seed CI runs in a high zone that the same CNPJ's real
 * production traffic cannot plausibly reach:
 *
 *   - Base    = 500,000,000 (well above any plausible real nNF for our
 *                            test CNPJ; well below the 9-digit ceiling)
 *   - Range   = 499,999,000 (so `base + Date.now() % range` always fits
 *                            in 9 digits even with a 10-nNF emission run
 *                            allocating consecutive numbers above the seed)
 *
 * Collision probability across CI runs is birthday-paradox over the range
 * with a per-run "window" equal to the number of nNFs that run emits
 * (~10 for the orchestrator's full suite). With ~500M slots and 10-nNF
 * windows, the per-pair collision rate is ~2 × 10⁻⁸ and remains
 * negligible to tens of thousands of CI runs.
 *
 * `idLote` does not have the same SEFAZ-side persistence landmine as
 * nNF (it's a lote handle, not a fiscal-key component), but seeding it
 * the same way costs nothing and avoids any chance of a single test
 * run's lote handles colliding with a parallel run's.
 *
 * ## Per-run cleanup is best-effort, not load-bearing
 *
 * The orchestrator test creates a per-run-unique filial via
 * `RUN_ID = Date.now().toString(36)` and deletes it in `afterAll`.
 * If teardown fails (crash, OOM, killed CI), the orphaned filial doc
 * leaks — next run uses a fresh RUN_ID, so leaks don't affect
 * correctness. The nNF seed widening here is the actual correctness
 * mechanism; the per-run filial isolation is just cleanliness.
 */

/**
 * Série reserved exclusively for the inutilização live test.
 *
 * SEFAZ persists inutilized ranges per (CNPJ, serie, tpAmb, mod) **forever**,
 * exactly like numeração. The emission tests own séries 1 (orchestrator) and
 * 2 (library duplicidade) and emit real NF-es there; if the inutilização test
 * burned a número on one of those séries it could clash with a número an
 * emission test wants. Reserving série **9** — which no emission test ever
 * emits on — keeps the two lanes disjoint. The inutilização test still picks a
 * fresh `seedNNF()` range per run so a re-run never hits "número já
 * inutilizado" on this série.
 */
export const SEFAZ_HOM_INUT_SERIE = 9;

/**
 * Série reserved exclusively for the SVC contingency live suite
 * (`svc.homologacao.test.ts`). Its emissions ride tpEmis=6, so they could
 * never 539-collide with the tpEmis=1 lanes anyway (tpEmis is part of the
 * SEFAZ persistence key AND the chave) — but a dedicated série keeps the
 * lane registry uniform and the failure triage unambiguous.
 */
export const SEFAZ_HOM_SVC_SERIE = 3;

/**
 * Série reserved exclusively for the Reforma Tributária (IBS/CBS/IS) live test
 * (`rtc.homologacao.test.ts`). It emits real tpEmis=1 NF-e carrying the RTC
 * item/total groups, so it needs its own série to stay 539-disjoint from the
 * library emission lane (serie 2) and the orchestrator lane (serie 1).
 */
export const SEFAZ_HOM_RTC_SERIE = 4;

/** High base for the homologação test nNF zone. See file header. */
export const SEFAZ_HOM_TEST_NNF_BASE = 500_000_000;

/**
 * Width of the homologação test nNF zone. Picked so that
 * `BASE + RANGE + ~50 emissions` still fits in 9 digits (SEFAZ cap).
 */
export const SEFAZ_HOM_TEST_NNF_RANGE = 499_999_000;

/** Wide seed for `idLote` — see file header for why this matters less. */
export const SEFAZ_HOM_TEST_IDLOTE_BASE = 500_000;
export const SEFAZ_HOM_TEST_IDLOTE_RANGE = 499_000;

/**
 * Returns a starting `nNF` for a homologação CI run. Each call samples
 * `Date.now()` so two `seedNNF()` calls within the same ms collide;
 * callers should call this **once** per run and increment from there.
 */
export function seedNNF(): number {
  return SEFAZ_HOM_TEST_NNF_BASE + (Date.now() % SEFAZ_HOM_TEST_NNF_RANGE);
}

/** Same shape as `seedNNF` but for the `idLote` counter. */
export function seedIdLote(): number {
  return SEFAZ_HOM_TEST_IDLOTE_BASE + (Date.now() % SEFAZ_HOM_TEST_IDLOTE_RANGE);
}
