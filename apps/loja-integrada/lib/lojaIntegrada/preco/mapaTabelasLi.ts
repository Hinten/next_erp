/**
 * Which Loja Integrada contas an ERP produto write concerns for the PRICE (master plan step 13,
 * PR 13-e): the price trigger's conta gate, the twin of the stock trigger's depósito map
 * (`estoque/depositosLi.ts`). A produto write concerns a conta exactly when the conta is ACTIVE,
 * names a NORMAL price tabela, and appears in the produto's anchor (`integracoesComProduto`) on
 * either side of the write.
 *
 * ## What it answers
 *
 *  - {@link mapaTabelasLi}: conta id → its two tabelas as BARE `listaDePrecos` ids
 *    (`core/contas.ts` folds either stored ref form through `tabelasDaContaLi`); the promotional
 *    one AS STORED, so a promo equal to the normal one keeps the price function's own reading
 *    ("no promo list");
 *  - {@link contasDaAncoraLi}: the conta ids the produto's anchor lists, on each side that
 *    exists — the payload alone, zero reads;
 *  - {@link contasDoEventoPrecoLi}: the two intersected, sorted.
 *
 * The anchor holds BARE conta ids (the anchor writer's own spelling), so an id is matched
 * EXACTLY: no trim, no case fold, no ref form. An element the writer never spells (a padded id, a
 * `documents/integracao/...` ref, a number) concerns no conta, and a counting link whose conta is
 * missing from the array is never seen here — the anchor's failure asymmetry (over-include) is
 * what keeps that rare.
 *
 * ## The map is CACHED, per instance
 *
 * The trigger fires on every ERP produto write, every channel's included, so the conta enumeration
 * (`listarContasLojaIntegrada`: ONE query on the declared `integracao (tipo, nome)` composite) is
 * read at most once per `READ_CACHE_TTL.config` (15 min) per warm instance, through a module-scope
 * `createReadCache`. Its answer decides only whether to ENQUEUE a send run, never a write: the run
 * reads the conta again itself. Staleness bound = the TTL, per instance — a conta created,
 * re-pointed to another tabela or deleted is seen within 15 min, and the events in between wait for
 * the produto's next event or the nightly price phase; the re-point's immediate full run belongs
 * to the tabela arm (a later PR of step 13). An EMPTY map is an answer and is cached like any
 * other: a project with no Loja Integrada conta pays one query per TTL, not one per produto write.
 *
 * ## Deliberate differences from the depósito map
 *
 *  - **INACTIVE contas are dropped here**, where the depósito map keeps them: the send run would
 *    skip one anyway, and every relevant produto write of an inactive conta would otherwise pay a
 *    parent read or a family query for nothing. The cost is that a reactivation is seen within the
 *    TTL per warm instance; the events in between wait for the produto's next event or the nightly.
 *  - **A conta naming no normal tabela is INERT**: the run would hold `sem-tabela`, so the trigger
 *    reads nothing more for it and enqueues nothing.
 *
 * A tipo-3 conta lacking `nome` is outside the enumeration (`core/contas.ts`), so the map never
 * lists it. `db` is a parameter; nothing here reads the process environment.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { READ_CACHE_TTL, createReadCache } from '@delfrance/data/admin/cache';

import { type ContaLojaIntegradaResumo, listarContasLojaIntegrada } from '../core/contas';

/** One conta the price sync prices: its id and its tabelas, bare ids. */
export interface ContaDoPrecoLi {
  readonly contaId: string;
  readonly tabelaNormalId: string;
  /** AS STORED: may equal `tabelaNormalId`, or `null`. */
  readonly tabelaPromocionalId: string | null;
}

/** Conta id → its tabelas: ACTIVE contas that name a normal tabela, only. */
export type MapaTabelasLi = ReadonlyMap<string, ContaDoPrecoLi>;

/** A produto document's raw data, as an event hands it over (`null` = that side does not exist). */
type DadosDoLadoLi = Readonly<Record<string, unknown>> | null;

function porConta(a: ContaDoPrecoLi, b: ContaDoPrecoLi): number {
  return a.contaId < b.contaId ? -1 : a.contaId > b.contaId ? 1 : 0;
}

