/**
 * The product import's FAMILY ASSEMBLY (master plan step 9): the store's families, rebuilt from
 * the job's snapshot (`listagem.ts`) and the details it read (`detalhes.ts`), and the `orfaos`
 * phase that reads the details the assembly needs.
 *
 * ## The words
 *
 * A store *family* is a parent (`tipo: atributo`) with its variations (`atributo_opcao`); a
 * *simple* product (`normal`) is a family with no variation. Only a parent CLAIMS variations,
 * through its `filhos`. A variation is a list row of its own, carrying no `pai`; only its detail
 * names its parent.
 *
 * ## The snapshot, indexed ({@link indexarSnapshotLi})
 *
 *  - The live rows, de-duplicated by `id` — a row repeated across pages keeps the copy read LAST
 *    (the freshest); the list's order is never relied on.
 *  - The trash rows (`removido: true`), de-duplicated the same way. A product in BOTH lists was
 *    trashed between the two reads (the trash list is read after the listing), so it counts as
 *    trashed and leaves the live rows.
 *  - Which listed parents claim each id, and which ids a TRASHED parent claims.
 *
 * ## Where each variation row goes
 *
 *  1. Claimed by exactly ONE listed parent ⇒ that family, wherever either row sat in the listing.
 *  2. Claimed by none, and claimed by a trashed parent ⇒ "na lixeira" (`na-lixeira`: never linked,
 *     never created) with NO detail read. The owner's capture showed exactly this: a trashed
 *     parent's variations listed as live rows nobody else claims.
 *  3. Anything else — claimed by none and unexplained by the trash, or claimed by TWO listed
 *     parents — is an orphan to explain ({@link orfaosAExplicarLi}): the `orfaos` phase reads its
 *     detail, and the detail's `pai` decides:
 *     - a listed parent ⇒ that family (even one that does not claim it);
 *     - a trashed parent, or the detail itself says `removido: true` ⇒ `na-lixeira`;
 *     - no `pai`, an unreadable one, an id that is not a listed parent, a 404, or no usable detail
 *       ⇒ `orfao` (informational). An orphan is NEVER imported as a simple product.
 *
 * ## A parent's claims that are not rows
 *
 * A `filhos` id never seen as a row: in the trash list ⇒ a `na-lixeira` pendência on the family;
 * otherwise its detail decides — the `orfaos` phase reads it with the orphans, before any family is
 * matched ({@link idsADetalharLi}); read and unusable (a divergent answer, a body off its schema) ⇒
 * `semDetalhe`, a family the plan cannot complete; a 404, a detail of another `tipo`, or a `pai`
 * naming another product ⇒ an `orfao` pendência; a detail saying `removido` ⇒ `na-lixeira`;
 * otherwise the detail is the variation. A claimed row that is not a variation (a
 * parent, a simple product, an unknown `tipo`) is never attached: the claim is ignored and
 * counted, and the row stands on its own.
 *
 * A parent with no variation attached and none waiting for a detail is an EMPTY family
 * (`familia-vazia`: linked if the ERP has it, never created). A row whose `tipo` this build does not
 * know is `tipo-desconhecido` — reported, never treated as `normal`.
 *
 * Every list here is in ascending store id: families by their root, variations within a family,
 * the loose rows ({@link AvulsoLi}). The assembly is pure and total ({@link montarFamiliasLi}); it
 * folds nothing — every id is a number the views already read, compared as such — and decides no
 * SKU (the match cascade does that, through the shared decisions).
 *
 * ## The `orfaos` phase — one detail per unit
 *
 * {@link unidadeDosOrfaosLi} and {@link executarUnidadeDosOrfaosLi}: the next id above the
 * cursor (`orfaos.cursorLiId`, ascending) of {@link idsADetalharLi} — an orphan, or a claimed id
 * never listed — one detail read and its document, the cursor moved to it; with none left, a unit
 * with no call that only concludes the phase. The list is recomputed from the snapshot (the
 * dispatch reads it once), so a retried unit re-reads the same id. The `selecionados` an operator picked that the store no longer lists as a family are
 * {@link naoListadosLi}.
 *
 * ## The reads, against the indexes (root rule 1)
 *
 * The job's `paginas` whole in document-key order (`listagem.ts`, `lerPaginasDoJobLi`) and its
 * `detalhes` by id (`detalhes.ts`): no query with a filter, nothing outside the job.
 *
 * ⚠️ Never name the Admin SDK's multi-document read-and-write call here — not even in a comment
 * (`estrutura.test.ts`). Next-free, `db` and the client are parameters.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  type DetalheImportacaoLi,
  type ImportacaoLojaIntegrada,
  PENDENCIA_IMPORTACAO_LI,
  type ProdutoLiDetalhado,
  type ProdutoLiLido,
  TIPO_PAGINA_IMPORTACAO_LI,
  TIPO_PRODUTO_LI,
} from '@delfrance/schemas';

import {
  type DetalhesDeps,
  type ResultadoDetalheLi,
  detalheLidoLi,
  lerDetalheParaOJobLi,
  lerDetalhesGravadosLi,
} from './detalhes';
import { lerPaginasDoJobLi, linhaPertenceALista } from './listagem';
import { UNIDADE_IMPORTACAO_LI, type UnidadeImportacaoLi } from './orcamento';

/* -------------------------------------------------------------------------- */
/*                                The snapshot                                 */
/* -------------------------------------------------------------------------- */

