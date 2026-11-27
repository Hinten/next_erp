/**
 * The daily reconcile's UNCACHED re-reads of the contas for its PRICE arm (master plan step 13, PR
 * 13-f1): is a conta still the one the run priced? The price twin of `contasReconcile.ts`, apart
 * from it so `ContaRevistaLi`'s keys never move (its own suite compares them exactly).
 *
 * ## The tabelas a run prices with ({@link tabelasDobradasLi}, pure)
 *
 * A conta names its tabelas by ref (`tabelasDaContaLi`, either stored form). A run prices with them
 * FOLDED: the normal one, and the promotional one — `null` when the conta names none OR names its
 * normal one again ("no promo list": the same pricing, spelled two ways). No normal tabela ⇒ the
 * conta is not priced at all.
 *
 * Equal: `{ N, null }` ≡ `{ N, N }`. Distinct: `{ N, P }`; another normal tabela; no normal one.
 *
 * ## Is the conta still the one the run priced? ({@link indisponibilidadePrecoLi}, pure)
 *
 * Gone (or no longer a Loja Integrada conta) ⇒ `conta-ausente`; inactive ⇒ `conta-inativa`; folded
 * tabelas other than the ones the run fixed ⇒ `tabela-mudou`. Otherwise available. A run never
 * prices one conta from two tabelas: what a re-point changes is the release's to ask for.
 *
 * ONE `getAll` per call, by id (point reads, no index), never `contaCache.ts`: what it decides is
 * an aviso, and later a send. Next-free, `db` a parameter; this module logs nothing.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { integracaoCollection } from '@delfrance/data/admin/collections';
import { INTEGRACAO_TIPO, type TabelasPrecoLi } from '@delfrance/schemas';

import { relogioDoDocumentoUs } from '../../avisos/avisos';
import { type TabelasDaContaLi, tabelasDaContaLi } from '../../preco/tabelasLi';

/** One conta, as read now, for the price arm. */
export interface ContaPrecoRevistaLi {
  readonly contaId: string;
  /** The document exists AND is a Loja Integrada conta. */
  readonly existe: boolean;
  /** `false` only when the document says so explicitly (the listing's rule). */
  readonly ativo: boolean;
  /** Its tabelas, folded ({@link tabelasDobradasLi}); `null` = no normal tabela. */
  readonly tabelas: TabelasPrecoLi | null;
  /** The operator-facing store name (`''` when not a string). */
  readonly nome: string;
  /** µs of the read's `updateTime` (`null` when absent). */
  readonly versaoUs: number | null;
  /** µs of the document's `createTime` (`null` when absent). */
  readonly criadaUs: number | null;
}

/** Why a conta is not the conta the run priced. */
export type IndisponibilidadePrecoLi = 'conta-ausente' | 'conta-inativa' | 'tabela-mudou';

/** Named members of {@link IndisponibilidadePrecoLi}. */
export const INDISPONIBILIDADE_PRECO_LI = {
  ausente: 'conta-ausente',
  inativa: 'conta-inativa',
  tabelaMudou: 'tabela-mudou',
} as const satisfies Record<string, IndisponibilidadePrecoLi>;

/** The tabelas a run prices with (module header). Pure. */
export function tabelasDobradasLi(t: TabelasDaContaLi): TabelasPrecoLi | null {
  if (t.normal === null) return null;
  return { normal: t.normal, promocional: t.promocional === t.normal ? null : t.promocional };
}

/** Two folded pairs are the same pricing: the same normal and the same promotional tabela. */
export function mesmasTabelasPrecoLi(a: TabelasPrecoLi, b: TabelasPrecoLi): boolean {
  return a.normal === b.normal && a.promocional === b.promocional;
}

/** Every conta of `contaIds`, read now, by id, in ONE `getAll` (module header). */
export async function reverContasPrecoLi(
  db: Firestore,
  contaIds: readonly string[],
): Promise<Map<string, ContaPrecoRevistaLi>> {
  const revistas = new Map<string, ContaPrecoRevistaLi>();
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
      tabelas: existe ? tabelasDobradasLi(tabelasDaContaLi(dados)) : null,
      nome: existe && typeof dados.nome === 'string' ? dados.nome : '',
      versaoUs:
        snap?.exists === true && snap.updateTime !== undefined
          ? relogioDoDocumentoUs(snap.updateTime)
          : null,
      criadaUs:
        snap?.exists === true && snap.createTime !== undefined
          ? relogioDoDocumentoUs(snap.createTime)
          : null,
    });
  });
  return revistas;
}

/**
 * Why `conta` is not the conta the run priced at `tabelasDoRun`, or `null` when it is (module
 * header). Pure. Absent from the map counts as gone.
 */
export function indisponibilidadePrecoLi(
  conta: ContaPrecoRevistaLi | undefined,
  tabelasDoRun: TabelasPrecoLi,
): IndisponibilidadePrecoLi | null {
  if (conta === undefined || !conta.existe) return INDISPONIBILIDADE_PRECO_LI.ausente;
  if (!conta.ativo) return INDISPONIBILIDADE_PRECO_LI.inativa;
  if (conta.tabelas === null || !mesmasTabelasPrecoLi(conta.tabelas, tabelasDoRun)) {
    return INDISPONIBILIDADE_PRECO_LI.tabelaMudou;
  }
  return null;
}
