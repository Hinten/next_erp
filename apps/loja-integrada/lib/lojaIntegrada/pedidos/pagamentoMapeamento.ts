/**
 * A Loja Integrada order's `pagamentos[]` → one `pedidos/{id}/pagamentos/{id}`
 * document each (master plan step 6, PR 5-b): the forma, the card block, the
 * instalments, the status the step-5 decision gives, the dates the history
 * gives — and the overlay an update applies to a stored document.
 *
 * PURE: no Firestore, no clock (`nowUs` is a parameter). Every entry of the
 * list is mapped, never only the first.
 *
 * ## Money
 *
 * `valor = roundReais(valor)`, NEVER `valor_pago`: the platform's `valor_pago`
 * is a copy of the amount due, equal to `valor` on an order still awaiting
 * payment. Whether money was captured comes from the situação codigo alone. A
 * payment with no `valor`, or a negative one, cannot be written: the mapping
 * answers `ok: false` with the field path and the importer refuses the order
 * before any write.
 *
 * ## The forma: `pagamento_tipo` first, then the exact codigo, else 99
 *
 *  - `pagamento_tipo`: `instantPayment` → PIX (17), `creditCard` → card (3),
 *    `bankInvoice` → boleto (15). Exact: `INSTANTPAYMENT` is not a tipo.
 *  - Else `forma_pagamento.codigo`, EXACT: the boleto family → 15, the PIX
 *    gateways → 17, the card gateway → 3, `deposito` → 16.
 *  - Else 99 (`outros`), with `descricaoPagamento = 'Loja Integrada: <codigo>'`
 *    (the NF-e's `xPag`, cut to its 60 characters). A redirect gateway stays 99
 *    until a capture shows what it carries.
 *
 * On update the forma, `parcelas` and `aVista` are overlaid ONLY from a known
 * forma: a 99 is a guess, and never overwrites a stored one (an operator's
 * correction, or a known forma from an earlier import).
 *
 * ## The card block
 *
 * PIX, credit and debit (3, 4, 17) always carry
 * `{ tpIntegra: '2', bandeira: null, cAut: authorization_code }`: the NF-e
 * needs a card group on those formas, and a paid card order may carry no
 * authorization code. The brand stays `null` until a capture shows the
 * platform's brand vocabulary. On update it is fill-once.
 *
 * ## Instalments
 *
 * `parcelas = max(1, numero_parcelas ?? 1)` — `parcelamento` is `{}` on PIX and
 * boleto — and `aVista = parcelas <= 1`. `juros`, `tarifas` and `vencimento`
 * are `null`: the order's expiry is never a boleto due date.
 *
 * ## Clocks and the overlay (root `CLAUDE.md` rule 7, tier 2)
 *
 * `lastProviderUpdate` is the ORDER's Loja Integrada stamp in µs — never
 * compared with `ultimaModificacao`, which is the ERP's own clock. A stored
 * stamp strictly newer ⇒ `obsoleto`, nothing written; equal or older ⇒ the
 * patch is built, and an empty one writes nothing. The accepted stamp is
 * written, never a max. The overlay: `valor`, the status (through the ladder,
 * or kept), `lastProviderUpdate`, and the approval and cancellation dates when
 * the history could derive them; fill-once `id`, `dataCadastro` and `cartao`;
 * `ultimaModificacao = max(stored, now)` on a non-empty patch.
 */
import { roundReais } from '@delfrance/core/money';
import type { PedidoLi, PedidoPagamentoLi } from '@delfrance/integrations-loja-integrada';
import {
  FORMA_PAGAMENTO,
  type Cartao,
  type FormaPagamento,
  type StatusPagamento,
} from '@delfrance/schemas';

import { dataLiParaMicros, microsArmazenadoLi } from './dataLi';
import {
  statusPagamentoLiAplicavel,
  type AlvoStatusPagamentoLi,
  type DataDoHistoricoLi,
} from './estadoPedidoLi';
import { idPagamentoLi } from './orderIdsLi';

/* -------------------------------------------------------------------------- */
/*                                  the forma                                  */
/* -------------------------------------------------------------------------- */

