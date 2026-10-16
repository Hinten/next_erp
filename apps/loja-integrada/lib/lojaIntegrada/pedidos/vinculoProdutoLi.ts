/**
 * Produto resolution for ONE Loja Integrada order line (master plan step 5, PR
 * 5-c): the link-doc lookup, the OWNER read and its hop, and the cascade that
 * ends on the shared SKU rungs. Reads only — and one Loja Integrada GET, the
 * `id_externo` fallback, through the context's paced client.
 *
 * ## The cascade, narrowest first
 *
 * The line's reference form comes from `itensMapeamento.ts` (`formaDoProdutoLi`):
 *
 *  1. **`id-li`** (a resource URI with no query) — the Loja Integrada produto id
 *     ⇒ the link docs ({@link vinculoDoProdutoLi}). One owner binds, after the
 *     hop below; more than one owner is AMBIGUOUS and ends the cascade unbound.
 *  2. **`produto_pai`** — the parent's Loja Integrada id ⇒ the same lookup. Its
 *     owner is the ERP PARENT, handed to the SKU rungs as `paiId` and never
 *     bound, so a variation line can never bind a parent that owns no stock.
 *  3. **The SKU rungs** — `resolverProdutoPorSku` in `@delfrance/data/admin/produtos`,
 *     the stage every channel ends on. Its three guards (the kit guard, the
 *     família-de-um hop, the `limit(2)` ambiguity detector) exist exactly once:
 *     do NOT re-implement any of them here.
 *  4. **`id-externo`** (the URI with `?id_externo=1`), only after the SKU missed
 *     ⇒ `buscarProdutoPorIdExternoLi` ⇒ the Loja Integrada id it answers ⇒ (1).
 *     Around THAT GET only, a 404 (`LiNotFoundError`) or a body that does not
 *     parse (`LiSchemaError`) makes the LINE unmatched — uncaught, the
 *     classifier would park the whole order. Every other error rethrows (a 401
 *     parks the conta, a 429 or a 5xx retries). The id handed to the GET is
 *     always a canonical positive integer (`formaDoProdutoLi` reads `''` and any
 *     other text as NEITHER form), so the package's own path guard never fires
 *     here.
 *
 * A miss is not a failure: the line keeps `produtoUid: null` under `'NONE'` —
 * inert for stock — and the importer records an incidente.
 *
 * ## The owner and its hop
 *
 * A link doc sits under the produto it describes, so its owner is
 * `ref.parent.parent.id`. That owner is read ONCE by id and hopped by
 * `unidadeVendavelDaRaiz` — the SKU rungs' own rule, shared and never copied
 * (the Shopee kit component resolution does the same): a KIT stays on itself, a
 * família-de-um wrapper answers its sole member (the produto that owns the
 * stock), anything else answers itself. `paiId` IS projected — this read is by
 * id, not through a `paiId == null` query — so a child owner answers itself
 * whatever stale `filhoUnicoId` it carries. An owner that no longer exists (a
 * link left behind by a produto delete) is NO hit: binding a produto that is
 * gone would move stock nowhere.
 *
 * ## The query
 *
 * Link docs are read with every stored form of the conta reference
 * (`contaRefForms`: `documents/integracao/<id>` and the bare `integracao/<id>`):
 * `produtolojaintegrada where contaLojaIntegrada in [both] and id == <number>`,
 * served by the collection-group index {@link CAMPOS_INDICE_VINCULO_LI} names
 * (`vinculoProdutoLi.test.ts` pins it against `firestore.indexes.json`). On
 * Firestore Enterprise an undeclared composite silently full-scans and bills the
 * data scanned. `id` is a NUMBER on the link doc: its text matches nothing.
 *
 * Owners are told apart, not hits: two link docs under ONE produto (one per
 * stored ref form, say) are one owner, never an ambiguity.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  produtoCollection,
  produtoLojaIntegradaLinkCollection,
} from '@delfrance/data/admin/collections';
import {
  contaRefForms,
  resolverProdutoPorSku,
  unidadeVendavelDaRaiz,
  type SkuMatchKind,
  type SkuMissKind,
} from '@delfrance/data/admin/produtos';
import {
  LiNotFoundError,
  LiSchemaError,
  buscarProdutoPorIdExternoLi,
  type LiLeituraClient,
} from '@delfrance/integrations-loja-integrada';

import type { ReferenciaDeProdutoLi } from './itensMapeamento';

/**
 * The collection-group index the link lookup needs, in the order its filters
 * are declared — the SAME constant the `.where()` calls below are built from.
 */
