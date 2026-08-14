/**
 * `POST /api/marketplace/mercado-livre/sugerir-atributos`
 *
 * Body: `{ integracaoId, produtoId, categoryId }`.
 *
 * Asks a model to fill the ML category attributes for a produto, and returns the
 * answer as **suggestions to stage** — nothing is written. #799's criterion is
 * that a suggestion is offered rather than applied, and the review modal in the
 * UI pre-checks only attributes that are currently empty.
 *
 * Requires `PERM.integracao.write`: this spends money and it is the same bit
 * that already gates publishing.
 *
 * Two things here exist nowhere else in this app — see `AI_TIMEOUT_MS` and
 * `runSingleFlight` below.
 */
import { NextResponse } from 'next/server';
import { createMercadoLivreApi } from '@delfrance/integrations-mercado-livre';
import {
  CONFIG_IA_ML_ATRIBUTOS_DOC_ID,
  CONFIG_IA_MODELO_PADRAO,
  PROVEDOR_IA,
} from '@delfrance/schemas';

import { AlreadyRunningError, resolveModelo, runSingleFlight } from '@delfrance/ai';
import {
  AiNotConfiguredError,
  AiUnparseableAnswerError,
  createVertexGenerateFn,
  createVertexListModelsFn,
  getAiModelosCached,
  loadConfigIa,
  loadFotoImage,
  modelosParaValidacao,
} from '@delfrance/ai/admin';

import { ProdutoNotFoundError, suggestAttributes } from '@/lib/ai/suggestAttributes';
import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminBucket, getAdminFirestore } from '@/lib/firebase/admin';
import { isLeafCategory, projectCategoriaAtributos } from '@/lib/marketplace/categoriaAtributos';
import { loadMercadoLivreContext } from '@/lib/marketplace/mercadoLivre';
import { getCategoriaAtributosCached, getCategoriaCached } from '@/lib/marketplace/mlMetadataCache';
import { isMercadoLivreError, mercadoLivreErrorResponse } from '@/lib/marketplace/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * No other route in this app sets a timeout, and the ML HTTP client has none
 * either — an ML REST call is fast and bounded. A model call is neither: it can
 * sit for minutes on a bad day, holding a container slot the whole time. 45 s is
 * well past a normal Flash-Lite answer and well short of a hung request.
 */
const AI_TIMEOUT_MS = 45_000;

