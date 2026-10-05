/**
 * `POST /api/marketplace/shopee/importar` — import ONE Shopee listing into the
 * ERP catalogue. Body: `{ integracaoId, itemId, options? }`. Requires
 * `PERM.integracao.write`.
 *
 * It pays for the wire reads (`lerAnuncioShopee`: base info, then models OR the
 * kit detail) and hands the resulting `ItemLido` to the per-item importer — the
 * identical record the mass-import job builds, so this route and the job cannot
 * import the same listing two different ways.
 *
 * ## ⚠️ The two memos are the caller's job
 *
 * `ImportarAnuncioDeps` carries no Shopee client: every wire read was already
 * paid for here. The one read the importer still needs is the CATEGORY TREE,
 * and it reaches it through a memo the caller hands in. Passing no `categorias`
 * is not a failure — the categoria leg is skipped with one log line — which is
 * exactly why it must be passed explicitly rather than left to a default: a
 * silently uncategorised produto looks like a correct import. `grupos` is the
 * same shape for the `grupoDeVariacoes` scan; for a single item the module
 * would happily build its own, and it is handed in anyway so the route, the
 * script and the job assemble deps the same way.
 *
 * ## Outcomes
 *
 * 200 with the importer's result · 400 for a bad body (a stringified `itemId`
 * included) · 422 `SHOPEE_IMPORT_BLOCKED` with `motivo` for a listing the
 * importer refuses before writing anything · otherwise `shopeeErrorResponse`
 * (404 conta, 409 reauth / sem shop id, 502 schema/http, 503 rede).
 */
import { NextResponse } from 'next/server';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore, tryGetAdminBucket } from '@/lib/firebase/admin';
import { isShopeeError, shopeeErrorResponse } from '@/lib/shopee/core/respond';
import { loadShopeeContext } from '@/lib/shopee/core/shopee';
import { criarMemoDeCategorias } from '@/lib/shopee/produtos/categoriaShopee';
import {
  corpoDeErro,
  lerCorpoImportar,
  lerJsonDoCorpo,
} from '@/lib/shopee/produtos/corpoImportacao';
import { importarAnuncioShopee } from '@/lib/shopee/produtos/importarAnuncio';
import { ehKitDe, type ImportarAnuncioDeps } from '@/lib/shopee/produtos/itemLido';
import { importarKitShopee } from '@/lib/shopee/produtos/kitShopee';
import { lerAnuncioShopee } from '@/lib/shopee/produtos/lerAnuncio';
import { criarMemoDeGrupos } from '@/lib/shopee/produtos/taxonomiaShopee';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return auth.error;

  const json = await lerJsonDoCorpo(req);
  if (!json.ok) return NextResponse.json(corpoDeErro(json), { status: 400 });
  const corpo = lerCorpoImportar(json.valor);
  if (!corpo.ok) return NextResponse.json(corpoDeErro(corpo), { status: 400 });
  const { integracaoId, itemId, options } = corpo.valor;

  // ⚠️ ONE clock read for the whole request, handed DOWN. Every module under
  // `produtos/` takes the instant as a parameter, so two documents written by
  // one import can never disagree about when it happened.
  const nowMs = Date.now();

  try {
    const db = getAdminFirestore();
    const ctx = await loadShopeeContext(db, integracaoId);
    const client = ctx.createShopClient();

    const entrada = await lerAnuncioShopee(client, itemId);

    // An unresolvable bucket NAME degrades to "skip photos", never to a failed
    // import — `tryGetAdminBucket` is a null-return, so a genuine Storage
    // failure still propagates.
    const bucket = tryGetAdminBucket();
    const deps: ImportarAnuncioDeps = {
      db,
      integracaoId: ctx.integracaoId,
      tabelaNormalOuterRef: ctx.conta.tabelaNormalOuterRef,
      // Carried and deliberately never written — the import prices to the NORMAL
      // table only (#803's stance).
      tabelaPromocionalOuterRef: ctx.conta.tabelaPromocionalOuterRef,
      depositoOuterRef: ctx.conta.depositoOuterRef,
      ...(bucket !== null ? { bucket } : {}),
      options,
      nowMs,
      grupos: criarMemoDeGrupos(db),
      categorias: criarMemoDeCategorias(client, ctx.integracaoId),
    };

    const res = ehKitDe(entrada.base)
      ? await importarKitShopee(deps, entrada)
      : await importarAnuncioShopee(deps, entrada);

    // Built by NAME: the result type is ours, and echoing it whole is how a
    // field added for the job's bookkeeping would start leaving through an HTTP
    // body nobody reviewed.
    return NextResponse.json({
      produtoId: res.produtoId,
      criado: res.criado,
      nome: res.nome,
      variacoes: res.variacoes,
      fotos: res.fotos,
      ...(res.kit !== undefined ? { kit: res.kit } : {}),
    });
  } catch (err) {
    // ⚠️ A `ShopeeImportBlockedError` reaches this arm and comes back 422 with
    // its `motivo`: `respond.ts` holds that mapping immediately above the base
    // `ShopeeError` arm, and re-mapping it here would be a second copy of a
    // decision that already has one home.
    if (isShopeeError(err)) return shopeeErrorResponse(err);
    throw err;
  }
}
