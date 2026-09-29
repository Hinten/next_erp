/**
 * **The conta verdict for the price sync** (#1521, step 13) — one Shopee conta
 * plus one instant ⇒ may this ERP write ANY price onto that shop, and if so in
 * which currency and under which max/min ratio between variations?
 *
 * Run ONCE per conta, before any item: the manual push runs it before its pool
 * (a refusal answers the whole request 422 `SHOPEE_PRECO_CONTA_RECUSADA`), and
 * the job runs it on every drain before touching the fila. Where
 * `estoque/contaEstoque.ts` asks the same question about a QUANTITY, this
 * module asks it about a PRICE — and the two read the ONE shop-info cache, so
 * one conta inside one cache window costs one `get_shop_info` whichever sync
 * asked first (`lerInfoDaLojaShopee`, register 140).
 *
 * ## The order is the cost model
 *
 * | # | rung | motivo | cost |
 * |---|---|---|---|
 * | 1 | `shopId == null` | `sem-shop-id` | zero — the enumerated conta already said so |
 * | 2 | `tabelaNormalOuterRef` names no document | `sem-tabela-normal` | zero |
 * | 3 | the client + `get_shop_info` (the SHARED cache) | `conta-nao-configurada` for the four conta classes | one cached GET |
 * | 4 | `status !== NORMAL` | `loja-banida-ou-congelada` | the same read |
 * | 5 | `is_cb === true` | `loja-cross-border` | the same read |
 * | 6 | the region | `regiao-nao-suportada` | the same read |
 *
 * The two local rungs come first so a conta that cannot sign a shop call, or
 * that has nowhere to read a price from, costs no provider call and builds no
 * client. The client itself is built LAZILY and at most once: a warm cache
 * entry that refuses the conta builds none, and a warm entry that accepts it
 * builds exactly the one the accepted context carries.
 *
 * ⚠️ Cross-border is refused BEFORE the region, and on a BR shop too: a CB
 * listing's `original_price` is in the seller's own currency while
 * `local_price` is that times an adjustment rate, so a reais figure sent to a
 * CB shop would be read as another currency — and no region row can say which.
 *
 * ## ⚠️ Only reais, and the ONE branch this app takes on the sandbox
 *
 * The ERP's price tables are in reais. A BR shop takes them as BRL; any other
 * region would take the same NUMBER in its own currency, which is a wrong price
 * that Shopee accepts with a 200. So the verdict is `BR` or nothing — EXCEPT
 * that the only shop the sandbox gives us is Singaporean (probe P0 read
 * `region: "SG"`, upper case), and a price sync that cannot be rehearsed end to
 * end before production is a price sync first exercised on real listings.
 *
 * Hence {@link overrideDeSandboxAtivo}: a non-BR region that has a row in
 * {@link MOEDA_E_MULTIPLO_POR_REGIAO} is accepted ONLY while the backend is on
 * the sandbox. This is the one named exception to `apps/shopee/CLAUDE.md`
 * rule 6 ("credentials and env, never a branch in code"), and it keys on TWO
 * facts, never one:
 *
 * - the config's sandbox flag, AND
 * - the RESOLVED API host being exactly `SHOPEE_SANDBOX_API_HOST`.
 *
 * The flag alone is not a production guard: host precedence is override >
 * flag > default (`resolveShopeeHosts`), so the flag ON beside an explicit API
 * host pointing at production — the proxied-egress shape the host docblock
 * names — talks to REAL shops with the flag still on. Keyed on the resolved
 * host, a process that can reach a production shop cannot have the override
 * on. An unknown region refuses with the override on as well: a multiple or a
 * currency is never guessed.
 *
 * The config arrives as a PARAMETER (`deps.config`, default `shopeeConfig()`),
 * read only when a non-BR region actually needs it — so this module reads no
 * environment of its own, and a BR shop's verdict never depends on the flag.
 *
 * ## The conta classes — a verdict, never a throw
 *
 * Four app-local classes say "this conta cannot sign a shop call":
 * `ShopeeContaNotConfiguredError` (the conta document is missing or is not a
 * Shopee conta), `ShopeeContaSemShopIdError` (main-account consent),
 * `ShopeeSemCredencialError` (no stored token pair) and
 * `ShopeeCredencialInvalidaError` (a stored pair that no longer parses). The
 * first two fire when the client is BUILT; the last two fire LAZILY, at the
 * first shop-signed CALL, which here is the `get_shop_info` read. Every one of
 * them becomes `conta-nao-configurada` with the class name and message in
 * `erro` — one route answer or one report row, never a 500 or a dead letter.
 *
 * Deliberately NOT in {@link ehContaInutilizavel}: the token-refresh-in-flight
 * class (transient — the next call finds the fresh pair, so it propagates), the
 * package's config error (a backend missing a variable is OUR bug and must
 * surface as one) and every provider error — a Shopee envelope, an expired
 * grant, a rate limit propagate to the caller's own containment, exactly as in
 * the stock gate.
 *
 * ## Rule 7
 *
 * Reads only; this module writes nothing, so it has no race to lose. The
 * shared cache's instant is advisory and last-writer-wins (see
 * `estoque/contaEstoque.ts`): a stale entry costs at worst one re-read or one
 * verdict up to 15 minutes old, and every refusal it could miss is also a
 * refusal Shopee answers per item.
 *
 * Sources: `design-reconcile-step13.md` §1 C-i/C-j, §2.5, Appendix B (P0);
 * `design-D1-sender.md` §3.4 and §3.13.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  SHOPEE_SANDBOX_API_HOST,
  SHOPEE_SHOP_STATUS,
  type ShopeeClient,
  type ShopeeShopInfo,
} from '@delfrance/integrations-shopee';

import { ShopeeCredencialInvalidaError } from '../core/credentialStore';
import { ShopeeContaNotConfiguredError, loadShopeeContext } from '../core/shopee';
import { ShopeeContaSemShopIdError, ShopeeSemCredencialError } from '../core/tokenStore';
import { idDoRef } from '../core/vinculosShopee';
import { type ShopeeConfig, shopeeConfig } from '../env';
import { type DepsDeConta, lerInfoDaLojaShopee } from '../estoque/contaEstoque';
import { MOTIVO_PRECO_SHOPEE, type MotivoPrecoShopee } from './errosPreco';

/* -------------------------------------------------------------------------- */
/*                               the region table                              */
/* -------------------------------------------------------------------------- */

