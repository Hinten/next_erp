import { z } from 'zod';
import { coerceToMillis, dataCivilNoFuso } from '@delfrance/core/datetime';
import { centavosDeReais, formatReais, roundReais } from '@delfrance/core/money';
import { ESTADO_NFE, type EstadoNFe } from '../../nfe';
import { idFromRef } from '../../shared/outerRef';
import {
  MODO_LINK_PAGAMENTO,
  STATUS_LINK_PAGAMENTO,
  modoLinkPagamentoSchema,
  statusLinkPagamentoSchema,
} from '../collection/linkPgtoMercadoPago';
import type { ModoLinkPagamento, StatusLinkPagamento } from '../collection/linkPgtoMercadoPago';
import { isPagamentoPagante, sumPagamentosPagos } from '../collection/pagamento';
import type { EstadoPedido } from '../collection/pedido';
import { nfeFiscalEncerrada, podeGerarLinkPagamento, travarPagamentoComNFe } from './estado';

/*
 * Pure helpers behind the pedido editor's "Link Pgto" tab (#367): why a link
 * cannot be generated, how to summarise the links and the payments that settle
 * them, and the two plain-text messages the operator copies into WhatsApp.
 *
 * Everything here is total and browser-safe (no clock, no network, no
 * Firestore) so `apps/web` and `apps/mercado-pago` run ONE implementation of each
 * rule instead of two copies that drift toward "plausible".
 */

/* -------------------------------------------------------------------------- */
/*                               Refusal reasons                               */
/* -------------------------------------------------------------------------- */

/**
 * Why a link operation is refused. ONE vocabulary for the whole feature: the
 * pure gate ({@link motivoBloqueioLinkPagamento}) uses the first five, the
 * `apps/mercado-pago` routes answer the rest in their 409 body
 * (`erroLinkPagamentoSchema.reason`), and the web renders the same
 * {@link MOTIVO_RECUSA_LINK_LABELS} for both — so a client-side notice and a
 * server-side refusal never describe one situation in two ways.
 *
 *  - `entrada`   / `canal` / `estado` / `nfe` / `semValor` — the pedido itself
 *    (see {@link motivoBloqueioLinkPagamento} for the order they are checked in).
 *  - `excedeRestante` / `valorDesatualizado` / `limiteLinks` — the batch asked
 *    for does not fit the pedido right now.
 *  - `metodoSemLink` / `compartilhadoDesabilitado` / `semConta` /
 *    `contaSemUsuario` — the Mercado Pago account or feature flag.
 *  - `conflitoLinkId` / `semPreferencia` / `preferenciaInacessivel` — the link
 *    doc or its Mercado Pago preference.
 */
export const motivoRecusaLinkSchema = z.enum([
  'entrada',
  'canal',
  'estado',
  'nfe',
  'semValor',
  'excedeRestante',
  'valorDesatualizado',
  'limiteLinks',
  'metodoSemLink',
  'compartilhadoDesabilitado',
  'conflitoLinkId',
  'semPreferencia',
  'preferenciaInacessivel',
  'semConta',
  'contaSemUsuario',
]);
export type MotivoRecusaLink = z.infer<typeof motivoRecusaLinkSchema>;

/** Named members of {@link motivoRecusaLinkSchema}. */
export const MOTIVO_RECUSA_LINK = {
  entrada: 'entrada',
  canal: 'canal',
  estado: 'estado',
  nfe: 'nfe',
  semValor: 'semValor',
  excedeRestante: 'excedeRestante',
  valorDesatualizado: 'valorDesatualizado',
  limiteLinks: 'limiteLinks',
  metodoSemLink: 'metodoSemLink',
  compartilhadoDesabilitado: 'compartilhadoDesabilitado',
  conflitoLinkId: 'conflitoLinkId',
  semPreferencia: 'semPreferencia',
  preferenciaInacessivel: 'preferenciaInacessivel',
  semConta: 'semConta',
  contaSemUsuario: 'contaSemUsuario',
} as const satisfies Record<string, MotivoRecusaLink>;

/** Operator-facing (pt-BR) sentence for each {@link MotivoRecusaLink}. */
export const MOTIVO_RECUSA_LINK_LABELS: Record<MotivoRecusaLink, string> = {
  entrada: 'Links de pagamento só existem em pedidos de saída.',
  canal: 'O canal de venda (marketplace) decide o estado deste pedido.',
  estado: 'O estado do pedido não permite gerar links de pagamento.',
  nfe: 'A NF-e deste pedido bloqueia pagamentos.',
  semValor: 'Não há valor restante a cobrar.',
  excedeRestante: 'Os links somam mais do que o valor restante (incluindo links em aberto).',
  valorDesatualizado: 'O total do pedido mudou — recarregue e tente de novo.',
  limiteLinks: 'Este pedido atingiu o limite de links de pagamento.',
  metodoSemLink: 'Esta conta do Mercado Pago não está habilitada para gerar links de pagamento.',
  compartilhadoDesabilitado: 'O link compartilhado ainda não está habilitado.',
  conflitoLinkId: 'Já existe um link diferente com este identificador. Gere os links de novo.',
  semPreferencia: 'Este link não tem uma preferência no Mercado Pago para encerrar.',
  preferenciaInacessivel:
    'O Mercado Pago não permite alterar este link. Encerre-o pelo painel do Mercado Pago.',
  semConta: 'Este pedido não tem uma conta do Mercado Pago para sincronizar.',
  contaSemUsuario: 'Reconecte a conta do Mercado Pago para continuar.',
};

