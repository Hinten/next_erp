/**
 * **The per-conta stock gates** (#1520, step 12) — one Shopee conta plus one
 * instant ⇒ may this ERP write ANY quantity onto that shop right now?
 *
 * Run ONCE per conta per tick, before discovery. Where `./podeEnviarEstoque`
 * answers "may this LISTING take a quantity", this module answers the question
 * one altitude up: a shop whose fulfilment regime, status, holiday mode or
 * warehouse shape makes every `update_stock` of that conta refuse. Both speak
 * the one {@link MotivoEstoqueShopee} vocabulary in `./errosEstoque`, so the
 * operator reads ONE slug and ONE sentence whichever altitude refused.
 *
 * ## The order is the cost model
 *
 * | # | check | cost |
 * |---|---|---|
 * | 1 | `shopId == null` | zero — the enumerated document already said so |
 * | 2 | `depositoOuterRef` blank | zero |
 * | 3 | `get_shop_info` → status · fulfilment flag · CBSC · outlet | one cached GET |
 * | 4 | `get_shop_holiday_mode` → a FULL holiday | one cached GET |
 * | 5 | `get_warehouse_detail` → a multi-warehouse regime | one cached GET |
 *
 * The two local checks come first so a conta that cannot sign a shop call, or
 * has no depósito bound, costs **no provider call at all** — and the client
 * itself is built lazily inside the load closures, so a tick whose three
 * entries are all warm makes no call and loads no context either.
 *
 * ⚠️ Rungs 3–5 also read in INCREASING order of surprise: a banned shop and an
 * FBS shop are permanent shapes, a holiday is a switch the seller flips, and
 * the warehouse regime is the rarest of all. That is also why an FBS conta in
 * holiday mode answers `loja-fbs` — the operator must read the shape that will
 * still be true tomorrow, not the switch sitting on top of it.
 *
 * ## ⚠️ The clock is a PARAMETER, and it is the caches' clock too
 *
 * `deps.nowMs` is the logical instant of the tick, in MILLISECONDS. Nothing
 * under `lib/shopee/estoque/` reaches for the ambient clock, so the three
 * caches below read their expiry instant from the binding this function sets on
 * entry rather than from the process clock — see {@link instanteMs}.
 *
 * ## ⚠️ Nothing here is caught
 *
 * A provider failure on a gate read — a Shopee error envelope, an expired
 * grant, a rate limit, a dropped connection — PROPAGATES. There is no `catch`
 * in this module at all, which is what makes that structural rather than a
 * promise. The per-conta containment in `../core/containment.ts` is where such
 * a failure becomes one conta's `lastError` while the tick continues; swallowing
 * it here would turn an outage into a green tick over a conta that sent nothing.
 * The ONE folded error is `get_warehouse_detail`'s whitelist refusal, and that
 * fold lives in the package (`getWarehouseDetail` answers a typed union), so no
 * app string-matches a wire code.
 *
 * Sources: `design-reconcile-step12.md` §1 C-f and §2.6, `design-D1` §4.9, the
 * `firestore-read-cache` skill, and `../core/contaCache.ts`, whose cache shape
 * this file copies deliberately.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { READ_CACHE_TTL, createReadCache } from '@delfrance/data/admin/cache';
import {
  SHOPEE_HOLIDAY_MODE_TYPE,
  SHOPEE_SHOP_STATUS,
  type ShopeeClient,
  type ShopeeShopHolidayMode,
  type ShopeeShopInfo,
  type ShopeeWarehouseDetail,
} from '@delfrance/integrations-shopee';

import { loadShopeeContext } from '../core/shopee';
import { MOTIVO_ESTOQUE_SHOPEE, type MotivoEstoqueShopee } from './errosEstoque';

/* -------------------------------------------------------------------------- */
/*                                  the seam                                   */
/* -------------------------------------------------------------------------- */

/** What a sweep tick already knows about the conta before any gate runs. */
export interface ContaParaEstoque {
  readonly integracaoId: string;
  /** `null` ⇒ consent given by MAIN ACCOUNT; nothing shop-signed can run. */
  readonly shopId: number | null;
  /** The ONE depósito bound to this conta. Blank ⇒ no quantity is derivable. */
  readonly depositoOuterRef: string | null;
}

