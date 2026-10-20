import { z } from 'zod';
import { MOTIVO_FRETE_NAO_SUPORTADO_LI, type MotivoFreteNaoSuportadoLi } from './aviso';
import { mapaDeIntegracoesSchema, type MapaDeIntegracoes } from './intFrete';
import { ESTADO_PEDIDO } from './pedido/collection/pedido';
import { INTEGRACAO_FRETE, MODALIDADE_FRETE, type IntegracaoFrete } from './shared/frete';
import { naoDocId, toOuterRef, toOuterRefOrNull, type OuterRef } from './shared/outerRef';

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
 * Since step 15 (#1825) it also holds the LABEL half of the route resolver: which target a pedido
 * still pointing at its conta's Loja Integrada `int_frete` doc is printed through, the pure guards
 * written for the routing route and the web's read-only preview to apply alike, the one reader of
 * an `int_frete` ref and the one reader of a Melhor Envio service id. See "The label route" below.
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

/** A positive decimal integer with no leading zero, at most 16 digits (the safe-integer width). */
const INTEIRO_POSITIVO_CANONICO = /^[1-9][0-9]{0,15}$/;

/** A plain object (never null, never an array), or `null`. */
function comoObjeto(valor: unknown): Readonly<Record<string, unknown>> | null {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Readonly<Record<string, unknown>>)
    : null;
}

/**
 * The ONE reader of the positive safe integers the Loja Integrada surfaces key on — a
 * `forma_envio.id` (the id part of {@link chaveFormaEnvioLi}), a Melhor Envio service id
 * ({@link idServicoMelhorEnvioLi}) and an order `numero` (the order-id preimage): the canonical
 * decimal of the value, else `null`.
 *
 * - A **number** qualifies when it is a positive safe integer; its `String()` is the answer.
 * - A **string** qualifies when it already IS that canonical decimal: digits only, no leading
 *   zero, no sign, no space, no fraction, no exponent, and a safe integer.
 *
 * Equal: `3` ≡ `'3'` → `'3'`. Distinct (`null`): `'03'`, `'3.0'`, `' 3'`, `'3 '`, `'+3'`, `'1e3'`,
 * `0`, `-1`, `1.5`, `NaN`, `Infinity`, `2 ** 53`, a boolean, `null`, an object. Never throws.
 */