/** Every row of the job's two lists, in the order their pages were read (by offset). */
export interface SnapshotDoJobLi {
  readonly listagem: readonly ProdutoLiLido[];
  readonly lixeira: readonly ProdutoLiLido[];
}

/** The job's snapshot pages, read back whole (module header, "The reads"). */
export async function lerSnapshotDoJobLi(db: Firestore, jobId: string): Promise<SnapshotDoJobLi> {
  const listagem: ProdutoLiLido[] = [];
  const lixeira: ProdutoLiLido[] = [];
  for (const pagina of await lerPaginasDoJobLi(db, jobId)) {
    (pagina.tipo === TIPO_PAGINA_IMPORTACAO_LI.lixeira ? lixeira : listagem).push(...pagina.linhas);
  }
  return { listagem, lixeira };
}

/** The snapshot indexed (module header). */
export interface IndiceDoSnapshotLi {
  /** The live rows by id: de-duplicated (last read wins), every trashed id removed. */
  readonly ativos: ReadonlyMap<number, ProdutoLiLido>;
  /** The trash rows by id, de-duplicated (last read wins). */
  readonly lixeira: ReadonlyMap<number, ProdutoLiLido>;
  /** For each id a listed parent claims: the claiming parents, ascending. */
  readonly reivindicacoes: ReadonlyMap<number, readonly number[]>;
  /** Every id a trashed parent claims. */
  readonly reivindicadosNaLixeira: ReadonlySet<number>;
}

const crescente = (a: number, b: number): number => a - b;

/** Index the snapshot (module header). Pure; `removido` re-checked on every row. */
export function indexarSnapshotLi(snapshot: SnapshotDoJobLi): IndiceDoSnapshotLi {
  const lixeira = new Map<number, ProdutoLiLido>();
  for (const linha of snapshot.lixeira) {
    if (linhaPertenceALista(TIPO_PAGINA_IMPORTACAO_LI.lixeira, linha)) lixeira.set(linha.id, linha);
  }
  const ativos = new Map<number, ProdutoLiLido>();
  for (const linha of snapshot.listagem) {
    if (!linhaPertenceALista(TIPO_PAGINA_IMPORTACAO_LI.listagem, linha)) continue;
    if (lixeira.has(linha.id)) continue;
    ativos.set(linha.id, linha);
  }

  const reivindicacoes = new Map<number, number[]>();
  for (const pai of ativos.values()) {
    if (pai.tipo !== TIPO_PRODUTO_LI.atributo) continue;
    for (const filhoId of new Set(pai.filhoIds)) {
      const pais = reivindicacoes.get(filhoId) ?? [];
      pais.push(pai.id);
      reivindicacoes.set(filhoId, pais);
    }
  }
  for (const pais of reivindicacoes.values()) pais.sort(crescente);

  const reivindicadosNaLixeira = new Set<number>();
  for (const pai of lixeira.values()) {
    if (pai.tipo !== TIPO_PRODUTO_LI.atributo) continue;
    for (const filhoId of pai.filhoIds) reivindicadosNaLixeira.add(filhoId);
  }

  return { ativos, lixeira, reivindicacoes, reivindicadosNaLixeira };
}

