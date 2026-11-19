/**
 * The conta gate of the operator's stock routes (master plan step 12, PR 12-h): the manual push and
 * the reconcile both refuse, with nothing enqueued, a conta the stock sync would skip. ONE read,
 * UNCACHED (`core/leituraDaConta.ts`): an operator action decides on it, so a deactivation must
 * take effect at once, never after the conta cache's 15 minutes. Next-free, `db` a parameter; the
 * HTTP answers are `core/respond.ts`'s (`respostaDaContaDoEstoqueLi`).
 *
 *  - missing, or not a Loja Integrada conta (`tipo` 3) ⇒ `nao-encontrada` (404);
 *  - `ativo === false` ⇒ `inativa` (409) — the send run and the reconcile skip it;
 *  - no depósito (`depositoDaContaLi`, either stored form) ⇒ `sem-deposito` (409).
 *
 * Neither a park nor the credential is checked: both live in the credential document, which these
 * routes never read. The send run checks them when it runs.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { type Integracao, depositoDaContaLi } from '@delfrance/schemas';

import { lerContaLojaIntegrada } from '../core/leituraDaConta';

/** What the gate found. */
export type ContaDoEstoqueLi =
  | { readonly tipo: 'ok'; readonly conta: Integracao; readonly depositoId: string }
  | { readonly tipo: 'nao-encontrada' }
  | { readonly tipo: 'inativa' }
  | { readonly tipo: 'sem-deposito' };

/** The conta gate (module header). */
export async function contaDoEstoqueLi(db: Firestore, contaId: string): Promise<ContaDoEstoqueLi> {
  const conta = await lerContaLojaIntegrada(db, contaId);
  if (conta === null) return { tipo: 'nao-encontrada' };
  if (conta.ativo === false) return { tipo: 'inativa' };
  const depositoId = depositoDaContaLi(conta);
  if (depositoId === null) return { tipo: 'sem-deposito' };
  return { tipo: 'ok', conta, depositoId };
}
