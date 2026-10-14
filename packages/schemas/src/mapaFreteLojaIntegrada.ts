import { mapaDeIntegracoesSchema, type MapaDeIntegracoes } from './intFrete';
import { INTEGRACAO_FRETE, type IntegracaoFrete } from './shared/frete';

/* -------------------------------------------------------------------------- */
/*     Loja Integrada freight `mapa`: the shipping-method key and its rows     */
/* -------------------------------------------------------------------------- */

/**
 * The pure rules of a Loja Integrada conta's freight `mapa` (master plan step 20, #1826): the
 * `int_frete` doc of tipo `lojaIntegrada` holds one `mapa` row per shipping method the conta's
 * orders have used, and the operator maps each row to the internal freight integration that ships
 * it.
 *
 * ONE copy for every surface (#1369): the order importer's auto-registration (the Loja Integrada
 * app), the conta screen's "Mapeamento do Frete" tab (`apps/web`), and the window pass's audit all
 * call these. `apps/web` has no dependency edge to any app, so a rule both sides need lives here or
 * is written twice, and two copies drift toward two plausible answers.
 *
 * Pure and total: no clock, no network, no Firestore, and no input throws — a malformed value
 * reads as `null` ("not a key", "not mapped"), never as an exception. The importer parks a task on
 * a `ZodError`, so a corpus row must never raise one here.
 *
 * ⚠️ A NEW file on purpose, not a block inside `shared/frete.ts` or `integracao.ts`: both sit on
 * the NF-e live lane's path list, so every push touching them would cost a SEFAZ homologação
 * emission. This one is on no such list.
 *
 * ⚠️ Every function that turns a value into a KEY, or reads a row through one, is listed in
 * `packages/config-eslint/rules/equivalence-fold-inventory.test.js`: a caller in a new file has to
 * say what the fold treats as equal. The equal pairs and the near-misses are pinned in
 * `mapaFreteLojaIntegrada.test.ts`.
 */

/** The `forma_envio.id` forms a key accepts: a positive decimal integer with no leading zero. */
const ID_FORMA_ENVIO = /^[1-9][0-9]{0,15}$/;

/** A plain object (never null, never an array), or `null`. */
function comoObjeto(valor: unknown): Readonly<Record<string, unknown>> | null {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Readonly<Record<string, unknown>>)
    : null;
}

/** The id part of the key: the canonical decimal of a positive safe integer, else `null`. */
function idDaChave(id: unknown): string | null {
  if (typeof id !== 'number' && typeof id !== 'string') return null;
  const texto = String(id);
  if (!ID_FORMA_ENVIO.test(texto)) return null;
  return Number.isSafeInteger(Number(texto)) ? texto : null;
}

/**
 * The code part of the key: a string VERBATIM; `null` or absent ⇒ the literal `'null'` — which the
 * STRING `'null'` also is, so the two cannot be told apart (accepted: the stored key format).
 */
function codeDaChave(code: unknown): string | null {
  if (code === null || code === undefined) return 'null';
  return typeof code === 'string' ? code : null;
}

/**
 * The registration key of a Loja Integrada shipping method (an order's `forma_envio`):
 * `'<id>---<code>'`, the `idOriginal` of its `mapa` row. `null` when the value cannot be keyed.
 *
 * In the provider's wire, `forma_envio.id` names the gateway and `code` the service inside it, so
 * ONE id can carry several services — and each needs its own row, or the operator could never map
 * the second one. Hence the FULL key, never the id part alone.
 *
 * - **id:** a number, or a string, whose `String()` is a positive decimal integer with no leading
 *   zero (`^[1-9][0-9]{0,15}$`) and a safe integer. It renders as plain decimal, so the number
 *   `141909` and the string `'141909'` give the same key. Anything else ⇒ `null`: `0`, a negative,
 *   a fraction, an exponent form, `'0141909'`, `' 141909'`, a boolean.
 * - **code:** a string is kept VERBATIM — no trim, no case fold, `''` stays `''`. `null` and an
 *   absent (or `undefined`) code both render as the literal `'null'` — the key the stored rows
 *   carry for a method without a code, so they keep matching. Any other type ⇒ `null`.
 *   ⚠️ Accepted collision: a code that IS the string `'null'` renders the same `'141909---null'`.
 *   The stored key format cannot tell it from a missing code, and the stored rows already carry
 *   that key, so the two share one row.
 *
 * Equal: `{id: 141909, code: 'PAC'}` ≡ `{id: '141909', code: 'PAC'}` → `'141909---PAC'`;
 * `{code: 'null'}` ≡ `{code: null}` ≡ no code → `'141909---null'`. Distinct: `'PAC '`, `'pac'`,
 * `'SEDEX'`, `'NULL'`; id `14190`; `code: ''` → `'141909---'`.
 */
