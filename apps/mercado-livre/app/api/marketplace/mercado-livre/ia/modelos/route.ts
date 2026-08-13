/**
 * `GET /api/marketplace/mercado-livre/ia/modelos`
 *
 * The models the AI settings page may offer, plus the agent's currently
 * effective settings — so the page can render a populated Select and show what a
 * suggestion would actually use right now, including the resolution the operator
 * cannot see (config doc → env → shipped default) and whether a stored model has
 * been substituted because the provider no longer serves it.
 *
 * Read-only and cached. Requires `PERM.integracao.read` — the same bit that gates
 * reading a channel's connection status, and the read half of the pair that
 * gates saving this document.
 *
 * ⚠️ This route must never fail because the provider is unreachable. The model
 * list is a convenience; the page's job is to let someone fix a broken setting,
 * which is exactly when the provider is most likely to be the broken thing. The
 * fallback lives in `getAiModelosCached`.
 */
import { NextResponse } from 'next/server';
import { DEFAULT_ATTRIBUTE_SYSTEM_INSTRUCTION } from '@delfrance/integrations-mercado-livre';
import { CONFIG_IA_MODELO_PADRAO } from '@delfrance/schemas';

import { loadConfigIa } from '@/lib/ai/configIa';
import { getAiModelosCached, modelosParaValidacao } from '@/lib/ai/modelosCache';
import { resolveModelo } from '@/lib/ai/models';
import { createVertexListModelsFn } from '@/lib/ai/provider';
import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.read);
  if ('error' in auth) return auth.error;

  const [lista, config] = await Promise.all([
    getAiModelosCached(createVertexListModelsFn()),
    loadConfigIa(getAdminFirestore()),
  ]);

  const envModelo = process.env.MERCADO_LIVRE_AI_MODEL ?? null;
  const resolvido = resolveModelo({
    stored: config.modelo,
    env: envModelo,
    padrao: CONFIG_IA_MODELO_PADRAO,
    // ⚠️ Validated against the LIVE list only. The fallback list is fine to
    // offer in the Select, but using it here would report a perfectly good
    // stored model as `substituido` purely because the list call failed — and
    // the page would tell the operator to fix a setting that is not broken.
    disponiveis: modelosParaValidacao(lista),
  });

  return NextResponse.json({
    modelos: lista.modelos,
    fonte: lista.fonte,
    ...(lista.erro != null ? { erro: lista.erro } : {}),
    /**
     * The shipped system instruction, verbatim, so the settings page can SHOW
     * what runs when the field is left empty — an instruction you cannot read is
     * one you cannot decide to change.
     *
     * ⚠️ It travels over the wire rather than being imported by `apps/web`
     * because this package's root is **server-side only** (its OAuth core holds
     * the app clientSecret and must never reach a browser bundle). Copying the
     * text into `apps/web` would be the other way to show it, and the copy would
     * drift from the one the model is actually given.
     */
    promptPadrao: DEFAULT_ATTRIBUTE_SYSTEM_INSTRUCTION,
    /**
     * What a call would use, and why. `origem` is the honest answer to "the page
     * shows model X, is that what runs?" — an env var set on the backend
     * overrides nothing the operator can see, so the page has to be able to say
     * that out loud.
     */
    efetivo: {
      modelo: resolvido.modelo,
      substituido: resolvido.substituido,
      origem: origemDe(config.modelo, envModelo),
      padrao: CONFIG_IA_MODELO_PADRAO,
    },
  });
}

/**
 * ⚠️ Mirrors `resolveModelo`'s precedence and must stay in step with it. It is
 * separate because `resolveModelo` answers *which* model and this answers *why*,
 * and folding the label into the resolver would put a UI string in the middle of
 * the call path.
 */
function origemDe(stored: string | null, env: string | null): 'config' | 'env' | 'padrao' {
  if (typeof stored === 'string' && stored.trim() !== '') return 'config';
  if (typeof env === 'string' && env.trim() !== '') return 'env';
  return 'padrao';
}