/** What {@link motivoBloqueioLinkPagamento} needs to know about the pedido. */
export interface BloqueioLinkPagamentoInput {
  /** Only an explicit `false` is an entrada (schema default `true`); `null` / absent = saída. */
  ehSaida: boolean | null | undefined;
  estado: EstadoPedido;
  /**
   * The pedido's sales channel is a marketplace (`ehMarketplace(integracao.tipo)`,
   * FAIL CLOSED: an unknown or missing integração counts as a marketplace). A
   * marketplace pedido's estado belongs to the marketplace ladder, but the
   * payment reconcile has no such gate — a link payment would jump it straight
   * to `pago` and authorise dispatch.
   */
  canalMarketplace: boolean;
  /** An NF-e locks the pagamentos — {@link pagamentosTravadosPorNFe} decides it. */
  pagamentosTravadosPorNFe: boolean;
  /** Still to pay — `coberturaDoPedido(...).restante`. */
  restante: number | null | undefined;
}

/**
 * Every numeric limit of the feature, in one place, so the form, the route and
 * the copy text cannot disagree.
 *
 *  - `nomePagadorMax`      — the payer label; also `linkPgtoMercadoPago.nomePagador`.
 *  - `linksPorLoteMax`     — links in ONE create request (a vaquinha of up to 20).
 *  - `linksPorPedidoMax`   — links a pedido may accumulate, cancelled and expired
 *    included. Equal to the link collection's `defaultQuery.limit`: the tab builds
 *    its summaries from that one page, so a pedido can never hold more links than
 *    the page shows.
 *  - `quantidadeMaximaMax` — payments one shared link accepts.
 *  - `parcelasMax`         — installments offered on a card.
 *  - `valorMinimo`         — the least (R$) one link may charge.
 *  - `expiracaoDiasPadrao` / `expiracaoDiasMax` — default and maximum horizon of
 *    a link's deadline, in days from today. Mercado Pago recommends at least
 *    three days for Pix and boleto. The maximum is 29, not 30: the deadline is
 *    the END of the chosen day (23:59:59 in São Paulo), so "today + 30" would sit
 *    up to a day past Pix's 30-day `date_of_expiration` bound, while the end of
 *    "today + 29" always stays under it.
 */
export const LIMITES_LINK_PAGAMENTO = {
  nomePagadorMax: 20,
  linksPorLoteMax: 20,
  linksPorPedidoMax: 50,
  quantidadeMaximaMax: 50,
  parcelasMax: 12,
  valorMinimo: 1,
  expiracaoDiasPadrao: 3,
  expiracaoDiasMax: 29,
} as const;

/**
 * The first reason a pedido cannot receive a payment link right now, or `null`
 * when it can. Checked in this order, so the message names the most fundamental
 * blocker and the answer never depends on which check ran first on which
 * surface:
 *
 * 1. `entrada`  — links exist only on saída pedidos (`ehSaida === false` blocks).
 * 2. `canal`    — a marketplace channel.
 * 3. `estado`   — {@link podeGerarLinkPagamento}.
 * 4. `nfe`      — an NF-e locks the pagamentos.
 * 5. `semValor` — less left to charge than ONE link may charge
 *    ({@link LIMITES_LINK_PAGAMENTO}`.valorMinimo`, R$ 1,00 — the same floor the
 *    route's body schema enforces, so the tab never offers a button whose every
 *    possible request the route would refuse). A remainder below it is settled by
 *    registering the pagamento by hand. (`restante` comes from
 *    `coberturaDoPedido` already rounded to the centavo; like every money
 *    comparison here, the check goes through `centavosDeReais`.)
 *
 * The web calls this for the notice and the button; the route re-derives every
 * input INSIDE its transaction and answers 409 with the same reason.
 */
export function motivoBloqueioLinkPagamento(
  i: BloqueioLinkPagamentoInput,
): MotivoRecusaLink | null {
  if (i.ehSaida === false) return MOTIVO_RECUSA_LINK.entrada;
  if (i.canalMarketplace) return MOTIVO_RECUSA_LINK.canal;
  if (!podeGerarLinkPagamento(i.estado)) return MOTIVO_RECUSA_LINK.estado;
  if (i.pagamentosTravadosPorNFe) return MOTIVO_RECUSA_LINK.nfe;
  if (
    i.restante == null ||
    !Number.isFinite(i.restante) ||
    centavosDeReais(i.restante) < centavosDeReais(LIMITES_LINK_PAGAMENTO.valorMinimo)
  ) {
    return MOTIVO_RECUSA_LINK.semValor;
  }
  return null;
}

