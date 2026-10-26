import { z } from 'zod';
import { motivoPedidoContestadoLiSchema } from './aviso';
import { inteiroPositivoCanonicoLi } from './mapaFreteLojaIntegrada';
import { naoDocId, toOuterRefOrNull } from './shared/outerRef';
import {
  CODIGOS_LI_PAGO,
  CODIGO_SITUACAO_LI,
  situacaoLi,
  type CodigoSituacaoLi,
} from './situacaoPedidoLojaIntegrada';

/* -------------------------------------------------------------------------- */
/*   Loja Integrada paid re-check: the verdict, the wire contract, the labels  */
/* -------------------------------------------------------------------------- */

/**
 * The pure half of the label step's paid re-check (master plan step 15, #1825): before the
 * checkout commits and before a Melhor Envio label is bought, the order's CURRENT Loja Integrada
 * situação must be a paid one; a reprint or a generic label outside it needs an acknowledged risk.
 *
 * ONE copy for every surface (#1369), written for both ends of master plan step 15:
 * `apps/loja-integrada`'s `GET …/pedidos/[pedidoId]/pagamento` route is to build its answer with
 * these, and `apps/web`'s gates to parse it and decide from it.
 *
 * Pure and total: no clock, no network, no Firestore; a malformed value answers `null` or
 * `desconhecido`, never an exception.
 *
 * ⚠️ A NEW file on purpose, not a block inside `shared/frete.ts` or `pedido/**`: both sit on the
 * NF-e live lane's path list.
 */

/**
 * What the re-check concludes:
 *
 * - `pago` — the current codigo is one of `CODIGOS_LI_PAGO`;
 * - `nao-pago` — a codigo the situação table knows, outside that set (awaiting payment, a dispute,
 *   a cancellation request, a cancellation, a refund, a chargeback…);
 * - `desconhecido` — a codigo the table does not know;
 * - `contestado` — Loja Integrada could not be read, and the ERP's own mirror (an open
 *   `lojaIntegradaPedidoContestado` aviso for the pedido) says the payment is contested.
 */
export const vereditoPagamentoLiSchema = z.enum(['pago', 'nao-pago', 'desconhecido', 'contestado']);
export type VereditoPagamentoLi = z.infer<typeof vereditoPagamentoLiSchema>;

/** Named members of {@link vereditoPagamentoLiSchema} — see `delfrance/prefer-schema-enum`. */
export const VEREDITO_PAGAMENTO_LI = {
  pago: 'pago',
  naoPago: 'nao-pago',
  desconhecido: 'desconhecido',
  contestado: 'contestado',
} as const satisfies Record<string, VereditoPagamentoLi>;

/** Where a verdict came from: Loja Integrada's live answer, or the ERP's own mirror. */
export const fonteConferenciaPagamentoLiSchema = z.enum(['loja', 'erp']);
export type FonteConferenciaPagamentoLi = z.infer<typeof fonteConferenciaPagamentoLiSchema>;

/** Named members of {@link fonteConferenciaPagamentoLiSchema} — see `delfrance/prefer-schema-enum`. */
export const FONTE_CONFERENCIA_PAGAMENTO_LI = {
  loja: 'loja',
  erp: 'erp',
} as const satisfies Record<string, FonteConferenciaPagamentoLi>;

/** Why the re-check does not apply to a pedido — the `motivo` of an `aplicavel: false` answer. */
export const MOTIVO_CONFERENCIA_NAO_APLICAVEL_LI = {
  /**
   * The pedido is not an order imported from Loja Integrada: no conta ref, no canonical `numero`,
   * or an id that is not the deterministic one (a duplicate, a devolução, a manual pedido).
   */
  naoImportado: 'nao-importado',
} as const;

/**
 * A contested motivo as the answer carries it, read TOLERANTLY: a motivo this build does not know
 * (one a newer backend added) reads as `null`, never as a parse failure. The backend deploys
 * before the web, and the web reads an answer that does not parse as "unverifiable" — a confirm
 * the operator can click through — so a strict motivo would turn a newer backend's BLOCK into a
 * click-through in an older browser. Display only: the verdict never depends on it. The same
 * convention as the aviso, which stores the motivo as a plain-string param.
 */
const motivoContestacaoTolerante = motivoPedidoContestadoLiSchema.nullable().catch(null);