/** Whether `id` is a listed (live, untrashed) parent. */
function ehPaiListado(indice: IndiceDoSnapshotLi, id: number): boolean {
  return indice.ativos.get(id)?.tipo === TIPO_PRODUTO_LI.atributo;
}

/**
 * The live variation rows only their detail can place (module header, rule 3): claimed by no
 * listed parent and not by a trashed one, or claimed by two or more listed parents. Ascending.
 * The `orfaos` phase reads each one's detail.
 */
export function orfaosAExplicarLi(indice: IndiceDoSnapshotLi): number[] {
  const orfaos: number[] = [];
  for (const linha of indice.ativos.values()) {
    if (linha.tipo !== TIPO_PRODUTO_LI.atributoOpcao) continue;
    const pais = indice.reivindicacoes.get(linha.id) ?? [];
    if (pais.length === 1) continue;
    if (pais.length === 0 && indice.reivindicadosNaLixeira.has(linha.id)) continue;
    orfaos.push(linha.id);
  }
  return orfaos.sort(crescente);
}

/**
 * The ids listed parents claim that are neither a live row nor a trash row: only their detail
 * can say what they are (module header, "A parent's claims that are not rows"). Ascending.
 */
export function filhosSemLinhaLi(indice: IndiceDoSnapshotLi): number[] {
  const ids = new Set<number>();
  for (const id of indice.reivindicacoes.keys()) {
    if (!indice.ativos.has(id) && !indice.lixeira.has(id)) ids.add(id);
  }
  return [...ids].sort(crescente);
}

/**
 * EVERY id the assembly needs a detail of, ascending: the orphans to explain
 * ({@link orfaosAExplicarLi}, live rows) and the claimed ids never listed ({@link filhosSemLinhaLi},
 * not rows) — two disjoint lists. The `orfaos` phase reads them all before any family is matched,
 * so the assembly — and the SKUs the store repeats or nearly repeats, which a never-listed variation
 * can carry — is whole before the first match: processing order never picks a winner.
 */
export function idsADetalharLi(indice: IndiceDoSnapshotLi): number[] {
  return [...orfaosAExplicarLi(indice), ...filhosSemLinhaLi(indice)].sort(crescente);
}

/* -------------------------------------------------------------------------- */
/*                                 The assembly                                */
/* -------------------------------------------------------------------------- */

/** How a variation came to its family. */
export type OrigemDoFilhoLi =
  /** Its parent's `filhos` claims it (its row, or — never listed — its detail). */
  | 'filhos'
  /** Its own detail's `pai` names the parent (an orphan, or a variation two parents claimed). */
  | 'pai';

/** Named members of {@link OrigemDoFilhoLi}. */
export const ORIGEM_DO_FILHO_LI = {
  filhos: 'filhos',
  pai: 'pai',
} as const satisfies Record<string, OrigemDoFilhoLi>;

/** One variation of a family. */
export interface FilhoDaFamiliaLi {
  /** Its row view — for a variation never listed, its detail. */
  readonly linha: ProdutoLiLido;
  /** Its detail, when this job read one. */
  readonly detalhe: ProdutoLiDetalhado | null;
  readonly origem: OrigemDoFilhoLi;
}

/** The pendências the assembly itself decides (all informational). */
export type CodigoDaMontagemLi =
  | typeof PENDENCIA_IMPORTACAO_LI.orfao
  | typeof PENDENCIA_IMPORTACAO_LI.naLixeira
  | typeof PENDENCIA_IMPORTACAO_LI.familiaVazia
  | typeof PENDENCIA_IMPORTACAO_LI.tipoDesconhecido;

/** A pendência of a family: about one of its claimed ids (`liId`), or the family (`null`). */
export interface PendenciaDaMontagemLi {
  readonly codigo: CodigoDaMontagemLi;
  readonly liId: number | null;
}

