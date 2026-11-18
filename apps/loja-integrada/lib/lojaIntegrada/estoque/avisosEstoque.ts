/**
 * The stock send run's ONE aviso tipo, `lojaIntegradaEstoqueRecusado` (master plan step 12, PR
 * 12-e) — raised and resolved by the send run (`estoque/processarEstoque.ts`). Its contract is
 * documented on `tipoAvisoSchema` (`packages/schemas/src/aviso.ts`): Loja Integrada refused a
 * child's stock write with a 3xx or 4xx other than 429 on the task's LAST attempt (a 401/403
 * only once the next deciding read on the same credential reads fine; refused too, the conta
 * parks instead).
 *
 *  - **Key:** one row per child produto of the conta (`entidade: produtoId`).
 *  - **Params:** `loja` (the conta name), `produto` (the ERP produto id), `idLi` (the store
 *    product id, as TEXT) and `status` (the HTTP status, a NUMBER). Severity `atencao`, canal
 *    `lojaIntegrada`, route the produto.
 *  - **Clock (root `CLAUDE.md` rule 7, tier 2):** the send run's dispatch start, ms → µs through
 *    the app's one conversion module (`avisos/avisos.ts`). `escreverAviso` drops a raise whose
 *    clock is `<=` the stored one, so an older run can never reopen a row a newer one closed.
 *
 * ## The resolve reads first, and writes only an OPEN row
 *
 * A clocked `resolverAviso` SEEDS a resolved row when none exists — a Firestore write on every
 * successful send, which the run's cost contract forbids ("no write on success"). So
 * {@link resolverEstoqueRecusadoLi} reads the row once: absent, or already resolved ⇒ nothing
 * written; open ⇒ the clocked `resolverAviso`, which advances the row's clock on the write that
 * closes it (and compares it first, so a newer run's open row is never closed by an older run).
 *
 * ⚠️ The accepted residual of skipping an already-resolved row: its clock stays where the closing
 * run left it, so a refusal from a run that STARTED before this one but ends after it (two
 * dispatches overlapping — the stock queue runs one at a time, so only an abandoned dispatch can)
 * reopens it. The next run for that produto under `on` that ends written or reflected closes it
 * again.
 *
 * ⚠️ Raised and resolved only by a run whose write decision was `on` — the caller decides that;
 * this module writes what it is asked to.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { avisoCollection } from '@delfrance/data/admin/collections';
import {
  type PlanoAviso,
  type ResultadoAviso,
  escreverAviso,
  resolverAviso,
} from '@delfrance/data/admin/avisos';
import {
  CANAL_AVISO,
  ROTAS_AVISO,
  SEVERIDADE_AVISO,
  TIPO_AVISO,
  chaveDeAviso,
} from '@delfrance/schemas';

import { type AvisoDepsLi, agoraUsDe, relogioDoEnvioDeEstoqueUs } from '../avisos/avisos';

/** The motivo every machine resolution of the tipo is stamped with. */
export const MOTIVO_RESOLUCAO_ESTOQUE_LI = {
  /** A later run under `on` wrote the produto's stock, or found it already reflected. */
  enviado: 'estoque-enviado',
} as const;

/** One child produto, as the aviso names it. */
export interface ProdutoDoAvisoEstoqueLi {
  readonly integracaoId: string;
  /** The conta's `nome` — the operator-facing store name. */
  readonly lojaNome: string;
  readonly produtoId: string;
  /** The store product id, canonical decimal text. */
  readonly idLi: string;
  /** The send run's dispatch start, in MILLISECONDS: the clock. */
  readonly inicioDaTarefaMs: number;
}

/** The dedup identity — and the document id — of one produto's row. */
export function chaveDoAvisoEstoqueRecusadoLi(integracaoId: string, produtoId: string): string {
  return chaveDeAviso({
    tipo: TIPO_AVISO.lojaIntegradaEstoqueRecusado,
    conta: integracaoId,
    entidade: produtoId,
  });
}

/** The metadata every write of the tipo carries (the seed, minus what a raise alone knows). */
function base(p: ProdutoDoAvisoEstoqueLi): Omit<PlanoAviso, 'relogioEvento'> {
  return {
    tipo: TIPO_AVISO.lojaIntegradaEstoqueRecusado,
    conta: p.integracaoId,
    entidade: p.produtoId,
    severidade: SEVERIDADE_AVISO.atencao,
    canal: CANAL_AVISO.lojaIntegrada,
    params: { loja: p.lojaNome, produto: p.produtoId, idLi: p.idLi },
    urlInterna: { rota: ROTAS_AVISO.produto.build(p.produtoId), campo: null },
  };
}

/** Raise (or refresh) the produto's row for a refusal with `status`, clocked by the run's start. */
export async function avisarEstoqueRecusadoLi(
  db: Firestore,
  produto: ProdutoDoAvisoEstoqueLi,
  status: number,
  deps: AvisoDepsLi,
): Promise<ResultadoAviso> {
  const b = base(produto);
  const { resultado } = await escreverAviso(
    db,
    {
      ...b,
      params: { ...b.params, status },
      relogioEvento: relogioDoEnvioDeEstoqueUs(produto.inicioDaTarefaMs),
    },
    { increment: deps.increment, agoraUs: agoraUsDe(deps), logger: deps.logger },
  );
  return resultado;
}

/**
 * Close the produto's row when it is OPEN (module header): one read; absent or already resolved
 * ⇒ `false` and nothing written; open ⇒ the clocked `resolverAviso`. `true` only on a real open →
 * resolved transition.
 */
export async function resolverEstoqueRecusadoLi(
  db: Firestore,
  produto: ProdutoDoAvisoEstoqueLi,
  deps: Pick<AvisoDepsLi, 'nowMs'>,
): Promise<boolean> {
  const chave = chaveDoAvisoEstoqueRecusadoLi(produto.integracaoId, produto.produtoId);
  const snap = await avisoCollection.docRef(db, {}, chave).get();
  const dados: Readonly<Record<string, unknown>> | undefined = snap.exists
    ? snap.data()
    : undefined;
  // Open exactly as `resolverAviso` reads it: no `resolvidoEm` stamp (absent or `null`).
  if (dados === undefined || (Object.hasOwn(dados, 'resolvidoEm') && dados.resolvidoEm != null)) {
    return false;
  }
  return resolverAviso(
    db,
    chave,
    MOTIVO_RESOLUCAO_ESTOQUE_LI.enviado,
    { agoraUs: agoraUsDe(deps) },
    { ...base(produto), relogioEvento: relogioDoEnvioDeEstoqueUs(produto.inicioDaTarefaMs) },
  );
}
