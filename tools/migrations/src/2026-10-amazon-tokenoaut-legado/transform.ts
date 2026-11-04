/**
 * Pure decision for the legacy `tokenoaut` deletion. No Firestore here: see
 * `migrate.ts` for the I/O and `tools/migrations/amazon-tokenoaut-legado.README.md`
 * for the runbook.
 *
 * `integracao/{contaId}/tokenoaut/{docId}` is where the legacy app kept its
 * Amazon LWA token documents, live refresh token included. This codebase never
 * models that subcollection and nothing reads it: the Amazon credential this app
 * uses lives in the generic admin-only `integracao/{id}/credenciais/current`
 * (Amazon step 2). So once the data has moved, every `tokenoaut` document is a
 * credential with no reader, and window item W3 deletes them all.
 *
 * ⚠️ **Nothing in this module ever handles a token document's CONTENT.** The plan
 * is decided from the parent's existence, its `tipo` and a COUNT of the
 * subcollection, never from a field of a token document, so no caller can log,
 * print or serialize a credential by accident. The deletion is the same for a
 * document whatever it holds (`revoked: true` and `revoked: false` alike).
 */

/** The parent collection whose documents are walked. */
export const COLECAO_PAI = 'integracao';

/**
 * The ONLY subcollection this migration touches, matched by its exact name.
 * Its near-misses (`tokenOaut`, `tokenoauth`, `token6h`, `tokenDuravel`,
 * `credenciais`, …) are other stores, and some of them are live: the script
 * never enumerates a parent's subcollections, it addresses this one by name.
 */
export const SUBCOLECAO_LEGADA = 'tokenoaut';

/** Page size of the key walk; one page is one batch of deletes (Firestore caps a batch at 500). */
export const TAMANHO_DA_PAGINA = 300;

/** The `field` column of a JSONL row: the whole document goes, not one field of it. */
export const ROTULO_DO_REGISTRO = 'documento';

/**
 * How a parent is reported:
 *  - its `tipo` when that is a finite number;
 *  - `'orfa'` when the parent document does not exist (a conta deleted without
 *    its subcollections: `listDocuments()` still returns it, and its token
 *    documents are exactly the ones a walk over existing contas would miss);
 *  - `'desconhecido'` when the parent exists but its `tipo` is not a number.
 */
export type TipoRelatorio = number | 'orfa' | 'desconhecido';

export interface EntradaDaConta {
  /** Whether the `integracao` document itself exists. */
  readonly existe: boolean;
  /** The parent's stored `tipo`, as read (only meaningful when `existe`). */
  readonly tipo: unknown;
  /** `count()` of the parent's `tokenoaut` subcollection. */
  readonly contagem: number;
}

export interface PlanoDaConta {
  readonly acao: 'apagar' | 'nada';
  readonly tipoRelatorio: TipoRelatorio;
}

/** A `count()` that is not a non-negative safe integer: an I/O bug, never a plan input. */
export class ContagemTokenoautInvalidaError extends Error {
  constructor(contagem: number) {
    super(`contagem de ${SUBCOLECAO_LEGADA} inválida: ${String(contagem)}`);
    this.name = 'ContagemTokenoautInvalidaError';
  }
}

function tipoRelatorioDe(existe: boolean, tipo: unknown): TipoRelatorio {
  if (!existe) return 'orfa';
  return typeof tipo === 'number' && Number.isFinite(tipo) ? tipo : 'desconhecido';
}

/**
 * Decide what to do with one parent.
 *
 * Every `tokenoaut` document goes, whatever the parent's `tipo` and whether the
 * parent still exists: the subcollection is a legacy credential store with no
 * reader, so its presence is the whole test. The parent document itself is never
 * part of the plan.
 *
 * **Idempotent by construction**: once the subcollection is empty the count is
 * 0 and the plan is `nada`, so a second pass reports zero.
 */
export function planoDaConta(entrada: EntradaDaConta): PlanoDaConta {
  const { existe, tipo, contagem } = entrada;
  if (!Number.isSafeInteger(contagem) || contagem < 0) {
    throw new ContagemTokenoautInvalidaError(contagem);
  }
  return { acao: contagem > 0 ? 'apagar' : 'nada', tipoRelatorio: tipoRelatorioDe(existe, tipo) };
}

/**
 * The `from` / `to` pair for one deleted document's JSONL row. The row's `path`
 * names the document and `from.tipo` names its parent's type; nothing the
 * document holds is part of it, by construction.
 */
export function descreverRemocao(tipoRelatorio: TipoRelatorio): {
  from: { tipo: TipoRelatorio };
  to: 'apagado';
} {
  return { from: { tipo: tipoRelatorio }, to: 'apagado' };
}

export interface LinhaDoRelatorio {
  /** Parents carrying at least one `tokenoaut` document. */
  contas: number;
  /** `tokenoaut` documents under those parents. */
  documentos: number;
}

/** The report key of a parent: its `tipo` as text, or `'orfa'` / `'desconhecido'`. */
export function chaveDoRelatorio(tipoRelatorio: TipoRelatorio): string {
  return typeof tipoRelatorio === 'number' ? String(tipoRelatorio) : tipoRelatorio;
}

/**
 * Per-tipo census of the parents that carry `tokenoaut` documents. Parents whose
 * plan is `nada` are not counted, so the post-apply census is an EMPTY map.
 */
export function contarPorTipo(
  linhas: ReadonlyArray<{ plano: PlanoDaConta; contagem: number }>,
): Map<string, LinhaDoRelatorio> {
  const tally = new Map<string, LinhaDoRelatorio>();
  for (const { plano, contagem } of linhas) {
    if (plano.acao !== 'apagar') continue;
    const chave = chaveDoRelatorio(plano.tipoRelatorio);
    const atual = tally.get(chave) ?? { contas: 0, documentos: 0 };
    tally.set(chave, { contas: atual.contas + 1, documentos: atual.documentos + contagem });
  }
  return tally;
}
