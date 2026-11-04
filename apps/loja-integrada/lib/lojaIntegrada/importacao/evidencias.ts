/**
 * The product import's EVIDENCE pass (master plan step 9, phase `evidencias`): which store option is
 * which ERP variante, as the products both sides already share by EXACT SKU prove it. Claims only:
 * nothing is learned here. The `aprendizado` phase (`gruposLi.ts`) learns a link only when EVERY
 * claim the whole job collected for an option agrees, so the first family processed never wins a
 * disagreement — which is why this pass runs over every family BEFORE anything is learned.
 *
 * ## One family per unit, no Loja Integrada call
 *
 * Families come from the job's assembly (`familias.ts`): every store PARENT with at least one
 * attached variation, in ascending store id above the cursor (`familias.cursorPaiId`, the same
 * cursor the `familias` phase reuses, reset between the two). The whole store takes part whatever
 * the job's target: a claim from a family the operator did not select is still evidence, and
 * unanimity over more families is the safer verdict. Per family:
 *
 *  1. the root's match (`resolverRaizLi`): only a family matched to ONE ERP family (`vinculado` or
 *     `encontrado`, shapes agreeing) has ERP variations to compare with;
 *  2. the variations' rungs (`resolverFilhosLi`), over the grupos the caller passes (the dispatch's
 *     memo — the overlay is empty this early);
 *  3. a store variation matched to an ERP child BY EXACT SKU — through rung 2, or through its own
 *     link whose ERP child carries the same SKU (`mesmoSkuLi`) — gives, for each of its options NOT
 *     already resolved, a claim "`(conta, grade, opção)` = variante X of grupo G", with G and X read
 *     from that ERP child's `variacoesUid` fake paths ({@link alegacoesDaFamiliaLi}):
 *     - an option whose grade is linked in G but which is not (`opcao-sem-vinculo`): X is the ERP
 *       child's ONE variante of G;
 *     - an option whose grade is linked nowhere (`grade-sem-vinculo`): only when it is the
 *       variation's ONLY such option, every other option is resolved or linked by grade, and the ERP
 *       child has exactly ONE grupo left unaccounted for, holding ONE of its variantes — that
 *       grupo and variante. The claim records whether the family has ONE axis on both sides
 *       (`todasDeEixoUnico`): the decision learns a NEW grade only from those;
 *     - any other verdict (an unreadable option, a grade or option linked twice, an option already
 *       standing for two variantes) gives no claim: learning cannot settle a conflict.
 *     A variation matched by COMBINATION gives none (its options already resolved), nor does one
 *     whose SKU another store row repeats, nor one whose ERP child's taxonomy does not read whole.
 *  4. the claims written to `evidencias/{gradeId}_{opcaoId}` — one document per store option,
 *     holding one entry per DISTINCT `(grupo, variante)` claimed, never one per variation, so a
 *     popular option cannot grow its document without bound.
 *
 * A variation never seen as a row and not detail-read yet (`semDetalhe`) has no view and gives no
 * claim; the owner's capture listed every variation a parent claims as a row.
 *
 * ## The writes (root rule 7, tier 0)
 *
 * Each claim document is read by id, merged with this family's claims ({@link fundirAlegacoesLi})
 * and written WHOLE at its deterministic id. Its only writer is this job's own dispatch (the reads
 * queue runs one task at a time, and every dispatch checks the job's `seq`), so nothing can land
 * between the read and the write. A unit retried after its writes landed but before its checkpoint
 * merges the same claims again: the distinct pairs and the single-axis flag (an AND) come out the
 * same, and only `ocorrencias` — a report count no decision reads — counts that family twice.
 *
 * ## The reads, against the indexes (root rule 1)
 *
 * The cascade's (its own header); a claim document by id; {@link lerEvidenciasDoJobLi} reads the
 * job's `evidencias` whole in document-key order — no filter, no composite, bounded by the store's
 * distinct options.
 *
 * ⚠️ Never name the Admin SDK's multi-document read-and-write call here — not even in a comment
 * (`estrutura.test.ts`). Next-free; `db` is a parameter.
 */
import { FieldPath, type Firestore } from 'firebase-admin/firestore';
import { evidenciaImportacaoLiCollection } from '@delfrance/data/admin/collections';
import {
  type EvidenciaOpcaoLi,
  type GrupoComLinksLi,
  type ImportacaoLojaIntegrada,
  SITUACAO_ERP_ITEM_LI,
  TIPO_PRODUTO_LI,
  TIPO_RESOLUCAO_OPCAO_LI,
  evidenciaOpcaoLiSchema,
  idEvidenciaImportacaoLi,
  mesmoSkuLi,
  parseFakePath,
} from '@delfrance/schemas';

