/**
 * The PURE plan of one price send (master plan step 13, PR 13-d): given the target the ERP prices
 * a linked child at (`precoAlvoLi`, `@delfrance/schemas`) and the store's produto detail read just
 * before the write (the engine's deciding read, `GET /v1/produto/{id}/`), what the run does —
 * skip, leave alone, refuse a lowering, or send exactly which builder inputs. The send run
 * (`processarPreco.ts`) binds it; the publish (step 11) will bind the same module.
 *
 * Pure and total, except where a shared helper throws on a target `precoAlvoLi` never builds (a
 * bug): `decidirBaixaPrecoLi`, and the package's builder `corpoPrecoProdutoLi`, past its exact
 * round trip. No clock, no network, no Firestore, no environment.
 *
 * ## The guard, on the detail as read
 *
 * The engine checks nothing in the detail ("whether the detail names the product asked for, is a
 * variation, is removed or blocked … are the flow's to judge"). So, first hit wins:
 *
 *  1. its `id` is not the store product asked for ⇒ `linha-divergente` (the price ROW's own id is
 *     another number sequence and may name ANOTHER product: the detail must name ours);
 *  2. its `tipo` is not `atributo_opcao` ⇒ `nao-e-variacao` (only a variation is priced here);
 *  3. `removido` exactly `true` ⇒ `removido`, anything but a boolean ⇒ `guarda-ilegivel`;
 *  4. `bloqueado` likewise (`bloqueado`, or `guarda-ilegivel`) — a guard that cannot be read
 *     fails CLOSED;
 *  5. `preco_sob_consulta` not a boolean ⇒ `sob-consulta-ilegivel`: the send echoes it, and the
 *     engine refuses a non-boolean echo as a `TypeError`, which would burn every attempt.
 *
 * `ativo` is NOT read: an inactive child is priced like any other.
 *
 * ## The decision, in integer centavos, against the deciding read
 *
 *  1. a current full price or promotion present but unreadable ⇒ `atual-ilegivel` (whatever
 *     `baixar` says): neither "lowers" nor "does not" can be decided over it;
 *  2. the store already shows the target (the shared "reflected" rule, under the configured clear)
 *     ⇒ `refletido`. The custo and `sob_consulta` are never compared: both are echoed;
 *  3. the task may not lower (`baixar` false) and the send would lower ANY buyer price — the full
 *     price, a positive promotion, or the effective price (a NEW promotion where the store shows
 *     none included) ⇒ `nao-baixado`, naming the leaves that went down. A clear never lowers;
 *  4. otherwise `enviar`, with the builder inputs taken FROM THE DECIDING READ: the target, the
 *     configured clear, the store's own `preco_custo` RAW (never folded, never the ERP's) and the
 *     guard's `sob_consulta`. The builder's verdict on that custo rides along, so the run can log
 *     the one WARNING when it had to omit it.
 *
 * (1) and (2) are disjoint — the reflected rule is false whenever a leaf is unreadable — so their
 * order only makes the unreadable case explicit and fail-closed.
 */
import {
  type CustoNoCorpoPrecoLi,
  type EntradaPrecoProdutoLi,
  type ProdutoComPrecoDetalheLi,
  corpoPrecoProdutoLi,
} from '@delfrance/integrations-loja-integrada';
import {
  type EnvioPrecoLi,
  type FormaPromoLimpaLi,
  ORIGEM_TAREFA_PRECO_LI,
  type OrigemTarefaPrecoLi,
  TIPO_PRODUTO_LI,
  decidirBaixaPrecoLi,
  precoRefletidoLi,
} from '@delfrance/schemas';

import type { TipoEscritaPrecoLi } from '../core/escrita';

/* -------------------------------------------------------------------------- */
/*                                The write kind                               */
/* -------------------------------------------------------------------------- */

/**
 * The write kind of each origin: an event, a manual push, a publish and a `deriva` follow-up
 * write `preco-produto` and are READ BACK by their own GET; a reconcile and an "Atualizar preços"
 * run write `preco-produto-lote`, with no read-back call (the next nightly by-id read is theirs).
 * Exhaustive: an origin added later does not compile until it is decided.
 */
export function tipoEscritaDaOrigemPrecoLi(origem: OrigemTarefaPrecoLi): TipoEscritaPrecoLi {
  switch (origem) {
    case ORIGEM_TAREFA_PRECO_LI.evento:
    case ORIGEM_TAREFA_PRECO_LI.manual:
    case ORIGEM_TAREFA_PRECO_LI.publicacao:
    case ORIGEM_TAREFA_PRECO_LI.deriva:
      return 'preco-produto';
    case ORIGEM_TAREFA_PRECO_LI.reconcile:
    case ORIGEM_TAREFA_PRECO_LI.atualizacao:
      return 'preco-produto-lote';
  }
}

/* -------------------------------------------------------------------------- */
/*                                  The guard                                  */
/* -------------------------------------------------------------------------- */

/** Why a deciding read is one this run may not price (module header, "The guard"). */
export type MotivoGuardaPrecoLi =
  | 'linha-divergente'
  | 'nao-e-variacao'
  | 'removido'
  | 'bloqueado'
  | 'guarda-ilegivel'
  | 'sob-consulta-ilegivel';

/** The guard's answer: a detail this run may price (with its `sob_consulta`), or why not. */
export type GuardaDetalhePrecoLi =
  | { readonly tipo: 'ok'; readonly sobConsulta: boolean }
  | { readonly tipo: MotivoGuardaPrecoLi };

