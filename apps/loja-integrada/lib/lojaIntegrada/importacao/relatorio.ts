/**
 * The product import's REPORT (master plan step 9): one `itens/{liId}` document per store family
 * the run took (its root's store id), the counters the job's card shows, and the per-code count of
 * the ACTIONABLE pendências the summary aviso carries.
 *
 * ## One item ({@link montarItemDaFamiliaLi})
 *
 * Built from the family, its plan (`plano.ts`) and its links' outcomes (`vinculos.ts`):
 *  - `situacaoErp` and `erpId`: the cascade's verdict on the root — except a root `vinculado` only
 *    through the link THIS job created (`criado` + `retomado`: a retried unit reading its own
 *    landed create, `vinculos.ts`), which reports `encontrado`. Such a link was created because the
 *    one-per-conta scan found the produto free of this conta's links, so the attempt that created
 *    it had no live link owner at rung 1 and matched by SKU (rungs 2–3). A migrated auto-id link is
 *    never one: the scan refreshes it and nothing is created. ⚠️ Residual: a root the cascade
 *    found by a link someone deleted before the scan, whose link this job then re-created, reads
 *    `encontrado` on a retry;
 *  - `acao`: `criar` when the plan's create is viable (the complete step creates it); otherwise
 *    `vincular` when at least one link was created — by this attempt or, `retomado`, by an earlier
 *    attempt of this job — or, under Simular, would be; otherwise `nenhuma` (already linked,
 *    refreshed, refused, or nothing to do);
 *  - `aplicada`: `false` under Simular (the action is what an `aplicar` run would do), and for a
 *    `criar` the complete step has not carried out; `true` otherwise;
 *  - `pendencias`: the plan's, then each link refusal (the root's with `liId: null`, a
 *    variation's with its store id) and each refresh as `vinculo-atualizado` (informational, the
 *    changed FIELD names as references), each tagged actionable or informational through the
 *    schema's one predicate (`ehPendenciaAcionavelLi`); exact duplicates dropped.
 *
 * A selected store id the listing lacks as a family root is its own item,
 * {@link itemNaoListadoLi}: `situacaoErp: nao-listado`, one informational `nao-listado` pendência.
 * A LOOSE row — a live row that belongs to no family (an orphan variation, a variation of a trashed
 * parent, a row of an unknown `tipo`) — is its own item too, {@link itemAvulsoLi}: `situacaoErp:
 * avulso`, never matched, one informational pendência with the assembly's code (`orfao`,
 * `na-lixeira`, `tipo-desconhecido`), so the report accounts for every row the store listed.
 *
 * ## The counters ({@link contadoresDoItemLi}, {@link somarContadoresLi})
 *
 * Per item: `familias` + 1 (not for a `nao-listado` or `avulso` item: neither is a family);
 * `vinculados` + the links created (or that would be); `semMudanca` + 1 when a family's item changed
 * nothing and would change nothing (no link created or refreshed, no create); the pendências by
 * half. The dispatch adds an item's delta to
 * the job's counters in the SAME checkpoint that moves the family cursor past it, so a retried
 * unit recomputes its delta from the same base and counts nothing twice — and, because a link its
 * own job created still reads `criado` (`vinculos.ts`), the SAME delta: never `vinculados + 0,
 * semMudanca + 1` for the links the failed attempt landed. Residuals: `vinculos.ts`'s, and the
 * cascade's informational `sku-diferente` / `sku-repetido-na-loja` on a variation first matched by
 * combination (`familiaDoJob.ts`, "A retried family").
 *
 * ## The write ({@link gravarItemLi}) — tier 0
 *
 * A whole-document `set` at the root's store id, through the item schema: the job's own dispatches
 * are its only writer (one at a time), so a retried unit overwrites its own earlier attempt.
 *
 * ## The actionable count ({@link contarPendenciasAcionaveisLi})
 *
 * The job's own `itens`, in document-key order, page by page (`lerItensDaImportacaoLi`): no query
 * with a filter, nothing outside the job (root rule 1). The items are the truth: a counter could
 * only restate them.
 *
 * Next-free; `db` is a parameter.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { itemImportacaoLiCollection } from '@delfrance/data/admin/collections';
import {
  ACAO_ITEM_IMPORTACAO_LI,
  type AcaoItemImportacaoLi,
  type ContadoresImportacaoLi,
  type ItemImportacaoLi,
  MODO_IMPORTACAO_LI,
  type ModoImportacaoLi,
  PENDENCIA_IMPORTACAO_LI,
  type PendenciaImportacaoLi,
  type PendenciaItemLi,
  SITUACAO_ERP_ITEM_LI,
  TIPO_PRODUTO_LI,
  contadoresImportacaoLiSchema,
  ehPendenciaAcionavelLi,
  itemImportacaoLiSchema,
} from '@delfrance/schemas';

import type { AvulsoLi, FamiliaLi } from './familias';
import { lerItensDaImportacaoLi } from './job';
import type { PendenciaDoPlanoLi, PlanoDaFamiliaLi } from './plano';
import {
  DESFECHO_DO_VINCULO_LI,
  type ResultadoDoVinculoLi,
  type ResultadoDosVinculosLi,
} from './vinculos';

/* -------------------------------------------------------------------------- */
/*                                   One item                                  */
/* -------------------------------------------------------------------------- */

