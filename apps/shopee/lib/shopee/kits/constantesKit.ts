/**
 * The constants of the native-kit arms (step 19, #1527) — the ones the app
 * decides. The kit SHAPE Shopee imposes lives elsewhere and is not repeated
 * here: the single-model tier pair (`NOME_TIER_KIT_UNICO` / `OPCAO_TIER_KIT_UNICO`)
 * and the model ceiling are `@delfrance/schemas`' (step 9 must recognise them
 * too), the wire guards are the package's, and the deterministic link ids are
 * `kits/idsKit.ts`'.
 *
 * Pure: no clock, no I/O.
 */
import {
  SHOPEE_ITEM_IMAGE_MAX,
  SHOPEE_ITEM_STATUS_WIRE,
  type ShopeeItemStatusWire,
} from '@delfrance/integrations-shopee';

/**
 * How many `get_item_list` pages (of 100) the duplicate-SKU scan
 * (`localizarKitsPorSku`) walks before it gives up and answers INCOMPLETE —
 * 10 000 listings. An incomplete scan creates nothing: the create arm refuses
 * `busca-de-kit-incompleta` rather than risk a second kit with one SKU. The
 * route has a 180 s ceiling and the CLI none, so a shop this large is the CLI's.
 */
export const MAX_PAGINAS_BUSCA_KIT = 100;

/**
 * The `item_status` filter of the duplicate-SKU scan (L6, R-14): every status a
 * kit that still EXISTS can carry. ⚠️ `SELLER_DELETE` / `SHOPEE_DELETE` are left
 * out on purpose — a deleted kit is never a duplicate, and a recriar's old kit
 * deleted a moment ago must not be taken for the new one. `REVIEWING` and
 * `BANNED` stay IN: such a kit still holds the SKU on Shopee, and creating a
 * second one beside it is exactly the duplicate the scan exists to refuse.
 */
export const STATUS_BUSCA_KIT = [
  SHOPEE_ITEM_STATUS_WIRE.normal,
  SHOPEE_ITEM_STATUS_WIRE.unlist,
  SHOPEE_ITEM_STATUS_WIRE.reviewing,
  SHOPEE_ITEM_STATUS_WIRE.banned,
] as const satisfies readonly ShopeeItemStatusWire[];

/**
 * A kit that is LIVE — selling or paused. The recriar's two gates (PR 6): the
 * nothing-to-recreate guard runs only on a target in one of these, and the old
 * kit is deleted only once the NEW one reads one of these.
 */
export const STATUS_KIT_VIVO = [
  SHOPEE_ITEM_STATUS_WIRE.normal,
  SHOPEE_ITEM_STATUS_WIRE.unlist,
] as const satisfies readonly ShopeeItemStatusWire[];

/**
 * How many of the kit produto's own photos a kit create sends (O-1, R-3) —
 * step 11's ITEM ceiling, because the photos go up through step 11's
 * `upload_image` resolver. ⚠️ Deliberately NOT the package's
 * `SHOPEE_KIT_IMAGE_MAX` (10): that one is the WIRE guard of `add_kit_item`
 * (`get_kit_item_limit`'s sample band), and the two are never merged.
 */
export const CAP_FOTOS_KIT: number = SHOPEE_ITEM_IMAGE_MAX;