/**
 * The currency a region's shop prices in, and the max/min ratio Shopee allows
 * between one item's variations there — for the ONLY regions this ERP could
 * ever send to. Every other region is ABSENT, and absent refuses.
 *
 * - `BR` → `BRL`, ×4 (`guide 223` §5; documented, not measured — no BR shop is
 *   reachable before production).
 * - `SG` → `SGD`, ×5 (probe P11b measured it: 4.5× accepted, 5.5× refused; P2
 *   read the currency `SGD`). Reachable only through
 *   {@link overrideDeSandboxAtivo}.
 *
 * Keys are the wire's spelling, UPPER case (probe P0), compared for identity:
 * `'br'`, `' BR'` and `'BR '` are not `'BR'`. A `Map`, never an object literal,
 * so a region named like a prototype key (`constructor`, `__proto__`) reads
 * absent instead of reading `Object.prototype`.
 */
export const MOEDA_E_MULTIPLO_POR_REGIAO: ReadonlyMap<
  string,
  { readonly moeda: string; readonly multiplo: number }
> = new Map([
  ['BR', { moeda: 'BRL', multiplo: 4 }],
  ['SG', { moeda: 'SGD', multiplo: 5 }],
]);

/** The one region the ERP's reais are native to. */
const REGIAO_NATIVA = 'BR';

/**
 * Is the sandbox override on? Both facts, strictly: the flag is exactly `true`
 * AND the resolved API host is exactly the sandbox host. See the module header
 * for why the flag alone is not enough.
 *
 * The host is compared for IDENTITY. `resolveShopeeHosts` already reduces an
 * override to its bare origin (no trailing slash, no path), so every real
 * config spells the sandbox host exactly as the constant does; a value that
 * does not is not the sandbox host.
 */
