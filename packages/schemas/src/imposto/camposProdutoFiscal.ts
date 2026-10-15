/**
 * **The `<prod>` fiscal codes a nota carries for one item** — CFOP, NCM, CEST
 * and unidade with the operação as a PER-FIELD fallback, plus the cEAN rule.
 *
 * The five-tier cascade (`@delfrance/data/admin/imposto`) picks ONE tier whole,
 * and `impostoSchema` declares every one of these codes optional — so a resolved
 * `Imposto` can legitimately arrive without an NCM. The NF-e then takes the
 * operação's value for that one field (`imposto.NCM ?? operacao.NCM`), and that
 * second step lived only in `apps/nfe`'s `buildGenItems`. It moved here (#745)
 * because a marketplace now registers the same codes with its own invoicer:
 * Mercado Livre's `items/fiscal_information` must say what OUR nota says, and a
 * copy of the fallback on the ML side is exactly the pair of files the root
 * `CLAUDE.md` warns drift "toward plausible".
 *
 * Pure and total. It decides nothing about absence: a missing CFOP/NCM/unidade
 * is `null` here, and each caller owns what that means — the NF-e THROWS naming
 * the pedido item, a marketplace SKIPS the SKU with a reason.
 */
import type { Imposto } from './tribute';

/**
 * The operação's own copies of the codes. Lenient on purpose: `apps/nfe` hands
 * the parsed `Operacao`, while `lerResolverBundle` hands the RAW document
 * (parsing it would strip the keys the cascade's tier 5 reads), so a
 * non-string value here reads as absent rather than failing.
 */
export type OperacaoCamposFiscais = Readonly<Record<string, unknown>>;

export interface CamposProdutoFiscal {
  readonly cfop: string | null;
  readonly cfopInterestadual: string | null;
  readonly NCM: string | null;
  readonly CEST: string | null;
  readonly unidade: string | null;
}

/**
 * The item's value wins; the operação's fills a field the item lacks.
 *
 * ⚠️ `??`, never `||`, and the operação's string is returned VERBATIM —
 * including `''`. That is byte-for-byte what the NF-e did before this moved, and
 * its callers already treat a falsy value as absent (`if (!NCM) throw`,
 * `CEST ? { CEST } : {}`); normalising here would change which operação
 * documents emit.
 */
export function camposProdutoFiscal(
  imposto: Pick<Imposto, 'cfop' | 'cfopInterestadual' | 'NCM' | 'CEST' | 'unidade'>,
  operacao: OperacaoCamposFiscais | null,
): CamposProdutoFiscal {
  return {
    cfop: imposto.cfop ?? textoDaOperacao(operacao, 'cfop'),
    cfopInterestadual: imposto.cfopInterestadual ?? textoDaOperacao(operacao, 'cfopInterestadual'),
    NCM: imposto.NCM ?? textoDaOperacao(operacao, 'NCM'),
    CEST: imposto.CEST ?? textoDaOperacao(operacao, 'CEST'),
    unidade: imposto.unidade ?? textoDaOperacao(operacao, 'unidade'),
  };
}

/**
 * The GTIN a nota may carry in `cEAN`, or `null` when it must say `SEM GTIN`:
 * 8 to 14 digits and nothing else. No check digit — the NF-e never validated
 * one, and a marketplace sending a GTIN the nota refuses would disagree with it.
 */
export function gtinFiscal(gtin: string | null | undefined): string | null {
  return gtin != null && /^\d{8,14}$/.test(gtin) ? gtin : null;
}

function textoDaOperacao(operacao: OperacaoCamposFiscais | null, campo: string): string | null {
  const valor = operacao?.[campo];
  return typeof valor === 'string' ? valor : null;
}