import type { FamiliaLi, MontagemLi } from './familias';
import { UNIDADE_IMPORTACAO_LI, type UnidadeImportacaoLi } from './orcamento';
import {
  type DepsResolucaoLi,
  type ProdutoErpLi,
  type ResolucaoDaRaizLi,
  type ResolucaoDoFilhoLi,
  type ResolucaoDosFilhosLi,
  SITUACAO_DO_FILHO_LI,
  VIA_DO_FILHO_LI,
  resolverFilhosLi,
  resolverRaizLi,
} from './resolucao';

/** One claim of one matched store variation. */
export interface AlegacaoDaFamiliaLi {
  readonly gradeId: number;
  readonly opcaoId: number;
  readonly grupoId: string;
  readonly varianteId: string;
  /** The family has ONE axis on both sides (module header, step 3). */
  readonly eixoUnico: boolean;
  /** The store variation and the ERP child it was matched to by exact SKU. */
  readonly liFilhoId: number;
  readonly erpFilhoId: string;
}

/* -------------------------------------------------------------------------- */
/*                                  The claims                                 */
/* -------------------------------------------------------------------------- */

/** An ERP child's variantes, from its fake paths; `null` when any path does not read. */
function variantesDoErp(erp: ProdutoErpLi): { grupoId: string; varianteId: string }[] | null {
  const lidas: { grupoId: string; varianteId: string }[] = [];
  for (const caminho of erp.variacoesUid ?? []) {
    const lida = parseFakePath(caminho);
    if (lida === null) return null;
    lidas.push(lida);
  }
  return lidas;
}

/**
 * Whether the family has ONE axis on BOTH sides: every store variation carries exactly one readable
 * option, all of one grade; every ERP child exactly one variante, all of one grupo. Pure.
 */
export function eixoUnicoDaFamiliaLi(
  familia: Pick<FamiliaLi, 'filhos'>,
  erpFilhos: readonly ProdutoErpLi[],
): boolean {
  const grades = new Set<number>();
  for (const { linha } of familia.filhos) {
    const [opcao, ...resto] = linha.opcoes;
    if (opcao === undefined || resto.length > 0 || linha.ilegiveis.opcoes > 0) return false;
    grades.add(opcao.gradeId);
  }
  const grupos = new Set<string>();
  for (const erp of erpFilhos) {
    const variantes = variantesDoErp(erp);
    const [variante, ...resto] = variantes ?? [];
    if (variante === undefined || resto.length > 0) return false;
    grupos.add(variante.grupoId);
  }
  return grades.size === 1 && grupos.size === 1;
}

/** Was this variation matched to its ERP child by EXACT SKU (module header, step 3)? */
function casadoPorSku(
  r: ResolucaoDoFilhoLi,
  sku: string | null,
  skusRepetidos: ReadonlySet<string>,
): r is ResolucaoDoFilhoLi & { readonly erp: ProdutoErpLi } {
  if (r.situacao !== SITUACAO_DO_FILHO_LI.casado || r.erp === null || sku === null) return false;
  if (skusRepetidos.has(sku)) return false;
  if (r.via !== VIA_DO_FILHO_LI.sku && r.via !== VIA_DO_FILHO_LI.vinculo) return false;
  return mesmoSkuLi(sku, r.erp.sku);
}

/** The claims of ONE variation matched by exact SKU (module header, step 3). */
function alegacoesDoFilho(
  r: ResolucaoDoFilhoLi & { readonly erp: ProdutoErpLi },
  eixoUnico: boolean,
): AlegacaoDaFamiliaLi[] {
  const variantes = variantesDoErp(r.erp);
  if (variantes === null) return [];
  const alegar = (
    gradeId: number,
    opcaoId: number,
    grupoId: string,
    varianteId: string,
  ): AlegacaoDaFamiliaLi => ({
    gradeId,
    opcaoId,
    grupoId,
    varianteId,
    eixoUnico,
    liFilhoId: r.liId,
    erpFilhoId: r.erp.id,
  });
  const doGrupo = (grupoId: string) => variantes.filter((v) => v.grupoId === grupoId);

  // The grupos the variation's other options already account for.
  const contabilizados = new Set<string>();
  let semGrade = 0;
  let outras = 0;
  for (const o of r.opcoes) {
    if (
      (o.tipo === TIPO_RESOLUCAO_OPCAO_LI.resolvida ||
        o.tipo === TIPO_RESOLUCAO_OPCAO_LI.opcaoSemVinculo) &&
      o.grupoIds.length === 1
    ) {
      contabilizados.add(o.grupoIds[0]!);
    } else if (o.tipo === TIPO_RESOLUCAO_OPCAO_LI.gradeSemVinculo) {
      semGrade += 1;
    } else {
      outras += 1;
    }
  }

  const alegacoes: AlegacaoDaFamiliaLi[] = [];
  for (const o of r.opcoes) {
    if (o.gradeId === null || o.opcaoId === null) continue;
    if (o.tipo === TIPO_RESOLUCAO_OPCAO_LI.opcaoSemVinculo && o.grupoIds.length === 1) {
      const [unica, ...resto] = doGrupo(o.grupoIds[0]!);
      if (unica !== undefined && resto.length === 0) {
        alegacoes.push(alegar(o.gradeId, o.opcaoId, unica.grupoId, unica.varianteId));
      }
    } else if (
      o.tipo === TIPO_RESOLUCAO_OPCAO_LI.gradeSemVinculo &&
      semGrade === 1 &&
      outras === 0
    ) {
      const restantes = [...new Set(variantes.map((v) => v.grupoId))].filter(
        (g) => !contabilizados.has(g),
      );
      const [grupoId, ...outrosGrupos] = restantes;
      if (grupoId === undefined || outrosGrupos.length > 0) continue;
      const [unica, ...resto] = doGrupo(grupoId);
      if (unica !== undefined && resto.length === 0) {
        alegacoes.push(alegar(o.gradeId, o.opcaoId, unica.grupoId, unica.varianteId));
      }
    }
  }
  return alegacoes;
}