export function chaveFormaEnvioLi(forma: unknown): string | null {
  const objeto = comoObjeto(forma);
  if (objeto === null) return null;
  const id = idDaChave(objeto.id);
  if (id === null) return null;
  const code = codeDaChave(objeto.code);
  if (code === null) return null;
  return `${id}---${code}`;
}

/**
 * The target doc id a `mapa` row's `integracaoUid` names, or `null` when the row is unmapped.
 *
 * A non-empty string gives its LAST non-empty `/` segment — a bare id is the expected form, and a
 * path (`int_frete/<id>`, `documents/int_frete/<id>`) is tolerated. Anything else ⇒ `null`: an
 * absent or `null` uid, `''`, a string of slashes, a non-string.
 *
 * "Mapped" is decided HERE, by `integracaoUid`, never by `targetTipoIntegracao`: `'outros'` is both
 * a real target tipo and the value a cleared row carries, so the tipo cannot tell the two apart.
 *
 * Equal: `'abc'` ≡ `'int_frete/abc'` ≡ `'documents/int_frete/abc'`. Distinct: `'abcd'`; `''` and
 * `null` are unmapped.
 */
export function idDoAlvoDoMapaLi(uid: unknown): string | null {
  if (typeof uid !== 'string') return null;
  const segmentos = uid.split('/').filter((s) => s.length > 0);
  return segmentos.length > 0 ? (segmentos[segmentos.length - 1] ?? null) : null;
}

/**
 * The stored `mapa` row registered under `chave` (its `idOriginal`, compared with `===`), or
 * `null`. A tolerant RAW read: a `mapa` that is not an array reads as "no row", an element that is
 * not a plain object is skipped, and the FIRST match wins. Nothing is parsed or normalised — a row
 * that fails the row schema is still found, so a corpus doc never makes a known method look new.
 *
 * Presence is the key alone: a row found under the same key with another `nome`, `tipo` or order
 * number IS the method; the same id under another code is NOT.
 */
export function entradaDoMapaPorChaveLi(
  mapa: unknown,
  chave: string,
): Readonly<Record<string, unknown>> | null {
  if (!Array.isArray(mapa)) return null;
  for (const elemento of mapa as readonly unknown[]) {
    const linha = comoObjeto(elemento);
    if (linha !== null && linha.idOriginal === chave) return linha;
  }
  return null;
}

/** The display label of a method: its trimmed `nome` and `tipo`, the non-empty ones joined. */
function rotuloDaForma(objeto: Readonly<Record<string, unknown>>): string {
  return [objeto.nome, objeto.tipo]
    .filter((parte): parte is string => typeof parte === 'string')
    .map((parte) => parte.trim())
    .filter((parte) => parte.length > 0)
    .join(' - ');
}

/**
 * The `mapa` row the importer appends the first time an order uses a method: unmapped
 * (`integracaoUid: null`), keyed by {@link chaveFormaEnvioLi}, and built through
 * `mapaDeIntegracoesSchema`, so it carries all seven keys of a stored row (`nomeTarget`,
 * `targetData` and `targetTipoIntegracao` at their defaults). `null` when the method has no key —
 * nothing can be registered for it.
 *
 * - `nomeOriginal` is display only: the trimmed `nome` and `tipo` joined by `' - '` (only the
 *   non-empty ones), falling back to the key when both are empty or absent.
 * - `observacao` is `'Origem: Pedido <numero>'`, the order that first used the method. It differs
 *   per order, which is why registration must look the key up first: an unconditional union would
 *   append one row per order.
 *
 * Never throws: every input the parse sees is a string or `null`.
 */
export function montarEntradaDoMapaLi({
  forma,
  numero,
}: {
  readonly forma: unknown;
  readonly numero: number | string;
}): MapaDeIntegracoes | null {
  const chave = chaveFormaEnvioLi(forma);
  const objeto = comoObjeto(forma);
  if (chave === null || objeto === null) return null;
  const rotulo = rotuloDaForma(objeto);
  return mapaDeIntegracoesSchema.parse({
    nomeOriginal: rotulo.length > 0 ? rotulo : chave,
    idOriginal: chave,
    observacao: `Origem: Pedido ${numero}`,
    integracaoUid: null,
  });
}

/**
 * The freight tipos a Loja Integrada `mapa` row may be mapped to — the targets the conta screen
 * offers. Marketplace-owned tipos (another channel's freight) are never a target. `outros` is
 * listed because it is a real tipo, but a row "mapped" there is still decided by its
 * `integracaoUid` ({@link idDoAlvoDoMapaLi}).
 */
export const TIPOS_ALVO_MAPA_FRETE_LI = [
  INTEGRACAO_FRETE.melhorEnvios,
  INTEGRACAO_FRETE.motoboy,
  INTEGRACAO_FRETE.retiradaNaLoja,
  INTEGRACAO_FRETE.fob,
  INTEGRACAO_FRETE.outros,
] as const satisfies readonly IntegracaoFrete[];

export type TipoAlvoMapaFreteLi = (typeof TIPOS_ALVO_MAPA_FRETE_LI)[number];
