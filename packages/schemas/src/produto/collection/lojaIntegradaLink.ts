import { z } from 'zod';
import { inteiroPositivoCanonicoLi } from '../../mapaFreteLojaIntegrada';
import { contaIdFromRef, outerRefSchema } from '../../shared/outerRef';

/**
 * Typed write-side schema for the Loja Integrada listing link doc —
 * `produtos/{id}/produtolojaintegrada/{docId}` — in the EXACT old Flutter
 * wire shape (`ProdutoIntegrada`, loja_integrada `models.dart`): the migrated
 * corpus is stored in exactly this shape, so it has to be read and written
 * that way.
 *
 * This is deliberately NOT a DomainSchema and NOT in `ALL_DOMAINS`: the loose
 * pass-through subcollection domain in `subcollections.ts` (leaf name
 * `produtolojaintegrada` — verified against the compiled
 * `models.odm.g.dart`; `produtointegrada` is just the Dart accessor getter
 * name, #289) already covers the Firestore rules (client reads, parent
 * produto permissions); this typed shape exists for the Admin-SDK writers,
 * which bypass rules but must not drift from the Flutter wire format.
 *
 * The FIRST writer is the product import (master plan step 9): it links a
 * store product to an ERP produto and refreshes the store-state mirror fields
 * (`ativo`, `bloqueado`, `removido`) on every run. The publish flow (step 11)
 * is the second.
 *
 * Wire notes (#289):
 *  - `estadoPublicacao` is one of the eight codes of
 *    {@link ESTADO_PUBLICACAO_LI}. Read-TOLERANT: an unknown, `null` or absent
 *    stored value reads as `r` (rascunho), never as a refused document, because
 *    the migrated corpus is not known to hold only those codes and no decision
 *    of the import depends on the stored code. Written only as a code (the
 *    input type is the enum);
 *  - `destaque` and `usado` exist only on a product DETAIL (the list row has
 *    neither), so a link written from a list row alone stores `null` — never an
 *    invented `false`;
 *  - `grades` is parent-only and `variacoes` is children-only — both stay
 *    nullable arrays since either can be absent depending on which side of
 *    the link a given doc represents.
 *
 * Three pure readers ride beside the schema, all total over a RAW stored value
 * (they never throw, and never need the doc to parse): {@link contaDoLinkLi}
 * and {@link vinculoLiConta}, the anchor's conta reader and counts predicate,
 * and {@link vinculoLiDaContaEId}, which decides whether a stored link IS the
 * link of one (conta, store product).
 *
 * ⚠️ They decide "the same", so this file is listed in
 * `packages/config-eslint/rules/equivalence-fold-inventory.test.js`, with their
 * equal pairs and near-misses pinned in `lojaIntegradaLink.test.ts`.
 */

/**
 * The eight publication codes a link may carry (master plan §3): `r` rascunho, `a` aguardando,
 * `ep` em processamento, `v` em revisão, `p` publicado, `pa` pausado, `c` cancelado, `E` erro.
 * The `E` is upper-case on the wire; the codes are compared exactly.
 */
export const estadoPublicacaoLiSchema = z.enum(['r', 'a', 'ep', 'v', 'p', 'pa', 'c', 'E']);
export type EstadoPublicacaoLi = z.infer<typeof estadoPublicacaoLiSchema>;

/** Named members of {@link estadoPublicacaoLiSchema} — see `delfrance/prefer-schema-enum`. */
export const ESTADO_PUBLICACAO_LI = {
  rascunho: 'r',
  aguardando: 'a',
  emProcessamento: 'ep',
  emRevisao: 'v',
  publicado: 'p',
  pausado: 'pa',
  cancelado: 'c',
  erro: 'E',
} as const satisfies Record<string, EstadoPublicacaoLi>;

