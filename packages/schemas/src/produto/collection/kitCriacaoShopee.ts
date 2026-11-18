import { z } from 'zod';
import { AGUARDAR_KIT_INCERTO_SHOPEE_MS } from '../../shopeeAcaoSugerida';
import type { CollectionMetadata } from '../../types';
import { PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS } from './shopeeRascunho';

/**
 * `kitCriacaoShopee` (TOP-LEVEL) — the single-flight LEASE of a native Shopee
 * kit's CREATE (#1912): at most ONE run per (conta, kit produto) may be on its
 * way to `add_kit_item`, which is NOT idempotent (two sends create two kits).
 *
 * Every create arm takes it — `kit-criar` (the first publish), `kit-recriar`
 * and `kit-converter` — from the route AND from `publicar:anuncio --live`, so
 * two tabs, two operators or the CLI beside the web send at most one create.
 * It is the ONLY state a kit create keeps, and it records nothing about what to
 * DO (L9 still holds: every create is an ENSURE re-derived from Shopee reads and
 * the link docs) — only whether another run may START a send.
 *
 * Doc id = `idDaCriacaoDeKit(integracaoId, produtoId)` (`apps/shopee`,
 * `kits/idsKit.ts`). Admin-only, default-deny: a bare schema + meta, NOT in
 * `ALL_DOMAINS` (see the NOTE at the bottom), so no rules block is generated.
 *
 * ## The ADR 0011 addendum's five conditions
 *
 * 1. **It expires**: `ateMs = desdeMs + CRIACAO_KIT_SHOPEE_TTL_MS`.
 * 2. **It is never renewed**: no writer moves `desdeMs` or `ateMs` of a lease
 *    it holds; the post-send grace below is a FIXED function of what is stored.
 * 3. **Corrupt reads as NO lease**: an unparseable document, an `ateMs` that is
 *    not `desdeMs + TTL`, or a `desdeMs` more than
 *    {@link FOLGA_RELOGIO_CRIACAO_KIT_SHOPEE_MS} ahead of the reader's clock.
 * 4. **Fenced by identity**: the holder re-reads it and stamps `enviadoEmMs` +
 *    `sku` under a `lastUpdateTime` precondition right before `add_kit_item`
 *    (token match, else nothing is sent); the link written after the act is at
 *    an id derived from the `item_id` Shopee minted, so a holder that outlived
 *    its lease can only ever write ITS OWN kit's link.
 * 5. **It outlasts the window a holder may still be sending in**: once STAMPED
 *    it stays taken for {@link AGUARDAR_KIT_INCERTO_SHOPEE_MS} past `ateMs`
 *    (the request ceiling + Shopee's listing lag), so a takeover's same-SKU
 *    scan runs only when a send that started just before the gate closed is
 *    visible on Shopee. The residual (a holder stalled longer than that between
 *    its gate and its send) ends in two LINKED kits, which every later publish
 *    refuses `vinculos-ambiguos` — visible, never silent (register 331).
 *
 * MILLISECONDS everywhere, and the unit is in every field name.
 */

/** Which create arm holds the lease — a diagnostic; the reading never uses it. */
export const ARMA_DA_CRIACAO_DE_KIT_SHOPEE = ['kit-criar', 'kit-recriar', 'kit-converter'] as const;
export type ArmaDaCriacaoDeKitShopee = (typeof ARMA_DA_CRIACAO_DE_KIT_SHOPEE)[number];

/**
 * MILLISECONDS — how long a create lease is LIVE once taken. An ALIAS of the
 * draft lock's TTL, never a second number (#1369): both bound a create that
 * the route's 180 s ceiling may cut off mid-send.
 */
export const CRIACAO_KIT_SHOPEE_TTL_MS = PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS;

/**
 * MILLISECONDS — how far AHEAD of the reader's clock a lease's `desdeMs` may
 * sit and still be believed (two instances' clocks differ a little). Further
 * ahead ⇒ condition 3: no lease.
 */
export const FOLGA_RELOGIO_CRIACAO_KIT_SHOPEE_MS = 60_000;

/**
 * MILLISECONDS — the longest a reader can ever be told to wait: a stamped
 * lease read the instant it was taken. The web's fallback wait for a 409
 * `emAndamento` that carried no `aguardarMs`.
 */
export const ESPERA_MAXIMA_CRIACAO_KIT_SHOPEE_MS =
  CRIACAO_KIT_SHOPEE_TTL_MS + AGUARDAR_KIT_INCERTO_SHOPEE_MS;

export const criacaoKitShopeeSchema = z
  .object({
    v: z.literal(1),
    integracaoId: z.string().min(1),
    produtoId: z.string().min(1),
    arma: z.enum(ARMA_DA_CRIACAO_DE_KIT_SHOPEE),
    /** Who holds it — compared, never parsed. */
    token: z.string().min(1),
    desdeMs: z.number().int().nonnegative(),
    ateMs: z.number().int().nonnegative(),
    /** Stamped right before `add_kit_item` — `null` until the holder reached its send. */
    enviadoEmMs: z.number().int().nonnegative().nullable(),
    /** The `item_sku` the stamped send carries — the takeover's scan key, a diagnostic. */
    sku: z.string().nullable(),
  })
  .strict();
export type CriacaoKitShopee = z.infer<typeof criacaoKitShopeeSchema>;