export interface EntradaDoItemLi {
  readonly familia: FamiliaLi;
  readonly plano: PlanoDaFamiliaLi;
  readonly vinculos: ResultadoDosVinculosLi;
  readonly modo: ModoImportacaoLi;
  /** The complete step carried the plan's create out (it is the only one that can). */
  readonly criacaoAplicada?: boolean;
  /** The ERP field NAMES the complete step filled (or would). */
  readonly camposPreenchidos?: readonly string[];
  /** The item's `atualizadoEmMs`. */
  readonly agoraMs: number;
}

/** The family's link outcomes, root first. */
function todosOsVinculos(vinculos: ResultadoDosVinculosLi): ResultadoDoVinculoLi[] {
  return vinculos.raiz === null ? [...vinculos.filhos] : [vinculos.raiz, ...vinculos.filhos];
}

/** The pendência one link outcome adds to the report, if any (module header). */
function pendenciaDoVinculo(r: ResultadoDoVinculoLi): PendenciaDoPlanoLi | null {
  const liId = r.vinculo.papel === 'raiz' ? null : r.vinculo.liId;
  const { desfecho } = r;
  if (desfecho.tipo === DESFECHO_DO_VINCULO_LI.recusado) {
    return { codigo: desfecho.codigo, liId, referencias: desfecho.referencias };
  }
  if (desfecho.tipo === DESFECHO_DO_VINCULO_LI.atualizado) {
    return {
      codigo: PENDENCIA_IMPORTACAO_LI.vinculoAtualizado,
      liId,
      referencias: desfecho.campos,
    };
  }
  return null;
}

/** A pendência as stored: tagged actionable or informational by the schema's predicate. */
function paraItem(p: PendenciaDoPlanoLi): PendenciaItemLi {
  return {
    codigo: p.codigo,
    acionavel: ehPendenciaAcionavelLi(p.codigo),
    liId: p.liId,
    referencias: [...p.referencias],
  };
}

function semRepetir(pendencias: readonly PendenciaItemLi[]): PendenciaItemLi[] {
  const vistas = new Set<string>();
  return pendencias.filter((p) => {
    const chave = JSON.stringify([p.codigo, p.liId, p.referencias]);
    if (vistas.has(chave)) return false;
    vistas.add(chave);
    return true;
  });
}

/** The links created (or, under Simular, that would be). */
function vinculosCriados(vinculos: ResultadoDosVinculosLi): number {
  return todosOsVinculos(vinculos).filter((r) => r.desfecho.tipo === DESFECHO_DO_VINCULO_LI.criado)
    .length;
}

/**
 * The item's `situacaoErp` (module header, "One item"): the cascade's, except a root `vinculado`
 * only through the link this job itself created — read back by a retried unit — which the attempt
 * that created it found by SKU (`encontrado`).
 */
function situacaoErpDoItem(plano: PlanoDaFamiliaLi, vinculos: ResultadoDosVinculosLi) {
  const raiz = vinculos.raiz?.desfecho;
  return plano.situacaoErp === SITUACAO_ERP_ITEM_LI.vinculado &&
    raiz?.tipo === DESFECHO_DO_VINCULO_LI.criado &&
    raiz.retomado === true
    ? SITUACAO_ERP_ITEM_LI.encontrado
    : plano.situacaoErp;
}

/** The report item of one family (module header, "One item"). Parsed through the item schema. */
export function montarItemDaFamiliaLi(e: EntradaDoItemLi): ItemImportacaoLi {
  const { familia, plano, vinculos } = e;
  const viavel = plano.criacao?.viavel === true;
  const acao: AcaoItemImportacaoLi = viavel
    ? ACAO_ITEM_IMPORTACAO_LI.criar
    : vinculosCriados(vinculos) > 0
      ? ACAO_ITEM_IMPORTACAO_LI.vincular
      : ACAO_ITEM_IMPORTACAO_LI.nenhuma;
  const aplicada =
    e.modo === MODO_IMPORTACAO_LI.aplicar &&
    (acao !== ACAO_ITEM_IMPORTACAO_LI.criar || e.criacaoAplicada === true);
  const dosVinculos = todosOsVinculos(vinculos)
    .map(pendenciaDoVinculo)
    .filter((p): p is PendenciaDoPlanoLi => p !== null);
  return itemImportacaoLiSchema.parse({
    liId: plano.liId,
    tipo: familia.raiz.tipo,
    sku: familia.raiz.sku,
    nome: familia.raiz.nome,
    filhos: familia.filhos.length,
    situacaoErp: situacaoErpDoItem(plano, vinculos),
    erpId: plano.erpId,
    acao,
    aplicada,
    camposPreenchidos: [...(e.camposPreenchidos ?? [])],
    pendencias: semRepetir([...plano.pendencias, ...dosVinculos].map(paraItem)),
    atualizadoEmMs: e.agoraMs,
  });
}