/** `pagamento_tipo` → forma, EXACT. */
const FORMA_POR_TIPO: ReadonlyMap<string, FormaPagamento> = new Map<string, FormaPagamento>([
  ['instantPayment', FORMA_PAGAMENTO.pix],
  ['creditCard', FORMA_PAGAMENTO.cartao_credito],
  ['bankInvoice', FORMA_PAGAMENTO.boleto_bancario],
]);

/** `forma_pagamento.codigo` → forma, EXACT. */
const FORMA_POR_CODIGO: ReadonlyMap<string, FormaPagamento> = new Map<string, FormaPagamento>([
  ...[
    'boleto',
    'wcboleto',
    'pmboleto',
    'pmboletov2',
    'psboleto',
    'pagali-boleto',
    'mpboleto',
    'proxy-pagali-v2-boleto',
  ].map((codigo): [string, FormaPagamento] => [codigo, FORMA_PAGAMENTO.boleto_bancario]),
  ['pagali-pix', FORMA_PAGAMENTO.pix],
  ['proxy-pagali-v2-pix', FORMA_PAGAMENTO.pix],
  ['proxy-pagali-v2-cartao', FORMA_PAGAMENTO.cartao_credito],
  ['deposito', FORMA_PAGAMENTO.deposito_bancario],
]);

/** The formas that carry a card block. */
const FORMAS_COM_CARTAO: ReadonlySet<FormaPagamento> = new Set<FormaPagamento>([
  FORMA_PAGAMENTO.cartao_credito,
  FORMA_PAGAMENTO.cartao_debito,
  FORMA_PAGAMENTO.pix,
]);

/** `xPag`'s length in the NF-e layout. */
const MAX_DESCRICAO = 60;

/** How a forma was decided. */
export type OrigemFormaLi = 'tipo' | 'codigo' | 'outros';

export interface FormaLi {
  readonly forma: FormaPagamento;
  readonly origem: OrigemFormaLi;
  /** The raw `forma_pagamento.codigo` (for the 99 log and description). */
  readonly codigo: string | null;
  /** `'Loja Integrada: <codigo>'` for a 99, else `null`. */
  readonly descricaoPagamento: string | null;
}

/** The forma of one payment (module header). */
export function formaPagamentoLi(pagamento: PedidoPagamentoLi): FormaLi {
  const codigo = pagamento.forma_pagamento?.codigo ?? null;
  const porTipo =
    typeof pagamento.pagamento_tipo === 'string'
      ? FORMA_POR_TIPO.get(pagamento.pagamento_tipo)
      : undefined;
  if (porTipo !== undefined) {
    return { forma: porTipo, origem: 'tipo', codigo, descricaoPagamento: null };
  }
  const porCodigo = codigo === null ? undefined : FORMA_POR_CODIGO.get(codigo);
  if (porCodigo !== undefined) {
    return { forma: porCodigo, origem: 'codigo', codigo, descricaoPagamento: null };
  }
  const rotulo = codigo !== null && codigo.length > 0 ? codigo : 'sem código';
  return {
    forma: FORMA_PAGAMENTO.outros,
    origem: 'outros',
    codigo,
    descricaoPagamento: `Loja Integrada: ${rotulo}`.slice(0, MAX_DESCRICAO),
  };
}

/** The card block for a forma that needs one, else `null` (module header). */
export function cartaoLi(forma: FormaPagamento, pagamento: PedidoPagamentoLi): Cartao | null {
  if (!FORMAS_COM_CARTAO.has(forma)) return null;
  const cAut = pagamento.authorization_code;
  return {
    tpIntegra: '2',
    bandeira: null,
    numeroCartao: null,
    cAut: typeof cAut === 'string' && cAut.trim().length > 0 ? cAut.trim() : null,
    cnpj_instituicao: null,
    tarifa: null,
    tarifaFixa: null,
    prazoRecebimento: null,
  };
}

/** `max(1, numero_parcelas ?? 1)` and `aVista = parcelas <= 1`. */
export function parcelasLi(pagamento: PedidoPagamentoLi): {
  readonly parcelas: number;
  readonly aVista: boolean;
} {
  const parcelas = Math.max(1, pagamento.parcelamento?.numero_parcelas ?? 1);
  return { parcelas, aVista: parcelas <= 1 };
}