export const CAMPOS_INDICE_VINCULO_LI = ['contaLojaIntegrada', 'id'] as const;

/** The collection-group id of the link docs. */
export const GRUPO_VINCULO_LI = 'produtolojaintegrada';

/**
 * Link docs read per lookup. Owners are told apart within this page; more
 * owners than fit cannot exist in practice (a Loja Integrada id names one
 * listing), and two already make the lookup ambiguous.
 */
export const LIMITE_VINCULOS_LI = 5;

/** What the link docs say about one Loja Integrada produto id. */
export type VinculoLi =
  | { readonly tipo: 'nenhum' }
  | { readonly tipo: 'um'; readonly donoId: string }
  | { readonly tipo: 'ambiguo'; readonly donoIds: readonly string[] };

/** The owners of the link docs naming `idLi` for this conta (module header, "The query"). */
export async function vinculoDoProdutoLi(
  db: Firestore,
  integracaoId: string,
  idLi: string,
): Promise<VinculoLi> {
  const [campoConta, campoId] = CAMPOS_INDICE_VINCULO_LI;
  const snap = await produtoLojaIntegradaLinkCollection
    .groupQuery(db)
    .where(campoConta, 'in', contaRefForms(integracaoId))
    .where(campoId, '==', Number(idLi))
    .limit(LIMITE_VINCULOS_LI)
    .get();
  const donos = [
    ...new Set(
      snap.docs
        .map((d) => d.ref.parent.parent?.id)
        .filter((id): id is string => typeof id === 'string' && id !== ''),
    ),
  ].sort();
  if (donos.length === 0) return { tipo: 'nenhum' };
  if (donos.length === 1) return { tipo: 'um', donoId: donos[0]! };
  return { tipo: 'ambiguo', donoIds: donos };
}

/**
 * The SELLABLE UNIT a link's owner stands for — read once by id and hopped
 * (module header, "The owner and its hop") — or `null` when the owner is gone.
 */
export async function unidadeVendavelDoDonoLi(
  db: Firestore,
  donoId: string,
): Promise<string | null> {
  const snap = await produtoCollection.docRef(db, {}, donoId).get();
  if (!snap.exists) return null;
  const raw = (snap.data() ?? {}) as Record<string, unknown>;
  return unidadeVendavelDaRaiz({
    ehKit: raw.ehKit === true,
    produtoId: donoId,
    familia: {
      id: donoId,
      paiId: raw.paiId as string | null | undefined,
      filhoUnicoId: raw.filhoUnicoId as string | null | undefined,
    },
  });
}

/** How a bound line was bound. */
export type ViaProdutoLi =
  /** The line's own Loja Integrada id, through the link docs. */
  | 'vinculo-li'
  /** The `id_externo` GET's answer, through the link docs. */
  | 'vinculo-id-externo'
  | SkuMatchKind;

/** Why a line was left unbound — the incidente's message picks its text by it. */
export type FalhaProdutoLi =
  /** The link docs name more than one produto. */
  | 'vinculo-ambiguo'
  /** The `id_externo` GET answered 404. */
  | 'id-externo-inexistente'
  /** The `id_externo` GET answered a body that does not parse. */
  | 'id-externo-ilegivel'
  | SkuMissKind;

export type ResolucaoProdutoLi =
  | { readonly produtoId: string; readonly via: ViaProdutoLi; readonly idLi: string | null }
  | { readonly produtoId: null; readonly via: FalhaProdutoLi; readonly idLi: string | null };

/** The `id_externo` GET's answer: the Loja Integrada id, or why the line stays unbound. */
type IdDoExternoLi =
  | { readonly ok: true; readonly idLi: string }
  | { readonly ok: false; readonly via: 'id-externo-inexistente' | 'id-externo-ilegivel' };

export interface ResolvedorDeLinhasLi {
  /** One line, through the cascade (module header). */
  resolver(referencia: ReferenciaDeProdutoLi): Promise<ResolucaoProdutoLi>;
}