/**
 * What `GET /api/marketplace/loja-integrada/pedidos/[pedidoId]/pagamento` answers with 200.
 *
 * - `{aplicavel: false, motivo}` — the pedido is not an imported Loja Integrada order, so only the
 *   ERP's local gates apply. `motivo` is a {@link MOTIVO_CONFERENCIA_NAO_APLICAVEL_LI} code, as a
 *   plain string so a motivo a newer backend adds still parses in an older browser.
 * - `{aplicavel: true, fonte: 'loja', …}` — a LIVE read:
 *   - `veredito` — `pago`, `nao-pago` or `desconhecido` ({@link veredictoDoCodigoLi}), never
 *     `contestado`;
 *   - `codigo` — the situação codigo Loja Integrada answered, verbatim;
 *   - `motivoContestacao` — the codigo's own (`SITUACOES_LI[codigo].motivoContestacao`) or `null`;
 *   - `conferidoEmMs` — when the live read answered (ms, server clock, display only: a client
 *     reusing a verdict measures its age with its own clock);
 *   - `correlationId` — the live call's id, to find it in the logs, or `null`.
 * - `{aplicavel: true, fonte: 'erp', …}` — the ERP's contested MIRROR, when the live read could
 *   not run: `veredito` is ALWAYS `contestado`, `motivoContestacao` the open aviso's, and
 *   `codigo`, `conferidoEmMs` and `correlationId` are `null` (nothing was read live).
 *
 * The two `aplicavel: true` arms are split on `fonte` so the impossible states do not parse: a
 * mirror saying `pago` would authorise a checkout and a label buy that nothing verified. Every
 * `motivoContestacao` is read tolerantly ({@link motivoContestacaoTolerante}).
 *
 * Every failure is the error envelope (`erroContaLojaIntegradaSchema`) with a `CODIGO_ERRO_LI`
 * code. NON-strict on purpose: unknown keys are stripped, so nothing else from Loja Integrada's
 * order body (which carries personal data) can ride along.
 */
export const respostaConferenciaPagamentoLiSchema = z.discriminatedUnion('aplicavel', [
  z.object({
    aplicavel: z.literal(false),
    motivo: z.string().min(1),
  }),
  z.discriminatedUnion('fonte', [
    z.object({
      aplicavel: z.literal(true),
      fonte: z.literal(FONTE_CONFERENCIA_PAGAMENTO_LI.loja),
      veredito: vereditoPagamentoLiSchema.exclude([VEREDITO_PAGAMENTO_LI.contestado]),
      codigo: z.string(),
      motivoContestacao: motivoContestacaoTolerante,
      conferidoEmMs: z.number().int(),
      correlationId: z.string().nullable(),
    }),
    z.object({
      aplicavel: z.literal(true),
      fonte: z.literal(FONTE_CONFERENCIA_PAGAMENTO_LI.erp),
      veredito: z.literal(VEREDITO_PAGAMENTO_LI.contestado),
      codigo: z.null(),
      motivoContestacao: motivoContestacaoTolerante,
      conferidoEmMs: z.null(),
      correlationId: z.null(),
    }),
  ]),
]);
export type RespostaConferenciaPagamentoLi = z.infer<typeof respostaConferenciaPagamentoLiSchema>;

/**
 * The verdict of a LIVE situação codigo, by the codigo ALONE — never by the situação flags, which
 * call a dispute and a chargeback "aprovado":
 *
 * - in `CODIGOS_LI_PAGO` ⇒ `pago`;
 * - known to the situação table (`situacaoLi`, an exact, prototype-safe lookup) ⇒ `nao-pago` —
 *   every reversal, the dispute and the cancellation request included;
 * - anything else ⇒ `desconhecido`: an unknown codigo, another case or spacing of a known one
 *   (`'Pedido_Pago'`, `'pedido_pago '`), `''`, an inherited name (`'toString'`), a non-string.
 *
 * Never `contestado`: that verdict exists only for the ERP mirror.
 */
export function veredictoDoCodigoLi(codigo: unknown): VereditoPagamentoLi {
  if (typeof codigo !== 'string') return VEREDITO_PAGAMENTO_LI.desconhecido;
  if (CODIGOS_LI_PAGO.has(codigo)) return VEREDITO_PAGAMENTO_LI.pago;
  return situacaoLi(codigo) === null
    ? VEREDITO_PAGAMENTO_LI.desconhecido
    : VEREDITO_PAGAMENTO_LI.naoPago;
}

const C = CODIGO_SITUACAO_LI;