/**
 * Whether the pedido's NF-e locks its pagamentos — the input
 * {@link motivoBloqueioLinkPagamento} calls `pagamentosTravadosPorNFe`. It is the
 * rule the pedido editor computes for `pagamentosBloqueadosPorNFe`
 * (`apps/web/app/(app)/pedidos/_components/PedidoForm.tsx`), extracted so the
 * form and the `apps/mercado-pago` link routes cannot describe one lock two ways:
 *
 *  - a `cancelada` / `numeracaoInutilizada` NF-e ({@link nfeFiscalEncerrada})
 *    locks them outright, in ANY pedido estado — nothing is left to change;
 *  - an `aprovada` NF-e locks them except in the carve-out estados
 *    ({@link travarPagamentoComNFe}: `iniciado`, `aguardandoConfirmacaoDePagamento`
 *    and `cancelado` — the legacy save flow re-allows the write there);
 *  - any other NF-e estado (`gerado`, `enviando`, `rejeitada`, `error`, …) or no
 *    NF-e at all leaves them editable.
 *
 * `nfeEstado` is the estado of the pedido's NEWEST NF-e (by
 * `ultima_modificacao`), the same document the editor's `limit(1)` query reads;
 * the caller picks it, this only judges it. `null` / `undefined` means the pedido
 * has no NF-e.
 */
export function pagamentosTravadosPorNFe(
  nfeEstado: EstadoNFe | null | undefined,
  estadoPedido: EstadoPedido,
): boolean {
  if (nfeEstado == null) return false;
  return (
    nfeFiscalEncerrada(nfeEstado) ||
    (nfeEstado === ESTADO_NFE.aprovada && travarPagamentoComNFe(estadoPedido))
  );
}

/* -------------------------------------------------------------------------- */
/*                              Payer first name                               */
/* -------------------------------------------------------------------------- */

/** The locale every name is cased with — explicit, so a host's default locale never leaks in. */
const LOCALE_NOME = 'pt-BR';

/**
 * Longest name kept — counted in UTF-16 code units (`String.length`), which is
 * how Zod's `.max(20)` on `pagamento.primeiroNomePagador` counts too. The two
 * MUST agree: a name that fails that schema throws inside the reconcile
 * transaction, is treated as transient and parks a REAL payment.
 */
const NOME_MAX = 20;

/**
 * Cardholder names Mercado Pago's test cards return for each simulated outcome
 * (`APRO` approved, `OTHE` general error, `CONT` pending, …). A sandbox payment
 * never reconciles (the webhook drops `live_mode=false`), so this is only a
 * second line of defence: it keeps a test name from ever becoming a "first name".
 * Compared case-insensitively against the raw token, BEFORE title-casing.
 */
const NOMES_DE_TESTE_MP: ReadonlySet<string> = new Set([
  'APRO',
  'OTHE',
  'CONT',
  'CALL',
  'FUND',
  'SECU',
  'EXPI',
  'FORM',
  'CARD',
  'INST',
  'DUPL',
  'LOCK',
  'CTNA',
  'ATTE',
  'BLAC',
  'UNSU',
]);

/** Anything a first name may keep: Latin letters, combining marks, apostrophe, hyphen. */
const FORA_DO_NOME = /[^\p{Script=Latin}\p{M}'-]/gu;

/** The only shape an output may have: `Ana`, `Ana-Clara`, `D'ávila`, `José`. */
const FORMA_DO_NOME = /^\p{Lu}[\p{Ll}\p{M}']*(?:-\p{Lu}[\p{Ll}\p{M}']*)*$/u;

