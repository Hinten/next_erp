/**
 * The product import's VARIATION GROUPS (master plan step 9): the dispatch's `grupoDeVariacoes`
 * memo, the Simular overlay, and the `aprendizado` phase — the option links the job's evidence
 * proves, decided by the shared `decidirAprendizadoLi` and written through the shared never-drop
 * merge. Learning runs under BOTH actions ("complete" and "only link"): it changes no product and
 * no variante, it only records which ERP variante a store option is. It never creates a grupo or a
 * variante (decided 2026-10-27: a store option the ERP does not have yet is linked by a person in
 * the variation screen, and the next run picks it up).
 *
 * ## The memo ({@link lerMemoDeGruposLi})
 *
 * The WHOLE `grupoDeVariacoes` collection, read once per dispatch when a phase needs it (lazily: the
 * dispatch decides), each grupo as `{ id, variantesIds, linksVariacoesli, versao }`:
 *  - `variantesIds`: the ids of its embedded `variacoes` (exact strings) — the variante list the
 *    variation screen's own link validator reads;
 *  - `linksVariacoesli`: the RAW stored value, never parsed here (the shared reader and merge
 *    decide what each element is, and keep what they cannot read);
 *  - `versao`: the stamp the next write on that grupo is preconditioned on — the read's
 *    `updateTime`, then each landed write's `writeTime` (chained, so a later decision of the same
 *    dispatch writes on what it last saw).
 *
 * ## Simular: the overlay ({@link gruposParaResolverLi})
 *
 * A Simular run writes no grupo. It stores the decision's learnings on its job
 * (`aprendizadosSimulados`), and every later resolution of the run reads the memo with them merged
 * in through the SAME never-drop merge — so a family resolved under Simular gets the verdict an
 * `aplicar` run would give after writing them. The overlay is applied under Simular only.
 *
 * ## The `aprendizado` phase ({@link executarAprendizadoLi}) — one unit, no Loja Integrada call
 *
 * Every claim document of the job (`evidencias.ts`, key order) and the memo go through ONE
 * `decidirAprendizadoLi`: unanimity per option, the fail-closed "holds" check, the cross-grupo
 * check with the merge applied, the per-variante dispute — every check a learning could win by
 * coming first is decided over the input there. Then:
 *  - **Simular**: nothing is written; the learnings are returned for the checkpoint's
 *    `aprendizadosSimulados`.
 *  - **`aplicar`**: each grupo the decision changes is written ONCE, tier 1 (root rule 7):
 *    `update({ linksVariacoesli: <the decision's whole merged array>, ultimaModificacao },
 *    { lastUpdateTime: <the memo's stamp> })`, and the memo takes the write's `writeTime`. A lost
 *    precondition (9; a deleted grupo fails it too, and 5 is read the same way) re-reads THAT grupo
 *    and re-decides ONCE over the memo as it now stands — the decision re-runs every check against
 *    what the other writer left (the variation screen's link-by-link merge keeps both sides) — and
 *    writes that grupo's new entry, if any, on the fresh stamp. A second loss reports the grupo's
 *    learnings as `conflito-de-escrita` and the job goes on: an option left unlearned is only
 *    reported, and the next run re-collects its claims. No delete, no re-point, nothing dropped.
 *
 * ⚠️ Accepted residual: a dispatch that dies AFTER some grupo writes landed and BEFORE its
 * checkpoint re-runs the phase over a memo that already holds them. Those learnings then read as
 * already linked; and a store grade the first pass created can let a multi-axis claim of the same
 * grade extend it — exactly what the NEXT run would decide anyway (the "new grade" rule is per
 * pass). A concurrent link of `(conta, grade)` written into ANOTHER grupo between the memo read and
 * our write is not covered by our precondition (it guards one grupo); the next run reports it
 * (`grade-em-dois-grupos`) and the publish pre-flight refuses it.
 *
 * ## For the report ({@link recusasDoAprendizadoLi}, {@link pendenciaDaRecusaLi})
 *
 * Why an option stays unlearned is the decision re-run over the grupos as they stand (the memo, plus
 * the overlay under Simular). `divergente` and `variante-disputada` read as `evidencia-divergente`
 * (the claims disagree), every other motivo as `variacao-sem-vinculo`.
 *
 * ## The reads, against the indexes (root rule 1)
 *
 * `grupoDeVariacoes` whole and unfiltered (every grupo is wanted; no index involved); one grupo by
 * id after a lost write; the job's `evidencias` (`evidencias.ts`).
 *
 * ⚠️ Never name the Admin SDK's multi-document read-and-write call here — not even in a comment
 * (`estrutura.test.ts`). Next-free; `db` is a parameter.
 */
