/**
 * Defensive readers for the raw documents the payment-link orchestrations touch
 * (#367): a `linkPgtoMercadoPago` doc, a `metodo_pgto` account, and the outer
 * refs that point at either.
 *
 * Why not just trust the typed handle: the link collection holds the LEGACY
 * corpus too (no `modo`, no `status`, `id` sometimes null), and a soft-read that
 * fails its parse hands back the RAW document. Every field is therefore read with
 * a check and a fallback that means the same thing the schema default does, so
 * the routes behave identically on a typed read, a raw read and a legacy doc.
 */
import { coerceToMillis } from '@delfrance/core/datetime';
import {
  STATUS_LINK_PAGAMENTO,
  linkCriadoSchema,
  metodoPagamentoMeta,
  modoLinkPagamentoSchema,
  parseRef,
  statusLinkPagamentoSchema,
  type LinkCriado,
  type ModoLinkPagamento,
  type StatusLinkPagamento,
} from '@delfrance/schemas';

/** A plain-object view of a raw value; anything else reads as empty. */
export function comoRegistro(valor: unknown): Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : {};
}

/** A non-blank string, or `null`. */
export function textoOuNull(valor: unknown): string | null {
  return typeof valor === 'string' && valor.trim() !== '' ? valor : null;
}

/** A finite number, or `0` — the fail-safe read of a raw money field. */
export function numeroOuZero(valor: unknown): number {
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : 0;
}

/** `documents/usuarios/<uid>` — how every other ref to an operator is stored. */
export function usuarioOuterRef(uid: string): string {
  return `documents/usuarios/${uid}`;
}

/** `documents/metodo_pgto/<metodoId>` — the ref a link stores for its account. */
export function contaOuterRef(metodoId: string): string {
  return `documents/${metodoPagamentoMeta.collectionPath}/${metodoId}`;
}

/**
 * The `metodo_pgto` doc id a stored ref points at, or `null` when it is not a
 * string, is malformed, or points at another collection. `parseRef` tolerates
 * every ref form the legacy corpus carries (`documents/…`, `metodo_pgto/…`).
 *
 * ⚠️ The account of a link ALWAYS comes from the link's own stored ref, never
 * from the request body: a caller must not be able to make the backend act on a
 * link with another account's token.
 */
export function metodoIdDoRef(ref: unknown): string | null {
  if (typeof ref !== 'string') return null;
  const { collection, id } = parseRef(ref);
  return collection === metodoPagamentoMeta.collectionPath && id !== '' ? id : null;
}

/**
 * The Mercado Pago collector id (`user_id`) of a connected account, or `null`
 * when it is absent or not a positive integer. Strict on purpose: the webhook
 * resolves an account BY this number, so a payment on an account without a real
 * one could never be attributed (and a truncated `42.7` would name another
 * seller).
 */
export function userIdDaConta(conta: Readonly<Record<string, unknown>>): number | null {
  const valor = conta.user_id;
  return typeof valor === 'number' && Number.isSafeInteger(valor) && valor > 0 ? valor : null;
}

/** What the cancel / auto-close paths need to know about a stored link. */
export interface LinkLido {
  /** `null` ⇒ a legacy link (written by the Flutter app): not ours to close. */
  modo: ModoLinkPagamento | null;
  /** The stored status; a missing / unreadable one is `aberto`, the schema default. */
  status: StatusLinkPagamento;
  /** Mercado Pago's preference id (the doc's `id` FIELD — never the doc id). */
  preferenceId: string | null;
  /** The stored ref of the owning `metodo_pgto` account. */
  contaRef: string | null;
  /** Payments the link accepts, or `null` when unknown (legacy). */
  quantidadeMaxima: number | null;
}

/** Read a stored link doc (typed, raw or legacy) into {@link LinkLido}. */
export function lerLink(data: unknown): LinkLido {
  const dados = comoRegistro(data);
  const modo = modoLinkPagamentoSchema.safeParse(dados.modo);
  const status = statusLinkPagamentoSchema.safeParse(dados.status);
  const preferenceId = dados.id;
  const contaRef = dados.contaMercadoPagoOuterRef;
  const quantidade = dados.quantidadeMaxima;
  return {
    modo: modo.success ? modo.data : null,
    status: status.success ? status.data : STATUS_LINK_PAGAMENTO.aberto,
    preferenceId: typeof preferenceId === 'string' && preferenceId !== '' ? preferenceId : null,
    contaRef: typeof contaRef === 'string' && contaRef !== '' ? contaRef : null,
    quantidadeMaxima:
      typeof quantidade === 'number' && Number.isInteger(quantidade) && quantidade >= 1
        ? quantidade
        : null,
  };
}

/**
 * A stored link as the `criar` response describes it, or `null` when the doc
 * cannot be described (a legacy link has no `modo`; a raw read may miss the
 * preference id, the URL or the deadline). A `null` is never guessed around: the
 * caller treats it as "not a link this request could have created".
 */
export function linkCriadoDoDoc(linkId: string, data: unknown): LinkCriado | null {
  const dados = comoRegistro(data);
  const lido = linkCriadoSchema.safeParse({
    linkId,
    preferenceId: dados.id,
    link: dados.link,
    valorCobrado: dados.valorCobrado,
    nomePagador: dados.nomePagador ?? null,
    dataExpiracao: coerceToMillis(dados.dataExpiracao),
    modo: dados.modo,
    quantidadeMaxima: dados.quantidadeMaxima ?? null,
  });
  return lido.success ? lido.data : null;
}
