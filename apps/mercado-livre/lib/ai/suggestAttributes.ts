/**
 * Orchestration for "Sugestão com IA": produto + ML category metadata in, a
 * list of staged attribute suggestions out.
 *
 * Every piece of judgement lives elsewhere and is already unit-tested —
 * `buildAttributeSchema` decides what the model may answer, `buildAttributePrompt`
 * what it is told, `applyAiAttributes` what survives. This file only sequences
 * them, which is why it is short and why the tests here are about sequencing:
 * that a non-leaf category never reaches the model, that a missing photo is not
 * an error, that the answer is never trusted.
 *
 * **Nothing here writes to Firestore.** Suggestions are staged in a review modal
 * and applied by the operator — #799's own criterion.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { produtoCollection, produtoExtraDataCollection } from '@delfrance/data/admin/collections';
import {
  applyAiAttributes,
  buildAttributePrompt,
  buildAttributeSchema,
  type AiAttributeSpec,
  type AiAttributeSuggestion,
  type AiInlineImage,
} from '@delfrance/integrations-mercado-livre';
import type { Produto, ProdutoExtraData } from '@delfrance/schemas';

import type { GenerateFn } from '@delfrance/ai/admin';

export interface SuggestAttributesDeps {
  db: Firestore;
  generate: GenerateFn;
  /** Resolves the produto's first photo to inline bytes; null when there is none. */
  loadImage: (fotos: Produto['fotos']) => Promise<AiInlineImage | null>;
  /** The attributes this category defines, already filtered + ordered by the server. */
  loadAtributos: (categoryId: string) => Promise<{ leaf: boolean; atributos: AiAttributeSpec[] }>;
  model: string;
  systemInstruction?: string | null;
  /** The operator's correction plus the answer being corrected. */
  revisao?: { feedback: string; anterior: AiAttributeSuggestion[] } | null;
  temperature?: number | null;
  maxOutputTokens?: number | null;
  signal?: AbortSignal;
}

export interface SuggestAttributesResult {
  /** False ⇒ a mid-tree category; no model call was made. */
  leaf: boolean;
  /** How many attributes were offered to the model. */
  atributos: number;
  sugestoes: AiAttributeSuggestion[];
  /** Whether a product photo was included. Surfaced so the UI can say so. */
  comFoto: boolean;
}

/** Thrown when the produto does not exist — a 404, not a model failure. */
export class ProdutoNotFoundError extends Error {
  constructor(readonly produtoId: string) {
    super('Produto não encontrado.');
    this.name = 'ProdutoNotFoundError';
  }
}

export async function suggestAttributes(
  deps: SuggestAttributesDeps,
  args: { produtoId: string; categoryId: string; categoriaNome?: string | null },
): Promise<SuggestAttributesResult> {
  const snap = await produtoCollection.docRef(deps.db, {}, args.produtoId).get();
  if (!snap.exists) throw new ProdutoNotFoundError(args.produtoId);
  const produto = produtoCollection.parseRead(
    snap.data(),
    produtoCollection.docPath({}, args.produtoId),
  ) as Produto;

  // A mid-tree category has no attributes at all — short-circuit BEFORE
  // spending a model call on an empty schema.
  const { leaf, atributos } = await deps.loadAtributos(args.categoryId);
  if (!leaf || atributos.length === 0) {
    return { leaf, atributos: atributos.length, sugestoes: [], comFoto: false };
  }

  const extra = await loadExtraData(deps.db, args.produtoId);
  const image = await deps.loadImage(produto.fotos);

  const responseSchema = buildAttributeSchema(atributos);
  const request = buildAttributePrompt({
    produtoNome: produto.nome,
    descricao: extra?.descricao ?? null,
    marca: extra?.marca ?? null,
    categoriaNome: args.categoriaNome ?? null,
    attrs: atributos,
    responseSchema,
    ...(image ? { image } : {}),
    systemInstruction: deps.systemInstruction ?? null,
    revisao: deps.revisao ?? null,
  });

  const answer = await deps.generate({
    model: deps.model,
    request,
    temperature: deps.temperature ?? null,
    maxOutputTokens: deps.maxOutputTokens ?? null,
    ...(deps.signal ? { signal: deps.signal } : {}),
  });

  return {
    leaf: true,
    atributos: atributos.length,
    // The model answer is untrusted input; this is the only thing that reads it.
    sugestoes: applyAiAttributes(atributos, answer),
    comFoto: image != null,
  };
}

/** Marca and descrição live on the produto's extraData singleton, as publish reads them. */
async function loadExtraData(db: Firestore, produtoId: string): Promise<ProdutoExtraData | null> {
  const snap = await produtoExtraDataCollection.docRef(db, { produtoId }, 'singleton').get();
  if (!snap.exists) return null;
  return produtoExtraDataCollection.parseRead(
    snap.data(),
    produtoExtraDataCollection.docPath({ produtoId }, 'singleton'),
  ) as ProdutoExtraData;
}