/* -------------------------------------------------------------------------- */
/*                                  the docs                                   */
/* -------------------------------------------------------------------------- */

export interface PagamentoMapeadoLi {
  readonly docId: string;
  /** The payment's id as text: the document's fill-once `id`. */
  readonly id: string;
  readonly valor: number;
  readonly forma: FormaLi;
  readonly parcelas: number;
  readonly aVista: boolean;
  readonly cartao: Cartao | null;
  /** The order's creation stamp (µs), or `null`. */
  readonly dataCadastroUs: number | null;
  readonly dataAprovacao: DataDoHistoricoLi;
  readonly dataCancelamento: DataDoHistoricoLi;
  readonly statusCriacao: StatusPagamento;
  readonly statusAtualizacao: AlvoStatusPagamentoLi;
  /** The order's Loja Integrada stamp, µs: `lastProviderUpdate`. */
  readonly watermarkUs: number;
}

export interface EntradaPagamentosLi {
  readonly contaId: string;
  readonly pedido: PedidoLi;
  /** From the step-5 decision (`decidirEstadoLi`). */
  readonly statusPagamento: {
    readonly criacao: StatusPagamento;
    readonly atualizacao: AlvoStatusPagamentoLi;
  };
  readonly dataAprovacao: DataDoHistoricoLi;
  readonly dataCancelamento: DataDoHistoricoLi;
  /** `dataLiParaMicros(pedido.data_modificacao)`. */
  readonly watermarkUs: number;
}

export type PagamentosMapeadosLi =
  /** A payment cannot be written: the field paths, never a value. */
  | { readonly ok: false; readonly campos: readonly string[] }
  | { readonly ok: true; readonly pagamentos: readonly PagamentoMapeadoLi[] };

/**
 * Every payment of the order (module header).
 *
 * @throws RangeError for a payment without a positive id — the importer's
 *   first step refuses those (`exigirIdPagamentoLi`) before calling this.
 */
export function mapearPagamentosLi(entrada: EntradaPagamentosLi): PagamentosMapeadosLi {
  const { contaId, pedido } = entrada;
  if (pedido.pagamentos.some((p) => p.valor == null || p.valor < 0)) {
    return { ok: false, campos: ['pagamentos[].valor'] };
  }
  const dataCadastroUs = dataLiParaMicros(pedido.data_criacao);
  const pagamentos = pedido.pagamentos.map((p): PagamentoMapeadoLi => {
    if (p.id == null) throw new RangeError('mapearPagamentosLi: pagamento sem id');
    const forma = formaPagamentoLi(p);
    return {
      docId: idPagamentoLi(contaId, p.id),
      id: String(p.id),
      valor: roundReais(p.valor!),
      forma,
      ...parcelasLi(p),
      cartao: cartaoLi(forma.forma, p),
      dataCadastroUs,
      dataAprovacao: entrada.dataAprovacao,
      dataCancelamento: entrada.dataCancelamento,
      statusCriacao: entrada.statusPagamento.criacao,
      statusAtualizacao: entrada.statusPagamento.atualizacao,
      watermarkUs: entrada.watermarkUs,
    };
  });
  return { ok: true, pagamentos };
}

/* -------------------------------------------------------------------------- */
/*                                 the write                                   */
/* -------------------------------------------------------------------------- */

const usOuNulo = (data: DataDoHistoricoLi): number | null => (data.derivavel ? data.us : null);

/** Nothing stored yet, for a fill-once field: `null`, absent or `''` (never `0`). */
function vazio(valor: unknown): boolean {
  return valor === null || valor === undefined || valor === '';
}

export type EscritaPagamentoLi =
  /** The full document; the importer parses it (`pagamentoSchema`) before any write. */
  | { readonly tipo: 'criar'; readonly corpo: Readonly<Record<string, unknown>> }
  /** The stored stamp is strictly newer: nothing at all is written. */
  | { readonly tipo: 'obsoleto'; readonly armazenadoUs: number }
  | { readonly tipo: 'sem-mudanca' }
  | {
      readonly tipo: 'atualizar';
      readonly patch: Readonly<Record<string, unknown>>;
      /** A dead status was left (logged). */
      readonly statusRessuscitado: boolean;
    };