/** A selected store id the listing lacks as a family root (module header). */
export function itemNaoListadoLi(liId: number, agoraMs: number): ItemImportacaoLi {
  return itemImportacaoLiSchema.parse({
    liId,
    tipo: TIPO_PRODUTO_LI.desconhecido,
    situacaoErp: SITUACAO_ERP_ITEM_LI.naoListado,
    acao: ACAO_ITEM_IMPORTACAO_LI.nenhuma,
    pendencias: [
      paraItem({ codigo: PENDENCIA_IMPORTACAO_LI.naoListado, liId: null, referencias: [] }),
    ],
    atualizadoEmMs: agoraMs,
  });
}

/** A loose row: no family, never matched, its one informational code (module header). */
export function itemAvulsoLi(avulso: AvulsoLi, agoraMs: number): ItemImportacaoLi {
  const { linha, codigo } = avulso;
  return itemImportacaoLiSchema.parse({
    liId: linha.id,
    tipo: linha.tipo,
    sku: linha.sku,
    nome: linha.nome,
    situacaoErp: SITUACAO_ERP_ITEM_LI.avulso,
    acao: ACAO_ITEM_IMPORTACAO_LI.nenhuma,
    pendencias: [paraItem({ codigo, liId: null, referencias: [] })],
    atualizadoEmMs: agoraMs,
  });
}

/* -------------------------------------------------------------------------- */
/*                                 The counters                                */
/* -------------------------------------------------------------------------- */

/** All counters at zero. */
export function contadoresZeradosLi(): ContadoresImportacaoLi {
  return contadoresImportacaoLiSchema.parse({});
}

/**
 * One item's contribution to the job's counters (module header, "The counters"). `vinculos` is the
 * family's link outcomes (`null` for a `nao-listado` item).
 */
export function contadoresDoItemLi(
  item: ItemImportacaoLi,
  vinculos: ResultadoDosVinculosLi | null,
): ContadoresImportacaoLi {
  const acionaveis = item.pendencias.filter((p) => p.acionavel).length;
  // Neither a selected id the listing lacks nor a loose row is a family.
  const semFamilia =
    item.situacaoErp === SITUACAO_ERP_ITEM_LI.naoListado ||
    item.situacaoErp === SITUACAO_ERP_ITEM_LI.avulso;
  const todos = vinculos === null ? [] : todosOsVinculos(vinculos);
  const mudou =
    item.acao !== ACAO_ITEM_IMPORTACAO_LI.nenhuma ||
    todos.some(
      (r) =>
        r.desfecho.tipo === DESFECHO_DO_VINCULO_LI.criado ||
        r.desfecho.tipo === DESFECHO_DO_VINCULO_LI.atualizado,
    ) ||
    item.camposPreenchidos.length > 0;
  return contadoresImportacaoLiSchema.parse({
    familias: semFamilia ? 0 : 1,
    vinculados: vinculos === null ? 0 : vinculosCriados(vinculos),
    semMudanca: semFamilia || mudou ? 0 : 1,
    pendenciasAcionaveis: acionaveis,
    pendenciasInformativas: item.pendencias.length - acionaveis,
  });
}

/** `a + b`, counter by counter. */
export function somarContadoresLi(
  a: ContadoresImportacaoLi,
  b: ContadoresImportacaoLi,
): ContadoresImportacaoLi {
  const soma = { ...a };
  for (const chave of Object.keys(b) as (keyof ContadoresImportacaoLi)[]) {
    soma[chave] = a[chave] + b[chave];
  }
  return contadoresImportacaoLiSchema.parse(soma);
}

/* -------------------------------------------------------------------------- */
/*                                  The write                                  */
/* -------------------------------------------------------------------------- */

/** Write one item at `itens/{liId}`, whole (module header, "The write"). */
export async function gravarItemLi(
  db: Firestore,
  jobId: string,
  item: ItemImportacaoLi,
): Promise<void> {
  await itemImportacaoLiCollection.set(db, { jobId }, String(item.liId), item);
}

/* -------------------------------------------------------------------------- */
/*                             The actionable count                            */
/* -------------------------------------------------------------------------- */

/** The actionable pendências of a whole job: the total and one count per code. */
export interface ContagemAcionavelLi {
  readonly total: number;
  readonly porCodigo: Readonly<Partial<Record<PendenciaImportacaoLi, number>>>;
}

/** Count the job's actionable pendências over its own items (module header). */
export async function contarPendenciasAcionaveisLi(
  db: Firestore,
  jobId: string,
): Promise<ContagemAcionavelLi> {
  const porCodigo: Partial<Record<PendenciaImportacaoLi, number>> = {};
  let total = 0;
  let depois: string | null = null;
  do {
    const pagina = await lerItensDaImportacaoLi(db, jobId, depois);
    for (const item of pagina.itens) {
      for (const p of item.pendencias) {
        if (!p.acionavel || !ehPendenciaAcionavelLi(p.codigo)) continue;
        const codigo = p.codigo as PendenciaImportacaoLi;
        porCodigo[codigo] = (porCodigo[codigo] ?? 0) + 1;
        total += 1;
      }
    }
    depois = pagina.proximo;
  } while (depois !== null);
  return { total, porCodigo };
}