export function inteiroPositivoCanonicoLi(valor: unknown): string | null {
  if (typeof valor !== 'number' && typeof valor !== 'string') return null;
  const texto = String(valor);
  if (!INTEIRO_POSITIVO_CANONICO.test(texto)) return null;
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
  const id = inteiroPositivoCanonicoLi(objeto.id);
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

/** The target tipo a raw `tipo` names, or `null` — exact, never folded. */
function tipoAlvoOuNull(tipo: unknown): TipoAlvoMapaFreteLi | null {
  return TIPOS_ALVO_MAPA_FRETE_LI.find((alvo) => alvo === tipo) ?? null;
}

/* -------------------------------------------------------------------------- */
/*                  The label route (step 15, #1825): one resolver             */
/* -------------------------------------------------------------------------- */

/*
 * A pedido imported from Loja Integrada points `freteInicial.integracaoFreteOuterRef` either at a
 * label TARGET (one of {@link TIPOS_ALVO_MAPA_FRETE_LI}, routed at import) or at its conta's Loja
 * Integrada `int_frete` doc (unmapped, deliberately mapped to `fob`/`outros`, or routed by an
 * aviso). Only the second needs routing before a label: the routing route is to re-point the ref
 * at the target this section resolves, and the web's read-only preview to ask the same questions
 * with the same functions, so the two can never answer differently.
 *
 * The sequence, for one pedido:
 *
 *  1. {@link idIntFreteDaRefLi} on the ref — one naming no `int_frete` doc ⇒ `sem-rota-li`, with
 *     no read — then {@link classificarDocDoFreteLi} on the doc it names: a target ⇒ already
 *     routed; the Loja Integrada doc ⇒ go on; anything else ⇒ `sem-rota-li`.
 *  2. {@link recusaDoDocLiParaRotaLi} on that doc, against the pedido's own conta.
 *  3. {@link recusaDoPedidoParaRotaLi} on the pedido.
 *  4. {@link planejarRotaEtiquetaLi} names the doc(s) to read; {@link concluirRotaEtiquetaLi}
 *     decides from what was read — the target policy, the Melhor Envio service and the endereço.
 *
 * The mapa row is found by the FULL `'<id>---<code>'` key only, never by its id part: one id
 * carries several services, so an id-part match would print a service under its sibling's
 * carrier.
 */

/**
 * The Melhor Envio service id a `mapa` row's `targetData` names (`targetData.id`), as its canonical
 * decimal — or `null` when there is none. {@link inteiroPositivoCanonicoLi} over `targetData.id`.
 * It is the ONE service reader for every surface: the conta screen's service select reads it,
 * the label route resolves through it ({@link decidirLinhaDoMapaLi}), and the order importer is
 * to move its own copy onto it (master plan step 15) — so a service stored as `3` and one stored
 * as `'3'` are the same service everywhere.
 *
 * Equal: `{id: 3}` ≡ `{id: '3'}` → `'3'`. Distinct (`null`): `'03'`, `'3.0'`, `0`, `'1e3'`, an
 * absent `id`, a `targetData` that is not a plain object.
 */
export function idServicoMelhorEnvioLi(targetData: unknown): string | null {
  return inteiroPositivoCanonicoLi(comoObjeto(targetData)?.id);
}

/** What a conta's `mapa` says about one shipping method, before any target is read. */
export type LinhaDoMapaLi =
  /** The method has no usable key ({@link chaveFormaEnvioLi} answered `null`). */
  | { readonly tipo: 'sem-chave' }
  /** The stored `mapa` is present and not a list. */
  | { readonly tipo: 'mapa-invalido'; readonly chave: string }
  /** No row under the key, a row naming no target, or an absent / `null` `mapa`. */
  | { readonly tipo: 'nao-mapeado'; readonly chave: string }
  | {
      readonly tipo: 'mapeado';
      readonly chave: string;
      /**
       * The target `int_frete` doc id ({@link idDoAlvoDoMapaLi}) — always one a document can have.
       * `null` when the row's uid names a target no document can be (its last segment is `.` or
       * `..`): the row IS mapped, and its target is ABSENT — judge it `alvo-ausente`
       * ({@link avaliarAlvoDoMapaLi} over `null`) without a read. The type makes every caller
       * handle it, so none can hand such an id to a document read.
       */
      readonly alvoId: string | null;
      /** The row's display name, when it is a string. */
      readonly nomeOriginal: string | null;
      /** The row's Melhor Envio service ({@link idServicoMelhorEnvioLi}), or `null`. */
      readonly idServico: string | null;
    };

/**
 * Decide one shipping method against a conta's stored `mapa`: the key first, then the row, then
 * whether the row names a target.
 *
 * - The key is {@link chaveFormaEnvioLi} — the FULL key. The same id under another code is
 *   another method, so it is `nao-mapeado` here even when its sibling row is mapped.
 * - An absent or `null` `mapa` reads as an EMPTY one (`nao-mapeado`), as the registration does; a
 *   `mapa` that is present and not a list is `mapa-invalido`.
 *   ⚠️ So pass the doc's RAW `mapa`. A caller holding a reader that has already turned a non-list
 *   `mapa` into `null` must answer `mapa-invalido` itself BEFORE calling this, or the corrupted
 *   `mapa` reads here as an empty one.
 * - The row is found raw ({@link entradaDoMapaPorChaveLi}, the first match) and "mapped" is its
 *   `integracaoUid` ({@link idDoAlvoDoMapaLi}) — never its `targetTipoIntegracao`.
 * - A mapped target id no document can have (`.`, `..`) comes back as `alvoId: null` — see
 *   {@link LinhaDoMapaLi}. This is the one place that filter lives.
 */
export function decidirLinhaDoMapaLi(mapa: unknown, formaEnvio: unknown): LinhaDoMapaLi {
  const chave = chaveFormaEnvioLi(formaEnvio);
  if (chave === null) return { tipo: 'sem-chave' };
  if (mapa !== null && mapa !== undefined && !Array.isArray(mapa)) {
    return { tipo: 'mapa-invalido', chave };
  }
  const linha = entradaDoMapaPorChaveLi(mapa, chave);
  const alvoId = linha === null ? null : idDoAlvoDoMapaLi(linha.integracaoUid);
  if (linha === null || alvoId === null) return { tipo: 'nao-mapeado', chave };
  return {
    tipo: 'mapeado',
    chave,
    alvoId: naoDocId(alvoId) ? null : alvoId,
    nomeOriginal: typeof linha.nomeOriginal === 'string' ? linha.nomeOriginal : null,
    idServico: idServicoMelhorEnvioLi(linha.targetData),
  };
}

/**
 * Which target tipos a surface routes to, as DATA: `aceitos` are routed; `deliberados` are
 * recognised and left on the conta's doc on purpose (a `deliberado` answer, never an error).
 * A tipo in both lists is `deliberado`. Neither list can name `lojaIntegrada` or a marketplace's
 * freight — the type admits only {@link TIPOS_ALVO_MAPA_FRETE_LI} — so a policy never routes a
 * pedido back to a router.
 */
export interface PoliticaAlvoLi {
  readonly aceitos: readonly TipoAlvoMapaFreteLi[];
  readonly deliberados: readonly TipoAlvoMapaFreteLi[];
}

/**
 * The LABEL policy: every one of the five targets prints a label (`fob` and `outros` through the
 * generic label), and none is deliberate.
 */
export const POLITICA_ALVO_ETIQUETA_LI = {
  aceitos: TIPOS_ALVO_MAPA_FRETE_LI,
  deliberados: [],
} as const satisfies PoliticaAlvoLi;

/** What {@link avaliarAlvoDoMapaLi} answers for one target read. */
export type AvaliacaoAlvoLi =
  | {
      readonly tipo: 'valido';
      readonly tipoAlvo: TipoAlvoMapaFreteLi;
      /** The Melhor Envio service for a `melhorEnvios` target; `null` for every other tipo. */
      readonly externalOptionId: string | null;
    }
  | { readonly tipo: 'deliberado'; readonly tipoAlvo: TipoAlvoMapaFreteLi }
  | { readonly tipo: 'invalido'; readonly motivo: MotivoFreteNaoSuportadoLi };

/**
 * Judge a target `int_frete` doc as read by id (`alvoLido`: its RAW data, or `null` / `undefined`
 * when it does not exist) against a policy, in this order:
 *
 *  1. absent (or not a plain object) ⇒ `alvo-ausente`;
 *  2. `ativo === false` ⇒ `alvo-inativo` (an ABSENT `ativo` reads as active);
 *  3. a tipo the policy lists as deliberate ⇒ `deliberado`;
 *  4. a tipo outside the five targets, or outside the policy's `aceitos` ⇒ `tipo-nao-suportado`
 *     (the tipo is compared EXACTLY: `'MelhorEnvios'` is not `melhorEnvios`);
 *  5. a `melhorEnvios` target with no service (`idServico === null`) ⇒ `alvo-sem-servico`;
 *  6. otherwise `valido`, carrying the service for a Melhor Envio target.
 *
 * The tipo is ALWAYS the target document's own, never a row's `targetTipoIntegracao` copy.
 */
export function avaliarAlvoDoMapaLi(
  alvoLido: unknown,
  idServico: string | null,
  politica: PoliticaAlvoLi,
): AvaliacaoAlvoLi {
  const dados = comoObjeto(alvoLido);
  if (dados === null)
    return { tipo: 'invalido', motivo: MOTIVO_FRETE_NAO_SUPORTADO_LI.alvoAusente };
  if (dados.ativo === false) {
    return { tipo: 'invalido', motivo: MOTIVO_FRETE_NAO_SUPORTADO_LI.alvoInativo };
  }
  const tipoAlvo = tipoAlvoOuNull(dados.tipo);
  if (tipoAlvo !== null && politica.deliberados.includes(tipoAlvo)) {
    return { tipo: 'deliberado', tipoAlvo };
  }
  if (tipoAlvo === null || !politica.aceitos.includes(tipoAlvo)) {
    return { tipo: 'invalido', motivo: MOTIVO_FRETE_NAO_SUPORTADO_LI.tipoNaoSuportado };
  }
  if (tipoAlvo === INTEGRACAO_FRETE.melhorEnvios) {
    return idServico === null
      ? { tipo: 'invalido', motivo: MOTIVO_FRETE_NAO_SUPORTADO_LI.alvoSemServico }
      : { tipo: 'valido', tipoAlvo, externalOptionId: idServico };
  }
  return { tipo: 'valido', tipoAlvo, externalOptionId: null };
}

/**
 * Why the label route refuses to route a pedido — a CODE; the operator copy keys on it. A refusal
 * is a decision, never an error. It includes the four {@link MOTIVO_FRETE_NAO_SUPORTADO_LI}
 * values, under the same spelling.
 *
 *  - `sem-chave` — the pedido keeps no usable Loja Integrada shipping method (`externalOptionData`);
 *  - `sem-mapeamento` — the method has no row, or its row names no target;
 *  - `mapa-invalido` — the conta's `mapa` is present and not a list;
 *  - `doc-li-divergente` — the Loja Integrada doc is inactive, or belongs to another conta;
 *  - `sem-rota-li` — the pedido's ref names neither a target nor a Loja Integrada doc;
 *  - `estado-nao-pago` — the pedido is not `pago`;
 *  - `sem-frete` — the pedido ships nothing (modalidade `'9'`);
 *  - `etiqueta-ja-comprada` — a label was already bought for it;
 *  - `alvo-ausente`, `alvo-inativo`, `alvo-sem-servico`, `tipo-nao-suportado` — the MAPPED target
 *    fails the label policy;
 *  - `override-invalido` — a hand-picked target (stored, or the operator's choice) is not a usable
 *    label target;
 *  - `sem-endereco` — no delivery address, and the target is not a pickup.
 */
export const motivoRotaEtiquetaLiSchema = z.enum([
  'sem-chave',
  'sem-mapeamento',
  'mapa-invalido',
  'doc-li-divergente',
  'sem-rota-li',
  'estado-nao-pago',
  'sem-frete',
  'etiqueta-ja-comprada',
  'alvo-ausente',
  'alvo-inativo',
  'alvo-sem-servico',
  'tipo-nao-suportado',
  'override-invalido',
  'sem-endereco',
]);
export type MotivoRotaEtiquetaLi = z.infer<typeof motivoRotaEtiquetaLiSchema>;

/** Named members of {@link motivoRotaEtiquetaLiSchema} — see `delfrance/prefer-schema-enum`. */
export const MOTIVO_ROTA_ETIQUETA_LI = {
  semChave: 'sem-chave',
  semMapeamento: 'sem-mapeamento',
  mapaInvalido: 'mapa-invalido',
  docLiDivergente: 'doc-li-divergente',
  semRotaLi: 'sem-rota-li',
  estadoNaoPago: 'estado-nao-pago',
  semFrete: 'sem-frete',
  etiquetaJaComprada: 'etiqueta-ja-comprada',
  alvoAusente: 'alvo-ausente',
  alvoInativo: 'alvo-inativo',
  alvoSemServico: 'alvo-sem-servico',
  tipoNaoSuportado: 'tipo-nao-suportado',
  overrideInvalido: 'override-invalido',
  semEndereco: 'sem-endereco',
} as const satisfies Record<string, MotivoRotaEtiquetaLi>;

/** What the doc a pedido's `integracaoFreteOuterRef` names says about its route. */
export type DocDoFreteLi =
  /** A label target: the pedido is already routed; nothing to do. */
  | { readonly tipo: 'alvo'; readonly tipoAlvo: TipoAlvoMapaFreteLi }
  /** The conta's Loja Integrada doc: the pedido still needs a route. */
  | { readonly tipo: 'doc-li' }
  /** Absent, unreadable, or of any other tipo. */
  | { readonly tipo: 'sem-rota-li' };

/**
 * Classify the doc a pedido's `freteInicial.integracaoFreteOuterRef` names, by its RAW data
 * (`null` / `undefined` when it does not exist): a label target by its own `tipo` — whatever its
 * `ativo`, since a pedido routed at import keeps its route when the target is later deactivated —
 * the Loja Integrada doc, or neither. The tipo is compared exactly.
 */
export function classificarDocDoFreteLi(docLido: unknown): DocDoFreteLi {
  const dados = comoObjeto(docLido);
  if (dados === null) return { tipo: 'sem-rota-li' };
  if (dados.tipo === INTEGRACAO_FRETE.lojaIntegrada) return { tipo: 'doc-li' };
  const tipoAlvo = tipoAlvoOuNull(dados.tipo);
  return tipoAlvo === null ? { tipo: 'sem-rota-li' } : { tipo: 'alvo', tipoAlvo };
}

/**
 * Whether a raw `printLabelId` names a bought label: a NON-EMPTY string — the Melhor Envio buy's
 * own reading of the field (`ancoraDe` in `apps/melhor-envio/lib/freight/compraEtiqueta.ts`), so
 * the guard below never refuses a pedido the buy itself calls label-free. `null`, absent, `''`
 * and a non-string name none.
 */
function etiquetaComprada(printLabelId: unknown): boolean {
  return typeof printLabelId === 'string' && printLabelId.length > 0;
}

/**
 * The pedido guard, on the RAW pedido, in this order: `estado === 'pago'` (the checkout's own
 * gate: a cart, a cancellation in progress and every voided estado are refused), then no label
 * bought (`freteInicial.printLabelId` is not a non-empty string), then a pedido that ships
 * something (`freteInicial.modalidade !== '9'`). `null` when it passes.
 */
export function recusaDoPedidoParaRotaLi(pedidoLido: unknown): MotivoRotaEtiquetaLi | null {
  const pedido = comoObjeto(pedidoLido);
  if (pedido?.estado !== ESTADO_PEDIDO.pago) return MOTIVO_ROTA_ETIQUETA_LI.estadoNaoPago;
  const frete = comoObjeto(pedido.freteInicial);
  if (etiquetaComprada(frete?.printLabelId)) return MOTIVO_ROTA_ETIQUETA_LI.etiquetaJaComprada;
  if (frete?.modalidade === MODALIDADE_FRETE.semTransporte) return MOTIVO_ROTA_ETIQUETA_LI.semFrete;
  return null;
}

/**
 * The Loja Integrada doc guard: `doc-li-divergente` unless the doc (its RAW data) is active
 * (`ativo !== false`) AND its back-reference `contaLojaIntegradaEnviosOuterRef` names the pedido's
 * own conta (`integracaoPedidoOuterRef`). The mapa of a superseded doc, or of another conta's, is
 * not the mapa the import reads.
 *
 * The two sides are read DIFFERENTLY, on purpose:
 *
 * - the PEDIDO's ref names the conta, and is read tolerantly through {@link toOuterRefOrNull}, so
 *   its bare form and its `documents/` form are the same conta;
 * - the DOC's back-ref is compared EXACTLY against that canonical `documents/integracao/<id>`,
 *   as the conta sync's own `ehDocDaConta` (`@delfrance/data/admin/frete`) compares it. The
 *   import finds a conta's doc by that exact value, so a doc whose back-ref is in any other form
 *   is a doc the import never reads — routing by its mapa would route by a mapa nobody edits.
 *
 * Equal: the pedido's `'integracao/c'` ≡ `'documents/integracao/c'`. Distinct: `'integracao/c2'`;
 * a doc back-ref `'integracao/c'` (not canonical); an unreadable ref on either side (`null`, `''`,
 * an odd path) never matches anything.
 */
export function recusaDoDocLiParaRotaLi(
  docLi: unknown,
  integracaoPedidoOuterRef: unknown,
): MotivoRotaEtiquetaLi | null {
  const dados = comoObjeto(docLi);
  if (dados === null || dados.ativo === false) return MOTIVO_ROTA_ETIQUETA_LI.docLiDivergente;
  const doPedido = toOuterRefOrNull(integracaoPedidoOuterRef);
  if (doPedido === null || dados.contaLojaIntegradaEnviosOuterRef !== doPedido) {
    return MOTIVO_ROTA_ETIQUETA_LI.docLiDivergente;
  }
  return null;
}

/**
 * Whether a target needs no delivery address: a pickup (`retiradaNaLoja`) only. Every other
 * target — motoboy included — ships to an address. The tipo is compared exactly.
 */
export function alvoDispensaEnderecoLi(tipoAlvo: unknown): boolean {
  return tipoAlvo === INTEGRACAO_FRETE.retiradaNaLoja;
}

/** Where a route's target came from. Only `escolha` writes `integracaoTargetOuterRef`. */
export type OrigemRotaEtiquetaLi = 'escolha' | 'override' | 'mapa';

/** What {@link planejarRotaEtiquetaLi} answers: a refusal, or the docs to read. */
export type PlanoRotaEtiquetaLi =
  | { readonly tipo: 'recusa'; readonly motivo: MotivoRotaEtiquetaLi }
  | {
      readonly tipo: 'ler';
      readonly origem: OrigemRotaEtiquetaLi;
      /** The target `int_frete` doc id to read (always a usable doc id). */
      readonly alvoId: string;
      /**
       * `escolha` / `override` only: the target of the method's OWN mapa row, to read as well —
       * its tipo decides whether the row's service applies. `null` when the row maps nothing, and
       * always for `mapa` (the target IS the row's). May equal `alvoId`.
       */
      readonly lerLinha: string | null;
      /** The method's mapa row service ({@link idServicoMelhorEnvioLi}), or `null`. */
      readonly idServicoDaLinha: string | null;
      /**
       * `escolha` / `override` only: the stored `externalOptionId`, when the stored
       * `integracaoFreteOuterRef` ALREADY names this target, as {@link idIntFreteDaRefLi} reads it
       * (the option belongs to its ref). Never true for a pedido still on its Loja Integrada doc.
       */
      readonly idServicoArmazenado: string | null;
      /** The pedido carries a readable `enderecoFreteOuterReference`. */
      readonly temEndereco: boolean;
    };

/** `documents/int_frete/<id>`, for an id {@link naoDocId} accepts. */
function refIntFrete(id: string): OuterRef {
  return toOuterRef(`int_frete/${id}`);
}

/** The canonical form of a ref to a doc directly under the top-level `int_frete` collection. */
const PREFIXO_REF_INT_FRETE = 'documents/int_frete/';

/**
 * The `int_frete` doc id a stored REF names, or `null` when it names none — the ONE reader of an
 * `int_frete` ref on the label route. {@link planejarRotaEtiquetaLi} reads a stored override
 * (`integracaoTargetOuterRef`), and the stored `integracaoFreteOuterRef` beside it, through it;
 * the routing route and the web's read-only preview are to read the pedido's
 * `integracaoFreteOuterRef` through it before any read. So the three can never disagree on which
 * doc a ref names, and a ref naming none is never read at all. The inverse of the ref a route
 * writes (`integracaoFreteOuterRef` in {@link ConclusaoRotaEtiquetaLi}).
 *
 * The ref is canonicalised by `toOuterRefOrNull` (its bare `int_frete/<id>` form and its
 * `documents/` form are one ref), then it must name a doc DIRECTLY under the top-level
 * `int_frete` collection, under an id a document can have ({@link naoDocId}). The id is returned
 * verbatim: never trimmed, never case-folded.
 *
 * Equal: `'int_frete/abc'` ≡ `'documents/int_frete/abc'` ≡ `'/documents/int_frete/abc'` ≡
 * `'documents/int_frete/abc/'` → `'abc'`. Distinct: `'int_frete/abcd'` and `'int_frete/ abc'` are
 * other ids; `null` for another collection (`'integracao/abc'`, `'int_frete_x/abc'`), a nested doc
 * (`'int_frete/abc/sub/x'`, `'clientes/c/int_frete/abc'`), an id of `.` or `..`, the bare
 * collection (`'int_frete'`), `''` and a non-string (an object carrying a `path` included). ⚠️ A
 * NAKED id (`'abc'`) is not a ref and names NO doc here, unlike a `mapa` row's `integracaoUid`
 * ({@link idDoAlvoDoMapaLi}, a different field): no other reader of these ref fields resolves one
 * — the label host's dereference canonicalises through the same `toOuterRefOrNull`, which refuses
 * it — so naming a doc for it would let the route answer "already routed" for a pedido no label
 * path can print. Never throws.
 */
export function idIntFreteDaRefLi(ref: unknown): string | null {
  const canonica = toOuterRefOrNull(ref);
  if (canonica === null || !canonica.startsWith(PREFIXO_REF_INT_FRETE)) return null;
  const id = canonica.slice(PREFIXO_REF_INT_FRETE.length);
  return naoDocId(id) ? null : id;
}

/**
 * Plan the route of a pedido still on its conta's Loja Integrada doc, from its RAW `freteInicial`
 * (`frete`), that doc's RAW `mapa` and the operator's choice, if any (`escolha`, an `int_frete`
 * doc id). Precedence, first match wins:
 *
 *  1. **`escolha`** (the per-pedido picker) ⇒ read that target (`origem: 'escolha'`). An escolha
 *     that is not a usable doc id ⇒ `override-invalido`.
 *  2. **A stored override** — `integracaoTargetOuterRef` not `null` / absent ⇒ read the
 *     `int_frete` doc it names ({@link idIntFreteDaRefLi}: bare or `documents/` form alike;
 *     `origem: 'override'`). A ref that names anything else (another collection, a sub-path, a
 *     naked id, `''`) ⇒ `override-invalido`, and the mapa is NOT consulted: an operator's choice is
 *     never silently replaced.
 *  3. **The mapa** ({@link decidirLinhaDoMapaLi} over `externalOptionData`) ⇒ read the row's
 *     target (`origem: 'mapa'`), or refuse `sem-chave` / `mapa-invalido` / `sem-mapeamento`.
 *
 * For 1 and 2 the plan also names the method's own row target (`lerLinha`): a hand-picked Melhor
 * Envio target takes its service from that row only when the row's target is itself Melhor Envio
 * ({@link concluirRotaEtiquetaLi}). A row target no document can be ({@link decidirLinhaDoMapaLi}'s
 * `alvoId: null`) is never read: as the target it is `alvo-ausente`, as `lerLinha` it is `null`.
 */
export function planejarRotaEtiquetaLi(
  frete: unknown,
  mapaDoDocLi: unknown,
  escolha: string | null = null,
): PlanoRotaEtiquetaLi {
  const bloco = comoObjeto(frete) ?? {};
  const linha = decidirLinhaDoMapaLi(mapaDoDocLi, bloco.externalOptionData);
  const temEndereco = toOuterRefOrNull(bloco.enderecoFreteOuterReference) !== null;
  // `alvoId: null` (a target no document can be) is never read: as the target it is
  // `alvo-ausente`, as `lerLinha` it is `null`.
  const doMapa =
    linha.tipo === 'mapeado' && linha.alvoId !== null
      ? { alvoId: linha.alvoId, idServico: linha.idServico }
      : null;

  const manual = (origem: 'escolha' | 'override', alvoId: string): PlanoRotaEtiquetaLi => ({
    tipo: 'ler',
    origem,
    alvoId,
    lerLinha: doMapa?.alvoId ?? null,
    idServicoDaLinha: doMapa?.idServico ?? null,
    idServicoArmazenado:
      idIntFreteDaRefLi(bloco.integracaoFreteOuterRef) === alvoId
        ? inteiroPositivoCanonicoLi(bloco.externalOptionId)
        : null,
    temEndereco,
  });

  if (escolha !== null) {
    return naoDocId(escolha)
      ? { tipo: 'recusa', motivo: MOTIVO_ROTA_ETIQUETA_LI.overrideInvalido }
      : manual('escolha', escolha);
  }
  const override = bloco.integracaoTargetOuterRef;
  if (override !== null && override !== undefined) {
    const alvoId = idIntFreteDaRefLi(override);
    return alvoId === null
      ? { tipo: 'recusa', motivo: MOTIVO_ROTA_ETIQUETA_LI.overrideInvalido }
      : manual('override', alvoId);
  }
  switch (linha.tipo) {
    case 'sem-chave':
      return { tipo: 'recusa', motivo: MOTIVO_ROTA_ETIQUETA_LI.semChave };
    case 'mapa-invalido':
      return { tipo: 'recusa', motivo: MOTIVO_ROTA_ETIQUETA_LI.mapaInvalido };
    case 'nao-mapeado':
      return { tipo: 'recusa', motivo: MOTIVO_ROTA_ETIQUETA_LI.semMapeamento };
    case 'mapeado':
      break;
  }
  if (doMapa === null) return { tipo: 'recusa', motivo: MOTIVO_ROTA_ETIQUETA_LI.alvoAusente };
  return {
    tipo: 'ler',
    origem: 'mapa',
    alvoId: doMapa.alvoId,
    lerLinha: null,
    idServicoDaLinha: doMapa.idServico,
    idServicoArmazenado: null,
    temEndereco,
  };
}

/** What {@link concluirRotaEtiquetaLi} answers. */
export type ConclusaoRotaEtiquetaLi =
  | { readonly tipo: 'recusa'; readonly motivo: MotivoRotaEtiquetaLi }
  | {
      readonly tipo: 'rota';
      readonly origem: OrigemRotaEtiquetaLi;
      readonly alvoId: string;
      readonly tipoAlvo: TipoAlvoMapaFreteLi;
      /** `documents/int_frete/<alvoId>` — the `integracaoFreteOuterRef` to write. */
      readonly integracaoFreteOuterRef: OuterRef;
      /** The `externalOptionId` to write: the Melhor Envio service, `null` for any other tipo. */
      readonly externalOptionId: string | null;
      /**
       * Non-`null` only for an `escolha`: the `integracaoTargetOuterRef` to write beside the route.
       * `null` means "leave the stored field as it is" — a mapa route never writes it, and a
       * stored override is already there.
       */
      readonly targetEscolhido: OuterRef | null;
    };

/**
 * Conclude a plan from the docs it named, read by id (RAW data, `null` / `undefined` when absent):
 * `alvoLido` for `alvoId`, `alvoDaLinhaLido` for `lerLinha` (ignored when `lerLinha` is `null`).
 *
 * - **The service.** A `mapa` route takes the row's. A hand-picked target (`escolha` /
 *   `override`) takes the stored option when the plan carries one, else the row's service ONLY
 *   when the row's own target, as read, is tipo `melhorEnvios`; else none.
 * - **The policy** is {@link POLITICA_ALVO_ETIQUETA_LI} through {@link avaliarAlvoDoMapaLi}. A
 *   failing MAPPED target refuses with its own motivo; a failing hand-picked one refuses
 *   `override-invalido`, except a missing service, which stays `alvo-sem-servico`. An invalid
 *   override never falls back to the mapa.
 * - **The endereço**, last: no readable delivery address and a target that does not dispense one
 *   ({@link alvoDispensaEnderecoLi}) ⇒ `sem-endereco`.
 */
export function concluirRotaEtiquetaLi(
  plano: PlanoRotaEtiquetaLi,
  alvoLido: unknown,
  alvoDaLinhaLido: unknown,
): ConclusaoRotaEtiquetaLi {
  if (plano.tipo === 'recusa') return plano;
  const manual = plano.origem !== 'mapa';
  const linhaEhMelhorEnvio =
    plano.lerLinha !== null && comoObjeto(alvoDaLinhaLido)?.tipo === INTEGRACAO_FRETE.melhorEnvios;
  const idServico = manual
    ? (plano.idServicoArmazenado ?? (linhaEhMelhorEnvio ? plano.idServicoDaLinha : null))
    : plano.idServicoDaLinha;

  const avaliacao = avaliarAlvoDoMapaLi(alvoLido, idServico, POLITICA_ALVO_ETIQUETA_LI);
  if (avaliacao.tipo === 'invalido') {
    const motivo: MotivoRotaEtiquetaLi =
      manual && avaliacao.motivo !== MOTIVO_FRETE_NAO_SUPORTADO_LI.alvoSemServico
        ? MOTIVO_ROTA_ETIQUETA_LI.overrideInvalido
        : avaliacao.motivo;
    return { tipo: 'recusa', motivo };
  }
  // Unreachable under the label policy (no deliberate tipo); refused, never routed, if a policy
  // ever gains one.
  if (avaliacao.tipo === 'deliberado') {
    return { tipo: 'recusa', motivo: MOTIVO_ROTA_ETIQUETA_LI.tipoNaoSuportado };
  }
  if (!plano.temEndereco && !alvoDispensaEnderecoLi(avaliacao.tipoAlvo)) {
    return { tipo: 'recusa', motivo: MOTIVO_ROTA_ETIQUETA_LI.semEndereco };
  }
  const integracaoFreteOuterRef = refIntFrete(plano.alvoId);
  return {
    tipo: 'rota',
    origem: plano.origem,
    alvoId: plano.alvoId,
    tipoAlvo: avaliacao.tipoAlvo,
    integracaoFreteOuterRef,
    externalOptionId: avaliacao.externalOptionId,
    targetEscolhido: plano.origem === 'escolha' ? integracaoFreteOuterRef : null,
  };
}
