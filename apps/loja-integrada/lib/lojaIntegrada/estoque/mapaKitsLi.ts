/**
 * The READ side of the component → store-kits map (master plan step 12, PR 12-f): the per-conta
 * headers `sincEstoqueLojaIntegrada/{conta}/kits/{componente}`, their shards
 * `kitsFatias/{componente}~{n}`, and the sibling stock records a header names. The map is written
 * by the daily reconcile alone (`sincEstoqueLojaIntegrada.ts`, "Writers"); everything here only
 * READS it, through the admin handles, `db` a parameter, every read a point read by id — so no
 * index is involved, and every batch of them is ONE `getAll`.
 *
 * A header is parsed with the REFINED `kitsComponenteEstoqueLiSchema` (`F`, `kits` and `fatias`
 * agree), never the handle's shape-only schema: a header whose invariants do not hold decides
 * nothing (`invalido`). A shard is parsed with its own schema; what a shard read could not
 * account for is COUNTED, never guessed ({@link FatiasKitsLidasLi}).
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  estoqueCollection,
  fatiaKitsComponenteEstoqueLiCollection,
  kitsComponenteEstoqueLiCollection,
} from '@delfrance/data/admin/collections';
import {
  type KitDoComponenteEstoqueLi,
  type KitsComponenteEstoqueLi,
  fatiaKitsComponenteEstoqueLiSchema,
  idFatiaKitsEstoqueLi,
  kitsComponenteEstoqueLiSchema,
} from '@delfrance/schemas';

import type { DadosEstoqueLi } from './planoEstoqueLi';
import { caminhoEstoqueLi } from './quantidadeEstoqueLi';

/** One conta's header for one component, as read. */
export type CabecalhoLidoLi =
  /** NOT_FOUND: the component is in no store kit of the conta (the common case). */
  | { readonly tipo: 'ausente' }
  /** Stored, but off the refined schema: the top-level field names that failed, never a value. */
  | { readonly tipo: 'invalido'; readonly campos: readonly string[] }
  | { readonly tipo: 'ok'; readonly cabecalho: KitsComponenteEstoqueLi };

/** The field names a parse failed on, deduplicated and sorted — never a value. */
function camposDoErro(issues: readonly { readonly path: readonly PropertyKey[] }[]): string[] {
  return [...new Set(issues.map((i) => String(i.path[0] ?? '')))].sort();
}

/**
 * The header of `componenteId` in each of `contaIds`: ONE `getAll` of point reads (a NOT_FOUND
 * costs about one read unit). No read at all for an empty list. Keyed by conta id.
 */
export async function lerCabecalhosKitsLi(
  db: Firestore,
  contaIds: readonly string[],
  componenteId: string,
): Promise<ReadonlyMap<string, CabecalhoLidoLi>> {
  const lidos = new Map<string, CabecalhoLidoLi>();
  if (contaIds.length === 0) return lidos;
  const snaps = await db.getAll(
    ...contaIds.map((integracaoId) =>
      kitsComponenteEstoqueLiCollection.docRef(db, { integracaoId }, componenteId),
    ),
  );
  contaIds.forEach((contaId, i) => {
    const snap = snaps[i];
    const dados: unknown = snap?.exists ? snap.data() : undefined;
    if (dados === undefined) {
      lidos.set(contaId, { tipo: 'ausente' });
      return;
    }
    const lido = kitsComponenteEstoqueLiSchema.safeParse(dados);
    lidos.set(
      contaId,
      lido.success
        ? { tipo: 'ok', cabecalho: lido.data }
        : { tipo: 'invalido', campos: camposDoErro(lido.error.issues) },
    );
  });
  return lidos;
}

/**
 * Stock records by PATH (`produtos/{c}/estoques/{id}`): ONE `getAll` of the deduplicated paths,
 * each answered with its raw data, or `null` when it does not exist. No read for an empty list.
 * Throws `RangeError` on a text that is not a stock record's path (every caller builds them with
 * `caminhoDeEstoqueLi`, so that is a bug).
 */