/**
 * ⚠️ The shipped default now lives in `packages/schemas` as
 * {@link CONFIG_IA_MODELO_PADRAO}, because the settings page and this route must
 * agree on the last link of the chain. Resolution order:
 * **`configIa` doc → `MERCADO_LIVRE_AI_MODEL` → that constant**, then
 * re-validated against the live model list so a stored model the provider has
 * retired cannot 500 this route.
 */

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return auth.error;

  let body: unknown;
  try {
    body = await req.json();
  } catch (err) {
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: 'Corpo inválido: JSON esperado.' }, { status: 400 });
    }
    throw err;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Corpo inválido: objeto esperado.' }, { status: 400 });
  }
  const { integracaoId, produtoId, categoryId } = body as Record<string, unknown>;
  if (typeof integracaoId !== 'string' || integracaoId === '') {
    return NextResponse.json({ error: 'integracaoId é obrigatório.' }, { status: 400 });
  }
  if (typeof produtoId !== 'string' || produtoId === '') {
    return NextResponse.json({ error: 'produtoId é obrigatório.' }, { status: 400 });
  }
  if (typeof categoryId !== 'string' || categoryId === '') {
    return NextResponse.json({ error: 'categoryId é obrigatório.' }, { status: 400 });
  }

  const db = getAdminFirestore();

  // Read the agent's settings BEFORE claiming the single-flight slot: the kill
  // switch must be able to decline without occupying it, or one disabled-agent
  // click would block the operator's next attempt for no reason.
  const config = await loadConfigIa(db, CONFIG_IA_ML_ATRIBUTOS_DOC_ID);
  if (!config.ativo) {
    return NextResponse.json(
      {
        error: 'A sugestão por IA está desativada nas configurações.',
        code: 'AI_DESATIVADA',
      },
      { status: 409 },
    );
  }
  // ⚠️ Only Vertex is wired — `createVertexGenerateFn()` below runs
  // unconditionally. Without this check `provedor` was a WRITE-ONLY field: an
  // operator could select "Google AI", save, get a green confirmation, and every
  // suggestion would still run on Vertex with nothing anywhere saying so.
  // Declining turns a silent no-op into a diagnosable one, and gives a future
  // second provider a place that fails loudly until it is actually wired.
  if (config.provedor !== PROVEDOR_IA.vertex) {
    return NextResponse.json(
      {
        error: `O provedor "${config.provedor}" ainda não está implementado. Selecione Vertex AI nas configurações de IA.`,
        code: 'AI_PROVEDOR_NAO_SUPORTADO',
      },
      { status: 409 },
    );
  }

  try {
    return await runSingleFlight(auth.caller.uid, async () => {
      const ctx = await loadMercadoLivreContext(db, integracaoId);
      const channelCtx = await ctx.resolveChannelContext();
      const api = createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });

      const result = await suggestAttributes(
        {
          db,
          generate: createVertexGenerateFn(),
          loadImage: (fotos) =>
            loadFotoImage(
              {
                db,
                download: async (path) => {
                  const [buf] = await getAdminBucket().file(path).download();
                  return new Uint8Array(buf);
                },
              },
              fotos,
            ),
          loadAtributos: async (id) => {
            // Same cached reads the attributes route uses, so opening the
            // editor and then asking for a suggestion costs one fetch, not two.
            const node = await getCategoriaCached(api, id);
            if (!isLeafCategory(node.children_categories)) return { leaf: false, atributos: [] };
            const attrs = await getCategoriaAtributosCached(api, id);
            return { leaf: true, atributos: projectCategoriaAtributos(attrs, 'item').atributos };
          },
          model: resolveModelo({
            stored: config.modelo,
            env: process.env.MERCADO_LIVRE_AI_MODEL ?? null,
            padrao: CONFIG_IA_MODELO_PADRAO,
            // ⚠️ `modelosParaValidacao`, NOT `.modelos`. The cached result is
            // never empty (it falls back to the shipped list), so validating
            // against it would treat a `models.list` outage as proof that the
            // stored model is retired — and silently swap it.
            disponiveis: modelosParaValidacao(await getAiModelosCached(createVertexListModelsFn())),
          }).modelo,
          systemInstruction: config.promptSistema,
          temperature: config.temperatura,
          maxOutputTokens: config.maxOutputTokens,
          signal: AbortSignal.timeout(AI_TIMEOUT_MS),
        },
        { produtoId, categoryId },
      );

      if (!result.leaf) {
        return NextResponse.json(
          { error: 'Escolha uma categoria final do Mercado Livre antes de pedir sugestões.' },
          { status: 422 },
        );
      }
      return NextResponse.json(result);
    });
  } catch (err) {
    if (err instanceof AlreadyRunningError) {
      return NextResponse.json({ error: err.message, code: 'AI_JA_EM_ANDAMENTO' }, { status: 409 });
    }
    if (err instanceof ProdutoNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof AiNotConfiguredError) {
      return NextResponse.json({ error: err.message, code: 'AI_NAO_CONFIGURADA' }, { status: 500 });
    }
    if (err instanceof AiUnparseableAnswerError) {
      return NextResponse.json(
        { error: err.message, code: 'AI_RESPOSTA_INVALIDA' },
        { status: 502 },
      );
    }
    // An aborted call is the timeout above, not a bug.
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      return NextResponse.json(
        { error: 'A sugestão demorou demais e foi cancelada.', code: 'AI_TIMEOUT' },
        { status: 504 },
      );
    }
    if (isMercadoLivreError(err)) return mercadoLivreErrorResponse(err);
    throw err;
  }
}
