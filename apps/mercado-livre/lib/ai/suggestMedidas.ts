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
  type AiMedidaSuggestion,
  type MedidaColumnSpec,
  type MedidaRowSpec,
} from '@delfrance/integrations-mercado-livre';
import type { Foto, TabelaDeMedidas } from '@delfrance/schemas';

import type { GenerateFn } from '@delfrance/ai/admin';

export interface SuggestMedidasDeps {
  db: Firestore;
  generate: GenerateFn;
  /** Resolves the tabela's first photo to inline bytes; null when there is none. */
  loadImage: (fotos: readonly Foto[] | null | undefined) => Promise<AiInlineImage | null>;
  model: string;
  systemInstruction?: string | null;
  temperature?: number | null;
  maxOutputTokens?: number | null;
  signal?: AbortSignal;
}

export interface SuggestMedidasArgs {
  tabMediId: string;
  rows: MedidaRowSpec[];
  columns: MedidaColumnSpec[];
  measureType?: string | null;
}

export interface SuggestMedidasResult {
  sugestoes: AiMedidaSuggestion[];
  /** How many cells were offered to the model — rows × columns after capping. */
  celulas: number;
  /**
   * Whether a photo was included. Surfaced so the UI can SAY so: a tabela whose
   * photo predates the resize rollout has no derivative to read, and a
   * text-only answer to a transcription task is close to worthless. The
   * operator has to be able to tell those apart from a bad model.
   */
  comFoto: boolean;
  /** True when a cap or a duplicate size label dropped part of the grid. */
  truncado: boolean;
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
  // An empty grid buys an empty schema — short-circuit BEFORE spending a model
  // call, the same way a mid-tree category does for attribute suggestion.
  if (built.rows.length === 0 || built.columns.length === 0) {
    return { sugestoes: [], celulas: 0, comFoto: false, truncado: built.truncated };
  }

  const image = await deps.loadImage(tabela.fotos);

  const request = buildMedidasPrompt({
    tabelaNome: tabela.nome,
    // Read server-side from the stored document, never taken from the request
    // body: the body already carries the grid, and letting it carry the prompt's
    // factual content too would make the caller able to say anything about a
    // record it merely names.
    descricao: tabela.descricao,
    ...(args.measureType != null ? { measureType: args.measureType } : {}),
    built,
    ...(image ? { image } : {}),
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
    comFoto: image != null,
    truncado: built.truncated,
  };
}