/**
 * The claims one matched family gives (module header, step 3): ordered by grade, option, then the
 * store variation. Pure — the resolutions come from `resolverFilhosLi`.
 */
export function alegacoesDaFamiliaLi(
  familia: Pick<FamiliaLi, 'filhos'>,
  filhos: ResolucaoDosFilhosLi,
  skusRepetidos: ReadonlySet<string>,
): AlegacaoDaFamiliaLi[] {
  const eixoUnico = eixoUnicoDaFamiliaLi(familia, filhos.erpFilhos);
  const skuDe = new Map(familia.filhos.map((f) => [f.linha.id, f.linha.sku]));
  const alegacoes: AlegacaoDaFamiliaLi[] = [];
  for (const r of filhos.filhos) {
    if (!casadoPorSku(r, skuDe.get(r.liId) ?? null, skusRepetidos)) continue;
    alegacoes.push(...alegacoesDoFilho(r, eixoUnico));
  }
  return alegacoes.sort(
    (a, b) => a.gradeId - b.gradeId || a.opcaoId - b.opcaoId || a.liFilhoId - b.liFilhoId,
  );
}

/* -------------------------------------------------------------------------- */
/*                               The claim documents                           */
/* -------------------------------------------------------------------------- */

/**
 * One option's stored claims with `novas` merged in (module header, "The writes"): a pair already
 * there — keyed by its EXACT `(grupoId, varianteId)` — gains its occurrences and keeps its
 * single-axis flag only while every new claim of it is single-axis too; a new pair is appended.
 * Labels are kept as stored. Pure.
 */
export function fundirAlegacoesLi(
  gradeId: number,
  opcaoId: number,
  armazenada: EvidenciaOpcaoLi | null,
  novas: readonly AlegacaoDaFamiliaLi[],
): EvidenciaOpcaoLi {
  const alegacoes = (armazenada?.alegacoes ?? []).map((a) => ({ ...a }));
  for (const n of novas) {
    if (n.gradeId !== gradeId || n.opcaoId !== opcaoId) continue;
    const par = alegacoes.find((a) => a.grupoId === n.grupoId && a.varianteId === n.varianteId);
    if (par !== undefined) {
      par.ocorrencias += 1;
      par.todasDeEixoUnico = par.todasDeEixoUnico && n.eixoUnico;
    } else {
      alegacoes.push({
        grupoId: n.grupoId,
        varianteId: n.varianteId,
        ocorrencias: 1,
        todasDeEixoUnico: n.eixoUnico,
        exemploLiFilhoId: n.liFilhoId,
        exemploErpFilhoId: n.erpFilhoId,
      });
    }
  }
  return {
    gradeId,
    opcaoId,
    alegacoes,
    nomeGrade: armazenada?.nomeGrade ?? null,
    nomeOpcao: armazenada?.nomeOpcao ?? null,
  };
}

/** Merge `alegacoes` into the job's claim documents (module header, "The writes"). */
export async function gravarAlegacoesLi(
  db: Firestore,
  jobId: string,
  alegacoes: readonly AlegacaoDaFamiliaLi[],
): Promise<number> {
  const porOpcao = new Map<string, AlegacaoDaFamiliaLi[]>();
  for (const a of alegacoes) {
    const id = idEvidenciaImportacaoLi(a.gradeId, a.opcaoId);
    porOpcao.set(id, [...(porOpcao.get(id) ?? []), a]);
  }
  for (const [id, novas] of porOpcao) {
    const { gradeId, opcaoId } = novas[0]!;
    const snap = await evidenciaImportacaoLiCollection.docRef(db, { jobId }, id).get();
    // Written only through its schema, so one that does not parse is corruption (a ZodError).
    const armazenada = snap.exists ? evidenciaOpcaoLiSchema.parse(snap.data()) : null;
    await evidenciaImportacaoLiCollection.set(
      db,
      { jobId },
      id,
      fundirAlegacoesLi(gradeId, opcaoId, armazenada, novas),
    );
  }
  return porOpcao.size;
}