export const criacaoKitShopeeMeta: CollectionMetadata = {
  collectionPath: 'kitCriacaoShopee',
  // No client domain grants these bits — placeholder values. Deliberately NOT
  // registered in `ALL_DOMAINS`, so the rules generator emits no match block
  // and Firestore default-denies every client read/write. Only the Admin SDK
  // (apps/shopee) reaches it. Mirrors `backfillPedidosShopeeMeta`.
  permissions: {
    read: 0n,
    write: 0n,
    delete: 0n,
  },
};

/**
 * The 409 codes of a kit create the lease refused — every one means NOTHING was
 * sent by this run. Spelled through this table on both sides (the route and
 * `apps/web`), never as a quoted string.
 */
export const CODIGO_CRIACAO_KIT_SHOPEE = {
  /** Another run holds the lease (live, or inside its post-send grace). Detail: `aguardarMs`. */
  emAndamento: 'SHOPEE_KIT_CRIACAO_EM_ANDAMENTO',
  /**
   * This run stopped before `add_kit_item`: the scan or the send gate ran out of
   * the lease's time or the request's, or the lease was no longer this run's.
   */
  expirada: 'SHOPEE_KIT_CRIACAO_EXPIRADA',
  /** The lease was lost to concurrent writes on every attempt to take it. */
  contencao: 'SHOPEE_KIT_CRIACAO_CONTENCAO',
  /**
   * The produto's links changed so that this is no longer a native kit's first
   * create (a live listing appeared): the request named `criarKitNativo`, or the
   * re-read under the lease found it.
   */
  vinculosMudaram: 'SHOPEE_KIT_CRIACAO_VINCULOS_MUDARAM',
} as const satisfies Record<string, string>;
export type CodigoCriacaoKitShopee =
  (typeof CODIGO_CRIACAO_KIT_SHOPEE)[keyof typeof CODIGO_CRIACAO_KIT_SHOPEE];

/** What a reader makes of a stored create lease. */
export type EstadoDaCriacaoDeKitShopee =
  | { readonly tipo: 'livre' }
  | {
      readonly tipo: 'em-andamento';
      /** Who holds it. */
      readonly token: string;
      /** Whether its holder reached the send (stamped): the post-send grace applies. */
      readonly enviado: boolean;
      /** MILLISECONDS until the reading can turn `livre` — a positive integer. */
      readonly aguardarMs: number;
    };

const LIVRE: EstadoDaCriacaoDeKitShopee = { tipo: 'livre' };

/**
 * THE reading of a kit create lease — the acquire, the pre-send check and every
 * test decide with this, never by comparing the fields raw. Pure, total over
 * `unknown`, no clock of its own (`agoraMs` is the reader's, MILLISECONDS).
 *
 * - `null`/absent, unparseable, `ateMs ≠ desdeMs + TTL`, or `desdeMs` more than
 *   {@link FOLGA_RELOGIO_CRIACAO_KIT_SHOPEE_MS} ahead ⇒ **`livre`** (ADR 0011
 *   condition 3: the failure mode of a bad lock is "no lock");
 * - UNSTAMPED (`enviadoEmMs` null) ⇒ `em-andamento` while `agoraMs < ateMs`,
 *   then `livre` — its holder never reached the send, so nothing can be in
 *   flight;
 * - STAMPED ⇒ `em-andamento` while `agoraMs < ateMs + AGUARDAR_KIT_INCERTO_SHOPEE_MS`,
 *   then `livre`: a send that started just before the gate closed is visible
 *   to the takeover's scan by then.
 *
 * ⚠️ An invalid clock never frees a lease: every "free" test is written so `NaN`
 * fails it.
 *
 * Boundaries (pinned in `kitCriacaoShopee.test.ts`): unstamped `ateMs − 1` ⇒
 * em-andamento, `ateMs` ⇒ livre; stamped `ateMs + 240 000 − 1` ⇒ em-andamento,
 * `ateMs + 240 000` ⇒ livre; `desdeMs = agora + 60 000` ⇒ held, `+ 60 001` ⇒ livre.
 */
export function estadoDaCriacaoDeKitShopee(
  raw: unknown,
  agoraMs: number,
): EstadoDaCriacaoDeKitShopee {
  if (raw === null || raw === undefined) return LIVRE;
  const lido = criacaoKitShopeeSchema.safeParse(raw);
  if (!lido.success) return LIVRE;
  const { token, desdeMs, ateMs, enviadoEmMs } = lido.data;
  if (ateMs !== desdeMs + CRIACAO_KIT_SHOPEE_TTL_MS) return LIVRE;
  // Written as "free only if": a NaN clock fails it and keeps the lease.
  if (desdeMs - agoraMs > FOLGA_RELOGIO_CRIACAO_KIT_SHOPEE_MS) return LIVRE;

  const enviado = enviadoEmMs !== null;
  const fim = enviado ? ateMs + AGUARDAR_KIT_INCERTO_SHOPEE_MS : ateMs;
  if (agoraMs >= fim) return LIVRE;

  const restante = Number.isFinite(agoraMs) ? fim - agoraMs : fim - desdeMs;
  return { tipo: 'em-andamento', token, enviado, aguardarMs: Math.max(1, Math.ceil(restante)) };
}

// NOTE: intentionally exported as two BARE constants (`...Schema` + `...Meta`),
// NOT a single `{ schema, meta }` DomainSchema object, and NOT added to
// `ALL_DOMAINS` — `registry.test.ts`'s `isDomainSchema()` only flags a single
// export carrying both a `.schema` and a `.meta` property. The admin handle
// (`kitCriacaoShopeeCollection`) consumes `criacaoKitShopeeMeta.collectionPath`.