/** A name is Latin letters, marks, apostrophes and hyphens and nothing else. */
const CARACTERES_DO_NOME = /^[\p{Script=Latin}\p{M}'-]+$/u;

/** Upper-case the first letter, lower-case the rest (`'ß'` → `'Ss'`, never `'SS'`). */
function capitalizar(segmento: string): string {
  const [primeiro = '', ...resto] = Array.from(segmento);
  const [cabeca = '', ...cauda] = Array.from(primeiro.toLocaleUpperCase(LOCALE_NOME));
  return cabeca + (cauda.join('') + resto.join('')).toLocaleLowerCase(LOCALE_NOME);
}

/** {@link extrairPrimeiroNome} for ONE source: the name it carries, or `null`. */
function primeiroNomeDe(fonte: unknown): string | null {
  if (typeof fonte !== 'string') return null;
  const bruto = fonte.normalize('NFC').trim();
  if (bruto === '') return null;
  // An e-mail, a CPF, a card number or any "name" with a digit is not a name.
  if (/[@\p{Nd}]/u.test(bruto)) return null;

  const token = bruto.split(/\s+/u)[0] ?? '';
  const limpo = token
    .replace(FORA_DO_NOME, '')
    // A run of combining marks is capped at two: no legitimate name stacks more,
    // and "zalgo" text would otherwise spend the whole 20-unit budget on marks.
    .replace(/(\p{M}{2})\p{M}+/gu, '$1')
    .replace(/^[-']+|[-']+$/gu, '');

  if ((limpo.match(/\p{L}/gu) ?? []).length < 2) return null;
  if (NOMES_DE_TESTE_MP.has(limpo.toLocaleUpperCase(LOCALE_NOME))) return null;

  const titulo = limpo
    .split('-')
    .map((segmento) => segmento.replace(/^'+|'+$/gu, ''))
    .filter((segmento) => segmento !== '')
    .map(capitalizar)
    .join('-');
  // Truncate AFTER casing: `'ß'` grows to two characters, so truncating first and
  // casing second could overshoot the schema's 20. A cut can leave a dangling
  // hyphen / apostrophe — strip it again.
  const nome = titulo.slice(0, NOME_MAX).replace(/[-']+$/u, '');

  if (nome.length < 2 || nome.length > NOME_MAX) return null;
  // Final guard. Casing can produce characters no rule above anticipated (`'ŉ'`
  // upper-cases to a modifier letter apostrophe + `N`; a lone surrogate can
  // survive the cut): anything off-shape is dropped, never persisted.
  if (!CARACTERES_DO_NOME.test(nome) || !FORMA_DO_NOME.test(nome)) return null;
  return nome;
}

/**
 * A payer's FIRST name (LGPD data minimisation — the ERP never stores a
 * surname it does not need), or `null` when none of the sources yields one.
 * Sources are tried in order and the FIRST whose extraction is non-null wins, so
 * a `payer.first_name` REJECTED below (an e-mail, say) falls through to the
 * cardholder name instead of ending the search.
 *
 * Per source:
 *  1. must be a string; NFC-normalised and trimmed; blank → nothing;
 *  2. contains `@` or ANY digit → nothing (e-mails, CPFs, card-like strings);
 *  3. only the first whitespace token is kept, reduced to Latin letters, marks,
 *     `'` and `-` (leading / trailing `-` `'` stripped);
 *  4. fewer than two letters → nothing (an initial is not a name);
 *  5. a Mercado Pago TEST cardholder (`APRO`, `OTHE`, …) → nothing, compared
 *     case-insensitively BEFORE the name is title-cased;
 *  6. title-cased per hyphen segment (`ANA-CLARA` → `Ana-Clara`), THEN cut to 20
 *     UTF-16 units;
 *  7. a final shape guard — the result is `null` or matches
 *     `/^\p{Lu}[\p{Ll}\p{M}']*(?:-\p{Lu}[\p{Ll}\p{M}']*)*$/u` with length 2..20,
 *     i.e. it always passes `pagamentoSchema.shape.primeiroNomePagador`.
 *
 * Never throws. Latin only by design: a CJK / Arabic / Hebrew name has no case
 * and would not survive the shape guard, and the operator's own per-person
 * label (`nomePagador`) is the reliable name source for those payers anyway.
 *
 * ⚠️ Pix gives no payer name at all — only the payer's BANK — so this reads
 * `payer.first_name` and `card.cardholder.name`, never the Pix bank block.
 */
export function extrairPrimeiroNome(...fontes: ReadonlyArray<unknown>): string | null {
  for (const fonte of fontes) {
    const nome = primeiroNomeDe(fonte);
    if (nome !== null) return nome;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*                                 Link quota                                  */
/* -------------------------------------------------------------------------- */

/**
 * Whether a link has received all the payments it accepts — the trigger for the
 * backend's auto-close (PUT expire on the Mercado Pago preference, then
 * `status = concluido`).
 *
 * Counts payments that were EVER approved (`dataAprovacao != null`), NOT the
 * ones that currently count as paid ({@link isPagamentoPagante}): a payment
 * approved and later refunded still used up one of the link's slots at the
 * moment it was taken, and the link must not be left open to be paid again on
 * the strength of a refund. (The DISPLAY, {@link resumirLinksPagamento},
 * deliberately counts the paying ones — that is money in hand.)
 *
 * The quota is {@link cotaDoLink} — the SAME reading the summary uses — so a
 * TRACEABLE link (`modo` set) with no usable `quantidadeMaxima` accepts ONE
 * payment, while a LEGACY link (no readable `modo`) never reaches a quota, even
 * one it happens to store: payments cannot be attributed to it, and it was
 * created under the legacy application.
 */
export function linkAtingiuCota(
  link: { quantidadeMaxima?: number | null; modo?: unknown },
  pagamentosDoLink: ReadonlyArray<{ dataAprovacao?: number | null }>,
): boolean {
  const aprovados = pagamentosDoLink.filter((p) => p.dataAprovacao != null).length;
  return linkAtingiuCotaComAprovados(link, aprovados);
}

/**
 * {@link linkAtingiuCota} for a caller that already holds the count of payments
 * EVER approved on the link (the webhook's auto-close gets it from the reconcile
 * as `aprovadosDoLink`). ONE rule, two entry points: the list form above only
 * counts and delegates here.
 *
 * Written as "reached" rather than "not reached", so a count that is not a
 * number (`NaN`) leaves the link OPEN instead of closing it.
 */
export function linkAtingiuCotaComAprovados(
  link: { quantidadeMaxima?: number | null; modo?: unknown },
  aprovados: number,
): boolean {
  const rastreavel = modoLinkPagamentoSchema.safeParse(link.modo).success;
  if (!rastreavel) return false;
  const cota = cotaDoLink(link.quantidadeMaxima, rastreavel);
  return cota !== null && aprovados >= cota;
}

/**
 * Payments a link accepts, read the ONE way every quota rule here reads it (the
 * summary's `quantidadeMaxima` / `restantes` and {@link linkAtingiuCota}): the
 * stored `quantidadeMaxima` when it is an integer `>= 1`; otherwise `1` for a
 * TRACEABLE link (the create flow always stores a quota, and a per-person link
 * accepts one payment); otherwise `null` — no quota — for a legacy one.
 */
function cotaDoLink(quantidadeMaxima: unknown, rastreavel: boolean): number | null {
  return inteiroOuNull(quantidadeMaxima, 1) ?? (rastreavel ? 1 : null);
}

/* -------------------------------------------------------------------------- */
/*                              Summarising links                              */
/* -------------------------------------------------------------------------- */

/**
 * Where a link stands, DERIVED from its stored `status`, its expiry, the clock
 * and the payments attributed to it (expiry is never stored):
 *  - `aberto`    — payable, nothing paid yet;
 *  - `parcial`   — a `compartilhado` link with some but not all payments in;
 *  - `pago`      — every payment the link accepts has been received;
 *  - `expirado`  — past its `dataExpiracao` with the quota unmet;
 *  - `cancelado` — withdrawn by the operator with the quota unmet;
 *  - `legado`    — written by the legacy app: payments cannot be attributed to
 *    it, so its true state is unknown.
 */
export const situacaoLinkPagamentoSchema = z.enum([
  'aberto',
  'parcial',
  'pago',
  'expirado',
  'cancelado',
  'legado',
]);
export type SituacaoLinkPagamento = z.infer<typeof situacaoLinkPagamentoSchema>;

/** Named members of {@link situacaoLinkPagamentoSchema}. */
export const SITUACAO_LINK_PAGAMENTO = {
  aberto: 'aberto',
  parcial: 'parcial',
  pago: 'pago',
  expirado: 'expirado',
  cancelado: 'cancelado',
  legado: 'legado',
} as const satisfies Record<string, SituacaoLinkPagamento>;

export const SITUACAO_LINK_PAGAMENTO_LABELS: Record<SituacaoLinkPagamento, string> = {
  aberto: 'Aberto',
  parcial: 'Parcialmente pago',
  pago: 'Pago',
  expirado: 'Expirado',
  cancelado: 'Cancelado',
  legado: 'Legado (sem rastreio)',
};

/** One link of a pedido, summarised with the payments attributed to it. */
export interface LinkPagamentoResumo {
  /** The link's DOC id — never the `id` field (that is the preference id). */
  linkId: string;
  /** `null` ⇒ a legacy link. */
  modo: ModoLinkPagamento | null;
  /** `modo != null`: payments can be attributed to it. `false` for legacy links. */
  rastreavel: boolean;
  /** The amount each payment on this link charges (`valorCobrado`). */
  valor: number;
  /** The operator's label for the payer. */
  nomePagador: string | null;
  /** Payments the link accepts: stored, else `1` when traceable, else `null`. */
  quantidadeMaxima: number | null;
  /** Attributed payments that currently count as paid ({@link isPagamentoPagante}). */
  pagos: number;
  /** `max(0, quantidadeMaxima - pagos)`, or `null` without a quota. */
  restantes: number | null;
  /** Σ of the paying attributed payments ({@link sumPagamentosPagos}). */
  valorRecebido: number;
  /** The paying attributed payments, oldest approval first; FIRST names only. */
  pagantes: Array<{ nome: string | null; dataAprovacao: number | null }>;
  situacao: SituacaoLinkPagamento;
  /** Expiry, epoch MILLISECONDS (the link collection's unit), or `null`. */
  dataExpiracaoMs: number | null;
  link: string | null;
  /** Doc id of the `metodo_pgto` account that owns the link. */
  contaId: string | null;
  /** Mercado Pago's preference id (the link doc's `id` field). */
  preferenceId: string | null;
  /** The STORED status (`null` when the doc has none, e.g. a raw legacy read). */
  status: StatusLinkPagamento | null;
  ordem: number | null;
  grupoId: string | null;
  /** Creation, epoch MILLISECONDS, or `null`. */
  dataCriacaoMs: number | null;
}

/** Later than year 9999: not a date any ERP document carries — treated as absent. */
const MS_MAXIMO = 253_402_300_799_999;

/** A plain-object view of a raw value; anything else reads as empty. */
function comoRegistro(valor: unknown): Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : {};
}

/** A non-blank string, or `null`. */
function textoOuNull(valor: unknown): string | null {
  return typeof valor === 'string' && valor.trim() !== '' ? valor : null;
}

/** A finite number `>= 0`, or `fallback`. */
function numeroNaoNegativo(valor: unknown, fallback: number): number {
  return typeof valor === 'number' && Number.isFinite(valor) && valor >= 0 ? valor : fallback;
}

/** An integer `>= min`, or `null`. */
function inteiroOuNull(valor: unknown, min: number): number | null {
  return typeof valor === 'number' && Number.isInteger(valor) && valor >= min ? valor : null;
}

/**
 * Any stored date (ms, µs, ISO, `Date`) as epoch milliseconds, or `null` when it
 * is absent, unreadable or outside `1970..9999` — so `dataCivilNoFuso` can never
 * be handed an instant it rejects, however corrupt the legacy doc.
 */
function millisOuNull(valor: unknown): number | null {
  const ms = coerceToMillis(valor);
  return ms !== null && ms > 0 && ms <= MS_MAXIMO ? ms : null;
}

/** One attributed pagamento, read defensively. */
interface PagamentoDoLink {
  valor: number;
  status_pagamento: number | null;
  pagante: boolean;
  primeiroNome: string | null;
  dataAprovacaoMs: number | null;
  posicao: number;
}

/**
 * The {@link SituacaoLinkPagamento} of one link, first match wins:
 *
 * 1. no `modo` (a legacy link) → `legado`;
 * 2. `pagos >= quantidade` → `pago`. This comes BEFORE the stored `cancelado`:
 *    cancelling is best effort (a PUT-expire may not stop a Pix already issued),
 *    so a link paid after — or while racing — its cancellation must still read
 *    as paid, or the operator re-sends it and the pedido is overpaid (which
 *    blocks NF-e emission, cStat 866);
 * 3. stored `cancelado` → `cancelado`;
 * 4. stored `concluido` → `pago` (auto-closed after its quota);
 * 5. `dataExpiracao < agoraMs` (STRICT: at the exact instant it is still open)
 *    → `expirado`;
 * 6. some payments in → `parcial`;
 * 7. otherwise `aberto`.
 */
function situacaoDoLink(i: {
  rastreavel: boolean;
  pagos: number;
  quantidade: number | null;
  status: StatusLinkPagamento | null;
  dataExpiracaoMs: number | null;
  agoraMs: number;
}): SituacaoLinkPagamento {
  if (!i.rastreavel) return SITUACAO_LINK_PAGAMENTO.legado;
  if (i.pagos >= (i.quantidade ?? 1)) return SITUACAO_LINK_PAGAMENTO.pago;
  if (i.status === STATUS_LINK_PAGAMENTO.cancelado) return SITUACAO_LINK_PAGAMENTO.cancelado;
  if (i.status === STATUS_LINK_PAGAMENTO.concluido) return SITUACAO_LINK_PAGAMENTO.pago;
  if (i.dataExpiracaoMs !== null && i.dataExpiracaoMs < i.agoraMs) {
    return SITUACAO_LINK_PAGAMENTO.expirado;
  }
  return i.pagos > 0 ? SITUACAO_LINK_PAGAMENTO.parcial : SITUACAO_LINK_PAGAMENTO.aberto;
}

/**
 * Summarise the links of a pedido with the payments attributed to them.
 *
 * ⚠️ Every row may be RAW: a soft-read that fails its parse hands back the raw
 * document, so each field is read with a `typeof` check and nothing throws.
 *
 * ## Attribution
 * A pagamento belongs to link `L` when `pagamento.linkPagamentoId === L.id`,
 * where `L.id` is the link's DOC id. Never the `id` FIELD — that is Mercado
 * Pago's preference id, and matching on it would credit a payment to whichever
 * link happens to carry that string. A pagamento with no `linkPagamentoId`
 * (manual, legacy, or Mercado Pago dropped the metadata) belongs to no link.
 * `pagos` / `valorRecebido` / `pagantes` count only the attributed payments
 * that are paying ({@link isPagamentoPagante}); a pending or refused one is not.
 *
 * ## Situação
 * See {@link situacaoDoLink}.
 *
 * The result is ordered by `ordem` ascending (links without one last), then by
 * creation, newest first.
 */
export function resumirLinksPagamento(i: {
  links: ReadonlyArray<{ id: string; data: unknown }>;
  pagamentos: ReadonlyArray<{ id: string; data: unknown }>;
  agoraMs: number;
}): LinkPagamentoResumo[] {
  // Group the attributed pagamentos by the link DOC id they name.
  const porLink = new Map<string, PagamentoDoLink[]>();
  i.pagamentos.forEach((pagamento, posicao) => {
    const dados = comoRegistro(pagamento.data);
    const linkId = textoOuNull(dados.linkPagamentoId);
    if (linkId === null) return;

    // A missing status counts as paid (the canonical rule); a status that is
    // neither absent nor a number is corrupt — the row is skipped, not guessed at.
    const bruto = dados.status_pagamento;
    let status: number | null;
    if (bruto == null) status = null;
    else if (typeof bruto === 'number' && Number.isFinite(bruto)) status = bruto;
    else return;

    const lista = porLink.get(linkId) ?? [];
    lista.push({
      valor: numeroNaoNegativo(dados.valor, 0),
      status_pagamento: status,
      pagante: isPagamentoPagante(status),
      primeiroNome: textoOuNull(dados.primeiroNomePagador),
      dataAprovacaoMs: millisOuNull(dados.dataAprovacao),
      posicao,
    });
    porLink.set(linkId, lista);
  });

  const resumos = i.links.map((link): LinkPagamentoResumo => {
    const dados = comoRegistro(link.data);
    const modoLido = modoLinkPagamentoSchema.safeParse(dados.modo);
    const modo = modoLido.success ? modoLido.data : null;
    const statusLido = statusLinkPagamentoSchema.safeParse(dados.status);
    const status = statusLido.success ? statusLido.data : null;
    const rastreavel = modo !== null;
    const nomePagador = textoOuNull(dados.nomePagador);
    const dataExpiracaoMs = millisOuNull(dados.dataExpiracao);

    const pagantesBrutos = (porLink.get(link.id) ?? []).filter((p) => p.pagante);
    const pagos = pagantesBrutos.length;
    const quantidade = cotaDoLink(dados.quantidadeMaxima, rastreavel);
    const restantes = quantidade === null ? null : Math.max(0, quantidade - pagos);

    const pagantes = [...pagantesBrutos]
      .sort((a, b) => {
        if (a.dataAprovacaoMs !== b.dataAprovacaoMs) {
          if (a.dataAprovacaoMs === null) return 1; // no approval date sorts last
          if (b.dataAprovacaoMs === null) return -1;
          return a.dataAprovacaoMs - b.dataAprovacaoMs;
        }
        return a.posicao - b.posicao;
      })
      .map((p) => ({
        // A shared link's payers are only known from the cardholder; an individual
        // link is named by the operator first, the cardholder second.
        nome:
          modo === MODO_LINK_PAGAMENTO.compartilhado
            ? p.primeiroNome
            : (nomePagador ?? p.primeiroNome),
        dataAprovacao: p.dataAprovacaoMs,
      }));

    const situacao = situacaoDoLink({
      rastreavel,
      pagos,
      quantidade,
      status,
      dataExpiracaoMs,
      agoraMs: i.agoraMs,
    });

    const contaRef = textoOuNull(dados.contaMercadoPagoOuterRef);
    return {
      linkId: link.id,
      modo,
      rastreavel,
      valor: numeroNaoNegativo(dados.valorCobrado, 0),
      nomePagador,
      quantidadeMaxima: quantidade,
      pagos,
      restantes,
      valorRecebido: sumPagamentosPagos(pagantesBrutos),
      pagantes,
      situacao,
      dataExpiracaoMs,
      link: textoOuNull(dados.link),
      contaId: contaRef === null ? null : idFromRef(contaRef) || null,
      preferenceId: textoOuNull(dados.id),
      status,
      ordem: inteiroOuNull(dados.ordem, 0),
      grupoId: textoOuNull(dados.grupoId),
      dataCriacaoMs: millisOuNull(dados.dataCriacao),
    };
  });

  return resumos
    .map((resumo, posicao) => ({ resumo, posicao }))
    .sort((a, b) => {
      const ordemA = a.resumo.ordem;
      const ordemB = b.resumo.ordem;
      if (ordemA !== ordemB) {
        if (ordemA === null) return 1; // no ordem sorts last
        if (ordemB === null) return -1;
        return ordemA - ordemB;
      }
      const criadoA = a.resumo.dataCriacaoMs;
      const criadoB = b.resumo.dataCriacaoMs;
      if (criadoA !== criadoB) {
        if (criadoA === null) return 1; // undated is the oldest
        if (criadoB === null) return -1;
        return criadoB - criadoA; // newest first
      }
      return a.posicao - b.posicao;
    })
    .map(({ resumo }) => resumo);
}

/**
 * Whether a summarised link can still receive a payment: TRACEABLE and `aberto` /
 * `parcial`. The ONE definition of "open" — {@link valorEmAbertoEmLinks}, both copy
 * messages and the backend's exposure guard (`apps/mercado-pago`'s
 * `elegibilidade.ts`, which must tell the links this sum covers from the ones it
 * does not) all ask it here.
 */
export function linkPagamentoEmAberto(resumo: LinkPagamentoResumo): boolean {
  return (
    resumo.rastreavel &&
    (resumo.situacao === SITUACAO_LINK_PAGAMENTO.aberto ||
      resumo.situacao === SITUACAO_LINK_PAGAMENTO.parcial)
  );
}

/**
 * Money that open links could still bring in: Σ over the TRACEABLE links that
 * are `aberto` / `parcial` of `valor × restantes` (a shared link counts once per
 * payment it still accepts). Compared with the pedido's `restante` it is the
 * overpayment guard — creating a link worth more than `restante - emAberto` can
 * only overshoot, and an overshoot blocks NF-e emission (cStat 866: Mercado
 * Pago money is never tPag 01 dinheiro, so no troco is allowed).
 *
 * Legacy links are EXCLUDED: they can never show `pagos > 0`, so an unexpired
 * legacy link that was in fact paid long ago would otherwise count as fully open
 * forever and block every new link. The UI lists them separately as "sem rastreio".
 */
export function valorEmAbertoEmLinks(resumos: ReadonlyArray<LinkPagamentoResumo>): number {
  let centavos = 0;
  for (const resumo of resumos) {
    if (!linkPagamentoEmAberto(resumo)) continue;
    centavos += centavosDeReais(resumo.valor) * (resumo.restantes ?? 1);
  }
  return roundReais(centavos / 100);
}

/* -------------------------------------------------------------------------- */
/*                                Copy messages                                */
/* -------------------------------------------------------------------------- */

/** `DD/MM` of an instant on the civil calendar of `fuso` (never the ambient zone). */
function diaMes(ms: number, fuso: string): string {
  const [, mes = '', dia = ''] = dataCivilNoFuso(ms, fuso).split('-');
  return `${dia}/${mes}`;
}

/**
 * The plain-text message with every payable link, ready to paste into WhatsApp
 * (the app never sends it — the operator copies it). `null` when no traceable
 * link is `aberto` / `parcial` with a URL.
 *
 * ```
 * Pedido 1234 — links de pagamento:
 *
 * Maria: R$ 33,34 (até 30/09)
 * https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=…
 *
 * Link compartilhado — 3 × R$ 50,00 (até 30/09)
 * https://…
 * ```
 *
 * One block per link, blank-line separated, in the order of `resumos`. A link
 * with no `nomePagador` is `Link k` (its position in the message). The deadline
 * is a civil `DD/MM` in `fuso` — the day the payer sees, not the UTC day — so the
 * caller passes the fiscal zone (`FUSO_FISCAL`). An invalid `fuso` throws.
 */
export function mensagemLinksPagamento(i: {
  numeroPedido: string | null;
  resumos: ReadonlyArray<LinkPagamentoResumo>;
  fuso: string;
}): string | null {
  const enviaveis = i.resumos.filter((r) => linkPagamentoEmAberto(r) && r.link !== null);
  if (enviaveis.length === 0) return null;

  const cabecalho = i.numeroPedido
    ? `Pedido ${i.numeroPedido} — links de pagamento:`
    : 'Links de pagamento:';

  const blocos = enviaveis.map((resumo, indice) => {
    const validade =
      resumo.dataExpiracaoMs === null ? '' : ` (até ${diaMes(resumo.dataExpiracaoMs, i.fuso)})`;
    const titulo =
      resumo.modo === MODO_LINK_PAGAMENTO.compartilhado
        ? `Link compartilhado — ${resumo.restantes ?? 0} × ${formatReais(resumo.valor)}`
        : `${resumo.nomePagador ?? `Link ${indice + 1}`}: ${formatReais(resumo.valor)}`;
    return `${titulo}${validade}\n${resumo.link}`;
  });

  return [cabecalho, ...blocos].join('\n\n');
}

/**
 * The plain-text "quem já pagou" message: FIRST NAMES ONLY — no amounts, no
 * URLs, no surnames, nothing that identifies a payer beyond the name the group
 * already knows them by (LGPD). `null` when nobody has paid.
 *
 * ```
 * Pedido 1234 — quem já pagou:
 * ✅ Maria
 * ✅ João
 * ✅ 1 pagamento(s) sem nome
 *
 * Aguardando:
 * ⏳ Ana
 * ```
 *
 * One `✅` line per paying attributed payment across the traceable links, oldest
 * approval first; payments whose payer is unknown collapse into a single
 * `✅ n pagamento(s) sem nome` line. The `Aguardando:` block lists the
 * `individual` links that are still open and were given a name — a shared link
 * has no one to wait for by name.
 *
 * The names are printed as the summary carries them: a first name from the
 * Mercado Pago cardholder ({@link extrairPrimeiroNome}) or the operator's own
 * per-person label (at most 20 characters, asked for as a first name). This
 * function adds no data of its own.
 */
export function mensagemQuemJaPagou(i: {
  numeroPedido: string | null;
  resumos: ReadonlyArray<LinkPagamentoResumo>;
}): string | null {
  const rastreaveis = i.resumos.filter((r) => r.rastreavel);
  const pagantes = rastreaveis
    .flatMap((r) => r.pagantes)
    .map((pagante, posicao) => ({ ...pagante, posicao }))
    .sort((a, b) => {
      if (a.dataAprovacao !== b.dataAprovacao) {
        if (a.dataAprovacao === null) return 1; // no approval date sorts last
        if (b.dataAprovacao === null) return -1;
        return a.dataAprovacao - b.dataAprovacao;
      }
      return a.posicao - b.posicao;
    });
  if (pagantes.length === 0) return null;

  const cabecalho = i.numeroPedido ? `Pedido ${i.numeroPedido} — quem já pagou:` : 'Quem já pagou:';

  const nomeados = pagantes.flatMap((p) => (p.nome === null ? [] : [`✅ ${p.nome}`]));
  const semNome = pagantes.length - nomeados.length;
  const linhas = [cabecalho, ...nomeados];
  if (semNome > 0) linhas.push(`✅ ${semNome} pagamento(s) sem nome`);

  const aguardando = rastreaveis.flatMap((r) =>
    r.modo === MODO_LINK_PAGAMENTO.individual && linkPagamentoEmAberto(r) && r.nomePagador !== null
      ? [`⏳ ${r.nomePagador}`]
      : [],
  );
  if (aguardando.length > 0) linhas.push('', 'Aguardando:', ...aguardando);

  return linhas.join('\n');
}
