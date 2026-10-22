import { z } from 'zod';

/**
 * The machine-readable NEXT STEP of a Shopee publish refusal (step 21, #1529),
 * and the one wait an uncertain kit create asks for.
 *
 * A kit or dispatcher refusal used to reach the operator as a sentence that
 * named a CLI flag ("rode `publicar:anuncio … --recriar`"). The CLI keeps that
 * text; the web cannot run a command line, so each such refusal also carries an
 * `acao` from this vocabulary and the produto's Shopee tab maps it to a button
 * on the right link — it never parses the sentence.
 *
 * NOT a collection: nothing here is a document, so there is no `registry.ts`
 * entry and nothing reaches a ruleset. It sits at the schemas root beside
 * `receitaKitShopee.ts`, because both sides must agree on it and `apps/web` has
 * no dependency edge to `apps/shopee` — the producer (`apps/shopee`'s refusal
 * sites) and the reader (`apps/web/lib/shopee/wire.ts`) import the SAME schema
 * objects, so a renamed `tipo` is a compile error on both sides of the deploy.
 *
 * ⚠️ The reader parses `acao` PER ROW with a fallback to `null`: a `tipo` a newer
 * backend adds degrades that one refusal to "no button", never the whole 422.
 * So a new member here is additive on the wire, and the web learns it on its
 * next deploy.
 */

/** Every `tipo` a refusal's `acao` may carry. */
export const tipoAcaoSugeridaPublicacaoShopeeSchema = z.enum([
  'recriar',
  'republicar',
  'sem-opcoes-de-kit',
  'informar-principal',
  'importar',
  'escolher-vinculo',
]);
export type TipoAcaoSugeridaPublicacaoShopee = z.infer<
  typeof tipoAcaoSugeridaPublicacaoShopeeSchema
>;

/** Named members of {@link tipoAcaoSugeridaPublicacaoShopeeSchema}. */
export const TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE = {
  recriar: 'recriar',
  republicar: 'republicar',
  semOpcoesDeKit: 'sem-opcoes-de-kit',
  informarPrincipal: 'informar-principal',
  importar: 'importar',
  escolherVinculo: 'escolher-vinculo',
} as const satisfies Record<string, TipoAcaoSugeridaPublicacaoShopee>;

/**
 * The machine-readable next step of a kit/dispatcher refusal (the web maps it to
 * a button; the CLI keeps its text).
 *
 * - `recriar` — "Recriar kit" on `linkDocId`, the link the refusal is about;
 * - `republicar` — republish `linkDocId`; `null` means a publish that names no
 *   link at all. `substituidoLinkDocId` (a `vinculo-substituido` row) names the
 *   SUPERSEDED link the refusal is ABOUT: the dispatcher's is the link that was
 *   sent, but a kit create's duplicate scan raises it about ANOTHER link (K's
 *   old kit, still live), so the reader must not call the sent link
 *   superseded. Absent from a server older than the field (and `null` = not
 *   reported);
 * - `sem-opcoes-de-kit` — republish WITHOUT the kit options (recriar/converter);
 * - `informar-principal` — the request must name the kit's principal;
 * - `importar` — the kit already exists on Shopee as `itemIds` (at least one):
 *   import it instead of creating another. `vinculados` names the hits a link
 *   of some produto ALREADY holds, each with that produto: the mass import
 *   skips a listing a link names, so for those the next step is the owning
 *   produto, never the import. Absent from a server older than the field (and
 *   `null` = not reported) — the reader then words every id alike;
 * - `escolher-vinculo` — several links qualify: the operator picks one of
 *   `linkDocIds` (at least two, or there was nothing to choose).
 */
export const acaoSugeridaPublicacaoShopeeSchema = z.discriminatedUnion('tipo', [
  z.object({
    tipo: z.literal(TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.recriar),
    linkDocId: z.string().min(1),
  }),
  z.object({
    tipo: z.literal(TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.republicar),
    linkDocId: z.string().min(1).nullable(),
    substituidoLinkDocId: z.string().min(1).nullable().optional(),
  }),
  z.object({ tipo: z.literal(TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.semOpcoesDeKit) }),
  z.object({ tipo: z.literal(TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.informarPrincipal) }),
  z.object({
    tipo: z.literal(TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.importar),
    itemIds: z.array(z.number().int().positive()).min(1),
    vinculados: z
      .array(z.object({ itemId: z.number().int().positive(), produtoId: z.string().min(1) }))
      .nullable()
      .optional(),
  }),
  z.object({
    tipo: z.literal(TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.escolherVinculo),
    linkDocIds: z.array(z.string().min(1)).min(2),
  }),
]);
export type AcaoSugeridaPublicacaoShopee = z.infer<typeof acaoSugeridaPublicacaoShopeeSchema>;

/** 4 min = the route ceiling (180 s, apphosting.yaml) + 60 s over the ~9 s listing latency. ONE copy (#1369). */
export const AGUARDAR_KIT_INCERTO_SHOPEE_MS = 240_000;