export function overrideDeSandboxAtivo(config: Pick<ShopeeConfig, 'sandbox' | 'hosts'>): boolean {
  return config.sandbox === true && config.hosts.apiHost === SHOPEE_SANDBOX_API_HOST;
}

/* -------------------------------------------------------------------------- */
/*                              the conta classes                              */
/* -------------------------------------------------------------------------- */

/**
 * Does this error say "the conta cannot sign a shop call"? The ONE predicate
 * for the four conta classes — the verdict below and the sender's own error
 * ladder both narrow through it, so the two cannot disagree about which class
 * is a conta problem. See the module header for what is deliberately left out.
 */
export function ehContaInutilizavel(
  err: unknown,
): err is
  | ShopeeContaNotConfiguredError
  | ShopeeContaSemShopIdError
  | ShopeeSemCredencialError
  | ShopeeCredencialInvalidaError {
  return (
    err instanceof ShopeeContaNotConfiguredError ||
    err instanceof ShopeeContaSemShopIdError ||
    err instanceof ShopeeSemCredencialError ||
    err instanceof ShopeeCredencialInvalidaError
  );
}

/* -------------------------------------------------------------------------- */
/*                                  the seam                                   */
/* -------------------------------------------------------------------------- */

declare const marca: unique symbol;

/**
 * A conta that PASSED the verdict, with everything the per-item sender needs
 * from it. BRANDED: the brand is a type that no object literal carries, so the
 * sender — which takes this and not a bare region — cannot be handed a context
 * that did not come out of {@link avaliarContaParaPreco}.
 */
export interface ContextoContaPreco {
  readonly [marca]: true;
  readonly integracaoId: string;
  /** The shop-signed client the verdict built (or would have built) — one per evaluation. */
  readonly client: ShopeeClient;
  /** The shop's region, verbatim from `get_shop_info` (`'BR'`, or `'SG'` under the override). */
  readonly regiao: string;
  /** The currency every fresh read's `price_info[].currency` must carry. */
  readonly moeda: string;
  /** The max/min ratio between one item's variations, for the pre-wire check. */
  readonly multiplo: number;
  /** The document id the conta's `tabelaNormalOuterRef` names — the key into `produto.precos`. */
  readonly tabelaNormalId: string;
}

/**
 * Narrow on `.ok` before reading anything else.
 *
 * `regiao` on a refusal is the shop's region whenever `get_shop_info` was read
 * (rungs 4–6), and `null` before that. `erro` is `"<class>: <message>"` for
 * `conta-nao-configurada`, `null` otherwise.
 */
export type VereditoContaPreco =
  | { readonly ok: true; readonly contexto: ContextoContaPreco }
  | {
      readonly ok: false;
      readonly motivo: MotivoPrecoShopee;
      readonly regiao: string | null;
      readonly erro: string | null;
    };

/** What the caller already knows about the conta before any rung runs. */
export interface ContaParaPreco {
  readonly integracaoId: string;
  /** `null` ⇒ consent given by MAIN ACCOUNT; nothing shop-signed can run. */
  readonly shopId: number | null;
  /** `integracao.tabelaNormalOuterRef`, unvalidated. */
  readonly tabelaNormalOuterRef: unknown;
}

/**
 * The stock gate's deps (the client seam + the instant, which is also the
 * shared cache's instant) plus the config the override reads. `config`
 * defaults to `shopeeConfig()`, evaluated only when a non-BR region needs it.
 */
export type DepsDeContaPreco = DepsDeConta & {
  readonly config?: Pick<ShopeeConfig, 'sandbox' | 'hosts'>;
};

/* -------------------------------------------------------------------------- */
/*                                  the verdict                                */
/* -------------------------------------------------------------------------- */

function recusa(motivo: MotivoPrecoShopee, regiao: string | null): VereditoContaPreco {
  return { ok: false, motivo, regiao, erro: null };
}

