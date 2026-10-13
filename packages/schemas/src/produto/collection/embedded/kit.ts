import { z } from 'zod';

/**
 * One entry of `produto.componentesKit` — the map is keyed by the **component
 * produto's doc id** and each value is a `Kit`. Mirrors the Flutter `Kit` wire
 * shape (`packages/produtos/lib/src/models.dart:3937` / generated
 * `_$KitToJson`): every field is always written (no `includeIfNull`), and
 * `timestamp` is an ms-epoch int (`maybeDateTimeToJson` → `millisecondsSinceEpoch`).
 *
 * `quantidade` (min 1) is how many of the component go into one kit;
 * `limitarEstoque` flags whether the component constrains the kit's available
 * stock. `.passthrough()` preserves any extra field the migrated corpus carries.
 *
 * ⚠️ `limitarEstoque` is DEPRECATED (Lucas, 2026-10-07): every component will
 * limit stock. Shopee native kits already send every component regardless of
 * the flag (step 19, #1527), because Shopee derives a kit's stock from ALL its
 * components; removal is tracked in #1835, which also covers the corpus rows
 * that hold it `false`, the ERP availability rule, Mercado Livre and the web
 * editor. Do not add readers.
 */
export const kitSchema = z
  .object({
    quantidade: z
      .number()
      .int()
      .min(1, 'A quantidade do componente deve ser ao menos 1')
      .default(1),
    /**
     * @deprecated Deprecated (Lucas, 2026-10-07): every component will limit
     * stock. Shopee native kits already send every component regardless
     * (step 19); removal tracked in #1835. Do not add readers.
     */
    limitarEstoque: z.boolean().default(true),
    timestamp: z.number().int().nullable().default(null),
  })
  .passthrough();

export type Kit = z.infer<typeof kitSchema>;

/** `produto.componentesKit` — component produto id → `Kit`. */
export const componentesKitSchema = z.record(z.string(), kitSchema);

export type ComponentesKit = z.infer<typeof componentesKitSchema>;