import type { Firestore, Timestamp } from 'firebase-admin/firestore';
import { grupoDeVariacoesCollection } from '@delfrance/data/admin/collections';
import { isFailedPrecondition, isNotFound } from '@delfrance/data/admin/grpcErrors';
import {
  type AprendizadoLinkLi,
  type DecisaoAprendizadoLi,
  type EvidenciaAprendizadoLi,
  type GrupoComLinksLi,
  type ImportacaoLojaIntegrada,
  MODO_IMPORTACAO_LI,
  MOTIVO_RECUSA_APRENDIZADO_LI,
  type ModoImportacaoLi,
  type MotivoRecusaAprendizadoLi,
  PENDENCIA_IMPORTACAO_LI,
  decidirAprendizadoLi,
  fundirLinksVariacoesLi,
  idEvidenciaImportacaoLi,
} from '@delfrance/schemas';

import { type EvidenciaDoJobLi, lerEvidenciasDoJobLi } from './evidencias';
import { UNIDADE_IMPORTACAO_LI, type UnidadeImportacaoLi } from './orcamento';

/* -------------------------------------------------------------------------- */
/*                                   The memo                                  */
/* -------------------------------------------------------------------------- */

/** One grupo as the memo holds it (module header, "The memo"). */
export interface GrupoDoMemoLi extends GrupoComLinksLi {
  /** The stamp the next tier-1 write on this grupo is preconditioned on. */
  readonly versao: Timestamp;
}

/** Every grupo, ascending id. */
export type MemoDeGruposLi = readonly GrupoDoMemoLi[];

/** The ids of a stored `variacoes` value: each element's `id` when it is a string, in order. */
function idsDasVariantes(variacoes: unknown): string[] {
  if (!Array.isArray(variacoes)) return [];
  const lista: readonly unknown[] = variacoes;
  const ids: string[] = [];
  for (const v of lista) {
    if (typeof v !== 'object' || v === null) continue;
    const id = (v as Record<string, unknown>).id;
    if (typeof id === 'string') ids.push(id);
  }
  return ids;
}

function grupoDoDocumento(id: string, raw: unknown, versao: Timestamp): GrupoDoMemoLi {
  const dados = (raw ?? {}) as Record<string, unknown>;
  return {
    id,
    variantesIds: idsDasVariantes(dados.variacoes),
    linksVariacoesli: dados.linksVariacoesli,
    versao,
  };
}

