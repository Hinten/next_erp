/**
 * Native kits (step 19, #1527) — the paths, wire constants, request shapes and
 * bound guards of the three `v2.product.*` kit WRITES {@link ShopeeClient} runs
 * (`addKitItem`, `updateKitItem`, `generateKitImage`), the success alias of the
 * `get_kit_item_limit` read, and {@link linhasDeReenvioDoKit}, the ONE copy of a
 * live kit model's components back onto the wire.
 *
 * The operations themselves are `api.ts`'s; their response schemas are
 * `types.ts`'s section "Kits — escrita (step 19)". This module holds what they
 * share — the `logistica.ts` / `devolucoes.ts` / `tabelasDeMedidas.ts` split,
 * for the same reason: `api.ts` must not grow by another step's worth of
 * request types and guards.
 *
 * ⚠️ **The one type-only back edge.** The kit body reuses three step-11 wire
 * shapes that live in `api.ts` — `ShopeeLogisticInfoRequest`,
 * `ShopeeDimensionRequest`, `ShopeePreOrderRequest` — and imports them with
 * `import type`, which is ERASED: there is no runtime cycle (`api.ts` imports
 * this module's values; this module imports none of `api.ts`'s). Re-declaring
 * the three here would be a second copy of one wire shape, the #1369 smell.
 * The numeric guards are LOCAL copies, as `tabelasDeMedidas.ts` keeps its own.
 *
 * ⚠️ **Every guard runs BEFORE the access token is asked for**, every branch is
 * a `ShopeeConfigError` (a caller bug, never a provider failure), and **no
 * guard message carries a VALUE** — each names the FIELD, a position, a count or
 * a type.
 *
 * ⚠️ **There is deliberately NO component-count constant.** Three doc
 * statements disagree: `get_kit_item_limit` samples 2/10, the `add_kit_item`
 * error example says "more than 2 and less than 10", and announcement 1262 says
 * "Quantity must be higher than one for kits with one model". They agree only if
 * the bound is on Σ`quantity` rather than on the number of rows — UNVERIFIED. So
 * the band, when served, is the app's, and `add_kit_item` is the authority. The
 * ONE component rule this package enforces is announcement 1262's: a model with
 * ONE component row needs `quantity >= 2`.
 *
 * ⚠️ **ONE `main_component: true` per KIT, never per model** — MEASURED (SG
 * sandbox, probe #2, 2026-10-07): a second main anywhere in the kit is refused
 * with `product.error_busi` "mupltiple main sku". The create guard demands
 * exactly one across ALL models; the update guard allows at most one across the
 * sent list and none on an appended model (the main is frozen after create).
 *
 * ⚠️ **`component_model_id: 0` is refused everywhere — OMIT the key instead.**
 * For a component item with NO variations Shopee mints a HIDDEN default model id
 * (non-zero, `''` name/sku, absent from `get_model_list`); a create omits the
 * key and Shopee fills it in, and a resend carries the hidden id verbatim
 * ({@link linhasDeReenvioDoKit}). `0` is never "no model".
 *
 * ⚠️ **`update_kit_item` is PARTIAL and its 200 proves nothing** (probe #2):
 * sending only the changed models, with no tier list, keeps the omitted ones;
 * an append (`model_id: 0` + the WHOLE tier list) works; and a QUANTITY change
 * on an existing model answers 200 and is SILENTLY IGNORED. Every kit write is
 * verified by a read-back — never by this guard and never by the ack.
 */
import { roundReais } from '@delfrance/core/money';

import type {
  ShopeeDimensionRequest,
  ShopeeLogisticInfoRequest,
  ShopeePreOrderRequest,
} from './api';
import { ShopeeConfigError } from './errors';
import { SHOPEE_MODEL_SKU_MAX_LENGTH, type ShopeeKitModel } from './types';

/* -------------------------------------------------------------------------- */
/*                                 The paths                                  */
/* -------------------------------------------------------------------------- */

/** `POST` — Shop-signed. WRAPPED. Creates the kit; answers `response.item_id`. NOT idempotent. */
export const SHOPEE_ADD_KIT_ITEM_PATH = '/api/v2/product/add_kit_item';
/** `POST` — Shop-signed. FLAT (bare envelope; no `response`). Appends models; edits image/price/model_sku only. */
export const SHOPEE_UPDATE_KIT_ITEM_PATH = '/api/v2/product/update_kit_item';
/** `POST` — Shop-signed. WRAPPED `response.kit_image`. Keys CONTRADICT the page (PROBE). */
export const SHOPEE_GENERATE_KIT_IMAGE_PATH = '/api/v2/product/generate_kit_image';