/** `produtos/{id}/produtolojaintegrada/{docId}` — the Loja Integrada listing link doc. */
export const produtoLojaIntegradaLinkSchema = z
  .object({
    // Required account link back to the owning ContaLojaIntegrada (legacy
    // required ctor param).
    contaLojaIntegrada: outerRefSchema,
    id: z.number().int().nullable().default(null),
    paiProdutoIntegradaId: z.number().int().nullable().default(null),
    // An unknown, `null` or absent stored code reads as `r` (see the header).
    estadoPublicacao: estadoPublicacaoLiSchema.catch(ESTADO_PUBLICACAO_LI.rascunho),
    error: z.string().nullable().default(null),
    sku: z.string().min(1),
    nome: z.string().nullable().default(null),
    descricao_html: z.string().nullable().default(null),
    // Legacy constructor defaults `ativo = true` — a fresh listing is active.
    ativo: z.boolean().default(true),
    /** Blocked by the platform. A list row carries it, so every import write mirrors it. */
    bloqueado: z.boolean().default(false),
    /** Detail-only (see the header): `null` when the link was written from a list row. */
    destaque: z.boolean().nullable().default(null),
    /** Detail-only (see the header): `null` when the link was written from a list row. */
    usado: z.boolean().nullable().default(null),
    /** Parent-only: the option-name (grade) list. */
    grades: z.array(z.string()).nullable().default(null),
    /** Children-only: the child variation listing ids. */
    variacoes: z.array(z.string()).nullable().default(null),
    categorias: z.array(z.string()).nullable().default(null),
    marca: z.string().nullable().default(null),
    removido: z.boolean().default(false),
  })
  .passthrough();
export type ProdutoLojaIntegradaLink = z.infer<typeof produtoLojaIntegradaLinkSchema>;

/* -------------------------------------------------------------------------- */
/*                       The readers of a stored link                          */
/* -------------------------------------------------------------------------- */

/** A plain object in the Firestore sense: not `null`, not an array, not a primitive. */
function ehObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** An OWN property only: an inherited one is not stored data. */
function proprio(o: Record<string, unknown>, chave: string): unknown {
  return Object.hasOwn(o, chave) ? o[chave] : undefined;
}

/**
 * The integração doc id a stored `produtolojaintegrada` link belongs to, or `null`: the
 * `integracoesComProduto` anchor's CONTA reader, {@link contaIdFromRef} over `contaLojaIntegrada`.
 *
 * It moved here from the app's anchor binding
 * (`apps/loja-integrada/lib/lojaIntegrada/produtos/integracoesComProdutoLi.ts`, which re-exports
 * it, so no importer changed) because a `tools/migrations` script needs the identical answer and
 * cannot import an app. The trigger's plan, the survivor read in `@delfrance/data/admin/produtos`
 * and that script now read one copy, always paired with {@link vinculoLiConta}.
 *
 * ⚠️ **The FIELD is the decision.** Another channel's conta field (`contaOuterRef`,
 * `contaProdutoShopeeOuterRef`) is one identifier apart and compiles. Read here, it answers `null`
 * for every Loja Integrada link, so both sides of the anchor plan's comparison are `null`, the
 * zero-cost fast path swallows every write and the trigger does nothing, silently.
 *
 * Total and non-throwing over a raw document, because `contaIdFromRef` is.
 *
 * Equal (⇒ `'C1'`): `'documents/integracao/C1'` ≡ `'integracao/C1'` ≡ `'/documents/integracao/C1'`.
 * Distinct: `'documents/integracao/C2'` ⇒ `'C2'`, never `'C1'`; `'documents/integracao/c1'` ⇒
 * `'c1'` (no case fold); another collection's ref, the ref inside an array, and a doc carrying
 * ONLY another channel's conta field ⇒ `null`.
 */
export function contaDoLinkLi(link: Record<string, unknown>): string | null {
  return contaIdFromRef(link.contaLojaIntegrada);
}