export async function lerRegistrosPorCaminhoLi(
  db: Firestore,
  caminhos: readonly string[],
): Promise<ReadonlyMap<string, DadosEstoqueLi | null>> {
  const unicos = [...new Set(caminhos)];
  const lidos = new Map<string, DadosEstoqueLi | null>();
  if (unicos.length === 0) return lidos;
  const refs = unicos.map((caminho) => {
    const partes = caminhoEstoqueLi(caminho);
    if (partes === null)
      throw new RangeError('lerRegistrosPorCaminhoLi: caminho de estoque inválido');
    return estoqueCollection.docRef(db, { produtoId: partes.produtoId }, partes.estoqueId);
  });
  const snaps = await db.getAll(...refs);
  unicos.forEach((caminho, i) => {
    const snap = snaps[i];
    const dados: DadosEstoqueLi | undefined = snap?.exists ? snap.data() : undefined;
    lidos.set(caminho, dados ?? null);
  });
  return lidos;
}

/** What a read of one component's shards found. */
export interface FatiasKitsLidasLi {
  /** Every kit of every shard that parsed, by kit produto id (the first shard to name it wins). */
  readonly kits: Readonly<Record<string, KitDoComponenteEstoqueLi>>;
  /** Shards the header promises and the read did not find. */
  readonly ausentes: number;
  /** Shards stored off their schema. */
  readonly invalidas: number;
  /** Shards that parsed but carry another run's `execucaoId` than the header. */
  readonly deOutraExecucao: number;
  /** Kit ids found in more than one shard. */
  readonly repetidos: number;
  /**
   * Every promised shard found, valid and of the header's run, and exactly `F` distinct kits
   * across them. Anything else is a map caught between two runs of its writer.
   */
  readonly completa: boolean;
}

/**
 * The shards of `componenteId` in conta `contaId` that `cabecalho` promises (`fatias` of them,
 * ids from `idFatiaKitsEstoqueLi`): ONE `getAll` of point reads, each parsed with the shard
 * schema. The kits of every shard that parsed are merged — those of another run included, the
 * over-inclusive direction — and what could not be accounted for is counted
 * ({@link FatiasKitsLidasLi}); the caller decides what an incomplete read means. No read when the
 * header promises no shard.
 */
export async function lerFatiasKitsLi(
  db: Firestore,
  contaId: string,
  componenteId: string,
  cabecalho: Pick<KitsComponenteEstoqueLi, 'execucaoId' | 'F' | 'fatias'>,
): Promise<FatiasKitsLidasLi> {
  const kits: Record<string, KitDoComponenteEstoqueLi> = {};
  let ausentes = 0;
  let invalidas = 0;
  let deOutraExecucao = 0;
  let repetidos = 0;
  if (cabecalho.fatias > 0) {
    const snaps = await db.getAll(
      ...Array.from({ length: cabecalho.fatias }, (_, n) =>
        fatiaKitsComponenteEstoqueLiCollection.docRef(
          db,
          { integracaoId: contaId },
          idFatiaKitsEstoqueLi(componenteId, n),
        ),
      ),
    );
    for (const snap of snaps) {
      const dados: unknown = snap.exists ? snap.data() : undefined;
      if (dados === undefined) {
        ausentes += 1;
        continue;
      }
      const lida = fatiaKitsComponenteEstoqueLiSchema.safeParse(dados);
      if (!lida.success) {
        invalidas += 1;
        continue;
      }
      if (lida.data.execucaoId !== cabecalho.execucaoId) deOutraExecucao += 1;
      for (const [kitId, kit] of Object.entries(lida.data.kits)) {
        if (Object.hasOwn(kits, kitId)) repetidos += 1;
        else kits[kitId] = kit;
      }
    }
  }
  const completa =
    ausentes === 0 &&
    invalidas === 0 &&
    deOutraExecucao === 0 &&
    repetidos === 0 &&
    Object.keys(kits).length === cabecalho.F;
  return { kits, ausentes, invalidas, deOutraExecucao, repetidos, completa };
}