/* -------------------------------------------------------------------------- */
/*                             The wire constants                             */
/* -------------------------------------------------------------------------- */

/** `add_kit_item`: "model number at most 9"; its tier: "1 to 9 kit variations". */
export const SHOPEE_KIT_MAX_MODELS = 9;

/**
 * `item_setting.images.image_id_list` — the `get_kit_item_limit` SAMPLE band
 * max (`item_image_count_limit` 1…10).
 *
 * ⚠️ NOT `SHOPEE_ITEM_IMAGE_MAX` (9, an ITEM's ceiling). The two are never
 * merged: the app sends at most `min(9, served max)` through step 11's photo
 * resolver, and this is only the WIRE ceiling.
 */
export const SHOPEE_KIT_IMAGE_MAX = 10;

/** `generate_kit_image` — PROBE: "value must contain between 2 and 9 items, inclusive". */
export const SHOPEE_KIT_IMAGE_COMPONENTES_MIN = 2;
/** `generate_kit_image` — the upper half of the same PROBE sentence. */
export const SHOPEE_KIT_IMAGE_COMPONENTES_MAX = 9;

/**
 * The envelope `error` value the `v2.product.get_kit_item_limit` page prints on
 * its ONLY success sample — `{"error": "-", "message": "success", "warning":
 * "-", …}` — where every other product page prints `""`. Tolerated on that ONE
 * call site through `ShopeeCallParams.emptyErrorAliases` (`call.ts`).
 *
 * ⚠️ Its OWN constant — the FOURTH, beside the lost-push pair's, the package
 * detail's (`api.ts`) and the returns' (`devolucoes.ts`) — because the
 * contradiction is per PAGE (the `call.ts` rule): narrowing another page's
 * alias must never move this one.
 *
 * ⚠️ Added on the doc's word: no host has answered a success yet (the sandbox
 * answers a bare 404, `ShopeeOperacaoNaoServidaError`). The cost is asymmetric:
 * with the alias, a `-` that meant failure dies at stage 2 (no `response`) as a
 * `ShopeeSchemaError`; without it, a live `-` would make every kit-limit read
 * throw. `' '` stays a FAILURE here — EXACT equality, and a test pins it.
 */
export const SHOPEE_KIT_ITEM_LIMIT_ERROR_ALIASES = ['-'] as const;

/* -------------------------------------------------------------------------- */
/*                   The request shapes (the WIRE bodies)                     */
/* -------------------------------------------------------------------------- */

/** One component row of one kit model, as `add_kit_item` / `update_kit_item` carry it. */
export interface ShopeeKitComponentRequest {
  readonly component_item_id: number;
  /** OMITTED for a component item with no variations — never `0` (Shopee mints a hidden model id). */
  readonly component_model_id?: number;
  readonly quantity: number;
  readonly main_component?: boolean;
}

/** One kit model on CREATE. */
export interface ShopeeKitModelRequest {
  /** ONE tier ⇒ exactly one index. */
  readonly tier_index: readonly [number];
  readonly original_price: number;
  readonly component_list: readonly ShopeeKitComponentRequest[];
  readonly model_sku?: string;
}

/** The ONE tier of a kit. */
export interface ShopeeKitTierRequest {
  readonly name?: string;
  /**
   * 1…{@link SHOPEE_KIT_MAX_MODELS} options. ⚠️ Option images are
   * ALL-OR-NONE: "If you choose to define, you need to define an image for all
   * options."
   */
  readonly option_list: readonly {
    readonly option: string;
    readonly image?: { readonly image_id: string };
  }[];
}

/**
 * `add_kit_item.item_setting`.
 *
 * ⚠️ **Not declared, on purpose:** `category_id`, `attribute_list`, `brand`,
 * `condition`, `gtin_code`, `size_chart_info`, `seller_stock` and `tax_info` —
 * none is on the page (category, attributes and brand SYNC from the main
 * component), so a kit create cannot carry NCM/CEST or a size chart. Nor
 * `long_images`, `video_upload_id` or `description_info` (nothing produces
 * them). `test/kits.test.ts` pins `seller_stock` and `category_id` OUT with
 * `@ts-expect-error`.
 *
 * ⚠️ `item_sku` stays optional in the TYPE, because the type describes the
 * wire (the `condition` precedent on `ShopeeAddItemRequest`). The app refuses
 * a create without one before the call: the duplicate-kit scan and step 9's
 * import key on it.
 */