/** The body a NEW pagamento is created with. */
export function corpoDoPagamentoLi(
  mapeado: PagamentoMapeadoLi,
  nowUs: number,
): Readonly<Record<string, unknown>> {
  return {
    id: mapeado.id,
    metodoPagamentoOuterRef: null,
    forma_de_pagamento: mapeado.forma.forma,
    status_pagamento: mapeado.statusCriacao,
    cartao: mapeado.cartao,
    cheque: null,
    descricaoPagamento: mapeado.forma.descricaoPagamento,
    valor: mapeado.valor,
    parcelas: mapeado.parcelas,
    juros: null,
    tarifas: null,
    aVista: mapeado.aVista,
    duplicata: false,
    nFat: null,
    marketplace: null,
    liquidacao: null,
    vencimento: null,
    ultimaModificacao: nowUs,
    lastProviderUpdate: mapeado.watermarkUs,
    dataCancelamento: usOuNulo(mapeado.dataCancelamento),
    dataAprovacao: usOuNulo(mapeado.dataAprovacao),
    dataCadastro: mapeado.dataCadastroUs,
  };
}

/**
 * The write for one payment against its STORED document (raw), or `null` for
 * a create (module header). Every value is re-derived from `armazenado`.
 */
export function montarEscritaPagamentoLi(
  armazenado: Readonly<Record<string, unknown>> | null,
  mapeado: PagamentoMapeadoLi,
  nowUs: number,
): EscritaPagamentoLi {
  if (armazenado === null) return { tipo: 'criar', corpo: corpoDoPagamentoLi(mapeado, nowUs) };

  const armazenadoUs = microsArmazenadoLi(armazenado.lastProviderUpdate);
  if (armazenadoUs !== null && mapeado.watermarkUs < armazenadoUs) {
    return { tipo: 'obsoleto', armazenadoUs };
  }

  const patch: Record<string, unknown> = {};
  if (armazenadoUs !== mapeado.watermarkUs) patch.lastProviderUpdate = mapeado.watermarkUs;
  if (armazenado.valor !== mapeado.valor) patch.valor = mapeado.valor;

  const veredito = statusPagamentoLiAplicavel(
    armazenado.status_pagamento,
    mapeado.statusAtualizacao,
  );
  if (veredito.escrever) patch.status_pagamento = veredito.status;

  for (const [campo, data] of [
    ['dataAprovacao', mapeado.dataAprovacao],
    ['dataCancelamento', mapeado.dataCancelamento],
  ] as const) {
    if (data.derivavel && microsArmazenadoLi(armazenado[campo]) !== data.us) patch[campo] = data.us;
  }

  // A 99 is a guess: only a KNOWN forma is overlaid, with its instalments.
  const formaConhecida = mapeado.forma.forma !== FORMA_PAGAMENTO.outros;
  if (formaConhecida) {
    if (armazenado.forma_de_pagamento !== mapeado.forma.forma) {
      patch.forma_de_pagamento = mapeado.forma.forma;
    }
    if (armazenado.parcelas !== mapeado.parcelas) patch.parcelas = mapeado.parcelas;
    if (armazenado.aVista !== mapeado.aVista) patch.aVista = mapeado.aVista;
  }
  const formaFinal = formaConhecida ? mapeado.forma.forma : armazenado.forma_de_pagamento;
  if (
    FORMAS_COM_CARTAO.has(formaFinal as FormaPagamento) &&
    vazio(armazenado.cartao) &&
    mapeado.cartao !== null
  ) {
    patch.cartao = mapeado.cartao;
  }

  if (vazio(armazenado.id)) patch.id = mapeado.id;
  if (vazio(armazenado.dataCadastro) && mapeado.dataCadastroUs !== null) {
    patch.dataCadastro = mapeado.dataCadastroUs;
  }

  if (Object.keys(patch).length === 0) return { tipo: 'sem-mudanca' };
  const ultima = microsArmazenadoLi(armazenado.ultimaModificacao);
  patch.ultimaModificacao = ultima !== null && ultima > nowUs ? ultima : nowUs;
  return {
    tipo: 'atualizar',
    patch,
    statusRessuscitado: veredito.escrever && veredito.ressuscitado,
  };
}