/**
 * A resolver for ONE order: the link lookups, the owner reads and the
 * `id_externo` GETs are memoised by id, so a parent shared by several lines,
 * or one listing sold twice, costs one read (and one paced call) per order.
 * Sequential by design — the importer resolves the lines in order.
 */
export function criarResolvedorDeLinhasLi(
  db: Firestore,
  integracaoId: string,
  cliente: LiLeituraClient,
): ResolvedorDeLinhasLi {
  const vinculos = new Map<string, Promise<VinculoLi>>();
  const unidades = new Map<string, Promise<string | null>>();
  const externos = new Map<string, Promise<IdDoExternoLi>>();

  const vinculo = (idLi: string): Promise<VinculoLi> => {
    let p = vinculos.get(idLi);
    if (p === undefined) {
      p = vinculoDoProdutoLi(db, integracaoId, idLi);
      vinculos.set(idLi, p);
    }
    return p;
  };
  const unidade = (donoId: string): Promise<string | null> => {
    let p = unidades.get(donoId);
    if (p === undefined) {
      p = unidadeVendavelDoDonoLi(db, donoId);
      unidades.set(donoId, p);
    }
    return p;
  };
  /** The Loja Integrada id an external id names, or why the line stays unbound. */
  const idDoExterno = (idExterno: string): Promise<IdDoExternoLi> => {
    let p = externos.get(idExterno);
    if (p === undefined) {
      p = (async (): Promise<IdDoExternoLi> => {
        try {
          const r = await buscarProdutoPorIdExternoLi(cliente, idExterno);
          return { ok: true, idLi: String(r.dados.id) };
        } catch (err) {
          // ONLY around this GET (module header): the line, never the order.
          if (err instanceof LiNotFoundError) return { ok: false, via: 'id-externo-inexistente' };
          if (err instanceof LiSchemaError) return { ok: false, via: 'id-externo-ilegivel' };
          throw err;
        }
      })();
      externos.set(idExterno, p);
    }
    return p;
  };

  /** Bind through the link docs: the hopped owner, an ambiguity, or nothing. */
  const pelosVinculos = async (
    idLi: string,
    via: ViaProdutoLi,
  ): Promise<ResolucaoProdutoLi | null> => {
    const v = await vinculo(idLi);
    if (v.tipo === 'ambiguo') return { produtoId: null, via: 'vinculo-ambiguo', idLi };
    if (v.tipo === 'nenhum') return null;
    const produtoId = await unidade(v.donoId);
    return produtoId === null ? null : { produtoId, via, idLi };
  };

  return {
    async resolver(referencia) {
      const { forma } = referencia;
      // (1) The line's own Loja Integrada id.
      if (forma.forma === 'id-li') {
        const r = await pelosVinculos(forma.idLi, 'vinculo-li');
        if (r !== null) return r;
      }
      const idLiDaLinha = forma.forma === 'id-li' ? forma.idLi : null;

      // (2) The parent: `paiId` for the scoped SKU rung, never a bind.
      let paiId: string | null = null;
      if (referencia.idLiPai !== null) {
        const v = await vinculo(referencia.idLiPai);
        if (v.tipo === 'um') paiId = v.donoId;
      }

      // (3) The SKU rungs — the shared stage, never a copy of it.
      const porSku = await resolverProdutoPorSku(db, {
        sku: referencia.sku,
        paiId,
        canal: 'loja-integrada',
        contexto: { integracaoId, linha: referencia.ensureUniqueId },
      });
      if (porSku.produtoId !== null) {
        return { produtoId: porSku.produtoId, via: porSku.via, idLi: idLiDaLinha };
      }
      if (forma.forma !== 'id-externo' || porSku.via === 'ambiguous-sku') {
        return { produtoId: null, via: porSku.via, idLi: idLiDaLinha };
      }

      // (4) The external id, after the SKU missed: the GET, then (1).
      const externo = await idDoExterno(forma.idExterno);
      if (!externo.ok) return { produtoId: null, via: externo.via, idLi: null };
      const r = await pelosVinculos(externo.idLi, 'vinculo-id-externo');
      return r ?? { produtoId: null, via: porSku.via, idLi: externo.idLi };
    },
  };
}
