/**
 * The NEUTRALISATION of a BR listing read before it is committed (#1911) —
 * test-only, beside `redact.ts` and `cortarCategorias.ts`, and like them
 * imported by no `src` file.
 *
 * `redact.ts` removes what can FIND the shop: titles, descriptions, media URLs,
 * SKUs. A listing read carries a second thing a public repository should not:
 * the shop's commercial FINGERPRINT — what it charges, how much it holds, when
 * each listing was created and last touched, and the option name the seller
 * typed. Lucas chose on 2026-11-05 to replace exactly those leaves with FIXED
 * invented values of the same type, so every schema and every test still
 * parses ({@link CAMPOS_NEUTRALIZADOS}):
 *
 * - **Times** — a `response.item_list` row's `create_time` and `update_time`
 *   (epoch SECONDS, as the wire sends them) become {@link CRIACAO_NEUTRA} and
 *   {@link ATUALIZACAO_NEUTRA}. Absent stays absent.
 * - **Prices** — a `response.model` row's four price keys, on every
 *   `price_info` entry, become {@link PRECO_NEUTRO}. `currency` is kept.
 * - **Stock** — the model's `stock_info_v2` counts become
 *   {@link ESTOQUE_NEUTRO} when positive; a `0` stays `0`, so in-stock vs
 *   sold-out survives. ⚠️ The ARITHMETIC between them does not: after the
 *   transform `total_available_stock` is no longer the sum of the location
 *   rows, and no test may read it as one.
 * - **Seller-typed option names** — an option whose paired standardised
 *   option has `variation_option_id: 0`, or any option of a tier with no
 *   standard variation, is renamed `Opção inventada N` (N from 1, in tier then
 *   option order) in all three places it is spelled: the tier option, the
 *   paired standardised option when it held the same text, and every
 *   `model_name`, rebuilt as the comma-join of its tier options. Standard
 *   options (a non-zero id) are Shopee's own vocabulary and keep their names.
 *
 * Everything else is KEPT unchanged, key order included — every id,
 * `tier_index`, `currency` and the promotion flags; the tax data, weights,
 * dimensions, attribute values and logistics flags that Lucas named as kept on
 * 2026-11-05; and — not separately put to him —
 * `logistic_info.*.estimated_shipping_fee` and the pre-order settings. Tier
 * NAMES are kept too: on the committed bodies every tier is a standard
 * variation, so its name is Shopee's.
 *
 * ⚠️ **It fails CLOSED, never into a smaller neutralisation.** It throws
 * {@link ErroDeNeutralizacao} rather than guess: a time that is not a number; a
 * price or stock leaf that is neither a number nor `null`, or a negative stock;
 * a standard tier (or a custom one whose standardised option list is not
 * empty) whose two option lists differ in length — they pair BY INDEX; a
 * standardised list LONGER than the tier list (an entry no tier explains); a
 * seller-typed option whose name is not a string or contains `,`, or whose
 * standardised twin spells a DIFFERENT non-empty name; a `model_name` that is
 * not the comma-join of its tier options (checked for EVERY model, before
 * anything is renamed), or a `tier_index` that is not one index per tier or
 * points at no option; a listing row, model, `price_info` entry, stock row,
 * tier or option that is not an object; an `item_list`, `model`,
 * `price_info`, `seller_stock`, `shopee_stock`, tier tree or `option_list`
 * that is not a list; a `stock_info_v2`, `summary_info` or `advance_stock`
 * that is not an object. An absent or `null` `tier_variation` counts as ZERO
 * tiers — so with no tier tree any standardised entry, any model whose
 * `tier_index` is not `[]` and any non-empty `model_name` refuses — and an
 * absent or `null` `standardise_tier_variation` counts as an empty one, so
 * every option is then the seller's. A body whose
 * `response` holds none of `item_list`, `model`, `tier_variation` and
 * `standardise_tier_variation` passes through unchanged (deep-equal), so a
 * promotion can call it on every body.
 *
 * ⚠️ **Pure and idempotent.** It returns a NEW value and never mutates its
 * input. Every replacement is a constant, and the numbering restarts at 1 on
 * every call and walks the same options in the same order — so
 * `neutralizarLeituraDeAnuncio(neutralizarLeituraDeAnuncio(x))` deep-equals
 * `neutralizarLeituraDeAnuncio(x)`, which is what lets a pin ask "is this
 * committed body already neutral?" instead of comparing values.
 */
import type { WireValue } from './redact';

