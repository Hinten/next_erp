import { type Bandeira, bandeiraDoNomeDaMarca } from './bandeiraCartao';
import { type Cartao, FORMA_PAGAMENTO, type FormaPagamento } from './pedido/collection/pagamento';
import { cpfCnpjUtilizavel } from './valorMascarado';

/**
 * The marketplace card rule: which pagamento carries a `cartao` block, and what
 * goes in it, for an order a marketplace already settled (the seller never sees
 * the card).
 *
 * Shared, not written once per channel: the rule is pure and total, it decides
 * what the NF-e `<card>` group says (`tpIntegra`, `tBand`, `cAut`, the
 * institution's `CNPJ`), and each channel that kept its own copy would drift
 * from the others. Amazon is its first caller; the per-subfield fill-once
 * overlay over a stored block stays with the caller.
 */

/**
 * The formas whose pagamento carries a card block: credit card, debit card and
 * Pix. Pix carries one for the institution and the authorization, never a brand.
 */
export const FORMAS_COM_CARTAO_MARKETPLACE: ReadonlySet<FormaPagamento> = new Set<FormaPagamento>([
  FORMA_PAGAMENTO.cartao_credito,
  FORMA_PAGAMENTO.cartao_debito,
  FORMA_PAGAMENTO.pix,
]);

/** A CNPJ has 14 characters; a CPF (11) must never reach `cnpj_instituicao`. */
const COMPRIMENTO_CNPJ_INSTITUICAO = 14;

/**
 * A usable institution CNPJ for `cartao.cnpj_instituicao`, or `null`.
 *
 * {@link cpfCnpjUtilizavel} — the mask gate, the normalisation (punctuation and
 * whitespace dropped, letters kept for the alphanumeric CNPJ), the check digits
 * — narrowed to exactly 14 characters: a valid CPF is a person, not a payment
 * institution, and an 8-digit root is not a CNPJ.
 */
export function cnpjInstituicaoUtilizavel(raw: unknown): string | null {
  const documento = cpfCnpjUtilizavel(raw);
  return documento !== null && documento.length === COMPRIMENTO_CNPJ_INSTITUICAO ? documento : null;
}

/** What {@link cartaoMarketplace} reads. */
export interface EntradaCartaoMarketplace {
  /** The pagamento's forma, already decided by the caller. */
  readonly forma: FormaPagamento;
  /** The card brand NAME as the marketplace sent it (raw). */
  readonly marcaBruta: unknown;
  /** The payment institution's document as the marketplace sent it (raw). */
  readonly cnpjBruto: unknown;
  /** The authorization code, already read by the caller (`null` when none). */
  readonly cAut: string | null;
}

/** What {@link cartaoMarketplace} answers. */
export interface CartaoMarketplace {
  /** The block, or `undefined` when the forma carries none. */
  readonly cartao: Cartao | undefined;
  /** A non-blank brand arrived that the fold does not know (`bandeira` 99). */
  readonly bandeiraDesconhecida: boolean;
  /**
   * A non-blank institution document ARRIVED and was refused (masked, a CPF, a
   * root, a wrong check digit). ⚠️ "Refused", never "absent": a document that
   * never arrived is nothing to report. Neither the value nor its length is
   * ever carried out of here.
   */
  readonly cnpjRecusado: boolean;
}

/**
 * The card block of one marketplace pagamento.
 *
 *  - Outside {@link FORMAS_COM_CARTAO_MARKETPLACE} (boleto, outros, …): no block,
 *    no flag, whatever arrived.
 *  - Inside: `{ tpIntegra: '2', bandeira, cAut, cnpj_instituicao,
 *    numeroCartao: null, tarifa: null, tarifaFixa: null, prazoRecebimento: null }`
 *    — even when every input is absent. `tpIntegra '2'` (payment not integrated
 *    with the emitter's system) is the marketplace precedent.
 *  - `bandeira` only on a CARD forma, through {@link bandeiraDoNomeDaMarca}; Pix
 *    never carries a brand (`null`), whatever arrived.
 *  - `cnpj_instituicao` through {@link cnpjInstituicaoUtilizavel}.
 */
export function cartaoMarketplace(entrada: EntradaCartaoMarketplace): CartaoMarketplace {
  if (!FORMAS_COM_CARTAO_MARKETPLACE.has(entrada.forma)) {
    return { cartao: undefined, bandeiraDesconhecida: false, cnpjRecusado: false };
  }
  const ehCartao = entrada.forma !== FORMA_PAGAMENTO.pix;
  const marca = ehCartao
    ? bandeiraDoNomeDaMarca(entrada.marcaBruta)
    : { bandeira: null as Bandeira | null, desconhecida: false };
  const cnpj = cnpjInstituicaoUtilizavel(entrada.cnpjBruto);
  return {
    cartao: {
      tpIntegra: '2',
      bandeira: marca.bandeira,
      numeroCartao: null,
      cAut: entrada.cAut,
      cnpj_instituicao: cnpj,
      tarifa: null,
      tarifaFixa: null,
      prazoRecebimento: null,
    },
    bandeiraDesconhecida: marca.desconhecida,
    cnpjRecusado:
      typeof entrada.cnpjBruto === 'string' && entrada.cnpjBruto.trim() !== '' && cnpj === null,
  };
}