export interface DepsDeConta {
  /** The client seam. Default: `loadShopeeContext(db, id).createShopClient()`. */
  readonly clientFor?: (db: Firestore, integracaoId: string) => Promise<ShopeeClient>;
  /** The ONE clock read of this tick, in MILLISECONDS. Also the caches' instant. */
  readonly nowMs: number;
}

/**
 * Narrow on `.ok` before reading `.motivo`.
 *
 * ⚠️ The accepting arm carries NOTHING. `design-reconcile-step12.md` §2.6
 * sketches a `bandas` member on it; the category band is per LISTING and is the
 * sender's own `get_item_limit` read, so carrying one here would be a
 * shop-scoped value standing in for a per-category one.
 */
export type VereditoDaConta =
  | { readonly ok: true }
  | { readonly ok: false; readonly motivo: MotivoEstoqueShopee };

/* -------------------------------------------------------------------------- */
/*                                 the caches                                  */
/* -------------------------------------------------------------------------- */

/**
 * The instant the three caches expire against — `deps.nowMs` of the most recent
 * evaluation, set on entry and never read from the process clock.
 *
 * `createReadCache` captures `opts.now` ONCE at construction, which for a
 * module-scope cache is import time, so each cache reads this binding through an
 * arrow rather than receiving the reference (`../core/contaCache.ts` records the
 * same trap for its own test clock).
 *
 * ⚠️ It is ADVISORY and last-writer-wins: two callers in one process (a sweep
 * tick and a manual push) hand in two instants microseconds apart, and expiry is
 * the only thing either decides. Every caller in this app reads that number from
 * the same place, so the drift is bounded by how long one tick runs — and a
 * caller passing a wildly wrong instant costs at worst a re-read, never a wrong
 * verdict, because the VALUES are never time-derived.
 */
let instanteMs = 0;

const opcoesComuns = {
  /** Sized for the contas one backend serves, exactly as `contaCache.ts`. */
  maxEntries: 64,
  /**
   * `0` — nothing here can resolve absent (all three answers are objects), and
   * declaring it says so rather than leaving a 5 s window to be reasoned about.
   */
  negativeTtlMs: 0,
  now: () => instanteMs,
  /**
   * The built-in sampler logs through `console.warn` — the wrong severity for a
   * metric — and at its default of 500 an instance serving fewer gets logs
   * nothing at all. Same call as `contaCache.ts` and the taxonomy caches.
   */
  sampleEvery: 0,
} as const;

/**
 * The shop's shape: status, fulfilment regime, CBSC and outlet flags.
 *
 * ⚠️ The key is `[integracaoId]` and NEVER `[shopId]`. The token is per
 * integração, `contaCache.ts` records why a stale shop mapping is the dangerous
 * direction, and two contas can legitimately name one shop while only one of
 * them is authorized — keying on the shop would serve one conta's gate verdict
 * to another, silently, in the direction that publishes.
 *
 * `READ_CACHE_TTL.config` (15 min): none of these four fields changes without a
 * seller-side event that also changes what they are allowed to sell.
 */
const cacheDaLoja = createReadCache<readonly [string], ShopeeShopInfo>({
  name: 'shopee:stock:shop-info',
  ttlMs: READ_CACHE_TTL.config,
  ...opcoesComuns,
});

/**
 * Holiday mode, at `READ_CACHE_TTL.volatile` (60 s) — deliberately the short
 * tier. A seller flips this switch BY HAND, and at a 15-minute tick cadence a
 * 60-second TTL means "once per tick, deduped inside the tick", which is the
 * honest reading: a stale ON costs a whole conta's tick, and a stale OFF spends
 * a conta's worth of refusals.
 */
const cacheDeFerias = createReadCache<readonly [string], ShopeeShopHolidayMode>({
  name: 'shopee:stock:holiday',
  ttlMs: READ_CACHE_TTL.volatile,
  ...opcoesComuns,
});

/**
 * The warehouse regime. `config` again: a shop gains a second warehouse through
 * an onboarding, not through a click, and the ordinary answer for a BR shop is
 * the package's folded `sem-multi-armazem` (probe P3 measured the prefixed
 * refusal arriving and the fold catching it).
 */