/**
 * The map, from the enumeration: a conta is kept exactly when `ativo` and `tabelaNormalId !==
 * null` (module header). Pure.
 */
export function mapaTabelasLi(
  contas: readonly Pick<
    ContaLojaIntegradaResumo,
    'integracaoId' | 'ativo' | 'tabelaNormalId' | 'tabelaPromocionalId'
  >[],
): MapaTabelasLi {
  const mapa = new Map<string, ContaDoPrecoLi>();
  for (const conta of contas) {
    if (!conta.ativo || conta.tabelaNormalId === null) continue;
    mapa.set(conta.integracaoId, {
      contaId: conta.integracaoId,
      tabelaNormalId: conta.tabelaNormalId,
      tabelaPromocionalId: conta.tabelaPromocionalId,
    });
  }
  return mapa;
}

/** The STRING elements of one side's OWN `integracoesComProduto` array; nothing otherwise. */
function contasDoLado(dados: DadosDoLadoLi): string[] {
  if (dados === null || !Object.hasOwn(dados, 'integracoesComProduto')) return [];
  const contas: unknown = dados.integracoesComProduto;
  if (!Array.isArray(contas)) return [];
  return contas.filter((c): c is string => typeof c === 'string');
}

/**
 * The payload anchor: the UNION of `integracoesComProduto` on each side that exists (an own
 * property holding an array; its STRING elements only), deduplicated and sorted. Pure, zero reads.
 * A side whose value is not an array contributes nothing; a conta present on the before side only
 * (a link removed in the same write) is in.
 */
export function contasDaAncoraLi(antes: DadosDoLadoLi, depois: DadosDoLadoLi): string[] {
  return [...new Set([...contasDoLado(antes), ...contasDoLado(depois)])].sort();
}

/**
 * The contas one produto write concerns: the anchor ∩ the map, matched EXACTLY (module header),
 * sorted by conta id. Pure.
 *
 * Equal (concerned): the anchor's `'c1'` against the map's `'c1'`. Distinct (not concerned):
 * `' c1'`, `'C1'` and `'documents/integracao/c1'` against `'c1'`; a map conta the anchor does not
 * list.
 */
export function contasDoEventoPrecoLi(
  mapa: MapaTabelasLi,
  ancora: readonly string[],
): ContaDoPrecoLi[] {
  const contas: ContaDoPrecoLi[] = [];
  for (const contaId of new Set(ancora)) {
    const conta = mapa.get(contaId);
    if (conta !== undefined) contas.push(conta);
  }
  return contas.sort(porConta);
}

/**
 * Injectable clock. `createReadCache` captures `opts.now` once, at construction — import time for
 * a module-scope cache — so the cache goes through this binding via an arrow. Production never
 * moves it.
 */
let relogioDoMapa: () => number = Date.now;

/** ONE entry: the whole map. `sampleEvery: 0` — the built-in sampler logs at the wrong severity. */
const cacheDoMapa = createReadCache<'mapa', MapaTabelasLi>({
  name: 'li:preco-tabelas',
  ttlMs: READ_CACHE_TTL.config,
  maxEntries: 1,
  // An empty map is an answer (no conta priced at any tabela), never "absent".
  isNegative: () => false,
  now: () => relogioDoMapa(),
  sampleEvery: 0,
});

/**
 * The tabela map, through the module-scope cache (module header): at most ONE enumeration query
 * per TTL per instance, a concurrent miss joining the load in flight. A failed load is not cached,
 * so the next event reads again.
 */
export function lerMapaTabelasLi(db: Firestore): Promise<MapaTabelasLi> {
  return cacheDoMapa.get('mapa', async () =>
    mapaTabelasLi((await listarContasLojaIntegrada(db)).contas),
  );
}

/**
 * Test-only. The cache is module-scope, so `now` cannot be passed per test. Pair it with
 * `__resetAllReadCaches()`.
 */
export function __setRelogioDoMapaTabelasParaTestes(now: () => number = Date.now): void {
  relogioDoMapa = now;
}