/** One store family — a parent with its variations, or a simple product. */
export interface FamiliaLi {
  /** The parent (`atributo`) or the simple product (`normal`). */
  readonly raiz: ProdutoLiLido;
  /** The root's detail, when this job read one. */
  readonly detalheDaRaiz: ProdutoLiDetalhado | null;
  /** Its variations, ascending id. Always empty for a simple product. */
  readonly filhos: readonly FilhoDaFamiliaLi[];
  /**
   * Claimed ids never seen as rows with no usable stored detail, ascending: read in the `orfaos`
   * phase and unusable (a divergent answer, a body off its schema), or — in an assembly built
   * before that phase ran — not read yet.
   */
  readonly semDetalhe: readonly number[];
  readonly pendencias: readonly PendenciaDaMontagemLi[];
}

/** A live row that belongs to no family. */
export interface AvulsoLi {
  readonly linha: ProdutoLiLido;
  readonly codigo:
    | typeof PENDENCIA_IMPORTACAO_LI.orfao
    | typeof PENDENCIA_IMPORTACAO_LI.naLixeira
    | typeof PENDENCIA_IMPORTACAO_LI.tipoDesconhecido;
}

/** The assembly. */
export interface MontagemLi {
  /** Ascending by root id: every listed parent and simple product. */
  readonly familias: readonly FamiliaLi[];
  /** Ascending id: orphans, variations in the trash, unknown `tipo`s. */
  readonly avulsos: readonly AvulsoLi[];
  readonly contagens: {
    /** Claims of a row that is not a variation (never attached), and a simple product's claims. */
    readonly reivindicacoesIgnoradas: number;
    /** Variation rows two or more listed parents claimed (placed by their detail's `pai`). */
    readonly reivindicacoesDisputadas: number;
    /** `filhos` URIs the row reader could not read, over every listed parent. */
    readonly filhosIlegiveis: number;
  };
}

/** Where an orphan's detail places it (module header, rule 3). */
type DestinoDoOrfaoLi =
  | { readonly tipo: 'familia'; readonly paiId: number }
  | { readonly tipo: typeof PENDENCIA_IMPORTACAO_LI.naLixeira }
  | { readonly tipo: typeof PENDENCIA_IMPORTACAO_LI.orfao };

function destinoDoOrfao(
  indice: IndiceDoSnapshotLi,
  detalhe: ProdutoLiDetalhado | null,
): DestinoDoOrfaoLi {
  if (detalhe === null) return { tipo: PENDENCIA_IMPORTACAO_LI.orfao };
  if (detalhe.removido === true) return { tipo: PENDENCIA_IMPORTACAO_LI.naLixeira };
  const { paiId } = detalhe;
  if (paiId === null || detalhe.paiIlegivel) return { tipo: PENDENCIA_IMPORTACAO_LI.orfao };
  if (ehPaiListado(indice, paiId)) return { tipo: 'familia', paiId };
  if (indice.lixeira.has(paiId)) return { tipo: PENDENCIA_IMPORTACAO_LI.naLixeira };
  return { tipo: PENDENCIA_IMPORTACAO_LI.orfao };
}

/** A claimed id never seen as a row, as its stored detail decides (module header). */
type FilhoSemLinhaLi =
  | { readonly tipo: 'filho'; readonly detalhe: ProdutoLiDetalhado }
  | { readonly tipo: 'sem-detalhe' }
  | { readonly tipo: 'pendencia'; readonly codigo: CodigoDaMontagemLi };

function filhoSemLinha(paiId: number, gravado: DetalheImportacaoLi | undefined): FilhoSemLinhaLi {
  if (gravado === undefined) return { tipo: 'sem-detalhe' };
  const d = gravado.detalhe;
  if (d === null) return { tipo: 'pendencia', codigo: PENDENCIA_IMPORTACAO_LI.orfao };
  if (d.removido === true) return { tipo: 'pendencia', codigo: PENDENCIA_IMPORTACAO_LI.naLixeira };
  if (d.tipo !== TIPO_PRODUTO_LI.atributoOpcao || d.paiIlegivel) {
    return { tipo: 'pendencia', codigo: PENDENCIA_IMPORTACAO_LI.orfao };
  }
  if (d.paiId !== null && d.paiId !== paiId) {
    return { tipo: 'pendencia', codigo: PENDENCIA_IMPORTACAO_LI.orfao };
  }
  return { tipo: 'filho', detalhe: d };
}