const cacheDeArmazens = createReadCache<readonly [string], ShopeeWarehouseDetail>({
  name: 'shopee:stock:warehouse',
  ttlMs: READ_CACHE_TTL.config,
  ...opcoesComuns,
});

/**
 * Test-only. The caches are module-scope — they must be, since a per-request
 * cache never hits — so a suite that wants a cold read drops the entries rather
 * than waiting out a TTL. The instant is reset too, so a suite cannot inherit
 * the previous one's clock.
 */
export function __resetCachesDeContaEstoqueForTests(): void {
  cacheDaLoja.clear();
  cacheDeFerias.clear();
  cacheDeArmazens.clear();
  instanteMs = 0;
}

/* -------------------------------------------------------------------------- */
/*                           the fulfilment-flag fold                          */
/* -------------------------------------------------------------------------- */

/**
 * The ONE value that refuses, already trimmed and lower-cased.
 *
 * "Pure - FBS Shop: Single mode, refer to Local/CB shops which only have Shopee
 * official warehouse stock" — such a shop can never take a seller-stock write,
 * and Shopee answers it as `error_server: The current item belong to the full
 * FBS shop, so normal stock must be equal to 0`.
 */
const FLAG_FBS_PURA = 'pure - fbs shop';

/** `shop_fulfillment_flag`'s own "reading it failed" value — C-f's subject. */
const FLAG_LEITURA_FALHOU = 'others - unknown';

/** The six values the page documents, lower-cased. Anything else is news. */
const FLAGS_DOCUMENTADAS: ReadonlySet<string> = new Set([
  FLAG_FBS_PURA,
  'pure - 3pf shop',
  'pff - fbs shop',
  'pff - 3pf shop',
  'lff hybrid shop',
  FLAG_LEITURA_FALHOU,
]);

/**
 * `mart_outlet_structure_type`'s one blocking value — the shape `guide 643` says
 * answers `product.cnsc_shop_block` on `update_stock`.
 *
 * ⚠️ Compared for IDENTITY, not folded like the fulfilment flag above. The page
 * enumerates four lower-case snake values and none of our evidence shows Shopee
 * spelling them two ways; a second, wider tolerance invented here would be free
 * to disagree with the one that is measured.
 */
const ESTRUTURA_ARMAZEM_OUTLET = 'warehouse_outlet_shop';

/**
 * Does this shop's `shop_fulfillment_flag` allow a seller-stock write?
 *
 * **The fold, and where it stops.** The value is trimmed and lower-cased, then
 * compared for EQUALITY against one needle. EQUAL — and therefore refusing —
 * are `'Pure - FBS Shop'`, `' pure - fbs shop '` and every casing between them:
 * one wire value written by hands that may or may not have kept Shopee's own
 * capitalisation. DISTINCT — and therefore SENDING — is everything else,
 * including `'PFF - FBS Shop'` (partial fulfilment, a different regime),
 * `'Pure - FBS Shops'`, `'Pure-FBS Shop'` and `'Pure - 3PF Shop'`. It is never
 * `startsWith`, never `includes` and never an allow-list of the other five: each
 * of those turns a value Shopee adds tomorrow into a refusal.
 *
 * ⚠️ **`'Others - Unknown'` SENDS** (ruling C-f). The page defines it as
 * "Returned when obtaining shop_fulfillment_flag information fails" — a READ
 * FAILURE wearing a value's clothes. Refusing on it converts an unreadable field
 * into a total, silent stock outage for the whole conta, reported as a green
 * tick; sending costs, at worst, one refusal per listing per state change, which
 * the sender names `loja-fbs` and turns into a 24 h conta pause with a rendered
 * message. One direction fails loudly and self-corrects in one tick, the other
 * fails silently for ever. `anuncioShopeeVivo`'s "absent ⇒ VIVO" is the same
 * asymmetry.
 *
 * A non-string — `null`, an absent key, a number — SENDS for the same reason:
 * the field is documented as returned only for the shop kinds it describes.
 */
export function contaAceitaEstoqueShopee(shopFulfillmentFlag: unknown): boolean {
  if (typeof shopFulfillmentFlag !== 'string') return true;
  return shopFulfillmentFlag.trim().toLowerCase() !== FLAG_FBS_PURA;
}