/**
 * The operator-facing pt-BR label of every situação codigo — total by type, so a codigo added to
 * the table without a label fails to compile. Read a WIRE codigo through {@link rotuloSituacaoLi},
 * never by indexing this object with it.
 */
export const ROTULO_SITUACAO_LI: Readonly<Record<CodigoSituacaoLi, string>> = {
  [C.pedidoEfetuado]: 'Pedido efetuado',
  [C.aguardandoPagamento]: 'Aguardando pagamento',
  [C.pagamentoEmAnalise]: 'Pagamento em análise',
  [C.pedidoPago]: 'Pedido pago',
  [C.faturado]: 'Faturado',
  [C.emProducao]: 'Em produção',
  [C.pedidoEmSeparacao]: 'Pedido em separação',
  [C.pedidoEnviado]: 'Pedido enviado',
  [C.prontoParaRetirada]: 'Pronto para retirada',
  [C.pedidoEntregue]: 'Pedido entregue',
  [C.pagamentoEmDisputa]: 'Pagamento em disputa',
  [C.cancelamentoSolicitado]: 'Cancelamento solicitado',
  [C.pedidoCancelado]: 'Pedido cancelado',
  [C.pagamentoDevolvido]: 'Pagamento devolvido',
  [C.pedidoChargeback]: 'Chargeback',
  [C.pagamentoDevolvidoSemRetorno]: 'Pagamento devolvido sem retorno',
};

/**
 * The label of a codigo as it arrives on the wire, or `null` when the table does not know it —
 * the same exact, prototype-safe lookup as `situacaoLi` (`'toString'` and `'Pedido_Pago'` are
 * unknown).
 */
export function rotuloSituacaoLi(codigo: unknown): string | null {
  if (typeof codigo !== 'string') return null;
  const linha = situacaoLi(codigo);
  return linha === null ? null : ROTULO_SITUACAO_LI[linha.codigo];
}

/**
 * The conta (`integracao` document id) an imported pedido belongs to, from its
 * `integracaoPedidoOuterRef` — or `null` when the ref names no `integracao` document.
 *
 * Read tolerantly through `toOuterRefOrNull`, so the bare form and the `documents/` form are the
 * same conta. Equal: `'integracao/c'` ≡ `'documents/integracao/c'` → `'c'`. Distinct (`null`):
 * another collection (`'int_frete/c'`), a sub-path (`'integracao/c/x/y'`), `''`, `null`, an id
 * that is not a usable document id. Another id is another conta (`'c2'`).
 */
export function contaIdDoPedidoLi(integracaoPedidoOuterRef: unknown): string | null {
  const ref = toOuterRefOrNull(integracaoPedidoOuterRef);
  const prefixo = 'documents/integracao/';
  if (ref === null || !ref.startsWith(prefixo)) return null;
  const id = ref.slice(prefixo.length);
  return naoDocId(id) ? null : id;
}

/**
 * The preimage of an imported Loja Integrada pedido's deterministic id —
 * `` `lojaIntegrada${contaId}-${numero}` ``, whose sha256 (lowercase hex) IS that id — or `null`
 * when no imported pedido can carry these values. The one home of that string (master plan step
 * 15): the order importer's pedido id (`idPedidoLi` in `apps/loja-integrada`) is its digest, and
 * the web's identity check hashes it to recognise an imported pedido, as the paid re-check route
 * is to.
 *
 * - `contaId` must be a usable document id (the `integracao` doc id, never a store id).
 * - `numero` goes through `inteiroPositivoCanonicoLi`: a positive safe integer or its canonical
 *   decimal, so `165` and `'165'` give the same preimage, and `'0165'`, `'165.0'`, `0`, `null`
 *   give none.
 *
 * ⚠️ The corpus's pedido ids are digests of EXACTLY this string: the vector
 * `('CONTA1', '165')` ⇒ `lojaIntegradaCONTA1-165` is pinned in the test, and nothing makes the
 * template literal safe to reformat. No `documents/`, no `/` after the channel name: the other
 * channels' pedido spellings (`mercadoLivre<conta>-<id>`, Shopee's bare `<conta>-<id>`) differ on
 * purpose.
 */
export function preimagemPedidoLi(contaId: unknown, numero: unknown): string | null {
  if (typeof contaId !== 'string' || naoDocId(contaId)) return null;
  const canonico = inteiroPositivoCanonicoLi(numero);
  if (canonico === null) return null;
  return `lojaIntegrada${contaId}-${canonico}`;
}
