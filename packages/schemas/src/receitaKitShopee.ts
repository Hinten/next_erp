import { CANAL_AVISO, ROTAS_AVISO, SEVERIDADE_AVISO, TIPO_AVISO, chaveDeAviso } from './aviso';

/**
 * The Shopee NATIVE-KIT recipe (step 19, #1527): ERP `componentesKit` ⇄ Shopee
 * `component_list`, in both directions, plus THE fold that decides whether the
 * two are "the same recipe", the structural bounds, and the L4 aviso decision.
 *
 * ⚠️ ONE module (#1369). The kit create, the republish, the recriar, step 9's
 * import, the `apps/functions` recipe trigger and step 21's preview all map a
 * recipe through here. Never re-implement a piece of it on another surface: two
 * copies drift toward plausible while both read correct, and reviewers cannot
 * diff them by eye. Pure and total — no clock, no network, no Firestore — which
 * is what lets it live here, where every surface (the browser included) can
 * reach it.
 *
 * Its input types are its OWN: `packages/schemas` cannot see the integration
 * package's wire types, so `apps/shopee` adapts `ShopeeKitItem` rows to
 * {@link LinhaKitShopeeLida} before calling in.
 *
 * ⚠️ The fold scopes (#1372) — each pinned by an EQUAL pair AND a near-miss in
 * `receitaKitShopee.test.ts`:
 *
 * | helper | EQUAL | DISTINCT |
 * |---|---|---|
 * | {@link mesmaReceitaKitShopee} | a plain item's absent ERP model vs Shopee's hidden id (has_model `false`); row order; duplicate keys SUMMED (2 + 3 ≡ 5); `main_component` | quantity; a component added/removed; model A vs B (has_model `true`); `null` vs a model on a has_model item; an UNKNOWN has_model compares ids literally |
 * | {@link principalDoKitShopee} | the same main flagged on several models | two different mains (⇒ `null`, unreadable) |
 * | {@link mesmoEnderecoDeComponente} | identical `(itemId, modelId)` | any other item, model, or `null` vs a model — literal, no fold |
 * | {@link chaveReceitaKitErp} | key order; `limitarEstoque`; `timestamp`; passthrough extras | any `quantidade` change; a key added, removed or renamed; `{p1:12}` vs `{p11:2}` |
 *
 * PROBE facts this encodes (SG sandbox, 2026-10-06/07): a component item WITHOUT
 * variations reads back a NON-ZERO hidden `component_model_id` that
 * `get_model_list` never exposes (probe #1); exactly ONE `main_component` per KIT
 * across all models, a second one refused "mupltiple main sku" (probe #2, P2-a);
 * a quantity change on an existing kit model is answered 200 and silently
 * IGNORED (P2-c) — so a recipe is only ever "applied" when a READ-BACK folds
 * equal, never on a write's 200.
 */

/* -------------------------------------------------------------------------- */
/*                                 Constants                                  */
/* -------------------------------------------------------------------------- */

/** The kit shape Shopee imposes: ONE tier, at most 9 kit models (D1 §1.2; L2). */
export const SHOPEE_KIT_MAX_MODELOS = 9;
/**
 * The single-model tier (R-8; Lucas L10(1)): a família de um publishes ONE kit
 * model under tier `'Kit'`, option `'Padrão'`. Declared HERE, not in
 * `apps/shopee`, because step 9's import must recognise the pair too and plan no
 * taxonomy for it — the sentinel is what makes create → import a fixed point.
 */
export const NOME_TIER_KIT_UNICO = 'Kit';
export const OPCAO_TIER_KIT_UNICO = 'Padrão';

/* -------------------------------------------------------------------------- */
/*                         Addresses and the model rule                       */
/* -------------------------------------------------------------------------- */

/** A component's Shopee address. `modelId === null` ⇔ the component item has NO variations. */
export interface EnderecoShopeeDoComponente {
  readonly itemId: number;
  readonly modelId: number | null;
}

