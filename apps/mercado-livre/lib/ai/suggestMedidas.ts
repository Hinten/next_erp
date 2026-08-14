/**
 * Orchestration for "Preencher com IA" on a size chart: a tabela de medidas plus
 * the grid the operator is looking at in, a list of staged cell suggestions out.
 *
 * Every piece of judgement lives elsewhere and is already unit-tested —
 * `buildMedidasSchema` decides what the model may answer, `buildMedidasPrompt`
 * what it is told, `applyAiMedidas` what survives. This file only sequences
 * them, which is why it is short and why its tests are about sequencing: that an
 * empty grid never reaches the model, that a missing photo is not an error, that
 * the answer is never trusted.
 *
 * **Nothing here writes to Firestore.** Suggestions are staged in a review modal
 * and applied cell by cell by the operator.
 */
import type { Firestore } from 'firebase-admin/firestore';
import type { AiInlineImage } from '@delfrance/ai';
import { tabelaDeMedidasCollection } from '@delfrance/data/admin/collections';
import {
  applyAiMedidas,
  buildMedidasPrompt,
  buildMedidasSchema,
  pickMedidaReference,
  type MedidaReferenceChart,
  type AiMedidaSuggestion,
  type MedidaColumnSpec,
  type MedidaRowSpec,
} from '@delfrance/integrations-mercado-livre';
import type { Foto, TabelaDeMedidas } from '@delfrance/schemas';

import type { GenerateFn } from '@delfrance/ai/admin';

export interface SuggestMedidasDeps {
  db: Firestore;
  generate: GenerateFn;
  /** Resolves the tabela's photos to inline bytes; empty when none can be read. */
  loadImages: (fotos: readonly Foto[] | null | undefined) => Promise<AiInlineImage[]>;
  model: string;
  systemInstruction?: string | null;
  temperature?: number | null;
  maxOutputTokens?: number | null;
  signal?: AbortSignal;
}

/**
 * The tabela's own fields, as the CALLER sees them.
 *
 * ⚠️ Optional, and the stored document is the fallback for each one
 * individually. The editor sits inside an `ObjectView` form, so what the
 * operator has typed is not on the document yet — reading only the stored copy
 * is what made a freshly typed descrição, and a freshly uploaded photo, invisible
 * to the model.
 */
export interface SuggestMedidasFacts {
  nome?: string | null;
  codigo?: string | null;
  descricao?: string | null;
  fotos?: readonly Foto[] | null;
}

export interface SuggestMedidasArgs {
  tabMediId: string;
  rows: MedidaRowSpec[];
  columns: MedidaColumnSpec[];
  measureType?: string | null;
  mainAttributeId?: string | null;
  /** The chart being edited — never offered back to the model as reference. */
  chartId?: string | null;
  facts?: SuggestMedidasFacts;
}

/**
 * What actually reached the model.
 *
 * ⚠️ Reported per source rather than as one `comFoto` flag, because the operator
 * needs to tell "the model had nothing to read" apart from "the model read it
 * and could not do it". A silent text-only run is what made a working feature
 * look broken.
 */
export interface SuggestMedidasContexto {
  /** How many photos actually reached the model, bytes and all. */
  fotos: number;
  /**
   * How many photos the tabela HAS.
   *
   * ⚠️ Separate from `fotos` on purpose, and the gap between them is the whole
   * point: `anexadas > 0` with `fotos === 0` means the photo exists but no
   * readable copy of it does yet, which is a totally different instruction to
   * the operator than "send a photo". Telling them to upload one they can see
   * on screen is what made a working feature look broken.
   */
  anexadas: number;
  descricao: boolean;
  codigo: boolean;
  /** Whether an already-filled chart from another conta was sent. */
  referencia: boolean;
}

export interface SuggestMedidasResult {
  sugestoes: AiMedidaSuggestion[];
  /** How many cells were offered to the model — rows × columns after capping. */
  celulas: number;
  contexto: SuggestMedidasContexto;
  /** True when a cap or a duplicate size label dropped part of the grid. */
  truncado: boolean;
}

