/**
 * ONE family of the product import's `familias` phase (master plan step 9): the match cascade, the
 * plan, the links, the report item — composed in that order for one store family, with no Loja
 * Integrada call. The dispatch runs it once per unit (a `familia` unit of the time budget) and
 * checkpoints what it returns: the family cursor moved past the family and the counters plus the
 * item's delta, in ONE write, so a retried unit redoes the same family from the same base (and,
 * past links it already created, reports the same delta: "A retried family").
 *
 * ## Order
 *
 *  1. The root through the cascade (`resolverRaizLi`).
 *  2. The target (`familiaNoAlvoLi`): a family outside it stops here — no variation resolved, no
 *     link, no item — unless it is in CONFLICT under `jaNoErp`/`naoNoErp`, which is reported with
 *     its conflict and no link (`plano.ts`, "The target").
 *  3. A matched parent's variations (`resolverFilhosLi`), resolved against the grupos the caller
 *     passes: the dispatch's memo, plus, under Simular, the overlay of what the job would have
 *     learned (`gruposParaResolverLi`), so a Simular verdict equals an `aplicar` one.
 *  4. The plan (`plano.ts`), pure.
 *  5. The links (`vinculos.ts`): written under `aplicar`, decided only under Simular.
 *  6. The report item (`relatorio.ts`), written whole at the root's store id (tier 0).
 *
 * What this unit writes, and nothing else: link documents (a produto's `produtolojaintegrada`
 * subcollection, `aplicar` only) and the job's own `itens/{liId}`. No produto, extraData, categoria, grupo or
 * arquivo document — completing the ERP side is the complete step's, and option learning is the
 * `aprendizado` phase's.
 *
 * ## A retried family
 *
 * The links land BEFORE the item and the checkpoint, so a unit that fails after a create landed
 * re-runs over this job's own links: the cascade's rung 1 now answers the root `vinculado` and
 * every link reads unchanged. `vinculos.ts` tells a link this job created from one it found by the
 * link's `createTime` against the job document's ({@link DepsFamiliaLi.criacaoDoJob}, from the
 * dispatch's job read) and reports it `criado` again; the report maps a root `vinculado` only
 * through such a link back to `encontrado` (`relatorio.ts`). So the retry's item and counter delta
 * equal the first attempt's — and Simular's for the same store — with the residuals
 * `vinculos.ts` states, and one of the cascade's own: a VARIATION the first attempt matched by its
 * option combination (or under a SKU the store repeats) is matched by its link on the retry, so
 * the informational `sku-diferente` / `sku-repetido-na-loja` that attempt reported for it is not
 * reported again (one informational pendência fewer; the link, the action and every other counter
 * agree). Closing it means rung 1 recognising this job's link and falling through to the SKU and
 * combination rungs, which read nothing new for a variation.
 *
 * ⚠️ Never name the Admin SDK's multi-document read-and-write call here — not even in a comment
 * (`estrutura.test.ts`). Next-free; `db` is a parameter.
 */
import type { Firestore, Timestamp } from 'firebase-admin/firestore';
import {
  type ContadoresImportacaoLi,
  type GrupoComLinksLi,
  type ImportacaoLojaIntegrada,
  type ItemImportacaoLi,
  SITUACAO_ERP_ITEM_LI,
  TIPO_PRODUTO_LI,
} from '@delfrance/schemas';

import type { FamiliaLi } from './familias';
import type { RecusaNoRelatorioLi } from './gruposLi';
import { type PlanoDaFamiliaLi, planejarFamiliaLi } from './plano';
import { contadoresDoItemLi, gravarItemLi, montarItemDaFamiliaLi } from './relatorio';
import {
  type ResolucaoDosFilhosLi,
  familiaNoAlvoLi,
  resolverFilhosLi,
  resolverRaizLi,
} from './resolucao';
import { type ResultadoDosVinculosLi, vincularFamiliaLi } from './vinculos';

export interface DepsFamiliaLi {
  readonly db: Firestore;
  readonly jobId: string;
  /**
   * The job document's own `createTime`, from the dispatch's job read: what tells a link this job
   * created from one it found (module header, "A retried family").
   */
  readonly criacaoDoJob: Timestamp;
  /** The item's `atualizadoEmMs`. */
  readonly agoraMs: () => number;
}

/** What every family of one dispatch shares (computed once per dispatch by the caller). */
export interface ContextoDasFamiliasLi {
  readonly job: Pick<
    ImportacaoLojaIntegrada,
    'integracaoId' | 'modo' | 'alvo' | 'acao' | 'selecionados'
  >;
  /** `skusRepetidosNaLojaLi` over the job's assembly. */
  readonly skusRepetidos: ReadonlySet<string>;
  /** What options resolve against: `gruposParaResolverLi(memo, job)`. */
  readonly grupos: readonly GrupoComLinksLi[];
  /** `recusasDoAprendizadoLi` over the job's evidence, the same grupos and its write conflicts. */
  readonly recusasDoAprendizado: ReadonlyMap<string, RecusaNoRelatorioLi>;
}

/** How one family unit ended. */
export type ResultadoDaFamiliaLi =
  /** Outside the job's target and not reported: nothing resolved past the root, nothing written. */
  | { readonly tipo: 'fora-do-alvo'; readonly plano: PlanoDaFamiliaLi }
  /** Planned, linked (or decided) and reported; `contadores` is the item's delta. */
  | {
      readonly tipo: 'relatado';
      readonly plano: PlanoDaFamiliaLi;
      readonly vinculos: ResultadoDosVinculosLi;
      readonly item: ItemImportacaoLi;
      readonly contadores: ContadoresImportacaoLi;
    };

/** Run one family (module header, "Order"). */
export async function executarFamiliaLi(
  deps: DepsFamiliaLi,
  ctx: ContextoDasFamiliasLi,
  familia: FamiliaLi,
): Promise<ResultadoDaFamiliaLi> {
  const resolucao = { db: deps.db, contaId: ctx.job.integracaoId };
  const raiz = await resolverRaizLi(resolucao, familia, ctx.skusRepetidos);
  const noAlvo = familiaNoAlvoLi(ctx.job, familia.raiz.id, raiz);

  let filhos: ResolucaoDosFilhosLi | null = null;
  if (
    noAlvo &&
    familia.raiz.tipo === TIPO_PRODUTO_LI.atributo &&
    (raiz.tipo === SITUACAO_ERP_ITEM_LI.vinculado || raiz.tipo === SITUACAO_ERP_ITEM_LI.encontrado)
  ) {
    filhos = await resolverFilhosLi(resolucao, familia, raiz.erpId, {
      grupos: ctx.grupos,
      skusRepetidos: ctx.skusRepetidos,
    });
  }

  const plano = planejarFamiliaLi({
    job: ctx.job,
    familia,
    raiz,
    filhos,
    skusRepetidos: ctx.skusRepetidos,
    recusasDoAprendizado: ctx.recusasDoAprendizado,
  });
  if (!plano.relatar) return { tipo: 'fora-do-alvo', plano };

  const vinculos = await vincularFamiliaLi(
    { ...resolucao, modo: ctx.job.modo, criacaoDoJob: deps.criacaoDoJob },
    plano,
  );
  const item = montarItemDaFamiliaLi({
    familia,
    plano,
    vinculos,
    modo: ctx.job.modo,
    agoraMs: deps.agoraMs(),
  });
  await gravarItemLi(deps.db, deps.jobId, item);
  return {
    tipo: 'relatado',
    plano,
    vinculos,
    item,
    contadores: contadoresDoItemLi(item, vinculos),
  };
}