export interface ShopeeKitItemSetting {
  readonly item_name: string;
  /** ⚠️ `images` here, `image` on `add_item`. */
  readonly images: { readonly image_id_list: readonly string[] };
  /** `extended` is whitelist-only (`add_item`'s narrowing). */
  readonly description_type: 'normal';
  readonly description: string;
  readonly logistic_info: readonly ShopeeLogisticInfoRequest[];
  readonly weight: number;
  readonly dimension?: ShopeeDimensionRequest;
  readonly pre_order?: ShopeePreOrderRequest;
  /** ⚠️ NOT `item_status`. */
  readonly unlisted?: boolean;
  readonly item_sku?: string;
  /** Exactly ONE tier. */
  readonly tier_variation_list: readonly [ShopeeKitTierRequest];
  readonly model_list: readonly ShopeeKitModelRequest[];
}

/** `add_kit_item` — the WHOLE body. */
export interface ShopeeAddKitItemRequest {
  readonly item_setting: ShopeeKitItemSetting;
  /** "Auto sync the pre_order setting from main component or not." */
  readonly sync_setting?: { readonly auto_sync_dts: boolean };
}

/** One kit model on UPDATE. */
export interface ShopeeUpdateKitModelRequest {
  /** EXISTING model: its positive id. APPENDED model: `0` — the page sample's sentinel, the ONE spelling. */
  readonly model_id: number;
  readonly tier_index: readonly [number];
  readonly original_price?: number;
  readonly model_sku?: string;
  readonly component_list?: readonly ShopeeKitComponentRequest[];
}

/**
 * `update_kit_item` — `item_id` is the only field the page REQUIRES.
 *
 * ⚠️ PARTIAL (probe #2): omitted models are KEPT, so a price change sends only
 * the changed models with no tier list. An APPENDED model (`model_id: 0`)
 * needs the WHOLE tier list resent with its new option. Items, the main
 * component and per-kit quantities of an existing model are frozen — and a
 * changed quantity is a SILENT 200, never a refusal.
 */
export interface ShopeeUpdateKitItemRequest {
  readonly item_id: number;
  readonly item_setting?: Partial<
    Omit<ShopeeKitItemSetting, 'model_list' | 'tier_variation_list'>
  > & {
    readonly model_list?: readonly ShopeeUpdateKitModelRequest[];
    readonly tier_variation_list?: readonly [ShopeeKitTierRequest];
  };
  readonly sync_setting?: { readonly auto_sync_dts: boolean };
}

/**
 * `generate_kit_image` — the ONE kit op whose caller passes camelCase PARAMS
 * rather than the wire body: the page documents `component_item_id` /
 * `component_model_id`, and the server's own validator (PROBE) demands
 * `item_id` / `model_id` ("ItemId is required", "ModelId is required"). So the
 * contradicted spelling lives in exactly one place, inside the method — the
 * `SHOPEE_ESCROW_DETAIL_TRANSPORT` argument: one literal flips the contract.
 */
export interface GenerateKitImageParams {
  /**
   * {@link SHOPEE_KIT_IMAGE_COMPONENTES_MIN}…{@link SHOPEE_KIT_IMAGE_COMPONENTES_MAX}
   * (PROBE). `modelId` REQUIRED, positive — for a plain item the HIDDEN default
   * model id, which exists only on an existing kit (`get_kit_item_info`).
   */
  readonly componentes: readonly { readonly itemId: number; readonly modelId: number }[];
}

/* -------------------------------------------------------------------------- */
/*                                The guards                                  */
/* -------------------------------------------------------------------------- */

/** `typeof`, with `null` and arrays named — the only thing a refusal may say about the value. */
function tipoDe(valor: unknown): string {
  if (valor === null) return 'null';
  if (Array.isArray(valor)) return 'array';
  return typeof valor;
}

function recusar(mensagem: string): never {
  throw new ShopeeConfigError(mensagem);
}

/** A positive safe integer. Local copy of `api.ts`'s `assertIdPositivo`, without the value echo. */
function assertIdPositivo(nome: string, valor: unknown): void {
  if (typeof valor !== 'number' || !Number.isSafeInteger(valor) || valor <= 0) {
    recusar(`${nome} deve ser um inteiro positivo (recebido: ${tipoDe(valor)}).`);
  }
}

/** A non-negative safe integer (`0` included). */
function assertInteiroNaoNegativo(nome: string, valor: unknown): void {
  if (typeof valor !== 'number' || !Number.isSafeInteger(valor) || valor < 0) {
    recusar(`${nome} deve ser um inteiro >= 0 (recebido: ${tipoDe(valor)}).`);
  }
}