function contaNaoConfigurada(err: Error): VereditoContaPreco {
  return {
    ok: false,
    motivo: MOTIVO_PRECO_SHOPEE.contaNaoConfigurada,
    regiao: null,
    erro: `${err.name}: ${err.message}`,
  };
}

/**
 * The tabela's document id, through the app's shared ref fold (`idDoRef`: both
 * stored encodings, `documents/<col>/<id>` and `<col>/<id>`, name the SAME
 * id), or `null` when there is none to read a price from. A whitespace-only id
 * is blank — the stock gate's `refUtilizavel` reading of "not configured".
 */
function idDaTabelaNormal(bruto: unknown): string | null {
  const id = idDoRef(bruto);
  return id === null || id.trim() === '' ? null : id;
}

/** The client seam, `contaEstoque.ts`'s verbatim. */
function clienteShopee(
  db: Firestore,
  integracaoId: string,
  deps: DepsDeContaPreco,
): Promise<ShopeeClient> {
  if (deps.clientFor !== undefined) return deps.clientFor(db, integracaoId);
  return loadShopeeContext(db, integracaoId).then((ctx) => ctx.createShopClient());
}

/**
 * The verdict for one conta. See the module header for the rungs and why they
 * run in this order.
 *
 * `{ ok: true }` means "ask Shopee about this conta's listings", never "Shopee
 * will accept them": every refusal this cannot see — a promotion lock, a
 * listing-level hold, a penalty — is the sender's code table.
 *
 * ⚠️ Only the four conta classes are caught. Every other failure of the client
 * build or the shop read PROPAGATES, uncached, to the caller's containment.
 */
export async function avaliarContaParaPreco(
  db: Firestore,
  conta: ContaParaPreco,
  deps: DepsDeContaPreco,
): Promise<VereditoContaPreco> {
  if (conta.shopId == null) return recusa(MOTIVO_PRECO_SHOPEE.semShopId, null);
  const tabelaNormalId = idDaTabelaNormal(conta.tabelaNormalOuterRef);
  if (tabelaNormalId === null) return recusa(MOTIVO_PRECO_SHOPEE.semTabelaNormal, null);

  // Built at most once per evaluation, and only when something needs it: the
  // cold shop read, or the accepted context.
  let clientePendente: Promise<ShopeeClient> | null = null;
  const cliente = (): Promise<ShopeeClient> => {
    clientePendente ??= clienteShopee(db, conta.integracaoId, deps);
    return clientePendente;
  };

  let loja: ShopeeShopInfo;
  try {
    loja = await lerInfoDaLojaShopee(db, conta.integracaoId, {
      nowMs: deps.nowMs,
      clientFor: () => cliente(),
    });
  } catch (err) {
    if (ehContaInutilizavel(err)) return contaNaoConfigurada(err);
    throw err;
  }

  if (loja.status !== SHOPEE_SHOP_STATUS.normal) {
    return recusa(MOTIVO_PRECO_SHOPEE.lojaBanidaOuCongelada, loja.region);
  }
  if (loja.is_cb === true) return recusa(MOTIVO_PRECO_SHOPEE.lojaCrossBorder, loja.region);

  const linha = MOEDA_E_MULTIPLO_POR_REGIAO.get(loja.region);
  if (linha === undefined) return recusa(MOTIVO_PRECO_SHOPEE.regiaoNaoSuportada, loja.region);
  if (loja.region !== REGIAO_NATIVA && !overrideDeSandboxAtivo(deps.config ?? shopeeConfig())) {
    return recusa(MOTIVO_PRECO_SHOPEE.regiaoNaoSuportada, loja.region);
  }

  let client: ShopeeClient;
  try {
    client = await cliente();
  } catch (err) {
    if (ehContaInutilizavel(err)) return contaNaoConfigurada(err);
    throw err;
  }

  // The ONE place the brand is applied: every field below was just decided.
  const contexto = {
    integracaoId: conta.integracaoId,
    client,
    regiao: loja.region,
    moeda: linha.moeda,
    multiplo: linha.multiplo,
    tabelaNormalId,
  } as ContextoContaPreco;
  return { ok: true, contexto };
}