/** One claim document of the job, with its id. */
export interface EvidenciaDoJobLi {
  readonly id: string;
  readonly evidencia: EvidenciaOpcaoLi;
}

/** Every claim document of job `jobId`, in document-key order, each parsed strictly. */
export async function lerEvidenciasDoJobLi(
  db: Firestore,
  jobId: string,
): Promise<EvidenciaDoJobLi[]> {
  const snap = await evidenciaImportacaoLiCollection
    .ref(db, { jobId })
    .orderBy(FieldPath.documentId())
    .get();
  return snap.docs.map((d) => ({ id: d.id, evidencia: evidenciaOpcaoLiSchema.parse(d.data()) }));
}

/* -------------------------------------------------------------------------- */
/*                                  The phase                                  */
/* -------------------------------------------------------------------------- */

type CursorFamiliasLi = ImportacaoLojaIntegrada['familias'];

/** Every unit of this phase calls nothing outside the ERP (module header). */
export const UNIDADE_DAS_EVIDENCIAS_LI: UnidadeImportacaoLi = UNIDADE_IMPORTACAO_LI.familia;

/** The families the pass visits: store parents with at least one attached variation, ascending. */
export function familiasComVariacoesLi(montagem: MontagemLi): FamiliaLi[] {
  return montagem.familias
    .filter((f) => f.raiz.tipo === TIPO_PRODUTO_LI.atributo && f.filhos.length > 0)
    .sort((a, b) => a.raiz.id - b.raiz.id);
}

/** The first family above the cursor, or `null` when the pass is done. Pure. */
export function proximaFamiliaDasEvidenciasLi(
  montagem: MontagemLi,
  cursor: CursorFamiliasLi,
): FamiliaLi | null {
  const { cursorPaiId } = cursor;
  return (
    familiasComVariacoesLi(montagem).find((f) => cursorPaiId === null || f.raiz.id > cursorPaiId) ??
    null
  );
}

export interface DepsEvidenciasLi extends DepsResolucaoLi {
  readonly jobId: string;
}

/** How one unit of the `evidencias` phase ended. */
export type PassoDasEvidenciasLi =
  /** One family visited; `familias` is the new cursor. */
  | {
      readonly tipo: 'familia';
      readonly liId: number;
      readonly familias: CursorFamiliasLi;
      readonly raiz: ResolucaoDaRaizLi;
      /** Claims this family gave, and the claim documents they were merged into. */
      readonly alegacoes: number;
      readonly documentos: number;
    }
  /** No family left above the cursor: the phase is done (the dispatch moves to `aprendizado`). */
  | { readonly tipo: 'concluido' };

/**
 * Run the `evidencias` phase's next unit: the next family above the cursor (module header).
 * `montagem` and `skusRepetidos` come from the job's snapshot (computed once per dispatch);
 * `grupos` is the dispatch's grupo memo.
 */
export async function executarUnidadeDasEvidenciasLi(
  deps: DepsEvidenciasLi,
  contexto: {
    readonly montagem: MontagemLi;
    readonly grupos: readonly GrupoComLinksLi[];
    readonly skusRepetidos: ReadonlySet<string>;
  },
  cursor: CursorFamiliasLi,
): Promise<PassoDasEvidenciasLi> {
  const familia = proximaFamiliaDasEvidenciasLi(contexto.montagem, cursor);
  if (familia === null) return { tipo: 'concluido' };
  const proximo: CursorFamiliasLi = { cursorPaiId: familia.raiz.id, filhosLidos: [] };

  const raiz = await resolverRaizLi(deps, familia, contexto.skusRepetidos);
  if (
    raiz.tipo !== SITUACAO_ERP_ITEM_LI.vinculado &&
    raiz.tipo !== SITUACAO_ERP_ITEM_LI.encontrado
  ) {
    return {
      tipo: 'familia',
      liId: familia.raiz.id,
      familias: proximo,
      raiz,
      alegacoes: 0,
      documentos: 0,
    };
  }
  const filhos = await resolverFilhosLi(deps, familia, raiz.erpId, {
    grupos: contexto.grupos,
    skusRepetidos: contexto.skusRepetidos,
  });
  const alegacoes = alegacoesDaFamiliaLi(familia, filhos, contexto.skusRepetidos);
  const documentos = await gravarAlegacoesLi(deps.db, deps.jobId, alegacoes);
  return {
    tipo: 'familia',
    liId: familia.raiz.id,
    familias: proximo,
    raiz,
    alegacoes: alegacoes.length,
    documentos,
  };
}