/** A finite, strictly positive number. */
function assertPositivoFinito(nome: string, valor: unknown): void {
  if (typeof valor !== 'number' || !Number.isFinite(valor) || valor <= 0) {
    recusar(`${nome} deve ser um número positivo (recebido: ${tipoDe(valor)}).`);
  }
}

/**
 * A price already in centavos: positive, finite, and `roundReais(p) === p` —
 * the ONE sanctioned money rounding (step 13's rule). Refused, never rounded:
 * the package never picks a price the caller did not.
 */
function assertPreco(nome: string, valor: unknown): void {
  assertPositivoFinito(nome, valor);
  if (roundReais(valor as number) !== valor) {
    recusar(
      `${nome} deve ter no máximo duas casas decimais — o arredondamento é de quem chama, nunca do pacote.`,
    );
  }
}

/** A non-blank string. */
function assertTexto(nome: string, valor: unknown): void {
  if (typeof valor !== 'string' || valor.trim() === '') {
    recusar(`${nome} deve ser um texto não vazio (recebido: ${tipoDe(valor)}).`);
  }
}

function assertBooleano(nome: string, valor: unknown): void {
  if (typeof valor !== 'boolean') {
    recusar(`${nome} deve ser true ou false (recebido: ${tipoDe(valor)}).`);
  }
}

/** A plain object (never `null`, never an array). */
function assertObjeto(nome: string, valor: unknown): asserts valor is Record<string, unknown> {
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) {
    recusar(`${nome} deve ser um objeto (recebido: ${tipoDe(valor)}).`);
  }
}

/** An array of `min…max` entries; returns it typed as unknowns. */
function assertLista(nome: string, valor: unknown, min: number, max: number): readonly unknown[] {
  if (!Array.isArray(valor)) {
    recusar(`${nome} deve ser uma lista (recebido: ${tipoDe(valor)}).`);
  }
  const lista: readonly unknown[] = valor;
  if (lista.length < min || lista.length > max) {
    const faixa =
      max === Number.POSITIVE_INFINITY
        ? `ao menos ${String(min)}`
        : `de ${String(min)} a ${String(max)}`;
    recusar(`${nome} deve conter ${faixa} entradas (recebido: ${String(lista.length)}).`);
  }
  return lista;
}

/** `item_setting.images.image_id_list` — 1…{@link SHOPEE_KIT_IMAGE_MAX} non-blank ids (rendered POSITIONALLY). */
function assertImagens(nome: string, valor: unknown): void {
  assertObjeto(nome, valor);
  const ids = assertLista(`${nome}.image_id_list`, valor.image_id_list, 1, SHOPEE_KIT_IMAGE_MAX);
  ids.forEach((id, posicao) => {
    assertTexto(`${nome}.image_id_list[${String(posicao)}]`, id);
  });
}

/** `logistic_info` — at least one channel, each `logistic_id` a positive id. */
function assertLogistica(nome: string, valor: unknown): void {
  const canais = assertLista(nome, valor, 1, Number.POSITIVE_INFINITY);
  canais.forEach((canal, posicao) => {
    const onde = `${nome}[${String(posicao)}]`;
    assertObjeto(onde, canal);
    assertIdPositivo(`${onde}.logistic_id`, canal.logistic_id);
  });
}

/** Three positive int32 centimetres. */
function assertDimensao(nome: string, valor: unknown): void {
  assertObjeto(nome, valor);
  assertIdPositivo(`${nome}.package_height`, valor.package_height);
  assertIdPositivo(`${nome}.package_length`, valor.package_length);
  assertIdPositivo(`${nome}.package_width`, valor.package_width);
}

/** `model_sku` — optional, at most {@link SHOPEE_MODEL_SKU_MAX_LENGTH} characters. */
function assertModelSku(nome: string, valor: unknown): void {
  if (valor === undefined) return;
  if (typeof valor !== 'string') {
    recusar(`${nome} deve ser um texto (recebido: ${tipoDe(valor)}).`);
  }
  if (valor.length > SHOPEE_MODEL_SKU_MAX_LENGTH) {
    recusar(
      `${nome} deve ter no máximo ${String(SHOPEE_MODEL_SKU_MAX_LENGTH)} caracteres (recebido: ${String(valor.length)}).`,
    );
  }
}