/** A body the neutralisation refuses — named, so a test can tell it from any other throw. */
export class ErroDeNeutralizacao extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ErroDeNeutralizacao';
  }
}

/** `create_time` of every listing row — epoch SECONDS (2020-09-13 UTC). */
export const CRIACAO_NEUTRA = 1_600_000_000;
/** `update_time` of every listing row — epoch SECONDS (2023-11-14 UTC), after {@link CRIACAO_NEUTRA}. */
export const ATUALIZACAO_NEUTRA = 1_700_000_000;
/** Every model price. */
export const PRECO_NEUTRO = 100;
/** Every POSITIVE stock count; a `0` stays `0`. */
export const ESTOQUE_NEUTRO = 10;
/** The invented name of the N-th seller-typed option: this prefix plus N. */
export const PREFIXO_OPCAO_INVENTADA = 'Opção inventada ';

/** The four price keys of a model's `price_info` entry. */
export const CHAVES_DE_PRECO = [
  'current_price',
  'original_price',
  'inflated_price_of_current_price',
  'inflated_price_of_original_price',
] as const;

/**
 * Every leaf the transform replaces, as a path (`*` = any array index). The
 * documentation list — the code below walks the same paths by hand, and
 * `neutralizarAnuncio.test.ts` proves the two agree in BOTH directions (every
 * entry is replaced on a body that carries it, and nothing else is).
 */
export const CAMPOS_NEUTRALIZADOS: readonly string[] = [
  'response.item_list.*.create_time',
  'response.item_list.*.update_time',
  ...CHAVES_DE_PRECO.map((chave) => `response.model.*.price_info.*.${chave}`),
  'response.model.*.stock_info_v2.summary_info.total_reserved_stock',
  'response.model.*.stock_info_v2.summary_info.total_available_stock',
  'response.model.*.stock_info_v2.seller_stock.*.stock',
  'response.model.*.stock_info_v2.shopee_stock.*.stock',
  'response.model.*.stock_info_v2.advance_stock.sellable_advance_stock',
  'response.model.*.stock_info_v2.advance_stock.in_transit_advance_stock',
  'response.tier_variation.*.option_list.*.option (seller-typed options only)',
  'response.standardise_tier_variation.*.variation_option_list.*.variation_option_name (seller-typed options only)',
  'response.model.*.model_name (rebuilt as the comma-join of its tier options)',
];

type Objeto = { [key: string]: WireValue };