const porId = (a: { readonly id: string }, b: { readonly id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** The whole `grupoDeVariacoes` collection (module header, "The memo"). */
export async function lerMemoDeGruposLi(db: Firestore): Promise<MemoDeGruposLi> {
  const snap = await grupoDeVariacoesCollection.ref(db, {}).get();
  return snap.docs.map((d) => grupoDoDocumento(d.id, d.data(), d.updateTime)).sort(porId);
}

/** One grupo, read by id; `null` when it no longer exists. */
async function lerGrupoLi(db: Firestore, id: string): Promise<GrupoDoMemoLi | null> {
  const snap = await grupoDeVariacoesCollection.docRef(db, {}, id).get();
  if (!snap.exists || snap.updateTime === undefined) return null;
  return grupoDoDocumento(id, snap.data(), snap.updateTime);
}

/** The memo with grupo `id` replaced by `grupo`, or dropped when `grupo` is `null`. */
function trocarNoMemo(
  memo: MemoDeGruposLi,
  id: string,
  grupo: GrupoDoMemoLi | null,
): MemoDeGruposLi {
  const resto = memo.filter((g) => g.id !== id);
  return (grupo === null ? resto : [...resto, grupo]).sort(porId);
}

/* -------------------------------------------------------------------------- */
/*                                 The overlay                                 */
/* -------------------------------------------------------------------------- */

/** One learning a Simular stored on its job. */
export type AprendizadoSimuladoLi = ImportacaoLojaIntegrada['aprendizadosSimulados'][number];

/**
 * `grupos` with the simulated learnings of conta `contaId` merged in, through the same never-drop
 * merge a write would use. A grupo whose stored value cannot take a merge is left as it is (the
 * decision never learns into one). Pure.
 */
export function gruposComSimulacaoLi(
  grupos: readonly GrupoComLinksLi[],
  contaId: string,
  simulados: readonly AprendizadoSimuladoLi[],
): GrupoComLinksLi[] {
  return grupos.map((grupo) => {
    const desteGrupo: AprendizadoLinkLi[] = simulados
      .filter((s) => s.grupoId === grupo.id)
      .map((s) => ({
        integracaoLiId: contaId,
        gradeId: s.gradeId,
        opcaoId: s.opcaoId,
        varianteId: s.varianteId,
      }));
    if (desteGrupo.length === 0) return grupo;
    const fusao = fundirLinksVariacoesLi(grupo.linksVariacoesli, desteGrupo);
    return fusao.ok ? { ...grupo, linksVariacoesli: fusao.array } : grupo;
  });
}

/**
 * What a family's options resolve against (module header, "Simular"): the memo, plus the job's
 * simulated learnings under Simular only. Pure.
 */
export function gruposParaResolverLi(
  memo: readonly GrupoComLinksLi[],
  job: Pick<ImportacaoLojaIntegrada, 'modo' | 'integracaoId' | 'aprendizadosSimulados'>,
): GrupoComLinksLi[] {
  if (job.modo !== MODO_IMPORTACAO_LI.simular) return [...memo];
  return gruposComSimulacaoLi(memo, job.integracaoId, job.aprendizadosSimulados);
}

/* -------------------------------------------------------------------------- */
/*                                The decision                                 */
/* -------------------------------------------------------------------------- */

/** The job's claim documents as the shared decision reads them. Pure. */
export function evidenciasParaAprenderLi(
  evidencias: readonly EvidenciaDoJobLi[],
): EvidenciaAprendizadoLi[] {
  return evidencias.map(({ evidencia }) => ({
    gradeId: evidencia.gradeId,
    opcaoId: evidencia.opcaoId,
    alegacoes: evidencia.alegacoes.map((a) => ({
      grupoId: a.grupoId,
      varianteId: a.varianteId,
      todasDeEixoUnico: a.todasDeEixoUnico,
    })),
    nomeGrade: evidencia.nomeGrade,
    nomeOpcao: evidencia.nomeOpcao,
  }));
}

/**
 * Why each option of the job's evidence stays unlearned, keyed by its claim document id
 * (`<gradeId>_<opcaoId>`): the decision re-run over `grupos` as they stand (module header, "For the
 * report"). An option absent from the map is learned, already linked, or has no claim. Pure.
 */
export function recusasDoAprendizadoLi(
  contaId: string,
  evidencias: readonly EvidenciaDoJobLi[],
  grupos: readonly GrupoComLinksLi[],
): ReadonlyMap<string, MotivoRecusaAprendizadoLi> {
  const decisao = decidirAprendizadoLi({
    contaId,
    evidencias: evidenciasParaAprenderLi(evidencias),
    grupos,
  });
  return new Map(
    decisao.recusados.map((r) => [idEvidenciaImportacaoLi(r.gradeId, r.opcaoId), r.motivo]),
  );
}

/** The report's pendência for a refused learning (module header, "For the report"). Pure. */
export function pendenciaDaRecusaLi(
  motivo: MotivoRecusaAprendizadoLi,
):
  | typeof PENDENCIA_IMPORTACAO_LI.evidenciaDivergente
  | typeof PENDENCIA_IMPORTACAO_LI.variacaoSemVinculo {
  return motivo === MOTIVO_RECUSA_APRENDIZADO_LI.divergente ||
    motivo === MOTIVO_RECUSA_APRENDIZADO_LI.varianteDisputada
    ? PENDENCIA_IMPORTACAO_LI.evidenciaDivergente
    : PENDENCIA_IMPORTACAO_LI.variacaoSemVinculo;
}

/* -------------------------------------------------------------------------- */
/*                               The aprendizado phase                         */
/* -------------------------------------------------------------------------- */

/** The phase is ONE unit that calls nothing outside the ERP (module header). */
export const UNIDADE_DO_APRENDIZADO_LI: UnidadeImportacaoLi = UNIDADE_IMPORTACAO_LI.familia;

export interface DepsAprendizadoLi {
  readonly db: Firestore;
  readonly jobId: string;
  /** The Loja Integrada conta (integração doc id) — the BARE id the links carry. */
  readonly contaId: string;
  readonly modo: ModoImportacaoLi;
  /** The grupo's `ultimaModificacao` stamp (ms). */
  readonly agoraMs: () => number;
}

/** One option link learned (or, under Simular, that would be). */
export interface AprendidoLi {
  readonly gradeId: number;
  readonly opcaoId: number;
  readonly grupoId: string;
  readonly varianteId: string;
}

/** One option left unlearned: the decision's motivo, or a write that lost twice. */
export interface RecusaDoAprendizadoLi {
  readonly gradeId: number;
  readonly opcaoId: number;
  readonly motivo: MotivoRecusaAprendizadoLi | typeof PENDENCIA_IMPORTACAO_LI.conflitoDeEscrita;
}

export interface ResultadoDoAprendizadoLi {
  /** The checkpoint's cursor: the last claim document decided (key order), `null` with none. */
  readonly aprendizado: ImportacaoLojaIntegrada['aprendizado'];
  /** Simular: the checkpoint's overlay. `aplicar`: always empty (the grupos carry it). */
  readonly aprendizadosSimulados: readonly AprendizadoSimuladoLi[];
  /** The memo after the phase's writes (their `writeTime`s), for the rest of the dispatch. */
  readonly memo: MemoDeGruposLi;
  readonly aprendidos: readonly AprendidoLi[];
  readonly recusados: readonly RecusaDoAprendizadoLi[];
  /** Options the claims name that their grupo already links (nothing to learn). */
  readonly jaVinculadas: number;
  /** The grupos written (`aplicar`), in write order. */
  readonly gruposGravados: readonly string[];
}

/** One tier-1 write of a grupo's whole merged links (module header). */
async function gravarGrupo(
  deps: DepsAprendizadoLi,
  grupo: GrupoDoMemoLi,
  links: readonly unknown[],
): Promise<Timestamp | null> {
  try {
    const { writeTime } = await grupoDeVariacoesCollection
      .docRef(deps.db, {}, grupo.id)
      .update(
        { linksVariacoesli: links, ultimaModificacao: deps.agoraMs() },
        { lastUpdateTime: grupo.versao },
      );
    return writeTime;
  } catch (err) {
    if (!isFailedPrecondition(err) && !isNotFound(err)) throw err;
    return null;
  }
}

const doGrupo = (decisao: DecisaoAprendizadoLi, grupoId: string): AprendidoLi[] =>
  decisao.aprendidos
    .filter((a) => a.grupoId === grupoId)
    .map(({ gradeId, opcaoId, varianteId }) => ({ gradeId, opcaoId, grupoId, varianteId }));

/**
 * Run the `aprendizado` phase (module header): decide over every claim of the job and `memo`
 * (read by the caller in this dispatch), then write — or, under Simular, return — the learnings.
 */
export async function executarAprendizadoLi(
  deps: DepsAprendizadoLi,
  memo: MemoDeGruposLi,
): Promise<ResultadoDoAprendizadoLi> {
  const lidas = await lerEvidenciasDoJobLi(deps.db, deps.jobId);
  const evidencias = evidenciasParaAprenderLi(lidas);
  const aprendizado = { cursorEvidenciaId: lidas.at(-1)?.id ?? null };
  const decidir = (grupos: MemoDeGruposLi): DecisaoAprendizadoLi =>
    decidirAprendizadoLi({ contaId: deps.contaId, evidencias, grupos });
  const primeira = decidir(memo);

  if (deps.modo === MODO_IMPORTACAO_LI.simular) {
    // In decision order: the overlay re-applies them in that order through the same merge.
    const aprendidos = primeira.aprendidos.map(({ gradeId, opcaoId, grupoId, varianteId }) => ({
      gradeId,
      opcaoId,
      grupoId,
      varianteId,
    }));
    return {
      aprendizado,
      aprendizadosSimulados: aprendidos,
      memo,
      aprendidos,
      recusados: primeira.recusados,
      jaVinculadas: primeira.jaVinculadas.length,
      gruposGravados: [],
    };
  }

  let atual = memo;
  const aprendidos: AprendidoLi[] = [];
  const recusados: RecusaDoAprendizadoLi[] = [...primeira.recusados];
  const gruposGravados: string[] = [];
  for (const { grupoId, linksVariacoesli } of primeira.grupos) {
    const grupo = atual.find((g) => g.id === grupoId);
    if (grupo === undefined) continue; // the decision only changes grupos of the memo
    const versao = await gravarGrupo(deps, grupo, linksVariacoesli);
    if (versao !== null) {
      atual = trocarNoMemo(atual, grupoId, { ...grupo, linksVariacoesli, versao });
      aprendidos.push(...doGrupo(primeira, grupoId));
      gruposGravados.push(grupoId);
      continue;
    }

    // Lost: re-read THIS grupo and re-decide once over the memo as it now stands.
    const fresco = await lerGrupoLi(deps.db, grupoId);
    atual = trocarNoMemo(atual, grupoId, fresco);
    const segunda = decidir(atual);
    for (const r of segunda.recusados) {
      const eraDesteGrupo = doGrupo(primeira, grupoId).some(
        (a) => a.gradeId === r.gradeId && a.opcaoId === r.opcaoId,
      );
      if (eraDesteGrupo) recusados.push(r);
    }
    const entrada = segunda.grupos.find((g) => g.grupoId === grupoId);
    if (fresco === null || entrada === undefined) continue;
    const versao2 = await gravarGrupo(deps, fresco, entrada.linksVariacoesli);
    if (versao2 === null) {
      // A second loss: reported, never forced. The next dispatch re-reads the memo.
      for (const a of doGrupo(segunda, grupoId)) {
        recusados.push({
          gradeId: a.gradeId,
          opcaoId: a.opcaoId,
          motivo: PENDENCIA_IMPORTACAO_LI.conflitoDeEscrita,
        });
      }
      continue;
    }
    atual = trocarNoMemo(atual, grupoId, {
      ...fresco,
      linksVariacoesli: entrada.linksVariacoesli,
      versao: versao2,
    });
    aprendidos.push(...doGrupo(segunda, grupoId));
    gruposGravados.push(grupoId);
  }

  return {
    aprendizado,
    aprendizadosSimulados: [],
    memo: atual,
    aprendidos,
    recusados,
    jaVinculadas: primeira.jaVinculadas.length,
    gruposGravados,
  };
}