/** `description_type` — `'normal'` only (`extended` is whitelist-only). */
function assertDescriptionType(nome: string, valor: unknown): void {
  if (valor !== 'normal') {
    recusar(
      `${nome} deve ser 'normal' — 'extended' é só para lojas na whitelist (recebido: ${tipoDe(valor)}).`,
    );
  }
}

/** The optional scalars of an `item_setting` that carry a type and nothing else. */
function assertEscalaresOpcionais(nome: string, setting: Record<string, unknown>): void {
  if (setting.unlisted !== undefined) assertBooleano(`${nome}.unlisted`, setting.unlisted);
  if (setting.item_sku !== undefined && typeof setting.item_sku !== 'string') {
    recusar(`${nome}.item_sku deve ser um texto (recebido: ${tipoDe(setting.item_sku)}).`);
  }
  if (setting.dimension !== undefined) assertDimensao(`${nome}.dimension`, setting.dimension);
}

/** `sync_setting` — when present, an object carrying a boolean `auto_sync_dts`. */
function assertSyncSetting(valor: unknown): void {
  if (valor === undefined) return;
  assertObjeto('sync_setting', valor);
  assertBooleano('sync_setting.auto_sync_dts', valor.auto_sync_dts);
}

/**
 * `tier_variation_list` — EXACTLY one tier, 1…{@link SHOPEE_KIT_MAX_MODELS}
 * non-blank options, option images all-or-none. Returns the option count.
 */
function assertTier(nome: string, valor: unknown): number {
  const tiers = assertLista(nome, valor, 1, 1);
  const onde = `${nome}[0]`;
  const tier = tiers[0];
  assertObjeto(onde, tier);
  if (tier.name !== undefined && typeof tier.name !== 'string') {
    recusar(`${onde}.name deve ser um texto (recebido: ${tipoDe(tier.name)}).`);
  }
  const opcoes = assertLista(`${onde}.option_list`, tier.option_list, 1, SHOPEE_KIT_MAX_MODELS);
  let comImagem = 0;
  opcoes.forEach((opcao, posicao) => {
    const aqui = `${onde}.option_list[${String(posicao)}]`;
    assertObjeto(aqui, opcao);
    assertTexto(`${aqui}.option`, opcao.option);
    if (opcao.image !== undefined) {
      assertObjeto(`${aqui}.image`, opcao.image);
      assertTexto(`${aqui}.image.image_id`, opcao.image.image_id);
      comImagem += 1;
    }
  });
  if (comImagem !== 0 && comImagem !== opcoes.length) {
    recusar(
      `${onde}.option_list: imagem de opção é tudo-ou-nada — ${String(comImagem)} de ${String(opcoes.length)} opções têm imagem.`,
    );
  }
  return opcoes.length;
}

/**
 * `tier_index` — exactly `[i]`, `i` a non-negative int and, when the body
 * declared the tier, `i < options`. Returns `i`.
 */
function assertTierIndex(nome: string, valor: unknown, opcoes: number | null): number {
  const indices = assertLista(nome, valor, 1, 1);
  const indice = indices[0];
  assertInteiroNaoNegativo(`${nome}[0]`, indice);
  const i = indice as number;
  if (opcoes !== null && i >= opcoes) {
    recusar(
      `${nome}[0] aponta para fora do tier — o tier declarado tem ${String(opcoes)} opção(ões).`,
    );
  }
  return i;
}

/**
 * One model's `component_list` — the §1.3 component rules. Returns how many
 * rows carry `main_component: true`, so the caller counts mains across the
 * KIT, never per model.
 *
 * - at least one row; each `component_item_id` a positive id;
 * - `component_model_id`, when present, POSITIVE — `0` is refused (omit it);
 * - `quantity` a positive safe int; `main_component` a boolean when present;
 * - no duplicate `(item, model)` pair inside the model (an absent model id is
 *   its own address);
 * - announcement 1262: a model with ONE row needs `quantity >= 2`.
 */