/**
 * Assemble the store's families from the indexed snapshot and the stored details (module header).
 * Pure and total: a detail missing from `detalhes` reads as "not read".
 */
export function montarFamiliasLi(
  indice: IndiceDoSnapshotLi,
  detalhes: ReadonlyMap<number, DetalheImportacaoLi>,
): MontagemLi {
  const avulsos: AvulsoLi[] = [];
  const porPai = new Map<number, FilhoDaFamiliaLi[]>();
  let reivindicacoesIgnoradas = 0;
  let reivindicacoesDisputadas = 0;
  let filhosIlegiveis = 0;

  // The orphans first: their detail's `pai` may add them to any family below.
  for (const id of orfaosAExplicarLi(indice)) {
    const linha = indice.ativos.get(id);
    if (linha === undefined) continue;
    if ((indice.reivindicacoes.get(id)?.length ?? 0) > 1) reivindicacoesDisputadas += 1;
    const detalhe = detalheLidoLi(detalhes, id);
    const destino = destinoDoOrfao(indice, detalhe);
    if (destino.tipo === 'familia') {
      const filhos = porPai.get(destino.paiId) ?? [];
      filhos.push({ linha, detalhe, origem: ORIGEM_DO_FILHO_LI.pai });
      porPai.set(destino.paiId, filhos);
    } else {
      avulsos.push({ linha, codigo: destino.tipo });
    }
  }

  const familias: FamiliaLi[] = [];
  for (const raiz of indice.ativos.values()) {
    if (raiz.tipo === TIPO_PRODUTO_LI.desconhecido) {
      avulsos.push({ linha: raiz, codigo: PENDENCIA_IMPORTACAO_LI.tipoDesconhecido });
      continue;
    }
    if (raiz.tipo === TIPO_PRODUTO_LI.atributoOpcao) {
      // A variation claimed by exactly one listed parent is in that family below; one claimed by
      // none but a trashed parent is in the trash. Orphans were placed above.
      const pais = indice.reivindicacoes.get(raiz.id) ?? [];
      if (pais.length === 0 && indice.reivindicadosNaLixeira.has(raiz.id)) {
        avulsos.push({ linha: raiz, codigo: PENDENCIA_IMPORTACAO_LI.naLixeira });
      }
      continue;
    }

    const detalheDaRaiz = detalheLidoLi(detalhes, raiz.id);
    if (raiz.tipo === TIPO_PRODUTO_LI.normal) {
      reivindicacoesIgnoradas += new Set(raiz.filhoIds).size;
      familias.push({ raiz, detalheDaRaiz, filhos: [], semDetalhe: [], pendencias: [] });
      continue;
    }

    // A parent.
    filhosIlegiveis += raiz.ilegiveis.filhos;
    const filhos: FilhoDaFamiliaLi[] = [...(porPai.get(raiz.id) ?? [])];
    const semDetalhe: number[] = [];
    const pendencias: PendenciaDaMontagemLi[] = [];
    for (const filhoId of [...new Set(raiz.filhoIds)].sort(crescente)) {
      const linha = indice.ativos.get(filhoId);
      if (linha !== undefined) {
        if (linha.tipo !== TIPO_PRODUTO_LI.atributoOpcao) {
          reivindicacoesIgnoradas += 1;
          continue;
        }
        // Two parents claim it: its detail's `pai` placed it above, or it is an orphan.
        if ((indice.reivindicacoes.get(filhoId)?.length ?? 0) > 1) continue;
        filhos.push({
          linha,
          detalhe: detalheLidoLi(detalhes, filhoId),
          origem: ORIGEM_DO_FILHO_LI.filhos,
        });
        continue;
      }
      if (indice.lixeira.has(filhoId)) {
        pendencias.push({ codigo: PENDENCIA_IMPORTACAO_LI.naLixeira, liId: filhoId });
        continue;
      }
      const sem = filhoSemLinha(raiz.id, detalhes.get(filhoId));
      if (sem.tipo === 'filho') {
        filhos.push({
          linha: sem.detalhe,
          detalhe: sem.detalhe,
          origem: ORIGEM_DO_FILHO_LI.filhos,
        });
      } else if (sem.tipo === 'sem-detalhe') {
        semDetalhe.push(filhoId);
      } else {
        pendencias.push({ codigo: sem.codigo, liId: filhoId });
      }
    }
    filhos.sort((a, b) => a.linha.id - b.linha.id);
    if (filhos.length === 0 && semDetalhe.length === 0) {
      pendencias.push({ codigo: PENDENCIA_IMPORTACAO_LI.familiaVazia, liId: null });
    }
    familias.push({ raiz, detalheDaRaiz, filhos, semDetalhe, pendencias });
  }

  familias.sort((a, b) => a.raiz.id - b.raiz.id);
  avulsos.sort((a, b) => a.linha.id - b.linha.id);
  return {
    familias,
    avulsos,
    contagens: { reivindicacoesIgnoradas, reivindicacoesDisputadas, filhosIlegiveis },
  };
}