/**
 * One `console.warn` for a flag we sent DESPITE not being able to read it — the
 * other half of C-f, and the only record that a conta is publishing blind.
 *
 * Two lines, deliberately distinct: a read Shopee itself says failed, and a
 * seventh value nobody has seen. An ABSENT flag logs nothing: the page returns
 * this field only for some shop kinds, so absence is the ordinary shape and a
 * line per conta per tick for it would drown the two that matter.
 *
 * The raw value is carried because it is a shop-shape token, never a seller
 * datum — the `live_push_status` rule in `avisos/pushSaude.ts` verbatim.
 */
function registrarFlagIlegivel(integracaoId: string, bruto: unknown): void {
  if (typeof bruto !== 'string') return;
  const normalizada = bruto.trim().toLowerCase();
  if (normalizada === '') return;
  if (normalizada === FLAG_LEITURA_FALHOU) {
    console.warn('[shopee/estoque] a Shopee não conseguiu ler o shop_fulfillment_flag — enviando', {
      integracaoId,
      shopFulfillmentFlag: bruto,
    });
    return;
  }
  if (!FLAGS_DOCUMENTADAS.has(normalizada)) {
    console.warn('[shopee/estoque] shop_fulfillment_flag desconhecido — enviando', {
      integracaoId,
      shopFulfillmentFlag: bruto,
    });
  }
}

/* -------------------------------------------------------------------------- */
/*                                  the gate                                   */
/* -------------------------------------------------------------------------- */

function recusa(motivo: MotivoEstoqueShopee): VereditoDaConta {
  return { ok: false, motivo };
}

/** A stored reference is usable only when it is a non-blank string. */
function refUtilizavel(valor: string | null): boolean {
  return typeof valor === 'string' && valor.trim() !== '';
}

/** The client seam, `pausarAnuncio.ts`'s verbatim. */
function clienteShopee(
  db: Firestore,
  integracaoId: string,
  deps: DepsDeConta,
): Promise<ShopeeClient> {
  if (deps.clientFor !== undefined) return deps.clientFor(db, integracaoId);
  return loadShopeeContext(db, integracaoId).then((ctx) => ctx.createShopClient());
}

/**
 * **The shop's `get_shop_info`, through the ONE shop-info cache** — the read
 * {@link avaliarContaParaEstoque} gates on, exported so step 13's price verdict
 * reads the SAME entry instead of paying a second `get_shop_info` for the same
 * conta inside one cache window. Register 140: the cache's metric name still
 * says `stock` — one cache, named after its first reader.
 *
 * Same key (`[integracaoId]`, never the shop id — see {@link cacheDaLoja}),
 * same TTL, same clock: `deps.nowMs` is written to the caches' instant on entry,
 * exactly as the stock gate does, so whichever of the two callers ran last is
 * the one the expiry reads.
 *
 * The client is built through `deps.clientFor` (default: the conta's context)
 * ONLY on a miss — a warm entry costs neither a context load nor a token.
 *
 * ⚠️ Nothing is caught: a provider failure PROPAGATES and is never cached, so
 * the next caller simply reads again. Each caller maps it onto its own
 * vocabulary.
 */
export function lerInfoDaLojaShopee(
  db: Firestore,
  integracaoId: string,
  deps: DepsDeConta,
): Promise<ShopeeShopInfo> {
  instanteMs = deps.nowMs;
  return cacheDaLoja.get([integracaoId], async () =>
    (await clienteShopee(db, integracaoId, deps)).getShopInfo(),
  );
}

/**
 * The verdict for one conta, this tick.
 *
 * `{ ok: true }` means "ask Shopee about this conta's listings", never "Shopee
 * will accept them": every refusal this cannot see — a promotion floor, a
 * listing-level compliance hold, a penalty — is the sender's error ladder, and
 * a conta-level condition this DOES see costs one read rather than one refused
 * call per listing. That trade is the whole reason the gates exist; the error
 * arms remain the correctness.
 */