function assertComponentes(nome: string, valor: unknown): number {
  const linhas = assertLista(nome, valor, 1, Number.POSITIVE_INFINITY);
  const enderecos = new Set<string>();
  let principais = 0;
  linhas.forEach((linha, posicao) => {
    const onde = `${nome}[${String(posicao)}]`;
    assertObjeto(onde, linha);
    assertIdPositivo(`${onde}.component_item_id`, linha.component_item_id);
    if (linha.component_model_id !== undefined) {
      if (linha.component_model_id === 0) {
        recusar(
          `${onde}.component_model_id não pode ser 0 — para um item sem variações OMITA a chave (a Shopee cria o modelo oculto).`,
        );
      }
      assertIdPositivo(`${onde}.component_model_id`, linha.component_model_id);
    }
    assertIdPositivo(`${onde}.quantity`, linha.quantity);
    if (linha.main_component !== undefined) {
      assertBooleano(`${onde}.main_component`, linha.main_component);
      if (linha.main_component === true) principais += 1;
    }
    // ⚠️ Joined on a NUL, and an ABSENT model id is its own value, so
    // `(1, —)` and `(1, 5)` stay distinct while two `(1, —)` collide.
    const endereco = `${String(linha.component_item_id)}\u0000${
      linha.component_model_id === undefined ? '-' : String(linha.component_model_id)
    }`;
    if (enderecos.has(endereco)) {
      recusar(`${onde} repete um par (item, modelo) já listado neste modelo do kit.`);
    }
    enderecos.add(endereco);
  });
  if (linhas.length === 1) {
    const unica = linhas[0] as Record<string, unknown>;
    if ((unica.quantity as number) < 2) {
      recusar(
        `${nome}: um modelo de kit com UM componente precisa de quantity >= 2 (anúncio 1262: "Quantity must be higher than one for kits with one model").`,
      );
    }
  }
  return principais;
}

/**
 * Every `add_kit_item` bound, checked BEFORE the access token is asked for.
 *
 * 1. `item_name` and `description` non-blank, `description_type` `'normal'`,
 *    `weight` finite and > 0, at least one `logistic_info` with positive ids,
 *    `dimension` three positive ints when present.
 * 2. `images.image_id_list` 1…{@link SHOPEE_KIT_IMAGE_MAX} non-blank ids.
 * 3. ONE tier, 1…9 non-blank options, option images all-or-none.
 * 4. `model_list` 1…{@link SHOPEE_KIT_MAX_MODELS}; each `tier_index` exactly
 *    `[i]` with `0 <= i < options`; no two models share an `i`, and EVERY option
 *    has a model (the bijection is an inference — the page does not say it).
 * 5. Per model: `original_price` in centavos, `model_sku` <= 100, and the
 *    component rules of `assertComponentes` (`component_model_id: 0` refused,
 *    one-row models need `quantity >= 2`).
 * 6. EXACTLY ONE `main_component: true` across the WHOLE kit (MEASURED, P2-a).
 */
export function assertAddKitItemRequest(body: ShopeeAddKitItemRequest): void {
  const corpo: unknown = body;
  assertObjeto('add_kit_item', corpo);
  const setting: unknown = corpo.item_setting;
  assertObjeto('item_setting', setting);

  assertTexto('item_setting.item_name', setting.item_name);
  assertTexto('item_setting.description', setting.description);
  assertDescriptionType('item_setting.description_type', setting.description_type);
  assertImagens('item_setting.images', setting.images);
  assertLogistica('item_setting.logistic_info', setting.logistic_info);
  assertPositivoFinito('item_setting.weight', setting.weight);
  assertEscalaresOpcionais('item_setting', setting);

  const opcoes = assertTier('item_setting.tier_variation_list', setting.tier_variation_list);
  const modelos = assertLista(
    'item_setting.model_list',
    setting.model_list,
    1,
    SHOPEE_KIT_MAX_MODELS,
  );
  const usados = new Set<number>();
  let principais = 0;
  modelos.forEach((modelo, posicao) => {
    const onde = `item_setting.model_list[${String(posicao)}]`;
    assertObjeto(onde, modelo);
    const i = assertTierIndex(`${onde}.tier_index`, modelo.tier_index, opcoes);
    if (usados.has(i)) {
      recusar(
        `${onde}.tier_index repete uma opção já usada — dois modelos na mesma opção é um sobrescrevendo o outro.`,
      );
    }
    usados.add(i);
    assertPreco(`${onde}.original_price`, modelo.original_price);
    assertModelSku(`${onde}.model_sku`, modelo.model_sku);
    principais += assertComponentes(`${onde}.component_list`, modelo.component_list);
  });
  // Distinct indices, each `< opcoes`: equal counts ⇔ every option has a model.
  if (usados.size !== opcoes) {
    recusar(
      `item_setting.model_list cobre ${String(usados.size)} de ${String(opcoes)} opções do tier — cada opção precisa de exatamente um modelo.`,
    );
  }
  if (principais !== 1) {
    recusar(
      `o kit precisa de EXATAMENTE um main_component: true no kit inteiro, somando todos os modelos (recebido: ${String(principais)}) — a Shopee recusa um segundo ("mupltiple main sku").`,
    );
  }
  assertSyncSetting(corpo.sync_setting);
}