/** The job's assembly, from its snapshot and the details the assembly needs (each read by id). */
export async function montarFamiliasDoJobLi(
  db: Firestore,
  jobId: string,
): Promise<{ readonly indice: IndiceDoSnapshotLi; readonly montagem: MontagemLi }> {
  const indice = indexarSnapshotLi(await lerSnapshotDoJobLi(db, jobId));
  const detalhes = await lerDetalhesGravadosLi(db, jobId, idsADetalharLi(indice));
  return { indice, montagem: montarFamiliasLi(indice, detalhes) };
}

/**
 * The selected store ids that are not a family's root in this snapshot — a parent or a simple
 * product the store no longer lists (or lists only as a variation, in the trash, or with an unknown
 * `tipo`). Each becomes a `nao-listado` report item, never a silent skip. Ascending, without
 * repeats.
 */
export function naoListadosLi(montagem: MontagemLi, selecionados: readonly number[]): number[] {
  const raizes = new Set(montagem.familias.map((f) => f.raiz.id));
  return [...new Set(selecionados)].filter((id) => !raizes.has(id)).sort(crescente);
}

/* -------------------------------------------------------------------------- */
/*                               The orfaos phase                              */
/* -------------------------------------------------------------------------- */

type CursorOrfaosLi = ImportacaoLojaIntegrada['orfaos'];

/** The first orphan above the cursor (`orfaos` ascending), or `null` when none is left. Pure. */
export function proximoOrfaoLi(orfaos: readonly number[], cursor: CursorOrfaosLi): number | null {
  const { cursorLiId } = cursor;
  return orfaos.find((id) => cursorLiId === null || id > cursorLiId) ?? null;
}

/** The cost of the `orfaos` phase's next unit: one detail read, or none (the phase ends). Pure. */
export function unidadeDosOrfaosLi(
  orfaos: readonly number[],
  cursor: CursorOrfaosLi,
): UnidadeImportacaoLi {
  return proximoOrfaoLi(orfaos, cursor) === null
    ? UNIDADE_IMPORTACAO_LI.familia
    : UNIDADE_IMPORTACAO_LI.chamada;
}

/** How one unit of the `orfaos` phase ended. */
export type PassoDosOrfaosLi =
  /** One orphan's detail read (and stored, unless divergent); `orfaos` is the new cursor. */
  | {
      readonly tipo: 'lido';
      readonly liId: number;
      readonly orfaos: CursorOrfaosLi;
      readonly resultado: ResultadoDetalheLi;
    }
  /** No orphan left above the cursor: the phase is done (no call). */
  | { readonly tipo: 'concluido' };

/**
 * Run the `orfaos` phase's next unit: the next orphan's detail (`orfaos` as computed from the
 * snapshot by {@link orfaosAExplicarLi}; `cursor`, the job's as last checkpointed).
 */
export async function executarUnidadeDosOrfaosLi(
  deps: DetalhesDeps,
  orfaos: readonly number[],
  cursor: CursorOrfaosLi,
): Promise<PassoDosOrfaosLi> {
  const liId = proximoOrfaoLi(orfaos, cursor);
  if (liId === null) return { tipo: 'concluido' };
  const resultado = await lerDetalheParaOJobLi(deps, liId);
  return { tipo: 'lido', liId, orfaos: { cursorLiId: liId }, resultado };
}
