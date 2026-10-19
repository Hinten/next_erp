/**
 * The keyed id faker of the capture sanitizer (step-2b plan §3 decision 14).
 *
 * Every id a `soLog` leaf (or a path slot, or a query value) holds is faked as
 * `HMAC-SHA256(sal, classe + ':' + valor)`, rendered in that class's FAKE
 * FORMAT. Documents get the redactor's shape-preserving placeholders instead;
 * dates, quantities and money stay real.
 *
 * - **Stable.** The same value under the same salt always gives the same fake,
 *   so joins hold across pairs and runs (a C1 order before and after its
 *   cancellation, a C1 SKU against a C5 listing), and a new capture never
 *   reshuffles older fixtures. The salt (`.sal-sanitizador`, 32 random bytes)
 *   lives beside the captures and dies with them (DPP §2.1).
 * - **Recognisable.** Every fake format is exported as a `FORMATO_FALSO_*`
 *   regex, and a value already in its class's format is returned unchanged — a
 *   FIXPOINT, which is what makes the `fixture` profile idempotent, and what
 *   `piiScan.ts` re-runs it with.
 * - **Never a document.** A candidate that passes the CPF or CNPJ check digits,
 *   or trips any pattern of the redactor's regex layer, is re-drawn with a
 *   counter; after {@link MAXIMO_DE_SORTEIOS} draws the class's all-zero fake is
 *   used (it never passes: repeated digits fail both checks).
 *
 * ⚠️ A REAL value that happens to sit in a fake format passes through as is.
 * The formats are chosen so that cannot be an Amazon id: `000-0000000-…` is no
 * order, `B0ZZ…` is a reserved-looking ASIN range, and the rest carry a `-Z`
 * marker no Amazon id grammar produces.
 */
import { createHmac } from 'node:crypto';
import { validateCNPJ, validateCPF } from '@delfrance/core/documents';

import { type ClasseFalsaAmazon, type FalsificadorAmazon, mascararTexto } from '../core/redacao';

/** The salt's exact size in bytes. */
export const TAMANHO_DO_SAL = 32;

/** Draws per value before the class's all-zero fake is used. */
export const MAXIMO_DE_SORTEIOS = 64;

/** The seller-id placeholder (the redactor itself writes `<sellerId>`; tests and docs use this). */
export const SELLER_ID_FALSO = 'AXXXXXXXXXXXXX';

/** The application id: one all-zero solution id, so it never names this integration's app. */
export const ID_APLICACAO_FALSO = 'amzn1.sp.solution.00000000-0000-0000-0000-000000000000';

/** The SQS record's `awsRegion`: where OUR queue lives, so it is one fixed fake. */
export const REGIAO_FALSA = 'xx-regiao-1';

export const FORMATO_FALSO_PEDIDO = /^000-0000000-\d{7}$/;
/** The same length as the real id (6 at least): `00000` then keyed digits. */
export const FORMATO_FALSO_ITEM_PEDIDO = /^00000\d{1,27}$/;
export const FORMATO_FALSO_ALIAS = /^ALIAS-Z[0-9a-f]{8}$/;
export const FORMATO_FALSO_PACOTE = /^PKG-Z[0-9a-f]{8}$/;
export const FORMATO_FALSO_ASIN = /^B0ZZ[A-Z0-9]{6}$/;
export const FORMATO_FALSO_SKU = /^SKU-Z[0-9a-f]{8}$/;
export const FORMATO_FALSO_RASTREIO = /^TRKZ\d{10}$/;
/** Every field of the chave zeroed except `mod` 55 and a keyed `nNF`; the DV recomputed. */
export const FORMATO_FALSO_CHAVE_NFE = /^0{20}55000\d{9}0{9}\d$/;
export const FORMATO_FALSO_SLOT = /^SLOT-Z[0-9a-f]{8}$/;
export const FORMATO_FALSO_PROMOCAO = /^PROMO-Z[0-9a-f]{8}$/;
export const FORMATO_FALSO_APLICACAO = /^amzn1\.sp\.solution\.0{8}-0{4}-0{4}-0{4}-0{12}$/;
/** A UUID whose first four groups are zero: a subscription, a notification, an SQS message. */
export const FORMATO_FALSO_UUID = /^00000000-0000-0000-0000-[0-9a-f]{12}$/;
export const FORMATO_FALSO_REMESSA = /^SHP-Z[0-9a-f]{8}$/;
export const FORMATO_FALSO_REGIAO = /^xx-regiao-1$/;

/** Each class's fake format: the fixpoints. Keyed by class, so a new class fails to compile. */
export const FORMATO_FALSO_POR_CLASSE: Readonly<Record<ClasseFalsaAmazon, RegExp>> = {
  pedido: FORMATO_FALSO_PEDIDO,
  itemPedido: FORMATO_FALSO_ITEM_PEDIDO,
  alias: FORMATO_FALSO_ALIAS,
  pacote: FORMATO_FALSO_PACOTE,
  asin: FORMATO_FALSO_ASIN,
  sku: FORMATO_FALSO_SKU,
  rastreio: FORMATO_FALSO_RASTREIO,
  chaveNfe: FORMATO_FALSO_CHAVE_NFE,
  slot: FORMATO_FALSO_SLOT,
  promocao: FORMATO_FALSO_PROMOCAO,
  aplicacao: FORMATO_FALSO_APLICACAO,
  assinatura: FORMATO_FALSO_UUID,
  notificacao: FORMATO_FALSO_UUID,
  mensagem: FORMATO_FALSO_UUID,
  remessa: FORMATO_FALSO_REMESSA,
  regiao: FORMATO_FALSO_REGIAO,
};

