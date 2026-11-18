/**
 * Which Loja Integrada contas a stock-record write concerns (master plan step 12, PR 12-f): the
 * stock trigger's third gate. A record write concerns a conta exactly when the record's stored
 * `depositoOuterRef` — on either side of the write — is one of the two stored forms of the conta's
 * depósito. Two contas on one depósito are both concerned; a write that MOVES a record between
 * depósitos concerns the contas of both.
 *
 * ## The match is EXACT, as the send run's
 *
 * The conta side is read through `depositoDaContaLi` (`core/contas.ts`), which accepts either
 * stored form of the conta's ref. The record side is matched EXACTLY against the two forms
 * (`formasDoDepositoLi`) — the equality the send run's own `in` query applies
 * (`leituraEstoqueErp.ts`). A record stored under any other spelling (a leading slash, a case
 * change, a trailing space, a reference object) is not found by the run, so the trigger ignores it
 * too: no further read, and the daily reconcile's full walk is where it shows. Folding it here
 * would only pay reads for a run that skips.
 *
 * ## The map is CACHED, per instance
 *
 * The trigger fires on every ERP stock write, every depósito included, so the conta enumeration
 * (`listarContasLojaIntegrada`: ONE query on the declared `integracao (tipo, nome)` composite) is
 * read at most once per `READ_CACHE_TTL.config` (15 min) per warm instance, through a
 * module-scope `createReadCache`. Its answer decides only whether to ENQUEUE a send run, never a
 * write: the run reads the conta again itself. Staleness bound = the TTL, per instance — a conta
 * created, re-pointed to another depósito or deleted is seen within 15 min, and the events in
 * between are covered by the nightly reconcile (an immediate full run on a depósito change belongs
 * to the reconcile's own step). An EMPTY map is an answer and is cached like any other: a project
 * with no Loja Integrada conta pays one query per TTL, not one per stock write.
 *
 * Inactive contas are KEPT: the send run skips one after a single cached read, and dropping it
 * here would delay a reactivation by up to the TTL on every warm instance. A tipo-3 conta lacking
 * `nome` is outside the enumeration (`core/contas.ts`), so the map never lists it.
 *
 * `db` is a parameter; nothing here reads the process environment.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { READ_CACHE_TTL, createReadCache } from '@delfrance/data/admin/cache';
import { formasDoDepositoLi } from '@delfrance/schemas';

import { type ContaLojaIntegradaResumo, listarContasLojaIntegrada } from '../core/contas';
import type { DadosEstoqueLi } from './planoEstoqueLi';

/** One conta a depósito serves: its id and its depósito's BARE document id. */
export interface ContaDoDepositoLi {
  readonly contaId: string;
  readonly depositoId: string;
}

/** Stored depósito ref (BOTH forms are keys) → the contas stocking from it, sorted by id. */
export type MapaDepositosLi = ReadonlyMap<string, readonly ContaDoDepositoLi[]>;

function porConta(a: ContaDoDepositoLi, b: ContaDoDepositoLi): number {
  return a.contaId < b.contaId ? -1 : a.contaId > b.contaId ? 1 : 0;
}

/**
 * The map, from the enumeration: every conta with a readable depósito, keyed under EACH of the
 * two stored forms of its ref (`documents/depositos/<id>` and `depositos/<id>`), contas sorted by
 * id. A conta whose depósito cannot be read (`depositoId: null`) is left out: no record can match
 * it. Pure.
 */
export function mapaDepositosLi(
  contas: readonly Pick<ContaLojaIntegradaResumo, 'integracaoId' | 'depositoId'>[],
): MapaDepositosLi {
  const mapa = new Map<string, ContaDoDepositoLi[]>();
  for (const conta of contas) {
    if (conta.depositoId === null) continue;
    const entrada = { contaId: conta.integracaoId, depositoId: conta.depositoId };
    for (const forma of formasDoDepositoLi(conta.depositoId)) {
      const lista = mapa.get(forma);
      if (lista === undefined) mapa.set(forma, [entrada]);
      else lista.push(entrada);
    }
  }
  for (const lista of mapa.values()) lista.sort(porConta);
  return mapa;
}

/** A record's stored depósito ref, when it is text at all; anything else matches no key. */
function refDoRegistro(dados: DadosEstoqueLi | null): string | null {
  if (dados === null || !Object.hasOwn(dados, 'depositoOuterRef')) return null;
  const ref = dados.depositoOuterRef;
  return typeof ref === 'string' ? ref : null;
}

/**
 * The contas one stock-record write concerns: the UNION of the contas under the record's stored
 * `depositoOuterRef` on each side that exists (a create's after, a delete's before, both on an
 * update), looked up EXACTLY (module header), deduplicated and sorted by conta id. A ref that is
 * not text, or any spelling the map does not hold, concerns no conta. Pure.
 *
 * Equal (one conta): before and after both at `documents/depositos/D`, or one side at
 * `documents/depositos/D` and the other at `depositos/D`. Distinct: before at D and after at
 * D2 ⇒ the contas of D AND of D2; a side at `/documents/depositos/D` ⇒ none from that side.
 */
export function contasDoEventoLi(
  mapa: MapaDepositosLi,
  antes: DadosEstoqueLi | null,
  depois: DadosEstoqueLi | null,
): ContaDoDepositoLi[] {
  const porId = new Map<string, ContaDoDepositoLi>();
  for (const lado of [antes, depois]) {
    const ref = refDoRegistro(lado);
    if (ref === null) continue;
    for (const conta of mapa.get(ref) ?? []) porId.set(conta.contaId, conta);
  }
  return [...porId.values()].sort(porConta);
}

/**
 * Injectable clock. `createReadCache` captures `opts.now` once, at construction — import time for
 * a module-scope cache — so the cache goes through this binding via an arrow. Production never
 * moves it.
 */
let relogioDoMapa: () => number = Date.now;

/** ONE entry: the whole map. `sampleEvery: 0` — the built-in sampler logs at the wrong severity. */
const cacheDoMapa = createReadCache<'mapa', MapaDepositosLi>({
  name: 'li:estoque-depositos',
  ttlMs: READ_CACHE_TTL.config,
  maxEntries: 1,
  // An empty map is an answer (no conta at any depósito), never "absent".
  isNegative: () => false,
  now: () => relogioDoMapa(),
  sampleEvery: 0,
});

/**
 * The depósito map, through the module-scope cache (module header): at most ONE enumeration
 * query per TTL per instance, a concurrent miss joining the load in flight. A failed load is not
 * cached, so the next event reads again.
 */
export function lerMapaDepositosLi(db: Firestore): Promise<MapaDepositosLi> {
  return cacheDoMapa.get('mapa', async () =>
    mapaDepositosLi((await listarContasLojaIntegrada(db)).contas),
  );
}

/**
 * Test-only. The cache is module-scope, so `now` cannot be passed per test. Pair it with
 * `__resetAllReadCaches()`.
 */
export function __setRelogioDoMapaDepositosParaTestes(now: () => number = Date.now): void {
  relogioDoMapa = now;
}