/** A store flag read for the guard: `true` stops, `false` passes, anything else is unreadable. */
function bandeiraDaGuardaLi(
  valor: unknown,
  motivo: 'removido' | 'bloqueado',
): GuardaDetalhePrecoLi | null {
  if (valor === false) return null;
  return { tipo: valor === true ? motivo : 'guarda-ilegivel' };
}

/** The guard on the deciding read (module header): the first hit wins. */
export function guardaDoDetalhePrecoLi(
  detalhe: ProdutoComPrecoDetalheLi,
  idLi: number,
): GuardaDetalhePrecoLi {
  if (detalhe.id !== idLi) return { tipo: 'linha-divergente' };
  if (detalhe.tipo !== TIPO_PRODUTO_LI.atributoOpcao) return { tipo: 'nao-e-variacao' };
  const removido = bandeiraDaGuardaLi(detalhe.removido, 'removido');
  if (removido !== null) return removido;
  const bloqueado = bandeiraDaGuardaLi(detalhe.bloqueado, 'bloqueado');
  if (bloqueado !== null) return bloqueado;
  const sobConsulta = detalhe.preco_sob_consulta;
  if (typeof sobConsulta !== 'boolean') return { tipo: 'sob-consulta-ilegivel' };
  return { tipo: 'ok', sobConsulta };
}

/* -------------------------------------------------------------------------- */
/*                                The decision                                 */
/* -------------------------------------------------------------------------- */

/** A buyer price a send would lower: the full price, a positive promotion, the effective price. */
export type FolhaBaixaPrecoLi = 'cheio' | 'promocional' | 'efetivo';

/** What the run does with one target against one deciding read (module header, "The decision"). */
export type DecisaoEnvioPrecoLi =
  | { readonly tipo: 'atual-ilegivel' }
  | { readonly tipo: 'refletido' }
  | { readonly tipo: 'nao-baixado'; readonly folhas: readonly FolhaBaixaPrecoLi[] }
  | {
      readonly tipo: 'enviar';
      /** The package builder's inputs: the engine refuses any custo or `sob_consulta` but the read's. */
      readonly entrada: EntradaPrecoProdutoLi;
      /** What the builder makes of the store's custo (the run logs `omitido-ilegivel` once). */
      readonly custo: CustoNoCorpoPrecoLi;
    };

/** The decision (module header, "The decision"). */
export function decidirEnvioPrecoLi(a: {
  readonly alvo: EnvioPrecoLi;
  readonly detalhe: ProdutoComPrecoDetalheLi;
  /** The guard's boolean: the deciding read's own `preco_sob_consulta`. */
  readonly sobConsulta: boolean;
  readonly baixar: boolean;
  readonly forma: FormaPromoLimpaLi;
}): DecisaoEnvioPrecoLi {
  // Only the two leaves a send SETS and a buyer sees: never the custo.
  const atual = { cheio: a.detalhe.preco_cheio, promocional: a.detalhe.preco_promocional };
  // A copy carrying the target alone (never the price function's signals).
  const alvo: EnvioPrecoLi = { cheioCentavos: a.alvo.cheioCentavos, promo: a.alvo.promo };
  const baixa = decidirBaixaPrecoLi({ alvo, atual });
  if (baixa.tipo === 'atual-ilegivel') return { tipo: 'atual-ilegivel' };
  if (precoRefletidoLi({ alvo, forma: a.forma, atual })) return { tipo: 'refletido' };
  if (!a.baixar && baixa.tipo === 'baixa') {
    const folhas: FolhaBaixaPrecoLi[] = [];
    if (baixa.cheio) folhas.push('cheio');
    if (baixa.promocional) folhas.push('promocional');
    if (baixa.efetivo) folhas.push('efetivo');
    return { tipo: 'nao-baixado', folhas };
  }
  const entrada: EntradaPrecoProdutoLi = {
    alvo,
    formaPromoLimpa: a.forma,
    // The store's own custo, RAW: the engine checks it is this very value.
    custo: a.detalhe.preco_custo,
    sobConsulta: a.sobConsulta,
  };
  return { tipo: 'enviar', entrada, custo: corpoPrecoProdutoLi(entrada).custo };
}

/* -------------------------------------------------------------------------- */
/*                                  The plan                                   */
/* -------------------------------------------------------------------------- */

/** The one pure answer for one (target, deciding read): a guard refusal, or the decision. */
export type PlanoPrecoLi =
  | Exclude<GuardaDetalhePrecoLi, { readonly tipo: 'ok' }>
  | DecisaoEnvioPrecoLi;

/** The guard, then the decision. */
export function planoPrecoLi(a: {
  readonly alvo: EnvioPrecoLi;
  readonly detalhe: ProdutoComPrecoDetalheLi;
  /** The store product asked for (the target's `recurso`). */
  readonly idLi: number;
  readonly baixar: boolean;
  readonly forma: FormaPromoLimpaLi;
}): PlanoPrecoLi {
  const guarda = guardaDoDetalhePrecoLi(a.detalhe, a.idLi);
  if (guarda.tipo !== 'ok') return guarda;
  return decidirEnvioPrecoLi({
    alvo: a.alvo,
    detalhe: a.detalhe,
    sobConsulta: guarda.sobConsulta,
    baixar: a.baixar,
    forma: a.forma,
  });
}
