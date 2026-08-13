/**
 * `POST /api/marketplace/mercado-livre/sugerir-medidas`
 *
 * Body: `{ tabMediId, rows, columns, measureType? }`.
 *
 * Asks a model to read the measurements off the tabela's own photo and fill the
 * size-chart grid, and returns the answer as **suggestions to stage** — nothing
 * is written. The review modal pre-checks only cells that are currently empty,
 * so a suggestion never silently overwrites a measurement an operator typed.
 *
 * Requires `PERM.integracao.write`: this spends money, and it is the same bit
 * that already gates publishing to Mercado Livre.
 *
 * Modelled line-for-line on `sugerir-atributos/route.ts` — same timeout, same
 * single-flight guard, same error map. Where it differs is noted inline.
 */
import { NextResponse } from 'next/server';
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
import type { MedidaColumnSpec, MedidaRowSpec } from '@delfrance/integrations-mercado-livre';
import {
  CONFIG_IA_ML_MEDIDAS_DOC_ID,
  CONFIG_IA_MODELO_PADRAO,
  PROVEDOR_IA,
} from '@delfrance/schemas';

import { TabelaDeMedidasNotFoundError, suggestMedidas } from '@/lib/ai/suggestMedidas';
import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminBucket, getAdminFirestore } from '@/lib/firebase/admin';
import { isMercadoLivreError, mercadoLivreErrorResponse } from '@/lib/marketplace/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Same bound as attribute suggestion: well past a normal answer, well short of a hang. */
const AI_TIMEOUT_MS = 45_000;

/**
 * Ceilings on the client-described grid.
 *
 * ⚠️ The grid arrives in the request body because `extractColumns` — the parser
 * that turns Mercado Livre's grids ficha técnica into columns — lives in
 * `apps/web` and is the single implementation. Re-deriving it here would mean a
 * second copy free to drift, plus an extra ML round trip on every click.
 *
 * That is safe but not unbounded: a caller can only mislead its OWN suggestion
 * (the applier drops anything outside the columns it was given, and nothing is
 * written), yet an enormous body would still buy an enormous schema and a
 * correspondingly enormous bill. These caps are the cost guard, and
 * `buildMedidasSchema` caps again on its own.
 */
const MAX_ROWS = 75;
const MAX_COLUMNS = 15;
const MAX_LABEL = 200;

