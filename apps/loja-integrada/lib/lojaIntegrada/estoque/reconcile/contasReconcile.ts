/**
 * The daily stock reconcile's UNCACHED re-read of its contas (master plan step 12, PR 12-g): the
 * queue phase (before each of its slices) and the end phase read every conta of the run again by
 * id, because a run lasts hours and each send run reads the conta's CURRENT depósito. A conta whose
 * depósito moved since the take — or that is gone, no longer a Loja Integrada conta, or inactive —
 * is NOT the conta the snapshot was built for, so nothing of the run is sent for it, and its
 * avisos are left to the next run.
 *
 * ONE `getAll` per call, by id (point reads, no index), never `contaCache.ts`: what it decides is a
 * send. The depósito is folded by the shared reader (`depositoDaContaLi`, either stored form), and
 * compared with the bare id the take fixed in the conta's root (`execucao.depositoId`) EXACTLY.
 *
 * Equal (available): the take fixed `D1`, the conta now holds `documents/depositos/D1` or
 * `depositos/D1`. Distinct (`deposito-mudou`): it holds `documents/depositos/D2`, or no depósito.
 *
 * Next-free, `db` a parameter. Every line elsewhere carries ids only; this module logs nothing.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { integracaoCollection } from '@delfrance/data/admin/collections';
import { INTEGRACAO_TIPO, depositoDaContaLi } from '@delfrance/schemas';

import { relogioDoDocumentoUs } from '../../avisos/avisos';

/** One conta of the run, as read now. */
export interface ContaRevistaLi {
  readonly contaId: string;
  /** The document exists AND is a Loja Integrada conta. */
  readonly existe: boolean;
  /** `false` only when the document says so explicitly (the listing's rule). */
  readonly ativo: boolean;
  /** Its depósito as a bare id (`depositoDaContaLi`), or `null`. */
  readonly depositoId: string | null;
  /** The operator-facing store name (`''` when not a string). */
  readonly nome: string;
  /** µs of the read's `updateTime` (`null` when absent): names the depósito re-run. */
  readonly versaoUs: number | null;
}

/** Why a conta is not the one the run's snapshot was built for. */
export type IndisponibilidadeContaLi = 'conta-ausente' | 'conta-inativa' | 'deposito-mudou';

/** Named members of {@link IndisponibilidadeContaLi}. */
export const INDISPONIBILIDADE_CONTA_LI = {
  ausente: 'conta-ausente',
  inativa: 'conta-inativa',
  depositoMudou: 'deposito-mudou',
} as const satisfies Record<string, IndisponibilidadeContaLi>;

/** Every conta of `contaIds`, read now, by id, in ONE `getAll` (module header). */
export async function reverContasDoRunLi(
  db: Firestore,
  contaIds: readonly string[],
): Promise<Map<string, ContaRevistaLi>> {
  const revistas = new Map<string, ContaRevistaLi>();
  if (contaIds.length === 0) return revistas;
  const snaps = await db.getAll(...contaIds.map((id) => integracaoCollection.docRef(db, {}, id)));
  contaIds.forEach((contaId, n) => {
    const snap = snaps[n];
    const dados: Readonly<Record<string, unknown>> | undefined = snap?.exists
      ? (snap.data() as Record<string, unknown> | undefined)
      : undefined;
    const existe = dados !== undefined && dados.tipo === INTEGRACAO_TIPO.lojaIntegrada;
    revistas.set(contaId, {
      contaId,
      existe,
      ativo: existe && dados.ativo !== false,
      depositoId: existe ? depositoDaContaLi(dados) : null,
      nome: existe && typeof dados.nome === 'string' ? dados.nome : '',
      versaoUs:
        snap?.exists === true && snap.updateTime !== undefined
          ? relogioDoDocumentoUs(snap.updateTime)
          : null,
    });
  });
  return revistas;
}

/**
 * Why `conta` is not the conta the run fixed at `depositoDoRun`, or `null` when it is (module
 * header). Pure. Absent from the map counts as gone.
 */
export function indisponibilidadeDaContaLi(
  conta: ContaRevistaLi | undefined,
  depositoDoRun: string,
): IndisponibilidadeContaLi | null {
  if (conta === undefined || !conta.existe) return INDISPONIBILIDADE_CONTA_LI.ausente;
  if (!conta.ativo) return INDISPONIBILIDADE_CONTA_LI.inativa;
  if (conta.depositoId !== depositoDoRun) return INDISPONIBILIDADE_CONTA_LI.depositoMudou;
  return null;
}