/** Whether `valor` already is a fake of `classe` (a fixpoint). */
export function ehFalsoAmazon(classe: ClasseFalsaAmazon, valor: string): boolean {
  return FORMATO_FALSO_POR_CLASSE[classe].test(valor);
}

/** The mod-11 check digit of a 43-digit chave prefix (weights 2..9 from the right). */
export function dvDaChaveNfe(c43: string): number {
  let soma = 0;
  let peso = 2;
  for (let i = c43.length - 1; i >= 0; i--) {
    soma += Number(c43[i]) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

/** A chave with every field zero except `mod` 55, `nNF` and the DV. */
function chaveFalsa(nNF: string): string {
  const c43 = `${'0'.repeat(20)}55000${nNF}${'0'.repeat(9)}`;
  return `${c43}${String(dvDaChaveNfe(c43))}`;
}

/** `n` decimal digits from the digest (each byte mod 10; the bias is irrelevant to a fake). */
const digitos = (h: Buffer, n: number) =>
  Array.from(h.subarray(0, n), (b) => String(b % 10)).join('');
const ALFANUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const alfanum = (h: Buffer, n: number) =>
  Array.from(h.subarray(0, n), (b) => ALFANUM.charAt(b % ALFANUM.length)).join('');
const hex = (h: Buffer, n: number) => h.toString('hex').slice(0, n);

/** The class's fake from a digest; `valor` only sets a length. */
function renderizar(classe: ClasseFalsaAmazon, valor: string, h: Buffer): string {
  switch (classe) {
    case 'pedido':
      return `000-0000000-${digitos(h, 7)}`;
    case 'itemPedido':
      return `00000${digitos(h, Math.min(27, Math.max(1, valor.length - 5)))}`;
    case 'alias':
      return `ALIAS-Z${hex(h, 8)}`;
    case 'pacote':
      return `PKG-Z${hex(h, 8)}`;
    case 'asin':
      return `B0ZZ${alfanum(h, 6)}`;
    case 'sku':
      return `SKU-Z${hex(h, 8)}`;
    case 'rastreio':
      return `TRKZ${digitos(h, 10)}`;
    case 'chaveNfe':
      return chaveFalsa(digitos(h, 9));
    case 'slot':
      return `SLOT-Z${hex(h, 8)}`;
    case 'promocao':
      return `PROMO-Z${hex(h, 8)}`;
    case 'aplicacao':
      return ID_APLICACAO_FALSO;
    case 'assinatura':
    case 'notificacao':
    case 'mensagem':
      return `00000000-0000-0000-0000-${hex(h, 12)}`;
    case 'remessa':
      return `SHP-Z${hex(h, 8)}`;
    case 'regiao':
      return REGIAO_FALSA;
  }
}

/** The class's all-zero fake: the last resort, never a valid document. */
export function falsoZeradoAmazon(classe: ClasseFalsaAmazon, valor: string): string {
  return renderizar(classe, valor, Buffer.alloc(32));
}

const ONZE = /^\d{11}$/;
const QUATORZE = /^[A-Z0-9]{12}\d{2}$/;

/**
 * Whether a candidate fake could be read as personal data: an EXACT 11-digit or
 * 14-character value with valid check digits, or anything the redactor's regex
 * layer (check-digit pass included) would mask.
 */
export function falsoInaceitavel(candidato: string): boolean {
  if (ONZE.test(candidato) && validateCPF(candidato)) return true;
  if (QUATORZE.test(candidato) && validateCNPJ(candidato)) return true;
  return mascararTexto(candidato, { digitos: true }).mascarados > 0;
}

/**
 * The keyed faker over `sal` ({@link TAMANHO_DO_SAL} bytes). Memoised per run;
 * total: no input throws.
 */
export function criarFalsificadorAmazon(sal: Uint8Array): FalsificadorAmazon {
  const vistos = new Map<string, string>();
  return (classe, valor) => {
    if (ehFalsoAmazon(classe, valor)) return valor;
    const chave = `${classe}:${valor}`;
    const visto = vistos.get(chave);
    if (visto !== undefined) return visto;
    let falso = falsoZeradoAmazon(classe, valor);
    for (let n = 0; n < MAXIMO_DE_SORTEIOS; n++) {
      const texto = n === 0 ? chave : `${chave}:${String(n)}`;
      const candidato = renderizar(
        classe,
        valor,
        createHmac('sha256', sal).update(texto, 'utf8').digest(),
      );
      if (!falsoInaceitavel(candidato)) {
        falso = candidato;
        break;
      }
    }
    vistos.set(chave, falso);
    return falso;
  };
}