/**
 * The anchor's COUNTS predicate (master plan step 12's prerequisite): does this stored link keep
 * its conta in the produto's `integracoesComProduto`?
 *
 * Yes when the link names a store product (`id` is a positive safe integer, as a number or as its
 * canonical decimal text) that is not in the trash (`removido !== true`). Hidden (`ativo:
 * false`) and blocked links COUNT: over-including costs a skipped sweep row, under-including is a
 * silent stock and price outage. `estadoPublicacao` is not read — no decision depends on a stored
 * publication code. The conta is not read either: {@link contaDoLinkLi} reads it from the same
 * document.
 *
 * Total and non-throwing: anything that is not an object counts nothing.
 *
 * Equal (counts): `{ id: 182904918, removido: false }`, the same with `ativo: false`, with
 * `bloqueado: true`, and `{ id: '182904918' }`.
 * Distinct (does not count): `{ removido: true }`, `{ id: null }`, `{ id: 0 }`, `{ id: '07' }`.
 */
export function vinculoLiConta(link: unknown): boolean {
  if (!ehObjeto(link)) return false;
  return (
    inteiroPositivoCanonicoLi(proprio(link, 'id')) !== null && proprio(link, 'removido') !== true
  );
}

/** How a stored link relates to one (conta, store product) — see {@link vinculoLiDaContaEId}. */
export const relacaoVinculoLiSchema = z.enum(['mesmo', 'outro-id', 'outra-conta', 'id-ilegivel']);
export type RelacaoVinculoLi = z.infer<typeof relacaoVinculoLiSchema>;

/** Named members of {@link relacaoVinculoLiSchema} — see `delfrance/prefer-schema-enum`. */
export const RELACAO_VINCULO_LI = {
  mesmo: 'mesmo',
  outroId: 'outro-id',
  outraConta: 'outra-conta',
  idIlegivel: 'id-ilegivel',
} as const satisfies Record<string, RelacaoVinculoLi>;

/**
 * Is this stored link THE link of store product `idLi` under conta `contaId`?
 *
 *  - `outra-conta`: its `contaLojaIntegrada` does not read ({@link contaIdFromRef}, the one conta
 *    ref reader the anchor binding also uses) as `contaId` —
 *    another conta's link, a malformed ref, or not an object at all;
 *  - `id-ilegivel`: this conta's link, but its stored `id` is not a positive safe-integer NUMBER.
 *    A TEXT id (`'182904918'`) lands here, never in `mesmo`: Firestore equality is type-strict,
 *    so a text id is invisible to every field query that finds links (`id == <number>`), and a
 *    link nobody can find must be reported, never adopted or filled;
 *  - `mesmo`: this conta's link, with exactly `idLi`;
 *  - `outro-id`: this conta's link, for another store product.
 *
 * Used for the one-store-product-per-conta scan of a produto's links and for adopting a link doc
 * that already exists at the import's own doc id.
 *
 * Equal (`mesmo`): stored `{ id: 182904918, contaLojaIntegrada: 'documents/integracao/C1' }`
 * against `('C1', 182904918)`; the same with `'integracao/C1'`.
 * Distinct: another id ⇒ `outro-id`; conta `C2` ⇒ `outra-conta`; stored id `'182904918'` (text)
 * ⇒ `id-ilegivel`, never `mesmo`.
 */
export function vinculoLiDaContaEId(
  link: unknown,
  contaId: string,
  idLi: number,
): RelacaoVinculoLi {
  if (!ehObjeto(link)) return RELACAO_VINCULO_LI.outraConta;
  if (contaIdFromRef(proprio(link, 'contaLojaIntegrada')) !== contaId) {
    return RELACAO_VINCULO_LI.outraConta;
  }
  const id = proprio(link, 'id');
  if (typeof id !== 'number' || inteiroPositivoCanonicoLi(id) === null) {
    return RELACAO_VINCULO_LI.idIlegivel;
  }
  return id === idLi ? RELACAO_VINCULO_LI.mesmo : RELACAO_VINCULO_LI.outroId;
}