/**
 * Every `update_kit_item` bound, checked BEFORE the access token is asked for.
 *
 * 1. `item_id` positive, and the body must CHANGE something: at least one
 *    DEFINED value in `item_setting` or `sync_setting`, counted over values and
 *    never over keys (`exactOptionalPropertyTypes` is off — the
 *    `assertUpdateItemParams` rule). A bare `{item_id}` is refused.
 * 2. Every field present passes the create's per-field rule (images 1…10,
 *    price in centavos, `model_sku` <= 100, …).
 * 3. `model_list`: 1…9 entries; no duplicate `model_id > 0` and no duplicate
 *    `tier_index`. An EXISTING model (`model_id > 0`) may carry only
 *    `{model_id, tier_index, original_price, component_list}` and no tier list
 *    (P2-c's partial update). An APPENDED model (`model_id === 0`) must carry
 *    `original_price` AND `component_list`, passes the model rules, and needs
 *    `tier_variation_list` in the same body (the whole tier, resent with its new
 *    option); every `tier_index` then falls within its options. At most ONE
 *    `main_component: true` across the sent list, and none on an appended model
 *    (the main is frozen after create).
 *
 * ⚠️ It does not and cannot check that a resent model's `component_list`
 * equals what Shopee holds — {@link linhasDeReenvioDoKit} copies the LIVE
 * rows, and a quantity change is a silent 200 (P2-c), so only a read-back
 * tells.
 */
export function assertUpdateKitItemRequest(body: ShopeeUpdateKitItemRequest): void {
  const corpo: unknown = body;
  assertObjeto('update_kit_item', corpo);
  assertIdPositivo('item_id', corpo.item_id);

  const setting: unknown = corpo.item_setting;
  const sync: unknown = corpo.sync_setting;
  if (setting !== undefined) assertObjeto('item_setting', setting);
  if (sync !== undefined) assertObjeto('sync_setting', sync);
  const definidos = (o: unknown): number =>
    o === undefined
      ? 0
      : Object.values(o as Record<string, unknown>).filter((v) => v !== undefined).length;
  if (definidos(setting) + definidos(sync) === 0) {
    recusar(
      'update_kit_item precisa de ao menos um campo em item_setting ou sync_setting — um corpo só com o item_id gasta a chamada e não muda nada.',
    );
  }
  assertSyncSetting(sync);
  if (setting === undefined) return;
  const st = setting as Record<string, unknown>;

  if (st.item_name !== undefined) assertTexto('item_setting.item_name', st.item_name);
  if (st.description !== undefined) assertTexto('item_setting.description', st.description);
  if (st.description_type !== undefined) {
    assertDescriptionType('item_setting.description_type', st.description_type);
  }
  if (st.images !== undefined) assertImagens('item_setting.images', st.images);
  if (st.logistic_info !== undefined)
    assertLogistica('item_setting.logistic_info', st.logistic_info);
  if (st.weight !== undefined) assertPositivoFinito('item_setting.weight', st.weight);
  assertEscalaresOpcionais('item_setting', st);

  const opcoes =
    st.tier_variation_list === undefined
      ? null
      : assertTier('item_setting.tier_variation_list', st.tier_variation_list);
  if (st.model_list === undefined) return;

  const modelos = assertLista('item_setting.model_list', st.model_list, 1, SHOPEE_KIT_MAX_MODELS);
  const ids = new Set<number>();
  const usados = new Set<number>();
  let principais = 0;
  let anexa = false;
  modelos.forEach((modelo, posicao) => {
    const onde = `item_setting.model_list[${String(posicao)}]`;
    assertObjeto(onde, modelo);
    // ⚠️ `0` IS the append sentinel — hence the NON-negative guard.
    assertInteiroNaoNegativo(`${onde}.model_id`, modelo.model_id);
    const modelId = modelo.model_id as number;
    if (modelId > 0) {
      if (ids.has(modelId)) recusar(`${onde}.model_id repete um modelo já listado neste corpo.`);
      ids.add(modelId);
    }
    const i = assertTierIndex(`${onde}.tier_index`, modelo.tier_index, opcoes);
    if (usados.has(i)) {
      recusar(
        `${onde}.tier_index repete uma opção já usada — dois modelos na mesma opção é um sobrescrevendo o outro.`,
      );
    }
    usados.add(i);
    assertModelSku(`${onde}.model_sku`, modelo.model_sku);

    if (modelId === 0) {
      anexa = true;
      if (modelo.original_price === undefined) {
        recusar(`${onde} é um modelo ANEXADO (model_id 0) e precisa de original_price.`);
      }
      if (modelo.component_list === undefined) {
        recusar(`${onde} é um modelo ANEXADO (model_id 0) e precisa de component_list.`);
      }
    }
    if (modelo.original_price !== undefined) {
      assertPreco(`${onde}.original_price`, modelo.original_price);
    }
    if (modelo.component_list !== undefined) {
      const mains = assertComponentes(`${onde}.component_list`, modelo.component_list);
      if (modelId === 0 && mains > 0) {
        recusar(
          `${onde} é um modelo ANEXADO e não pode trazer main_component: true — o componente principal do kit é congelado na criação.`,
        );
      }
      principais += mains;
    }
  });
  if (anexa && opcoes === null) {
    recusar(
      'item_setting.tier_variation_list é obrigatório ao anexar um modelo (model_id 0) — o tier inteiro vai de novo, com a opção nova.',
    );
  }
  if (principais > 1) {
    recusar(
      `item_setting.model_list traz ${String(principais)} main_component: true — no máximo UM no kit inteiro ("mupltiple main sku").`,
    );
  }
}