/** The caller's value when it has one, else the stored one, else null. */
function firstNonBlank(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

/**
 * The one already-filled chart offered as reference, from ANY conta on this
 * tabela except the chart being edited.
 *
 * ⚠️ Read from the stored document, never from the request body — unlike the
 * facts above. These are written only by the sync path and are excluded from the
 * form (`MEDIDA_EXCLUDED_FIELDS`), so there is no unsaved copy to miss, and
 * accepting a caller-supplied one would let the body dictate measurements the
 * model then repeats back as if a human had typed them.
 */
function pickReferencia(tabela: TabelaDeMedidas, args: SuggestMedidasArgs) {
  const mapa = tabela.tabelasDeMedidasMercadoLivre;
  if (mapa == null) return null;

  const charts: MedidaReferenceChart[] = [];
  for (const conta of Object.values(mapa)) {
    const tabelas = (conta as { tabelas?: unknown })?.tabelas;
    if (Array.isArray(tabelas)) charts.push(...(tabelas as MedidaReferenceChart[]));
  }
  return pickMedidaReference(charts, args.mainAttributeId ?? 'SIZE', {
    excludeChartId: args.chartId ?? null,
  });
}

/** Thrown when the tabela does not exist — a 404, not a model failure. */
export class TabelaDeMedidasNotFoundError extends Error {
  constructor(readonly tabMediId: string) {
    super('Tabela de medidas não encontrada.');
    this.name = 'TabelaDeMedidasNotFoundError';
  }
}

export async function suggestMedidas(
  deps: SuggestMedidasDeps,
  args: SuggestMedidasArgs,
): Promise<SuggestMedidasResult> {
  const snap = await tabelaDeMedidasCollection.docRef(deps.db, {}, args.tabMediId).get();
  if (!snap.exists) throw new TabelaDeMedidasNotFoundError(args.tabMediId);
  const tabela = tabelaDeMedidasCollection.parseRead(
    snap.data(),
    tabelaDeMedidasCollection.docPath({}, args.tabMediId),
  ) as TabelaDeMedidas;

  const built = buildMedidasSchema(args.rows, args.columns);
  const vazio: SuggestMedidasContexto = {
    fotos: 0,
    anexadas: 0,
    descricao: false,
    codigo: false,
    referencia: false,
  };
  // An empty grid buys an empty schema — short-circuit BEFORE spending a model
  // call, the same way a mid-tree category does for attribute suggestion.
  if (built.rows.length === 0 || built.columns.length === 0) {
    return { sugestoes: [], celulas: 0, contexto: vazio, truncado: built.truncated };
  }

  // ⚠️ Each fact falls back to the stored document INDIVIDUALLY. The caller is
  // the editor, which sits inside an ObjectView form, so a value the operator
  // typed or a photo they just uploaded is not on the document yet — and reading
  // only the stored copy is what made both invisible to the model.
  const facts = args.facts ?? {};
  const nome = firstNonBlank(facts.nome, tabela.nome) ?? '';
  const codigo = firstNonBlank(facts.codigo, tabela.codigo);
  const descricao = firstNonBlank(facts.descricao, tabela.descricao);
  const fotos = facts.fotos ?? tabela.fotos;

  const images = await deps.loadImages(fotos);
  const referencia = pickReferencia(tabela, args);

  const request = buildMedidasPrompt({
    tabelaNome: nome,
    codigo,
    descricao,
    ...(args.measureType != null ? { measureType: args.measureType } : {}),
    built,
    images,
    referencia,
    systemInstruction: deps.systemInstruction ?? null,
  });

  const answer = await deps.generate({
    model: deps.model,
    request,
    temperature: deps.temperature ?? null,
    maxOutputTokens: deps.maxOutputTokens ?? null,
    ...(deps.signal ? { signal: deps.signal } : {}),
  });

  return {
    // The model answer is untrusted input; this is the only thing that reads it.
    sugestoes: applyAiMedidas(built.rows, built.columns, answer),
    celulas: built.rows.length * built.columns.length,
    contexto: {
      fotos: images.length,
      anexadas: fotos?.length ?? 0,
      descricao: descricao != null,
      codigo: codigo != null,
      referencia: referencia != null,
    },
    truncado: built.truncated,
  };
}