export async function avaliarContaParaEstoque(
  db: Firestore,
  conta: ContaParaEstoque,
  deps: DepsDeConta,
): Promise<VereditoDaConta> {
  instanteMs = deps.nowMs;

  // Counted by the sweep, never written to the state doc — `orderBackfill.ts`'s
  // `semShopId` treatment exactly: a main-account conta is a renderable state of
  // this channel, not a failure of this tick.
  if (conta.shopId == null) return recusa(MOTIVO_ESTOQUE_SHOPEE.semShopId);
  if (!refUtilizavel(conta.depositoOuterRef)) return recusa(MOTIVO_ESTOQUE_SHOPEE.semDeposito);

  // Built at most once per evaluation, and only if a cache misses: three warm
  // entries must cost neither a context load nor a token.
  let clientePendente: Promise<ShopeeClient> | null = null;
  const cliente = (): Promise<ShopeeClient> => {
    clientePendente ??= clienteShopee(db, conta.integracaoId, deps);
    return clientePendente;
  };

  // Through the exported reader, with the evaluation's OWN lazy client as its
  // seam — so a cold tick still builds exactly one client for all three reads.
  const loja = await lerInfoDaLojaShopee(db, conta.integracaoId, {
    nowMs: deps.nowMs,
    clientFor: () => cliente(),
  });

  // BANNED and FROZEN are one verdict: neither is covered by an `update_stock`
  // error code, both mean the shop cannot sell, and only Seller Centre lifts
  // either. The enum's companion const is what keeps the literal out of here.
  if (loja.status !== SHOPEE_SHOP_STATUS.normal) {
    return recusa(MOTIVO_ESTOQUE_SHOPEE.lojaBanidaOuCongelada);
  }
  if (!contaAceitaEstoqueShopee(loja.shop_fulfillment_flag)) {
    return recusa(MOTIVO_ESTOQUE_SHOPEE.lojaFbs);
  }
  registrarFlagIlegivel(conta.integracaoId, loja.shop_fulfillment_flag);

  // A CBSC merchant is served by `v2.global_product.update_stock` — Merchant
  // signed, no per-model lists — and `guide 223` §6 says the shop API "will
  // result in an error". Strictly `=== true`: `null` is "not stated".
  if (loja.is_upgraded_cbsc === true) return recusa(MOTIVO_ESTOQUE_SHOPEE.lojaCbsc);
  if (
    loja.is_outlet_shop === true ||
    loja.mart_outlet_structure_type === ESTRUTURA_ARMAZEM_OUTLET
  ) {
    return recusa(MOTIVO_ESTOQUE_SHOPEE.lojaOutlet);
  }

  const ferias = await cacheDeFerias.get([conta.integracaoId], async () =>
    (await cliente()).getShopHolidayMode(),
  );

  // ⚠️ `holiday_mode_on` is read FIRST and the type only when it is on — probe
  // P2 measured a live body answering `holiday_mode_type: 0` (which IS the FULL
  // value) beside `holiday_mode_on: false`, so a type-first reading would have
  // paused every conta that has never taken a holiday.
  //
  // ⚠️ Only a FULL holiday refuses. P10 measured a PARTIAL one NOT blocking
  // `update_stock`; the FULL block itself stays UNVERIFIED, and the fallback if
  // that guess is wrong is one tick, not a latch — every listing answers
  // `error_holiday_mode_change_stock` and the sender's arm G pauses the conta.
  // A `null`/absent `holiday_mode_on` SENDS: absence is not a holiday.
  if (
    ferias.holiday_mode_on === true &&
    ferias.holiday_mode_type === SHOPEE_HOLIDAY_MODE_TYPE.total
  ) {
    return recusa(MOTIVO_ESTOQUE_SHOPEE.lojaEmFerias);
  }

  // The `warehouseType` key is OMITTED, so the page applies its own default
  // (pickup) — the warehouses a stock write would have to address.
  const armazens = await cacheDeArmazens.get([conta.integracaoId], async () =>
    (await cliente()).getWarehouseDetail(),
  );

  // ⚠️ An EMPTY list is the NORMAL path, not a multi-warehouse regime: `faq 61`
  // requires EVERY `location_id` in one call and this ERP binds ONE depósito per
  // conta, so the refusal exists for the case where there is a map to build and
  // we have no way to build it. Nothing to map is not that case. The package's
  // fold answers `sem-multi-armazem` for the whitelist refusal AND for an
  // error-free empty array, and narrowing is on `kind` alone — no app compares a
  // wire code against a literal.
  if (armazens.kind === 'lista' && armazens.armazens.length > 0) {
    return recusa(MOTIVO_ESTOQUE_SHOPEE.multiArmazem);
  }

  return { ok: true };
}