/**
 * The `generate_kit_image` bound, checked BEFORE the access token is asked
 * for: {@link SHOPEE_KIT_IMAGE_COMPONENTES_MIN}…{@link SHOPEE_KIT_IMAGE_COMPONENTES_MAX}
 * entries, both ids positive safe ints (`modelId` REQUIRED — PROBE "ModelId is
 * required"), and no duplicate pair.
 */
export function assertGenerateKitImageParams(p: GenerateKitImageParams): void {
  const params: unknown = p;
  assertObjeto('generate_kit_image', params);
  const componentes = assertLista(
    'componentes',
    params.componentes,
    SHOPEE_KIT_IMAGE_COMPONENTES_MIN,
    SHOPEE_KIT_IMAGE_COMPONENTES_MAX,
  );
  const pares = new Set<string>();
  componentes.forEach((componente, posicao) => {
    const onde = `componentes[${String(posicao)}]`;
    assertObjeto(onde, componente);
    assertIdPositivo(`${onde}.itemId`, componente.itemId);
    assertIdPositivo(`${onde}.modelId`, componente.modelId);
    const par = `${String(componente.itemId)}\u0000${String(componente.modelId)}`;
    if (pares.has(par)) recusar(`${onde} repete um par (item, modelo) já listado.`);
    pares.add(par);
  });
}

/* -------------------------------------------------------------------------- */
/*                  The resend — the single wire→wire copy                    */
/* -------------------------------------------------------------------------- */

/**
 * Live kit model → the rows to RESEND verbatim (the hidden id included). The
 * single wire→wire copy: `update_kit_item` cannot change an existing model's
 * components (P2-c: a different quantity is a silent 200), so whatever goes
 * back is what `get_kit_item_info` just answered — never a re-encoding of the
 * ERP's recipe.
 *
 * Per row: `component_item_id` and `quantity` as read; `component_model_id`
 * only when it is POSITIVE (the HIDDEN default id of a plain component is
 * non-zero and IS resent; a `null` or `0` omits the key — `0` is never "no
 * model" on the wire); `main_component: true` only when it read `true` (a
 * `false`/`null` omits the key).
 *
 * ⚠️ Copying every `true` yields ONE main because the read flags it on one
 * model only — MEASURED (SG sandbox probe, 2026-10-07, 2- and 3-model kits):
 * one row of `model_list[0]` reads `true`, every other row of every model reads
 * `false`, so resending all models stays within
 * {@link assertUpdateKitItemRequest}'s at-most-one bound.
 *
 * ⚠️ A row whose `quantity` did not read is refused rather than guessed: there
 * is nothing verbatim to resend, and a made-up quantity is exactly the silent
 * no-op P2-c measured.
 */
export function linhasDeReenvioDoKit(modelo: ShopeeKitModel): ShopeeKitComponentRequest[] {
  return modelo.component_list.map((linha, posicao): ShopeeKitComponentRequest => {
    if (linha.quantity === null) {
      recusar(
        `component_list[${String(posicao)}].quantity não veio na leitura do kit — sem ela não há linha para reenviar verbatim.`,
      );
    }
    const modelId = linha.component_model_id;
    return {
      component_item_id: linha.component_item_id,
      ...(modelId !== null && modelId > 0 ? { component_model_id: modelId } : {}),
      quantity: linha.quantity,
      ...(linha.main_component === true ? { main_component: true } : {}),
    };
  });
}