function ehInteiroPositivo(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

/** UTF-16 code-unit order — deterministic, never locale-dependent (`localeCompare` is). */
function compararTexto(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** The ONE total order on addresses: `(itemId, modelId ?? -1)`. */
function compararEnderecos(a: EnderecoShopeeDoComponente, b: EnderecoShopeeDoComponente): number {
  if (a.itemId !== b.itemId) return a.itemId < b.itemId ? -1 : 1;
  const ma = a.modelId ?? -1;
  const mb = b.modelId ?? -1;
  if (ma === mb) return 0;
  return ma < mb ? -1 : 1;
}

/**
 * An address as an unambiguous Map key. JSON, never a bare join: `(1, 23)` and
 * `(12, 3)` must not collide, and `null` must not read as a number.
 */
function chaveDeEndereco(e: EnderecoShopeeDoComponente): string {
  return JSON.stringify([e.itemId, e.modelId]);
}

/**
 * The default-model rule, both directions (D2 §2.3). `itemTemModelos`:
 *   false → null (a plain item: Shopee's hidden default id is meaningless — PROBE #1);
 *   true  → modelId when it is a positive safe int, else null (0/absent = "no usable model");
 *   null  → unknown (no base-info row): modelId VERBATIM (the import keeps today's path; never a guess).
 */
export function modeloDoComponenteKit(a: {
  readonly modelId: number | null | undefined;
  readonly itemTemModelos: boolean | null;
}): number | null {
  if (a.itemTemModelos === false) return null;
  if (a.itemTemModelos === true) return ehInteiroPositivo(a.modelId) ? a.modelId : null;
  return a.modelId ?? null;
}

/* -------------------------------------------------------------------------- */
/*                         Projection: ERP → Shopee                           */
/* -------------------------------------------------------------------------- */

/** One request row, wire-shaped. `component_model_id` ABSENT for a plain item — never 0. */
export interface LinhaComponenteKitShopee {
  readonly component_item_id: number;
  readonly component_model_id?: number;
  readonly quantity: number;
  readonly main_component?: true;
}

export type MotivoFalhaComponenteKit =
  | 'componente-nao-publicado'
  | 'componente-sem-modelo'
  | 'componente-e-kit-nativo'
  | 'componente-anuncio-inativo';
export type ResolucaoComponenteKit =
  | { readonly ok: true; readonly endereco: EnderecoShopeeDoComponente }
  | { readonly ok: false; readonly motivo: MotivoFalhaComponenteKit };

export interface ProjecaoReceitaKit {
  /** SUMMED by Shopee address, sorted `(itemId, modelId ?? -1)`. */
  readonly linhas: readonly LinhaComponenteKitShopee[];
  /** EVERY miss (never only the first), sorted by `produtoId`. */
  readonly falhas: readonly {
    readonly produtoId: string;
    readonly motivo: MotivoFalhaComponenteKit;
  }[];
  /**
   * The produtoIds with `limitarEstoque === false` that ARE in `linhas` (L3: sent
   * anyway — Shopee derives kit stock from EVERY component), sorted. A component
   * that failed resolution is in `falhas` instead: it is not sent.
   */
  readonly naoLimitam: readonly string[];
}

/** The wire row of one address. `component_model_id` is OMITTED for `null`, never written as 0. */
function linhaDeEndereco(
  e: EnderecoShopeeDoComponente,
  quantity: number,
): LinhaComponenteKitShopee {
  return e.modelId === null
    ? { component_item_id: e.itemId, quantity }
    : { component_item_id: e.itemId, component_model_id: e.modelId, quantity };
}

function enderecoDaLinha(l: LinhaComponenteKitShopee): EnderecoShopeeDoComponente {
  return { itemId: l.component_item_id, modelId: l.component_model_id ?? null };
}

/**
 * ERP `componentesKit` → Shopee rows. No main flag here (see {@link escolherPrincipalDoKit}).
 *
 * `resolucao` is keyed by component produtoId; an ABSENT key ⇒
 * `componente-nao-publicado`. Two ERP keys resolving to ONE Shopee address (a
 * wrapper and its sellable member, say) are SUMMED into one row — a request
 * cannot carry the same address twice, and a dropped row would under-count the
 * composition. `quantidade` is carried verbatim (the structural bounds and the
 * package guard refuse what Shopee would). The resolver is expected to have
 * applied {@link modeloDoComponenteKit} already; a `modelId` is sent as given.
 */
export function componentesShopeeDoKit(
  componentesKit: Readonly<
    Record<string, { readonly quantidade: number; readonly limitarEstoque?: boolean }>
  > | null,
  resolucao: ReadonlyMap<string, ResolucaoComponenteKit>,
): ProjecaoReceitaKit {
  const somas = new Map<string, { endereco: EnderecoShopeeDoComponente; quantity: number }>();
  const falhas: { produtoId: string; motivo: MotivoFalhaComponenteKit }[] = [];
  const naoLimitam: string[] = [];
  for (const [produtoId, entrada] of Object.entries(componentesKit ?? {})) {
    const resolvido = resolucao.get(produtoId);
    if (resolvido === undefined) {
      falhas.push({ produtoId, motivo: 'componente-nao-publicado' });
      continue;
    }
    if (!resolvido.ok) {
      falhas.push({ produtoId, motivo: resolvido.motivo });
      continue;
    }
    const endereco = { itemId: resolvido.endereco.itemId, modelId: resolvido.endereco.modelId };
    const chave = chaveDeEndereco(endereco);
    const anterior = somas.get(chave)?.quantity ?? 0;
    somas.set(chave, { endereco, quantity: anterior + entrada.quantidade });
    if (entrada.limitarEstoque === false) naoLimitam.push(produtoId);
  }
  const linhas = [...somas.values()]
    .sort((a, b) => compararEnderecos(a.endereco, b.endereco))
    .map((s) => linhaDeEndereco(s.endereco, s.quantity));
  falhas.sort((a, b) => compararTexto(a.produtoId, b.produtoId));
  naoLimitam.sort(compararTexto);
  return { linhas, falhas, naoLimitam };
}

/* -------------------------------------------------------------------------- */
/*                            The main component                              */
/* -------------------------------------------------------------------------- */

/** Main per KIT (P2-a). Flags the key on the FIRST model (array order = tier order) containing it, ONCE. */
export type PrincipalDoKit =
  | {
      readonly ok: true;
      readonly modelos: readonly (readonly LinhaComponenteKitShopee[])[];
      readonly principal: EnderecoShopeeDoComponente;
    }
  | { readonly ok: false; readonly motivo: 'principal-obrigatorio' | 'principal-invalido' };

/**
 * Picks the kit's ONE main component and flags it (Lucas L1; probe #2 P2-a).
 *
 * - `principal` given ⇒ flagged on the FIRST row (models in array order, rows in
 *   order) whose address {@link mesmoEnderecoDeComponente} matches; absent from
 *   every model ⇒ `principal-invalido`.
 * - `principal` null + ONE distinct `component_item_id` across all models ⇒ the
 *   default is the smallest `(itemId, modelId ?? -1)` address of the first model
 *   that has a row (model 0 whenever it has one).
 * - `principal` null + ≥ 2 distinct items ⇒ `principal-obrigatorio`: the main
 *   fixes the kit's category, attributes and brand and is frozen, so it is never
 *   guessed.
 * - An empty recipe (no row in any model) has no candidate ⇒ `principal-invalido`;
 *   the structural bounds' `kit-sem-componentes` is the refusal an operator acts on.
 *
 * Any `main_component` already present on an input row is DROPPED, so the output
 * carries exactly one flag across the whole kit.
 */
export function escolherPrincipalDoKit(
  modelos: readonly (readonly LinhaComponenteKitShopee[])[],
  principal: EnderecoShopeeDoComponente | null,
): PrincipalDoKit {
  let alvo = principal;
  if (alvo === null) {
    const itens = new Set<number>();
    for (const modelo of modelos) for (const linha of modelo) itens.add(linha.component_item_id);
    if (itens.size >= 2) return { ok: false, motivo: 'principal-obrigatorio' };
    const primeiro = modelos.find((m) => m.length > 0);
    if (primeiro === undefined) return { ok: false, motivo: 'principal-invalido' };
    const candidatos = primeiro.map(enderecoDaLinha).sort(compararEnderecos);
    alvo = candidatos[0] ?? null;
    if (alvo === null) return { ok: false, motivo: 'principal-invalido' };
  }
  const escolhido = alvo;
  let marcado = false;
  const saida = modelos.map((modelo) =>
    modelo.map((linha): LinhaComponenteKitShopee => {
      const endereco = enderecoDaLinha(linha);
      const semFlag = linhaDeEndereco(endereco, linha.quantity);
      if (!marcado && mesmoEnderecoDeComponente(endereco, escolhido)) {
        marcado = true;
        return { ...semFlag, main_component: true };
      }
      return semFlag;
    }),
  );
  if (!marcado) return { ok: false, motivo: 'principal-invalido' };
  return { ok: true, modelos: saida, principal: escolhido };
}

/* -------------------------------------------------------------------------- */
/*                           Inverse: Shopee → ERP                            */
/* -------------------------------------------------------------------------- */

/**
 * Shopee → ERP (moved OUT of `apps/shopee`'s `kitShopee.ts`): SUM by produtoId,
 * `limitarEstoque` forced `true`. No stamps — step 9's stamp carry-forward stays
 * in `apps/shopee`, because it reads the stored doc.
 *
 * ⚠️ SUMMED, never overwritten: "2 × parafuso + 3 × parafuso" holds five, and a
 * map keyed by produto id cannot hold the two rows apart. A row whose component
 * resolved to no produto (`produtoId === null`) is skipped — the import refuses
 * such a kit before it writes. `chaves` = the map's own key order.
 */
export function componentesKitDaReceitaShopee(
  linhas: readonly { readonly produtoId: string | null; readonly quantidade: number }[],
): {
  readonly mapa: Readonly<
    Record<string, { readonly quantidade: number; readonly limitarEstoque: true }>
  >;
  readonly chaves: readonly string[];
} {
  const somas = new Map<string, number>();
  for (const linha of linhas) {
    if (linha.produtoId === null) continue;
    somas.set(linha.produtoId, (somas.get(linha.produtoId) ?? 0) + linha.quantidade);
  }
  // `fromEntries` defines OWN properties, so no key (not even `__proto__`) can
  // reach the prototype the way a bracket assignment would.
  const mapa = Object.fromEntries(
    [...somas].map(([produtoId, quantidade]) => [
      produtoId,
      { quantidade, limitarEstoque: true as const },
    ]),
  );
  return { mapa, chaves: Object.keys(mapa) };
}

/* -------------------------------------------------------------------------- */
/*                              The recipe fold                               */
/* -------------------------------------------------------------------------- */

/** A live kit-model row as the fold reads it (the app adapts ShopeeKitItem rows to this). */
export interface LinhaKitShopeeLida {
  readonly component_item_id: number;
  readonly component_model_id: number | null;
  readonly quantity: number;
  readonly main_component: boolean;
}

/** One side of the fold: folded address → SUMMED quantity. */
function somarPorEnderecoDobrado(
  linhas: readonly {
    readonly component_item_id: number;
    readonly component_model_id?: number | null;
    readonly quantity: number;
  }[],
  temModelosPorItem: ReadonlyMap<number, boolean>,
): Map<string, number> {
  const somas = new Map<string, number>();
  for (const linha of linhas) {
    const itemId = linha.component_item_id;
    const modelId = modeloDoComponenteKit({
      modelId: linha.component_model_id,
      itemTemModelos: temModelosPorItem.get(itemId) ?? null,
    });
    const chave = chaveDeEndereco({ itemId, modelId });
    somas.set(chave, (somas.get(chave) ?? 0) + linha.quantity);
  }
  return somas;
}

/**
 * THE per-model recipe fold. EQUAL: plain item (ERP absent model) vs Shopee's hidden id when
 * temModelosPorItem.get(item) === false; row order; duplicate keys SUMMED (2+3 ≡ 5); main_component and every
 * display field ignored. DISTINCT: quantity; a component added/removed; model A vs B of an item with
 * variations; item equal but one side null model on an item that HAS variations (a resolution hole); an item
 * whose has_model is UNKNOWN compares its model ids literally.
 *
 * Both sides go through {@link modeloDoComponenteKit} with the SAME `has_model`
 * authority, so the plain/varied decision is never taken from the ERP side (a
 * fold that did would call a resolution hole equal). The main is compared
 * separately ({@link principalDoKitShopee}), so "main moved" and "quantity
 * changed" stay distinguishable (R-e).
 */
export function mesmaReceitaKitShopee(
  erp: readonly LinhaComponenteKitShopee[],
  shopee: readonly LinhaKitShopeeLida[],
  temModelosPorItem: ReadonlyMap<number, boolean>,
): boolean {
  const a = somarPorEnderecoDobrado(erp, temModelosPorItem);
  const b = somarPorEnderecoDobrado(shopee, temModelosPorItem);
  if (a.size !== b.size) return false;
  for (const [chave, quantidade] of a) {
    if (b.get(chave) !== quantidade) return false;
  }
  return true;
}

/**
 * The live main across ALL models, folded by the same default-model rule; null when none / unreadable.
 * The same address flagged on several models is ONE main; two DIFFERENT flagged
 * addresses are unreadable (Shopee refuses that shape, P2-a) ⇒ `null`, never a pick.
 */
export function principalDoKitShopee(
  modelos: readonly (readonly LinhaKitShopeeLida[])[],
  temModelosPorItem: ReadonlyMap<number, boolean>,
): EnderecoShopeeDoComponente | null {
  let achado: EnderecoShopeeDoComponente | null = null;
  for (const modelo of modelos) {
    for (const linha of modelo) {
      if (linha.main_component !== true) continue;
      const endereco: EnderecoShopeeDoComponente = {
        itemId: linha.component_item_id,
        modelId: modeloDoComponenteKit({
          modelId: linha.component_model_id,
          itemTemModelos: temModelosPorItem.get(linha.component_item_id) ?? null,
        }),
      };
      if (achado === null) achado = endereco;
      else if (!mesmoEnderecoDeComponente(achado, endereco)) return null;
    }
  }
  return achado;
}

/** Literal equality of two (already folded) addresses — no fold of its own. */
export function mesmoEnderecoDeComponente(
  a: EnderecoShopeeDoComponente,
  b: EnderecoShopeeDoComponente,
): boolean {
  return a.itemId === b.itemId && a.modelId === b.modelId;
}

/* -------------------------------------------------------------------------- */
/*                        The ERP-side fingerprint (L4)                       */
/* -------------------------------------------------------------------------- */

/**
 * The L4 change detector (R-4) — an ERP-SIDE fingerprint, NOT a recipe. JSON.stringify of the entries sorted by id,
 * each [produtoId, quantidade] (quantidade kept only when a positive safe int, else null). `null`/`{}` ⇒ '[]'.
 * EQUAL: key order; limitarEstoque; timestamp; passthrough extras. DISTINCT: any quantidade change; a key added,
 * removed or renamed (incl. the #1450 repoint — accepted: a plain republish folds EQUAL on Shopee's side, re-stamps
 * and resolves, and so does a re-import, which decides on content (R-t (i)); the aviso text tells the operator to
 * republish FIRST, §2.1.5).
 *
 * JSON, never a bare join: `{p1: 12}` and `{p11: 2}` must not collide. Total
 * over a legacy corpus value: an entry that is not an object reads `null`.
 */
export function chaveReceitaKitErp(
  componentesKit: Readonly<Record<string, { readonly quantidade?: unknown }>> | null | undefined,
): string {
  if (componentesKit === null || componentesKit === undefined) return '[]';
  const entradas = Object.entries(componentesKit).map(
    ([produtoId, entrada]): [string, number | null] => {
      const quantidade: unknown =
        typeof entrada === 'object' && entrada !== null ? entrada.quantidade : undefined;
      return [produtoId, ehInteiroPositivo(quantidade) ? quantidade : null];
    },
  );
  entradas.sort((a, b) => compararTexto(a[0], b[0]));
  return JSON.stringify(entradas);
}

/* -------------------------------------------------------------------------- */
/*                            Structural bounds                               */
/* -------------------------------------------------------------------------- */

/** Structural bounds (always local, limits served or not). Every violation listed. */
export type MotivoEstruturaKit =
  | 'kit-sem-unidade-vendavel'
  | 'kit-variacoes-demais'
  | 'kit-sem-componentes'
  | 'kit-componente-unico-quantidade'
  | 'componentes-fora-da-faixa';

/**
 * Every structural violation, kit-level first, then per model in input order.
 * Rows are re-summed by address first (R-5 is defined on the SUMMED rows).
 *
 * - no model ⇒ `kit-sem-unidade-vendavel`; more than {@link SHOPEE_KIT_MAX_MODELOS} ⇒ `kit-variacoes-demais`;
 * - a model with no row ⇒ `kit-sem-componentes` (and no band check — one cause, one line);
 * - ONE row with quantity < 2 ⇒ `kit-componente-unico-quantidade` (announcement 1262);
 * - the served band (R-f), refused only when BOTH readings agree — whether Shopee
 *   counts rows or quantities is undocumented, so `rows > max` (Σqty ≥ rows, so
 *   it is over either way) or `Σquantity < min` (rows ≤ Σqty, so under either way).
 *
 * `detalhe` carries counts only — ids and numbers, never a name.
 */
export function problemasDeEstruturaDoKit(a: {
  readonly modelos: readonly {
    readonly filhoId: string;
    readonly linhas: readonly LinhaComponenteKitShopee[];
  }[];
  /** Served `component_count_limit_of_single_model`, or null. Refuse only when BOTH readings agree (R-f). */
  readonly faixaDeComponentes: { readonly min: number; readonly max: number } | null;
}): readonly {
  readonly motivo: MotivoEstruturaKit;
  readonly filhoId: string | null;
  readonly detalhe: string;
}[] {
  const problemas: { motivo: MotivoEstruturaKit; filhoId: string | null; detalhe: string }[] = [];
  const n = a.modelos.length;
  if (n === 0) {
    problemas.push({ motivo: 'kit-sem-unidade-vendavel', filhoId: null, detalhe: '0 variações' });
  }
  if (n > SHOPEE_KIT_MAX_MODELOS) {
    problemas.push({
      motivo: 'kit-variacoes-demais',
      filhoId: null,
      detalhe: `${String(n)} variações; máximo ${String(SHOPEE_KIT_MAX_MODELOS)}`,
    });
  }
  for (const modelo of a.modelos) {
    const somas = new Map<string, number>();
    for (const linha of modelo.linhas) {
      const chave = chaveDeEndereco(enderecoDaLinha(linha));
      somas.set(chave, (somas.get(chave) ?? 0) + linha.quantity);
    }
    const linhas = somas.size;
    if (linhas === 0) {
      problemas.push({
        motivo: 'kit-sem-componentes',
        filhoId: modelo.filhoId,
        detalhe: '0 componentes',
      });
      continue;
    }
    let total = 0;
    for (const quantidade of somas.values()) total += quantidade;
    if (linhas === 1 && total < 2) {
      problemas.push({
        motivo: 'kit-componente-unico-quantidade',
        filhoId: modelo.filhoId,
        detalhe: `1 componente, quantidade ${String(total)}`,
      });
    }
    const faixa = a.faixaDeComponentes;
    if (faixa !== null && (linhas > faixa.max || total < faixa.min)) {
      problemas.push({
        motivo: 'componentes-fora-da-faixa',
        filhoId: modelo.filhoId,
        detalhe:
          `${String(linhas)} componentes, soma das quantidades ${String(total)}; ` +
          `faixa ${String(faixa.min)}–${String(faixa.max)}`,
      });
    }
  }
  return problemas;
}

/* -------------------------------------------------------------------------- */
/*                                 The L4 aviso                               */
/* -------------------------------------------------------------------------- */

/**
 * The L4 aviso, ONE definition for every writer. Keyed per (conta, KIT produto K): L4 "one per Shopee conta" for the
 * produto holding the native-kit link. A family kit with 3 divergent children is ONE aviso naming the 3.
 * No `janela`: one row per (conta, K) for life, reopened by a later raise.
 */
export function chaveAvisoReceitaKitShopee(integracaoId: string, kitProdutoId: string): string {
  return chaveDeAviso({
    tipo: TIPO_AVISO.shopeeKitReceitaDivergente,
    conta: integracaoId,
    entidade: kitProdutoId,
  });
}

/**
 * The aviso's plan (the {@link chaveAvisoReceitaKitShopee} identity fields + what
 * the wording in `apps/web/lib/avisos/mensagens.ts` interpolates). Params are
 * ids only: `anuncio` = the item id or `'—'`, `vinculo` = the link doc id the
 * recriar advice names or `'—'`, `variacoes` = the divergent child ids, sorted,
 * de-duplicated, joined `', '`.
 */
export function avisoReceitaKitShopee(a: {
  readonly integracaoId: string;
  /** K (link owner) = entidade = urlInterna target. */
  readonly kitProdutoId: string;
  /** The kit's Shopee item_id. */
  readonly itemId: number | null;
  /**
   * V2R1-08: that kit's link (the --link the recriar advice names). V2R2-02: the IO
   * twin picks it among the still-selling links holding a DIVERGENT row (stamp ≠
   * the child's current fingerprint) — a superseded one first (R5: the old kit is
   * what sells the old recipe, and `--link <it> --recriar` is its delete retry),
   * then R-12(b) order, `escolherLink` within a tier; never the active link merely
   * for being active — itemId is that link's.
   */
  readonly linkDocId: string | null;
  /** Child produtoIds, sorted; ids only. */
  readonly variacoesDivergentes: readonly string[];
}): {
  readonly tipo: 'shopeeKitReceitaDivergente';
  readonly severidade: 'atencao';
  readonly canal: 'shopee';
  readonly conta: string;
  readonly entidade: string;
  readonly janela: null;
  readonly params: {
    readonly kit: string;
    readonly anuncio: string;
    readonly vinculo: string;
    readonly variacoes: string;
  };
  readonly urlInterna: { readonly rota: string; readonly campo: 'componentesKit' };
} {
  const variacoes = [...new Set(a.variacoesDivergentes)].sort(compararTexto).join(', ');
  return {
    tipo: TIPO_AVISO.shopeeKitReceitaDivergente,
    severidade: SEVERIDADE_AVISO.atencao,
    canal: CANAL_AVISO.shopee,
    conta: a.integracaoId,
    entidade: a.kitProdutoId,
    janela: null,
    params: {
      kit: a.kitProdutoId,
      anuncio: ehInteiroPositivo(a.itemId) ? String(a.itemId) : '—',
      vinculo: a.linkDocId === null || a.linkDocId === '' ? '—' : a.linkDocId,
      variacoes,
    },
    urlInterna: { rota: ROTAS_AVISO.produto.build(a.kitProdutoId), campo: 'componentesKit' },
  };
}

/**
 * THE open/resolve decision (R-4), pure; its IO twin is `reavaliarAvisoDeReceitaKit` in @delfrance/data.
 * Input: per child of K, its CURRENT fingerprint and the stamps of its rows bound to a native-kit link of this conta
 * that still sells (`ehKitNativoQueAindaVende`: active, or superseded and neither removed nor banned — an old kit
 * whose delete did not take still sells the old composition). 'abrir' when ANY such stamp ≠ the child's current
 * fingerprint (a null stamp included), naming those children; 'resolver' when ≥ 1 row exists and ALL are equal;
 * 'nada' when no such row exists (its IO twin then resolves an OPEN row as 'sem-kit-ativo', and writes a resolved
 * watermark row only when K holds some native-kit link of the conta, so a raise computed before the kit was deleted
 * and landing later is dropped as stale).
 *
 * ⚠️ ONE divergent row opens, whatever the other rows say — a single equal row
 * never resolves a child that also has a stale one (the old kit of a recriar
 * whose delete did not take keeps selling the old composition).
 */
export function decidirAvisoDeReceitaKit(
  filhos: readonly {
    readonly produtoId: string;
    /** chaveReceitaKitErp(current componentesKit) */
    readonly chaveAtual: string;
    /** receitaKitConferida of its rows on native-kit links that still sell (ehKitNativoQueAindaVende) */
    readonly carimbos: readonly (string | null)[];
  }[],
):
  | { readonly acao: 'abrir'; readonly divergentes: readonly string[] }
  | { readonly acao: 'resolver' | 'nada' } {
  let linhas = 0;
  const divergentes = new Set<string>();
  for (const filho of filhos) {
    for (const carimbo of filho.carimbos) {
      linhas += 1;
      if (carimbo !== filho.chaveAtual) divergentes.add(filho.produtoId);
    }
  }
  if (linhas === 0) return { acao: 'nada' };
  if (divergentes.size > 0) {
    return { acao: 'abrir', divergentes: [...divergentes].sort(compararTexto) };
  }
  return { acao: 'resolver' };
}

/* -------------------------------------------------------------------------- */
/*                         The kit-model variashopee row                      */
/* -------------------------------------------------------------------------- */

/**
 * The builder of a kit-model `variashopee` doc the KIT ARMS create (`kits/vinculosKit.ts`) and test seeding uses, so
 * both halves of a round trip share one shape. Step 9's import writes the same fields through its own applier.
 *
 * `contaRef`/`linkPath` are canonical refs (`toOuterRef`) the caller built.
 * `modelStatus` is stored as given: the caller folds an unknown wire status to
 * `null` first (step 9's `modelStatusDeLink`) — this module keeps no second copy
 * of the status enum. `tierIndex` is copied, never aliased.
 */
export function linhaVariacaoDeKit(a: {
  /** canonical refs (toOuterRef) */
  readonly contaRef: string;
  readonly linkPath: string;
  readonly modelId: number;
  readonly tierIndex: readonly number[];
  /** from the read-back's get_model_list (S3F-10) */
  readonly modelStatus: string | null;
  /** null when the read-back did not fold EQUAL */
  readonly receitaKitConferida: string | null;
}): Record<string, unknown> {
  return {
    contaVariacaoShopeeOuterRef: a.contaRef,
    produtoShopeeOuterRef: a.linkPath,
    model_id: a.modelId,
    tier_index: [...a.tierIndex],
    model_status: a.modelStatus,
    receitaKitConferida: a.receitaKitConferida,
  };
}

/**
 * The `motivo` the caller of `reavaliarAvisoDeReceitaKit` passes for the case it
 * resolves (`'sem-kit-ativo'` is chosen by reavaliar itself on 'nada', whatever
 * the caller passed).
 */
export const MOTIVO_RESOLUCAO_RECEITA_KIT = {
  /** the trigger saw the fingerprint fold back */
  receitaIgualAShopee: 'receita-igual-a-shopee',
  /**
   * a create arm finished (criar, recriar, converter), or the reverify/push hook
   * saw a superseded old kit deleted while the new one folds equal (V2R1-09)
   */
  kitRecriado: 'kit-recriado',
  /** a republish folded EQUAL and re-stamped */
  republicadoIgual: 'republicado-igual',
  /** step 9 re-imported the kit and its recipe folded equal (R-t (i)) */
  importado: 'importado',
  /**
   * 'nada' over an OPEN row: no native kit of K still sells (deleted in Seller
   * Centre and reverified, or removed by a recriar)
   */
  semKitAtivo: 'sem-kit-ativo',
} as const;
