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
 * stock. `.passthrough()` preserves any extra field the Flutter app may add.
 */
export const kitSchema = z
  .object({
    quantidade: z
      .number()
      .int()
      .min(1, 'A quantidade do componente deve ser ao menos 1')
      .default(1),
    limitarEstoque: z.boolean().default(true),
    timestamp: z.number().int().nullable().default(null),
  })
  .passthrough();

export type Kit = z.infer<typeof kitSchema>;

/** `produto.componentesKit` — component produto id → `Kit`. */
export const componentesKitSchema = z.record(z.string(), kitSchema);

export type ComponentesKit = z.infer<typeof componentesKitSchema>;