function ehObjeto(valor: WireValue | undefined): valor is Objeto {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

/** An optional object child: absent and `null` answer `null`; any other non-object THROWS. */
function objetoOpcional(pai: Objeto, chave: string, onde: string): Objeto | null {
  const valor = pai[chave];
  if (valor === undefined || valor === null) return null;
  if (!ehObjeto(valor)) throw new ErroDeNeutralizacao(`${onde}.${chave} não é um objeto.`);
  return valor;
}

/** An optional array child: absent and `null` answer `null`; any other non-array THROWS. */
function listaOpcional(pai: Objeto, chave: string, onde: string): WireValue[] | null {
  const valor = pai[chave];
  if (valor === undefined || valor === null) return null;
  if (!Array.isArray(valor)) throw new ErroDeNeutralizacao(`${onde}.${chave} não é uma lista.`);
  return valor;
}

/** Every entry of a list as an object — a non-object entry THROWS. */
function objetosDa(lista: readonly WireValue[], onde: string): Objeto[] {
  return lista.map((entrada, i) => {
    if (!ehObjeto(entrada)) throw new ErroDeNeutralizacao(`${onde}.${String(i)} não é um objeto.`);
    return entrada;
  });
}

/** A listing time: a number becomes `neutro`, absent stays absent, anything else THROWS. */
function neutralizarTempo(linha: Objeto, chave: string, neutro: number, onde: string): void {
  if (!(chave in linha)) return;
  if (typeof linha[chave] !== 'number') {
    throw new ErroDeNeutralizacao(`${onde}.${chave} não é um número.`);
  }
  linha[chave] = neutro;
}

/** A price: a number becomes {@link PRECO_NEUTRO}; absent and `null` are kept; anything else THROWS. */
function neutralizarPreco(entrada: Objeto, chave: string, onde: string): void {
  const valor = entrada[chave];
  if (valor === undefined || valor === null) return;
  if (typeof valor !== 'number') throw new ErroDeNeutralizacao(`${onde}.${chave} não é um número.`);
  entrada[chave] = PRECO_NEUTRO;
}

/**
 * A stock count: positive becomes {@link ESTOQUE_NEUTRO}, `0` stays `0`; absent
 * and `null` are kept; a negative or non-number THROWS.
 */
function neutralizarEstoque(entrada: Objeto, chave: string, onde: string): void {
  const valor = entrada[chave];
  if (valor === undefined || valor === null) return;
  if (typeof valor !== 'number' || Number.isNaN(valor) || valor < 0) {
    throw new ErroDeNeutralizacao(`${onde}.${chave} não é uma contagem >= 0.`);
  }
  if (valor > 0) entrada[chave] = ESTOQUE_NEUTRO;
}

function neutralizarModelo(modelo: Objeto, onde: string): void {
  const precos = listaOpcional(modelo, 'price_info', onde);
  if (precos !== null) {
    objetosDa(precos, `${onde}.price_info`).forEach((entrada, i) => {
      for (const chave of CHAVES_DE_PRECO) {
        neutralizarPreco(entrada, chave, `${onde}.price_info.${String(i)}`);
      }
    });
  }

  const estoque = objetoOpcional(modelo, 'stock_info_v2', onde);
  if (estoque === null) return;
  const ondeEstoque = `${onde}.stock_info_v2`;
  const resumo = objetoOpcional(estoque, 'summary_info', ondeEstoque);
  if (resumo !== null) {
    neutralizarEstoque(resumo, 'total_reserved_stock', `${ondeEstoque}.summary_info`);
    neutralizarEstoque(resumo, 'total_available_stock', `${ondeEstoque}.summary_info`);
  }
  for (const local of ['seller_stock', 'shopee_stock']) {
    const linhas = listaOpcional(estoque, local, ondeEstoque);
    if (linhas === null) continue;
    objetosDa(linhas, `${ondeEstoque}.${local}`).forEach((linha, i) => {
      neutralizarEstoque(linha, 'stock', `${ondeEstoque}.${local}.${String(i)}`);
    });
  }
  const antecipado = objetoOpcional(estoque, 'advance_stock', ondeEstoque);
  if (antecipado !== null) {
    neutralizarEstoque(antecipado, 'sellable_advance_stock', `${ondeEstoque}.advance_stock`);
    neutralizarEstoque(antecipado, 'in_transit_advance_stock', `${ondeEstoque}.advance_stock`);
  }
}

/** The non-zero standard variation id of a standardised entry, else `0` (a custom tier). */
function idDaVariacao(padrao: Objeto | undefined): number {
  const id = padrao?.variation_id;
  return typeof id === 'number' && id !== 0 ? id : 0;
}

/** True when the standardised option names a Shopee option (a non-zero id). */
function ehOpcaoPadrao(opcaoPadrao: Objeto | undefined): boolean {
  const id = opcaoPadrao?.variation_option_id;
  return typeof id === 'number' && id !== 0;
}

/** The comma-join of a model's tier options — what Shopee spells as its `model_name`. */
function juncaoDoModelo(modelo: Objeto, opcoesPorTier: readonly Objeto[][], onde: string): string {
  const indices = modelo.tier_index;
  if (!Array.isArray(indices) || indices.length !== opcoesPorTier.length) {
    throw new ErroDeNeutralizacao(`${onde}.tier_index não tem um índice por tier.`);
  }
  return indices
    .map((indice, t) => {
      const opcao = typeof indice === 'number' ? opcoesPorTier[t]?.[indice] : undefined;
      if (opcao === undefined || typeof opcao.option !== 'string') {
        throw new ErroDeNeutralizacao(`${onde}.tier_index.${String(t)} não aponta para uma opção.`);
      }
      return opcao.option;
    })
    .join(',');
}

/**
 * Rename every seller-typed option of `response` (its tiers, their
 * standardised twins and every `model_name`). See the module docblock.
 */
function neutralizarOpcoes(response: Objeto, modelos: readonly Objeto[]): void {
  // An absent or `null` tier tree is ZERO tiers, never "nothing to check": the
  // refusals below then fire on any standardised entry or tiered model.
  const tiers = objetosDa(
    listaOpcional(response, 'tier_variation', 'response') ?? [],
    'response.tier_variation',
  );
  const padronizadosCrus = listaOpcional(response, 'standardise_tier_variation', 'response') ?? [];
  const padronizados = objetosDa(padronizadosCrus, 'response.standardise_tier_variation');
  if (padronizados.length > tiers.length) {
    throw new ErroDeNeutralizacao(
      'response.standardise_tier_variation tem mais entradas que response.tier_variation.',
    );
  }

  const opcoesPorTier = tiers.map((tier, t) => {
    const lista = tier.option_list;
    if (!Array.isArray(lista)) {
      throw new ErroDeNeutralizacao(
        `response.tier_variation.${String(t)}.option_list não é uma lista.`,
      );
    }
    return objetosDa(lista, `response.tier_variation.${String(t)}.option_list`);
  });

  // Every model_name must BE the join before anything is renamed: a name that
  // is not cannot be rebuilt, and it may carry text no rule here reaches.
  modelos.forEach((modelo, m) => {
    if (
      modelo.model_name !== juncaoDoModelo(modelo, opcoesPorTier, `response.model.${String(m)}`)
    ) {
      throw new ErroDeNeutralizacao(
        `response.model.${String(m)}.model_name não é a junção das opções do seu tier_index.`,
      );
    }
  });

  let numero = 0;
  tiers.forEach((_, t) => {
    const opcoes = opcoesPorTier[t] ?? [];
    const padrao = padronizados[t];
    const ondePadrao = `response.standardise_tier_variation.${String(t)}`;
    // A tier is STANDARD only when its standardised entry names a non-zero
    // variation; with no entry, or `variation_id` 0, every option is the
    // seller's.
    const ehPadrao = idDaVariacao(padrao) !== 0;
    const opcoesPadrao =
      padrao === undefined
        ? []
        : objetosDa(
            listaOpcional(padrao, 'variation_option_list', ondePadrao) ?? [],
            `${ondePadrao}.variation_option_list`,
          );
    // Paired BY INDEX, and only when both lists agree on how many there are. A
    // custom tier's standardised list is paired too when it has entries — its
    // names are the seller's text as well, and must be renamed with the option.
    if ((ehPadrao || opcoesPadrao.length > 0) && opcoesPadrao.length !== opcoes.length) {
      throw new ErroDeNeutralizacao(
        `tier ${String(t)}: option_list e variation_option_list têm tamanhos diferentes.`,
      );
    }

    opcoes.forEach((opcao, i) => {
      const opcaoPadrao = opcoesPadrao[i];
      if (ehPadrao && ehOpcaoPadrao(opcaoPadrao)) return;
      const onde = `response.tier_variation.${String(t)}.option_list.${String(i)}.option`;
      const antigo = opcao.option;
      if (typeof antigo !== 'string') throw new ErroDeNeutralizacao(`${onde} não é um texto.`);
      if (antigo.includes(',')) {
        throw new ErroDeNeutralizacao(`${onde} contém ',' — a junção do model_name seria ambígua.`);
      }
      numero += 1;
      const novo = `${PREFIXO_OPCAO_INVENTADA}${String(numero)}`;
      opcao.option = novo;
      if (opcaoPadrao !== undefined) {
        const nomePadrao = opcaoPadrao.variation_option_name;
        if (nomePadrao === antigo) {
          opcaoPadrao.variation_option_name = novo;
        } else if (typeof nomePadrao === 'string' && nomePadrao.trim() !== '') {
          throw new ErroDeNeutralizacao(
            `${ondePadrao}.variation_option_list.${String(i)}.variation_option_name difere da opção do tier.`,
          );
        }
      }
    });
  });

  if (numero === 0) return;
  modelos.forEach((modelo, m) => {
    modelo.model_name = juncaoDoModelo(modelo, opcoesPorTier, `response.model.${String(m)}`);
  });
}

/**
 * Neutralise one listing read. See the module docblock for what is replaced,
 * what is kept and every refusal.
 */
export function neutralizarLeituraDeAnuncio(corpo: WireValue): WireValue {
  // A deep copy: every write below lands on it, never on the caller's value,
  // and key order is the copy's own.
  const copia = structuredClone(corpo);
  if (!ehObjeto(copia) || !ehObjeto(copia.response)) return copia;
  const response = copia.response;

  const itens = listaOpcional(response, 'item_list', 'response');
  if (itens !== null) {
    objetosDa(itens, 'response.item_list').forEach((linha, i) => {
      const onde = `response.item_list.${String(i)}`;
      neutralizarTempo(linha, 'create_time', CRIACAO_NEUTRA, onde);
      neutralizarTempo(linha, 'update_time', ATUALIZACAO_NEUTRA, onde);
    });
  }

  const modelosCrus = listaOpcional(response, 'model', 'response');
  const modelos = modelosCrus === null ? [] : objetosDa(modelosCrus, 'response.model');
  modelos.forEach((modelo, m) => {
    neutralizarModelo(modelo, `response.model.${String(m)}`);
  });

  neutralizarOpcoes(response, modelos);
  return copia;
}
