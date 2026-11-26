/**
 * The price send run's ONE aviso tipo, `lojaIntegradaPrecoRecusado` (master plan step 13, PR
 * 13-d) — raised and resolved by the send run (`preco/processarPreco.ts`); the twin of the stock
 * run's (`estoque/avisosEstoque.ts`). Its contract is documented on `tipoAvisoSchema`
 * (`packages/schemas/src/aviso.ts`): a child's price did not land, with a CODE
 * (`MOTIVO_PRECO_RECUSADO_LI`) —
 *
 *  - `recusado`: Loja Integrada refused the write with a 3xx or 4xx other than 429 on the task's
 *    LAST attempt (a 401/403 only once the next deciding read on the same credential reads fine;
 *    refused too, the conta parks instead);
 *  - `nao-refletido`: the store did not keep what was sent, even after the one `deriva` follow-up
 *    (a generation-1 run whose read-back was VERIFIED and still drifted).
 *
 * The other three price tipos (`…SemErp`, `…NaoBaixado`, `…Parado`) are the nightly's: a send run
 * never writes them.
 *
 *  - **Key:** one row per child produto of the conta (`entidade: produtoId`).
 *  - **Params:** `loja` (the conta name), `produto` (the ERP produto id), `idLi` (the store
 *    product id, as TEXT), `motivo` (the code; the top-level `motivo` field too) and, for
 *    `recusado` only, `status` (the HTTP status, a NUMBER). A repeat replaces `params` whole, so a
 *    `nao-refletido` after a `recusado` carries no stale `status`. Severity `atencao`, canal
 *    `lojaIntegrada`, route the produto.
 *  - **Clock (root `CLAUDE.md` rule 7, tier 2):** the send run's dispatch start, ms → µs through
 *    the app's one conversion module (`avisos/avisos.ts`). `escreverAviso` drops a raise whose
 *    clock is `<=` the stored one — so a run never resolves this row and then raises it: the raise
 *    would carry the clock the resolve just stamped, and be dropped.
 *
 * ## The resolve reads first, and writes only an OPEN row
 *
 * A clocked `resolverAviso` SEEDS a resolved row when none exists — a Firestore write on every
 * successful send, which the run's cost contract forbids ("no write on success"). So
 * {@link resolverPrecoRecusadoLi} reads the row once: absent, or already resolved ⇒ nothing
 * written; open ⇒ the clocked `resolverAviso`, which advances the row's clock on the write that
 * closes it (and compares it first, so a newer run's open row is never closed by an older run).
 * The stock module's accepted residual of skipping an already-resolved row holds here too.
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
  MOTIVO_PRECO_RECUSADO_LI,
  ROTAS_AVISO,
  SEVERIDADE_AVISO,
  TIPO_AVISO,
  chaveDeAviso,
} from '@delfrance/schemas';

import { type AvisoDepsLi, agoraUsDe, relogioDoEnvioDePrecoUs } from '../avisos/avisos';

/** The motivo every machine resolution of the tipo is stamped with. */
export const MOTIVO_RESOLUCAO_PRECO_LI = {
  /** A later run under `on` landed the produto's price, or found it already reflected. */
  enviado: 'preco-enviado',
} as const;

/** One child produto, as the aviso names it. */
export interface ProdutoDoAvisoPrecoLi {
  readonly integracaoId: string;
  /** The conta's `nome` — the operator-facing store name. */
  readonly lojaNome: string;
  readonly produtoId: string;
  /** The store product id, canonical decimal text. */
  readonly idLi: string;
  /** The send run's dispatch start, in MILLISECONDS: the clock. */
  readonly inicioDaTarefaMs: number;
}

/** Why the price did not land, as the row records it (module header). */
export type RecusaPrecoLi =
  | { readonly motivo: typeof MOTIVO_PRECO_RECUSADO_LI.recusado; readonly status: number }
  | { readonly motivo: typeof MOTIVO_PRECO_RECUSADO_LI.naoRefletido };

/** The dedup identity — and the document id — of one produto's row. */
export function chaveDoAvisoPrecoRecusadoLi(integracaoId: string, produtoId: string): string {
  return chaveDeAviso({
    tipo: TIPO_AVISO.lojaIntegradaPrecoRecusado,
    conta: integracaoId,
    entidade: produtoId,
  });
}

/** The metadata every write of the tipo carries (the seed, minus what a raise alone knows). */
function base(p: ProdutoDoAvisoPrecoLi): Omit<PlanoAviso, 'relogioEvento'> {
  return {
    tipo: TIPO_AVISO.lojaIntegradaPrecoRecusado,
    conta: p.integracaoId,
    entidade: p.produtoId,
    severidade: SEVERIDADE_AVISO.atencao,
    canal: CANAL_AVISO.lojaIntegrada,
    params: { loja: p.lojaNome, produto: p.produtoId, idLi: p.idLi },
    urlInterna: { rota: ROTAS_AVISO.produto.build(p.produtoId), campo: null },
  };
}

/** The params of one refusal: the code always, the HTTP status for `recusado` only. */
function paramsDaRecusa(
  b: Readonly<Record<string, string | number>>,
  recusa: RecusaPrecoLi,
): Record<string, string | number> {
  return recusa.motivo === MOTIVO_PRECO_RECUSADO_LI.recusado
    ? { ...b, motivo: recusa.motivo, status: recusa.status }
    : { ...b, motivo: recusa.motivo };
}

/** Raise (or refresh) the produto's row for `recusa`, clocked by the run's dispatch start. */
export async function avisarPrecoRecusadoLi(
  db: Firestore,
  produto: ProdutoDoAvisoPrecoLi,
  recusa: RecusaPrecoLi,
  deps: AvisoDepsLi,
): Promise<ResultadoAviso> {
  const b = base(produto);
  const { resultado } = await escreverAviso(
    db,
    {
      ...b,
      params: paramsDaRecusa(b.params ?? {}, recusa),
      motivo: recusa.motivo,
      relogioEvento: relogioDoEnvioDePrecoUs(produto.inicioDaTarefaMs),
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
export async function resolverPrecoRecusadoLi(
  db: Firestore,
  produto: ProdutoDoAvisoPrecoLi,
  deps: Pick<AvisoDepsLi, 'nowMs'>,
): Promise<boolean> {
  const chave = chaveDoAvisoPrecoRecusadoLi(produto.integracaoId, produto.produtoId);
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
    MOTIVO_RESOLUCAO_PRECO_LI.enviado,
    { agoraUs: agoraUsDe(deps) },
    { ...base(produto), relogioEvento: relogioDoEnvioDePrecoUs(produto.inicioDaTarefaMs) },
  );
}
