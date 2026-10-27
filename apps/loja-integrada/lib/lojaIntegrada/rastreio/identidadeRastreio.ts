/**
 * The identity proof of the status write-back (master plan step 7, PR 7-d):
 * every sameness decision about WHICH order a write-back is about lives here, so
 * the equivalence-fold inventory names one file for all three.
 *
 *  - {@link pedidoRastreioLi} — is this pedido an imported Loja Integrada order
 *    at all, and of which conta and numero? The conta from the pedido's ref
 *    (`contaIdDoPedidoLi`), the numero canonical, then the import's own digest of
 *    the shared preimage (`preimagemPedidoLi` → `sha256Hex`) must BE the pedido
 *    id. A duplicate, a devolução or a manual pedido carries no such id, so it is
 *    never written back — with zero Loja Integrada work.
 *  - {@link envioDoPedidoLi} — which live envio is the pedido's: the one whose id
 *    equals the stored `freteInicial.externalId`, both read as canonical
 *    integers. A stored id that matches NONE is an identity failure (another
 *    store's order under the same numero, a token swapped between contas): the
 *    run writes nothing.
 *  - {@link numeroConfereLi} — is the guard read about THIS order: its `numero`
 *    against the pedido's, both canonical.
 *
 * Pure and total: no clock, no network, no Firestore; a malformed value answers
 * `null` / `false` / `nao-encontrado`, never an exception.
 */
import { sha256Hex } from '@delfrance/data/admin';
import {
  contaIdDoPedidoLi,
  inteiroPositivoCanonicoLi,
  preimagemPedidoLi,
} from '@delfrance/schemas';

import { vazioArmazenadoLi } from '../pedidos/vazioArmazenado';

/** A plain object (never null, never an array), or `null`. */
function comoObjeto(valor: unknown): Readonly<Record<string, unknown>> | null {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Readonly<Record<string, unknown>>)
    : null;
}

/** What the write-back reads from a pedido it proved to be an imported Loja Integrada order. */
export interface PedidoRastreioLi {
  /** The conta (`integracao` document id) the order belongs to. */
  readonly contaId: string;
  /** The order `numero`, canonical decimal. */
  readonly numero: string;
  /** `freteInicial.codRastreio` as stored (the objeto rule reads it raw). */
  readonly codRastreio: unknown;
  /** `freteInicial.externalId` as stored: the Loja Integrada envio id. */
  readonly externalId: unknown;
  /** `freteInicial.estado` as stored: what freshness reads. */
  readonly estadoFrete: unknown;
}

/**
 * The identity proof (module header): the pedido as the write-back reads it, or
 * `null` when it is not an imported Loja Integrada order whose id is the
 * digest of its own conta and numero.
 *
 * Equal: the master plan's vector `('CONTA1', '165')` hashes to its id; a numero
 * stored as the NUMBER 165 and a conta ref in its `documents/` form are the same
 * order. Distinct (`null`): a duplicate (a random id), `'0165'`, `'165.0'`, a
 * `null` numero, another conta, a ref to another collection.
 */
export function pedidoRastreioLi(pedidoId: string, raw: unknown): PedidoRastreioLi | null {
  const pedido = comoObjeto(raw);
  if (pedido === null) return null;
  const contaId = contaIdDoPedidoLi(pedido.integracaoPedidoOuterRef);
  const numero = inteiroPositivoCanonicoLi(pedido.numero);
  if (contaId === null || numero === null) return null;
  const preimagem = preimagemPedidoLi(contaId, numero);
  if (preimagem === null || sha256Hex(preimagem) !== pedidoId) return null;
  const frete = comoObjeto(pedido.freteInicial);
  return {
    contaId,
    numero,
    codRastreio: frete?.codRastreio,
    externalId: frete?.externalId,
    estadoFrete: frete?.estado,
  };
}

/** The live envio the pedido stores. */
export type EnvioDoPedidoLi =
  /** No stored envio id (`null`, absent, `''`): no objeto, the situação as usual. */
  | { readonly kind: 'sem-external-id' }
  /** A stored id that matches no live envio: an identity failure, NOTHING written. */
  | { readonly kind: 'nao-encontrado' }
  /** The live envio whose id equals the stored one — its id as Loja Integrada sent it. */
  | { readonly kind: 'encontrado'; readonly id: number; readonly objeto: unknown };

/** One live envio, as the order detail lists it. */
export interface EnvioVivoLi {
  readonly id?: unknown;
  readonly objeto?: unknown;
}

/**
 * The live envio matched by the stored `externalId`, both through the canonical
 * integer reader, by MEMBERSHIP (wherever it sits in the list).
 *
 * Equal: stored `'69291055'` ≡ stored `69291055` ≡ live `69291055`. Distinct
 * (`nao-encontrado`): `'069291055'`, `'69291055.0'`, `' 69291055'`, `0`, another
 * id, and a present stored id with no live envio at all. Absent (`null`, absent,
 * `''`) is `sem-external-id`, never a match.
 */
export function envioDoPedidoLi(
  envios: readonly EnvioVivoLi[],
  externalId: unknown,
): EnvioDoPedidoLi {
  if (vazioArmazenadoLi(externalId)) return { kind: 'sem-external-id' };
  const armazenado = inteiroPositivoCanonicoLi(externalId);
  if (armazenado === null) return { kind: 'nao-encontrado' };
  for (const envio of envios) {
    if (typeof envio.id !== 'number') continue;
    if (inteiroPositivoCanonicoLi(envio.id) === armazenado) {
      return { kind: 'encontrado', id: envio.id, objeto: envio.objeto };
    }
  }
  return { kind: 'nao-encontrado' };
}

/**
 * Whether the guard read's `numero` is the pedido's, both canonical. Equal: the
 * live NUMBER 165 ≡ the stored STRING `'165'`. Distinct: 166, `'0165'` on either
 * side, a fraction, `null`.
 */
export function numeroConfereLi(corpoNumero: unknown, numero: unknown): boolean {
  const vivo = inteiroPositivoCanonicoLi(corpoNumero);
  return vivo !== null && vivo === inteiroPositivoCanonicoLi(numero);
}