const CELL_KINDS = new Set(['text', 'number', 'select', 'multiselect']);

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

  const { tabMediId, rows, columns, measureType } = body as Record<string, unknown>;
  if (typeof tabMediId !== 'string' || tabMediId === '') {
    return NextResponse.json({ error: 'tabMediId é obrigatório.' }, { status: 400 });
  }
  const parsedRows = parseRows(rows);
  if (parsedRows == null) {
    return NextResponse.json({ error: 'rows inválido.' }, { status: 400 });
  }
  const parsedColumns = parseColumns(columns);
  if (parsedColumns == null) {
    return NextResponse.json({ error: 'columns inválido.' }, { status: 400 });
  }
  if (parsedRows.length === 0 || parsedColumns.length === 0) {
    return NextResponse.json(
      { error: 'Monte a grade da guia antes de pedir sugestões.' },
      { status: 422 },
    );
  }

  const db = getAdminFirestore();

  // Read the agent's settings BEFORE claiming the single-flight slot: the kill
  // switch must be able to decline without occupying it, or one disabled-agent
  // click would block the operator's next attempt for no reason.
  const config = await loadConfigIa(db, CONFIG_IA_ML_MEDIDAS_DOC_ID);
  if (!config.ativo) {
    return NextResponse.json(
      {
        error: 'O preenchimento por IA está desativado nas configurações.',
        code: 'AI_DESATIVADA',
      },
      { status: 409 },
    );
  }
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
    // ⚠️ Namespaced key. The two agents share the in-flight map, and an operator
    // filling a size chart must not be locked out by their own pending attribute
    // suggestion on another tab — they are different buttons on different pages.
    return await runSingleFlight(`medidas:${auth.caller.uid}`, async () => {
      const result = await suggestMedidas(
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
              // ⚠️ The FULL-SIZE variant, unlike attribute suggestion. This reads
              // digits off a printed table; 400 px cannot resolve them, so the
              // cheap thumbnail would produce a confident, wrong answer rather
              // than a cheap one. The 400/200 fallbacks are there only for a
              // photo whose full-size derivative has not landed yet.
              { prefer: ['jpeg', '400', '200'] },
            ),
          model: resolveModelo({
            stored: config.modelo,
            env: process.env.MERCADO_LIVRE_AI_MODEL ?? null,
            padrao: CONFIG_IA_MODELO_PADRAO,
            // `modelosParaValidacao`, NOT `.modelos` — the cached result falls
            // back to a shipped list, so validating against it would treat a
            // `models.list` outage as proof that the stored model is retired.
            disponiveis: modelosParaValidacao(await getAiModelosCached(createVertexListModelsFn())),
          }).modelo,
          systemInstruction: config.promptSistema,
          temperature: config.temperatura,
          maxOutputTokens: config.maxOutputTokens,
          signal: AbortSignal.timeout(AI_TIMEOUT_MS),
        },
        {
          tabMediId,
          rows: parsedRows,
          columns: parsedColumns,
          measureType: typeof measureType === 'string' ? measureType : null,
        },
      );
      return NextResponse.json(result);
    });
  } catch (err) {
    if (err instanceof AlreadyRunningError) {
      return NextResponse.json({ error: err.message, code: 'AI_JA_EM_ANDAMENTO' }, { status: 409 });
    }
    if (err instanceof TabelaDeMedidasNotFoundError) {
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

/**
 * Hand-rolled rather than Zod, matching every other route in this app: the shape
 * is shallow, and the guards double as the cost ceiling. Returns `null` for a
 * malformed body (→ 400) and an empty array only when the caller sent one.
 */
function parseRows(raw: unknown): MedidaRowSpec[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_ROWS) return null;
  const out: MedidaRowSpec[] = [];
  for (const item of raw) {
    if (item == null || typeof item !== 'object') return null;
    const { key, size } = item as Record<string, unknown>;
    if (typeof key !== 'string' || key === '' || key.length > MAX_LABEL) return null;
    if (typeof size !== 'string' || size.length > MAX_LABEL) return null;
    out.push({ key, size });
  }
  return out;
}

function parseColumns(raw: unknown): MedidaColumnSpec[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_COLUMNS) return null;
  const out: MedidaColumnSpec[] = [];
  for (const item of raw) {
    if (item == null || typeof item !== 'object') return null;
    const c = item as Record<string, unknown>;
    if (typeof c.attributeId !== 'string' || c.attributeId === '') return null;
    if (c.attributeId.length > MAX_LABEL) return null;
    if (typeof c.label !== 'string' || c.label.length > MAX_LABEL) return null;
    if (typeof c.kind !== 'string' || !CELL_KINDS.has(c.kind)) return null;
    const values = parseValues(c.values);
    if (values == null) return null;
    out.push({
      attributeId: c.attributeId,
      label: c.label,
      kind: c.kind as MedidaColumnSpec['kind'],
      values,
      unitId: typeof c.unitId === 'string' && c.unitId !== '' ? c.unitId : null,
      required: c.required === true,
    });
  }
  return out;
}

/**
 * ⚠️ Capped independently of the column count. A closed list is inlined into the
 * schema as an `enum` **per row**, so N values across M columns and R rows is
 * what actually reaches the model — the one place where a modest-looking body
 * multiplies into a large one.
 */
const MAX_VALUES_PER_COLUMN = 200;

function parseValues(raw: unknown): MedidaColumnSpec['values'] | null {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_VALUES_PER_COLUMN) return null;
  const out: MedidaColumnSpec['values'] = [];
  for (const item of raw) {
    if (item == null || typeof item !== 'object') return null;
    const { id, name } = item as Record<string, unknown>;
    if (typeof id !== 'string' || typeof name !== 'string') return null;
    if (name.length > MAX_LABEL) return null;
    out.push({ id, name });
  }
  return out;
}
