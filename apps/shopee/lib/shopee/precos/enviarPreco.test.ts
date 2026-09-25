import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SHOPEE_ERROR_KIND,
  SHOPEE_SURFACE,
  ShopeeApiPartialError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  ShopeeSchemaError,
  shopeeErrorFromEnvelope,
  shopeeItemBaseInfoRowSchema,
  shopeeModelListPayloadSchema,
  shopeeUpdatePriceSchema,
  type ShopeeApiError,
  type ShopeeClient,
  type ShopeeErrorKind,
  type ShopeeItemBaseInfoRow,
  type ShopeeModelList,
  type ShopeeUpdatePriceResponse,
} from '@delfrance/integrations-shopee';

// ⚠️ The REAL link writers (`./linkPreco`) and the REAL admin handles over the
// shared fake Firestore — never mocks of them. What this module promises about
// the link documents (children first, the item doc last, a lock or a mismatch
// writing NOTHING) is only visible in the write log a real writer produces.
import { proximaViradaDaCotaMs } from '../anuncios/pausarAnuncio';
// ⚠️ The REAL conta classes: the ladder narrows them with `instanceof`, and a
// look-alike with the same `name` would not be them.
import { ShopeeCredencialInvalidaError } from '../core/credentialStore';
import { ShopeeRefreshEmAndamentoError, ShopeeSemCredencialError } from '../core/tokenStore';
import { FakeDb, asDb } from '../testing/fakeDb';
import { SHOPEE_PRECO_MODEL_ID_SEM_MODELO } from './constantesPreco';
import { MOTIVO_PRECO_SHOPEE } from './errosPreco';
import type { ItemDePreco } from './planoPreco';
import type { ContextoContaPreco } from './regiaoPreco';
import {
  conferirCompletudeDoItemDePreco,
  enviarPrecoDoItem,
  type DepsEnvioPreco,
  type LinhaModeloPreco,
  type ResultadoEnvioPreco,
} from './enviarPreco';

/* -------------------------------------------------------------------------- */
/*                                  fixtures                                   */
/* -------------------------------------------------------------------------- */

const AGORA_MS = 1_760_000_000_000;
const INTEGRACAO = 'int-1';
const ANCORA = 'prod-abc';
const FILHO_A = 'prod-filho-a';
const FILHO_B = 'prod-filho-b';
const LINK_DOC = 'link-1';
const VAR_A = 'varlink-a';
const VAR_B = 'varlink-b';
const ITEM_ID = 2_500_139_861;
const MODELO_A = 2_000_458_802;
const MODELO_B = 2_000_458_803;
const CAMINHO = '/api/v2/product/update_price';

const CAMINHO_LINK = `produtos/${ANCORA}/prodshopee/${LINK_DOC}`;
const CAMINHO_VAR_A = `produtos/${FILHO_A}/variashopee/${VAR_A}`;
const CAMINHO_VAR_B = `produtos/${FILHO_B}/variashopee/${VAR_B}`;

/** The sandbox's catch-all refusal, as the probe measured it (B-3). */
const CODIGO_RECUSADO = 'product.error_update_price_fail';
const FRASE_RECUSADO = 'Update price failed, please try later.';
/** The one per-model reason text ever measured (P9) — free text, not a code. */
const RAZAO_MODELO_INEXISTENTE = 'model ID not exist in sku';

const FONTE = readFileSync(fileURLToPath(new URL('./enviarPreco.ts', import.meta.url)), 'utf8');

/** A refusal already stamped on the item — what a CLEAN send must clear, and nothing else. */
const RECUSA_ANTERIOR = {
  precoRecusaEm: AGORA_MS - 60_000,
  precoRecusaCodigo: CODIGO_RECUSADO,
  precoRecusaMotivo: MOTIVO_PRECO_SHOPEE.precoRecusado,
  precoRecusaMensagem: FRASE_RECUSADO,
} as const;

/** A has-model item: A and B, each priced from its own child. */
function itemComModelos(alvoA: number | null = 12, alvoB: number | null = 22): ItemDePreco {
  return {
    produtoId: ANCORA,
    linkDocId: LINK_DOC,
    itemId: ITEM_ID,
    semModelos: false,
    alvos: [
      { modelId: MODELO_A, produtoId: FILHO_A, varLinkDocId: VAR_A, precoAlvo: alvoA },
      { modelId: MODELO_B, produtoId: FILHO_B, varLinkDocId: VAR_B, precoAlvo: alvoB },
    ],
  };
}

/** A no-model item: ONE alvo at the no-model id, priced from the anchor, no child. */
function itemSemModelo(alvo: number | null = 15): ItemDePreco {
  return {
    produtoId: ANCORA,
    linkDocId: LINK_DOC,
    itemId: ITEM_ID,
    semModelos: true,
    alvos: [
      {
        modelId: SHOPEE_PRECO_MODEL_ID_SEM_MODELO,
        produtoId: ANCORA,
        varLinkDocId: null,
        precoAlvo: alvo,
      },
    ],
  };
}

/** A base row as the batched reader hands it over (every default applied). */
function base(over: Record<string, unknown> = {}): ShopeeItemBaseInfoRow {
  return shopeeItemBaseInfoRowSchema.parse({
    item_id: ITEM_ID,
    item_status: 'NORMAL',
    has_model: false,
    price_info: [{ currency: 'BRL', original_price: 10, current_price: 10 }],
    ...over,
  });
}

/** `get_model_list`'s payload: `[model_id, shelf price, currency?]`. */
function modelos(linhas: readonly (readonly [number, number, string?])[]): ShopeeModelList {
  return shopeeModelListPayloadSchema.parse({
    model: linhas.map(([model_id, preco, currency]) => ({
      model_id,
      model_status: 'MODEL_NORMAL',
      price_info: [{ currency: currency ?? 'BRL', original_price: preco, current_price: preco }],
    })),
  });
}

/** The two-model listing as Shopee shows it now: A at 10, B at 22 (B already equal). */
const LISTA_PADRAO = (): ShopeeModelList =>
  modelos([
    [MODELO_A, 10],
    [MODELO_B, 22],
  ]);

/** One echo row: `model_id` ABSENT when `null` (the measured no-model shape, P4c). */
type Eco = readonly [number | null, number | null];

/** The raw `update_price` body — what the wire would carry. */
function corpoBruto(
  listas: {
    readonly sucesso?: readonly Eco[];
    readonly falhas?: readonly (readonly [number, string])[];
  },
  error = '',
): Record<string, unknown> {
  return {
    request_id: 'req-1',
    error,
    message: error === '' ? null : FRASE_RECUSADO,
    warning: null,
    response: {
      success_list: (listas.sucesso ?? []).map(([model_id, original_price]) =>
        model_id === null ? { original_price } : { model_id, original_price },
      ),
      failure_list: (listas.falhas ?? []).map(([model_id, failed_reason]) => ({
        model_id,
        failed_reason,
      })),
    },
  };
}

/** A 200 envelope, parsed by the package's own schema (a no-model echo reads `model_id: null`). */
function envelope(listas: Parameters<typeof corpoBruto>[0]): ShopeeUpdatePriceResponse {
  return shopeeUpdatePriceSchema.parse(corpoBruto(listas));
}

/** A Shopee refusal built by the package's OWN factory — the realistic class, kind and message. */
function erroShopee(code: string, message = FRASE_RECUSADO): ShopeeApiError {
  return shopeeErrorFromEnvelope(
    { error: code, message, request_id: 'req-1', warning: null },
    { path: CAMINHO, httpStatus: 200, surface: SHOPEE_SURFACE.business },
  );
}

/** The measured THROWN partial: a code AND the lists in one body (B-2). */
function parcial(
  code: string,
  listas: Parameters<typeof corpoBruto>[0],
  kind: ShopeeErrorKind = SHOPEE_ERROR_KIND.other,
  parsed: unknown = corpoBruto(listas, code),
): ShopeeApiPartialError {
  return new ShopeeApiPartialError(`Shopee ${CAMINHO} respondeu ${code}`, {
    code,
    kind,
    httpStatus: 200,
    path: CAMINHO,
    parsed,
  });
}

function burst(retryAfterSeconds: number | null = null): ShopeeRateLimitError {
  return new ShopeeRateLimitError('limite de rajada', {
    code: 'error_rate_limit',
    kind: SHOPEE_ERROR_KIND.burst,
    httpStatus: 429,
    path: CAMINHO,
    retryAfterSeconds,
  });
}

function cotaDiaria(): ShopeeRateLimitError {
  return new ShopeeRateLimitError('cota diária', {
    code: 'error_limit',
    kind: SHOPEE_ERROR_KIND.daily,
    httpStatus: 429,
    path: CAMINHO,
    // Present ON PURPOSE: the daily arm must never read it (M62).
    retryAfterSeconds: 30,
  });
}

function reauth(): ShopeeReauthRequiredError {
  return new ShopeeReauthRequiredError('autorização expirada', {
    code: 'invalid_access_token',
    kind: SHOPEE_ERROR_KIND.reauth,
    httpStatus: 403,
    path: CAMINHO,
  });
}

interface Plano {
  /** What the batched reader answers (`null` ⇔ absent from the batch). */
  readonly base?: ShopeeItemBaseInfoRow | null | Error;
  readonly modelos?: ShopeeModelList | Error;
  readonly updatePrice?: readonly (ShopeeUpdatePriceResponse | Error)[];
  readonly moeda?: string;
  readonly multiplo?: number;
  readonly baixarPreco?: boolean;
  readonly semRecusaAnterior?: boolean;
}

interface Cenario {
  readonly db: FakeDb;
  readonly deps: DepsEnvioPreco;
  readonly ordem: string[];
  readonly corpos: unknown[];
  readonly lerBase: ReturnType<typeof vi.fn>;
  readonly getModelList: ReturnType<typeof vi.fn>;
  readonly updatePrice: ReturnType<typeof vi.fn>;
}

/**
 * One item's world: the two link docs (with a refusal already stamped on the
 * item), a client that records the ORDER of its calls, and the injected
 * batched reader.
 */
function cenario(p: Plano = {}): Cenario {
  const db = new FakeDb();
  db.seed(CAMINHO_LINK, {
    item_id: ITEM_ID,
    item_status: 'NORMAL',
    ...(p.semRecusaAnterior === true ? {} : RECUSA_ANTERIOR),
  });
  db.seed(CAMINHO_VAR_A, { model_id: MODELO_A });
  db.seed(CAMINHO_VAR_B, { model_id: MODELO_B });

  const ordem: string[] = [];
  const corpos: unknown[] = [];
  const respostas = [...(p.updatePrice ?? [])];
  const baseLida = p.base === undefined ? base() : p.base;

  const lerBase = vi.fn(async (_id: number) => {
    ordem.push('lerBase');
    if (baseLida instanceof Error) throw baseLida;
    return baseLida;
  });
  const getModelList = vi.fn(async () => {
    ordem.push('getModelList');
    if (p.modelos instanceof Error) throw p.modelos;
    if (p.modelos === undefined) throw new Error('cenario: getModelList sem resposta planejada');
    return p.modelos;
  });
  const updatePrice = vi.fn(async (corpo: unknown) => {
    ordem.push('updatePrice');
    corpos.push(corpo);
    const r = respostas.shift();
    if (r instanceof Error) throw r;
    if (r === undefined) throw new Error('cenario: updatePrice sem resposta planejada');
    return r;
  });
  const getItemBaseInfo = vi.fn(async () => {
    throw new Error('cenario: a leitura de base é do leitor injetado, nunca do cliente');
  });

  const client = { getModelList, updatePrice, getItemBaseInfo } as unknown as ShopeeClient;
  const conta = {
    integracaoId: INTEGRACAO,
    client,
    regiao: 'BR',
    moeda: p.moeda ?? 'BRL',
    multiplo: p.multiplo ?? 4,
    tabelaNormalId: 'tabela-normal',
  } as ContextoContaPreco;

  return {
    db,
    deps: {
      db: asDb(db),
      conta,
      nowMs: AGORA_MS,
      baixarPreco: p.baixarPreco ?? false,
      lerBase: lerBase as unknown as DepsEnvioPreco['lerBase'],
    },
    ordem,
    corpos,
    lerBase,
    getModelList,
    updatePrice,
  };
}

/** The has-model world where only A changes (10 → 12) and B is already at 22. */
function cenarioComModelos(p: Plano = {}): Cenario {
  return cenario({ base: base({ has_model: true }), modelos: LISTA_PADRAO(), ...p });
}

function caminhosEscritos(db: FakeDb): string[] {
  return db.writes.map((w) => w.path);
}

function patchesEm(db: FakeDb, caminho: string): Record<string, unknown>[] {
  return db.writes.filter((w) => w.path === caminho).map((w) => w.patch);
}

function unicoPatch(db: FakeDb, caminho: string): Record<string, unknown> {
  const todos = patchesEm(db, caminho);
  expect(todos).toHaveLength(1);
  return todos[0] ?? {};
}

/** Narrow a result to the row-carrying kinds, or fail the test. */
function comLinhas(r: ResultadoEnvioPreco): readonly LinhaModeloPreco[] {
  if (r.tipo === 'pausa' || r.tipo === 'fatal') {
    throw new Error(`esperava linhas, veio ${r.tipo}`);
  }
  return r.modelos;
}

function linhaDe(r: ResultadoEnvioPreco, modelId: number): LinhaModeloPreco {
  const linha = comLinhas(r).find((l) => l.modelId === modelId);
  if (linha === undefined) throw new Error(`sem linha para ${String(modelId)}`);
  return linha;
}

/** The clean-send patch the item doc must carry — TOTAL, every refusal field nulled. */
function patchLimpo(precoEnviado: number | null): Record<string, unknown> {
  return {
    precoEnviado,
    precoEnviadoEm: AGORA_MS,
    precoRecusaEm: null,
    precoRecusaCodigo: null,
    precoRecusaMotivo: null,
    precoRecusaMensagem: null,
    ultimaModificacao: AGORA_MS,
  };
}

const avisos: unknown[][] = [];

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    avisos.push(args);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  avisos.length = 0;
});

/* -------------------------------------------------------------------------- */
/*  (1) the happy paths, one per shape                                         */
/* -------------------------------------------------------------------------- */

describe('enviarPrecoDoItem — o envio limpo', () => {
  it('1 — ⚠️ PAR (C-4): item SEM modelo — corpo `[{model_id: 0, original_price}]`, o eco SEM `model_id` casa com o `0` enviado ⇒ enviado, e o vínculo recebe o patch LIMPO com `precoEnviado`', async () => {
    const c = cenario({
      base: base({ price_info: [{ currency: 'BRL', original_price: 10, current_price: 10 }] }),
      updatePrice: [envelope({ sucesso: [[null, 15]] })],
    });

    const r = await enviarPrecoDoItem(itemSemModelo(15), c.deps);

    expect(c.corpos).toEqual([
      {
        item_id: ITEM_ID,
        price_list: [{ model_id: SHOPEE_PRECO_MODEL_ID_SEM_MODELO, original_price: 15 }],
      },
    ]);
    expect(r).toEqual({
      tipo: 'enviado',
      chamadasShopee: 1,
      modelos: [
        {
          modelId: SHOPEE_PRECO_MODEL_ID_SEM_MODELO,
          produtoId: ANCORA,
          varLinkDocId: null,
          precoAlvo: 15,
          precoAnterior: 10,
          resultado: 'enviado',
          motivo: null,
          codigo: null,
        },
      ],
    });
    // No model list for a no-model listing; the base came from the injected reader.
    expect(c.getModelList).not.toHaveBeenCalled();
    expect(c.ordem).toEqual(['lerBase', 'updatePrice']);
    // ONE write, on the item doc, TOTAL — the earlier refusal is cleared (M59).
    expect(caminhosEscritos(c.db)).toEqual([CAMINHO_LINK]);
    expect(unicoPatch(c.db, CAMINHO_LINK)).toEqual(patchLimpo(15));
  });

  it('2 — ⚠️ PAR (P8, M63): item COM modelos — o corpo leva SÓ o modelo que muda; o filho recebe o par de sucesso e o vínculo o patch limpo com `precoEnviado: null`, POR ÚLTIMO', async () => {
    const c = cenarioComModelos({ updatePrice: [envelope({ sucesso: [[MODELO_A, 12]] })] });

    const r = await enviarPrecoDoItem(itemComModelos(12, 22), c.deps);

    expect(c.corpos).toEqual([
      { item_id: ITEM_ID, price_list: [{ model_id: MODELO_A, original_price: 12 }] },
    ]);
    expect(r.tipo).toBe('enviado');
    expect(r.chamadasShopee).toBe(2);
    expect(linhaDe(r, MODELO_A)).toMatchObject({
      resultado: 'enviado',
      motivo: null,
      precoAlvo: 12,
      precoAnterior: 10,
    });
    expect(linhaDe(r, MODELO_B)).toMatchObject({ resultado: 'pulado', motivo: 'preco-igual' });
    expect(c.ordem).toEqual(['lerBase', 'getModelList', 'updatePrice']);
    // Children first, the item doc LAST; B (already equal) is never written.
    expect(caminhosEscritos(c.db)).toEqual([CAMINHO_VAR_A, CAMINHO_LINK]);
    expect(unicoPatch(c.db, CAMINHO_VAR_A)).toEqual({
      precoEnviado: 12,
      precoEnviadoEm: AGORA_MS,
      ultimaModificacao: AGORA_MS,
    });
    expect(unicoPatch(c.db, CAMINHO_LINK)).toEqual(patchLimpo(null));
  });

  it('3 — QUASE-IGUAL: um irmão com o preço RETIDO pela guarda deixa o envio `enviado` SEM o patch limpo — o item não está em sincronia, e a recusa anterior segue legível', async () => {
    // B target 20 < current 22 and no `baixarPreco` ⇒ preco-menor-bloqueado.
    const c = cenarioComModelos({ updatePrice: [envelope({ sucesso: [[MODELO_A, 12]] })] });

    const r = await enviarPrecoDoItem(itemComModelos(12, 20), c.deps);

    expect(r.tipo).toBe('enviado');
    expect(linhaDe(r, MODELO_B)).toMatchObject({
      resultado: 'pulado',
      motivo: 'preco-menor-bloqueado',
    });
    expect(caminhosEscritos(c.db)).toEqual([CAMINHO_VAR_A]);
    expect(c.db.store[CAMINHO_LINK]?.data).toMatchObject(RECUSA_ANTERIOR);
  });

  it('4 — PAR: um irmão SEM preço na tabela não impede o patch limpo (o ERP não tem opinião sobre ele)', async () => {
    const c = cenarioComModelos({ updatePrice: [envelope({ sucesso: [[MODELO_A, 12]] })] });

    const r = await enviarPrecoDoItem(itemComModelos(12, null), c.deps);

    expect(r.tipo).toBe('enviado');
    expect(linhaDe(r, MODELO_B)).toMatchObject({
      resultado: 'pulado',
      motivo: 'preco-nao-encontrado',
    });
    expect(caminhosEscritos(c.db)).toEqual([CAMINHO_VAR_A, CAMINHO_LINK]);
    expect(unicoPatch(c.db, CAMINHO_LINK)).toEqual(patchLimpo(null));
  });
});

/* -------------------------------------------------------------------------- */
/*  (2) S4 — the replay, and G0                                                */
/* -------------------------------------------------------------------------- */

describe('enviarPrecoDoItem — o que não chega ao fio', () => {
  it('5 — ⚠️ PAR (S4, M60): o preço já é o do ERP ⇒ `pulado preco-igual`, ZERO `update_price` e ZERO escrita no vínculo (a repetição de um envio que já pousou)', async () => {
    const c = cenario({
      base: base({ price_info: [{ currency: 'BRL', original_price: 15, current_price: 15 }] }),
    });

    const r = await enviarPrecoDoItem(itemSemModelo(15), c.deps);

    expect(r).toMatchObject({ tipo: 'pulado', motivo: 'preco-igual', chamadasShopee: 0 });
    expect(c.updatePrice).not.toHaveBeenCalled();
    expect(c.db.writes).toEqual([]);
  });

  it('6 — QUASE-IGUAL: a UM centavo (`14.99` na Shopee, `15` no ERP) o preço É enviado', async () => {
    const c = cenario({
      base: base({
        price_info: [{ currency: 'BRL', original_price: 14.99, current_price: 14.99 }],
      }),
      updatePrice: [envelope({ sucesso: [[null, 15]] })],
    });

    const r = await enviarPrecoDoItem(itemSemModelo(15), c.deps);

    expect(r.tipo).toBe('enviado');
    expect(c.updatePrice).toHaveBeenCalledTimes(1);
  });

  it('7 — PAR (G0): nenhum alvo tem preço ⇒ `pulado preco-nao-encontrado` sem LER nada — zero chamadas, zero escrita', async () => {
    const c = cenarioComModelos();

    const r = await enviarPrecoDoItem(itemComModelos(null, null), c.deps);

    expect(r).toEqual({
      tipo: 'pulado',
      motivo: 'preco-nao-encontrado',
      chamadasShopee: 0,
      modelos: [
        expect.objectContaining({
          modelId: MODELO_A,
          resultado: 'pulado',
          motivo: 'preco-nao-encontrado',
          precoAnterior: null,
        }),
        expect.objectContaining({
          modelId: MODELO_B,
          resultado: 'pulado',
          motivo: 'preco-nao-encontrado',
          precoAnterior: null,
        }),
      ],
    });
    expect(c.ordem).toEqual([]);
    expect(c.db.writes).toEqual([]);
  });

  it('8 — QUASE-IGUAL (G0): UM alvo com preço já basta para ler o anúncio', async () => {
    const c = cenarioComModelos({ updatePrice: [envelope({ sucesso: [[MODELO_A, 12]] })] });

    await enviarPrecoDoItem(itemComModelos(12, null), c.deps);

    expect(c.ordem).toEqual(['lerBase', 'getModelList', 'updatePrice']);
  });
});

/* -------------------------------------------------------------------------- */
/*  (3) G1 — the fresh read under the ladder                                   */
/* -------------------------------------------------------------------------- */

describe('enviarPrecoDoItem — G1, a leitura', () => {
  it('9 — o anúncio AUSENTE do lote ⇒ `falha anuncio-inexistente` carimbada com o NOSSO código `erp:` — no item e em cada filho, o item por último, sem `update_price`', async () => {
    const c = cenarioComModelos({ base: null });

    const r = await enviarPrecoDoItem(itemComModelos(), c.deps);

    expect(r).toMatchObject({
      tipo: 'falha',
      motivo: 'anuncio-inexistente',
      codigo: 'erp:anuncio-inexistente',
      mensagem: null,
      carimbado: true,
      chamadasShopee: 0,
    });
    expect(comLinhas(r).map((l) => [l.resultado, l.motivo, l.codigo])).toEqual([
      ['falha', 'anuncio-inexistente', null],
      ['falha', 'anuncio-inexistente', null],
    ]);
    expect(c.updatePrice).not.toHaveBeenCalled();
    expect(caminhosEscritos(c.db)).toEqual([CAMINHO_VAR_A, CAMINHO_VAR_B, CAMINHO_LINK]);
    expect(unicoPatch(c.db, CAMINHO_VAR_A)).toEqual({
      precoRecusaEm: AGORA_MS,
      precoRecusaCodigo: 'erp:anuncio-inexistente',
      ultimaModificacao: AGORA_MS,
    });
    expect(unicoPatch(c.db, CAMINHO_LINK)).toEqual({
      precoRecusaEm: AGORA_MS,
      precoRecusaCodigo: 'erp:anuncio-inexistente',
      precoRecusaMotivo: 'anuncio-inexistente',
      precoRecusaMensagem: null,
      ultimaModificacao: AGORA_MS,
    });
  });

  it('10 — uma leitura RECUSADA pela tabela (`get_model_list` ⇒ `product.error_item_not_found`) carimba como a escrita carimbaria, com o código VERBATIM e a frase da Shopee', async () => {
    const erro = erroShopee('product.error_item_not_found', 'item not found');
    const c = cenarioComModelos({ modelos: erro });

    const r = await enviarPrecoDoItem(itemComModelos(), c.deps);

    expect(r).toMatchObject({
      tipo: 'falha',
      motivo: 'anuncio-inexistente',
      codigo: 'product.error_item_not_found',
      mensagem: erro.message,
      carimbado: true,
      // the model list WAS issued (and failed) — counted
      chamadasShopee: 1,
    });
    expect(unicoPatch(c.db, CAMINHO_LINK)).toMatchObject({
      precoRecusaCodigo: 'product.error_item_not_found',
      precoRecusaMotivo: 'anuncio-inexistente',
      precoRecusaMensagem: erro.message,
    });
    expect(c.updatePrice).not.toHaveBeenCalled();
  });

  it('11 — a cota DIÁRIA na leitura de base ⇒ `pausa cota-diaria` até a virada, sem linhas e sem escrita (a base é custo da superfície: zero chamadas)', async () => {
    const c = cenarioComModelos({ base: cotaDiaria() });

    const r = await enviarPrecoDoItem(itemComModelos(), c.deps);

    expect(r).toEqual({
      tipo: 'pausa',
      pausa: 'cota-diaria',
      ate: proximaViradaDaCotaMs(AGORA_MS),
      retryAfterSeconds: null,
      codigo: 'error_limit',
      chamadasShopee: 0,
    });
    expect(c.db.writes).toEqual([]);
  });

  it('12 — a autorização MORTA no `get_model_list` ⇒ `fatal reauth`, uma chamada contada, nada escrito', async () => {
    const c = cenarioComModelos({ modelos: reauth() });

    const r = await enviarPrecoDoItem(itemComModelos(), c.deps);

    expect(r).toMatchObject({ tipo: 'fatal', motivo: 'reauth', chamadasShopee: 1 });
    expect(c.db.writes).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  (4) G2–G8 — the decision's own refusals                                     */
/* -------------------------------------------------------------------------- */

describe('enviarPrecoDoItem — a decisão', () => {
  it('13 — PAR: um anúncio BANIDO ⇒ `pulado anuncio-banido`, sem `update_price` e sem escrita', async () => {
    const c = cenarioComModelos({ base: base({ has_model: true, item_status: 'BANNED' }) });

    const r = await enviarPrecoDoItem(itemComModelos(), c.deps);

    expect(r).toMatchObject({ tipo: 'pulado', motivo: 'anuncio-banido' });
    expect(c.updatePrice).not.toHaveBeenCalled();
    expect(c.db.writes).toEqual([]);
  });

  it('14 — ⚠️ QUASE-IGUAL (D-11): a moeda DIVERGENTE carimba o item com `erp:moeda-divergente` e SÓ o filho cuja linha é `falha` — o modelo ausente fica `pulado` e intocado', async () => {
    // A in SGD on a BRL conta; B absent from the fresh list.
    const c = cenarioComModelos({ modelos: modelos([[MODELO_A, 10, 'SGD']]) });

    const r = await enviarPrecoDoItem(itemComModelos(), c.deps);

    expect(r).toMatchObject({
      tipo: 'falha',
      motivo: 'moeda-divergente',
      codigo: 'erp:moeda-divergente',
      mensagem: null,
      carimbado: true,
    });
    expect(linhaDe(r, MODELO_B)).toMatchObject({ resultado: 'pulado', motivo: 'modelo-ausente' });
    expect(c.updatePrice).not.toHaveBeenCalled();
    expect(caminhosEscritos(c.db)).toEqual([CAMINHO_VAR_A, CAMINHO_LINK]);
    expect(unicoPatch(c.db, CAMINHO_VAR_A)).toMatchObject({
      precoRecusaCodigo: 'erp:moeda-divergente',
    });
    expect(unicoPatch(c.db, CAMINHO_LINK)).toMatchObject({
      precoRecusaCodigo: 'erp:moeda-divergente',
      precoRecusaMotivo: 'moeda-divergente',
    });
  });

  it('15 — a razão BR estourada (A a 50 ao lado de B a 10 ⇒ 5×) ⇒ `falha razao-de-precos-excedida`, carimbada `erp:`, o irmão igual intocado, sem `update_price`', async () => {
    const c = cenarioComModelos({
      modelos: modelos([
        [MODELO_A, 10],
        [MODELO_B, 10],
      ]),
    });

    const r = await enviarPrecoDoItem(itemComModelos(50, 10), c.deps);

    expect(r).toMatchObject({ tipo: 'falha', motivo: 'razao-de-precos-excedida', carimbado: true });
    expect(c.updatePrice).not.toHaveBeenCalled();
    expect(caminhosEscritos(c.db)).toEqual([CAMINHO_VAR_A, CAMINHO_LINK]);
    expect(unicoPatch(c.db, CAMINHO_LINK)).toMatchObject({
      precoRecusaCodigo: 'erp:razao-de-precos-excedida',
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  (5) G9/G10 — the write's ladder and the per-model attribution              */
/* -------------------------------------------------------------------------- */

describe('enviarPrecoDoItem — G9, a escada da escrita', () => {
  it('16 — ⚠️ PAR (B-3): `product.error_update_price_fail` SEM listas ⇒ cada linha ENVIADA vira `falha preco-recusado`, carimbada com o código VERBATIM — NUNCA relançado', async () => {
    const erro = erroShopee(CODIGO_RECUSADO);
    const c = cenarioComModelos({ updatePrice: [erro] });

    const r = await enviarPrecoDoItem(itemComModelos(12, 22), c.deps);

    expect(r).toMatchObject({
      tipo: 'falha',
      motivo: 'preco-recusado',
      codigo: CODIGO_RECUSADO,
      mensagem: erro.message,
      carimbado: true,
      chamadasShopee: 2,
    });
    expect(linhaDe(r, MODELO_A)).toMatchObject({
      resultado: 'falha',
      motivo: 'preco-recusado',
      codigo: CODIGO_RECUSADO,
    });
    // B was never sent: it keeps the decision's own verdict.
    expect(linhaDe(r, MODELO_B)).toMatchObject({
      resultado: 'pulado',
      motivo: 'preco-igual',
      codigo: null,
    });
    expect(caminhosEscritos(c.db)).toEqual([CAMINHO_VAR_A, CAMINHO_LINK]);
    expect(unicoPatch(c.db, CAMINHO_VAR_A)).toEqual({
      precoRecusaEm: AGORA_MS,
      precoRecusaCodigo: CODIGO_RECUSADO,
      ultimaModificacao: AGORA_MS,
    });
    expect(unicoPatch(c.db, CAMINHO_LINK)).toEqual({
      precoRecusaEm: AGORA_MS,
      precoRecusaCodigo: CODIGO_RECUSADO,
      precoRecusaMotivo: 'preco-recusado',
      precoRecusaMensagem: erro.message,
      ultimaModificacao: AGORA_MS,
    });
  });

  it('17 — ⚠️ QUASE-IGUAL: `error_system_busy` (o soluço de verdade) é RELANÇADO — a MESMA instância, nada escrito', async () => {
    const erro = erroShopee('product.error_system_busy', 'system busy');
    const c = cenarioComModelos({ updatePrice: [erro] });

    await expect(enviarPrecoDoItem(itemComModelos(), c.deps)).rejects.toBe(erro);
    expect(c.db.writes).toEqual([]);
  });

  it.each([
    [
      'LANÇADO (o parcial medido: código E listas no mesmo corpo)',
      () =>
        parcial(CODIGO_RECUSADO, {
          sucesso: [[MODELO_A, 12]],
          falhas: [[MODELO_B, RAZAO_MODELO_INEXISTENTE]],
        }),
    ],
    [
      'DEVOLVIDO (200 com `error` vazio e as listas — M55)',
      () => envelope({ sucesso: [[MODELO_A, 12]], falhas: [[MODELO_B, RAZAO_MODELO_INEXISTENTE]] }),
    ],
  ])(
    '18 — ⚠️ um parcial %s ⇒ `falha envio-parcial`: A com o par de sucesso no filho, B `modelo-invalido` no SEU filho, o item com a recusa de B e SEM `precoEnviadoEm`',
    async (_nome, resposta) => {
      const c = cenarioComModelos({
        modelos: modelos([
          [MODELO_A, 10],
          [MODELO_B, 20],
        ]),
        updatePrice: [resposta()],
      });

      const r = await enviarPrecoDoItem(itemComModelos(12, 22), c.deps);

      expect(c.corpos).toEqual([
        {
          item_id: ITEM_ID,
          price_list: [
            { model_id: MODELO_A, original_price: 12 },
            { model_id: MODELO_B, original_price: 22 },
          ],
        },
      ]);
      expect(r).toMatchObject({
        tipo: 'falha',
        motivo: 'envio-parcial',
        codigo: RAZAO_MODELO_INEXISTENTE,
        mensagem: null,
        carimbado: true,
      });
      expect(linhaDe(r, MODELO_A)).toMatchObject({ resultado: 'enviado', motivo: null });
      expect(linhaDe(r, MODELO_B)).toMatchObject({
        resultado: 'falha',
        motivo: 'modelo-invalido',
        codigo: RAZAO_MODELO_INEXISTENTE,
      });
      expect(caminhosEscritos(c.db)).toEqual([CAMINHO_VAR_A, CAMINHO_VAR_B, CAMINHO_LINK]);
      expect(unicoPatch(c.db, CAMINHO_VAR_A)).toEqual({
        precoEnviado: 12,
        precoEnviadoEm: AGORA_MS,
        ultimaModificacao: AGORA_MS,
      });
      expect(unicoPatch(c.db, CAMINHO_VAR_B)).toEqual({
        precoRecusaEm: AGORA_MS,
        precoRecusaCodigo: RAZAO_MODELO_INEXISTENTE,
        ultimaModificacao: AGORA_MS,
      });
      const item = unicoPatch(c.db, CAMINHO_LINK);
      expect(item).toEqual({
        precoRecusaEm: AGORA_MS,
        precoRecusaCodigo: RAZAO_MODELO_INEXISTENTE,
        precoRecusaMotivo: 'modelo-invalido',
        precoRecusaMensagem: null,
        ultimaModificacao: AGORA_MS,
      });
      expect(Object.hasOwn(item, 'precoEnviadoEm')).toBe(false);
    },
  );

  it('19 — ⚠️ PAR (C-5): um PARCIAL de `kind: burst` ⇒ `pausa burst`, SEM escrita — nem o modelo que o eco confirmou', async () => {
    const c = cenarioComModelos({
      updatePrice: [
        parcial('error_rate_limit', { sucesso: [[MODELO_A, 12]] }, SHOPEE_ERROR_KIND.burst),
      ],
    });

    const r = await enviarPrecoDoItem(itemComModelos(), c.deps);

    expect(r).toEqual({
      tipo: 'pausa',
      pausa: 'burst',
      ate: null,
      retryAfterSeconds: null,
      codigo: 'error_rate_limit',
      chamadasShopee: 2,
    });
    expect(c.db.writes).toEqual([]);
  });

  it('20 — ⚠️ PAR (C-5): o `ShopeeRateLimitError` comum de rajada dá a MESMA pausa, levando o `Retry-After`', async () => {
    const c = cenarioComModelos({ updatePrice: [burst(7)] });

    const r = await enviarPrecoDoItem(itemComModelos(), c.deps);

    expect(r).toEqual({
      tipo: 'pausa',
      pausa: 'burst',
      ate: null,
      retryAfterSeconds: 7,
      codigo: 'error_rate_limit',
      chamadasShopee: 2,
    });
    expect(c.db.writes).toEqual([]);
  });

  it('21 — ⚠️ (M62): a cota DIÁRIA pausa até a virada de 00:00 UTC+8 — NUNCA pelo `Retry-After` que veio junto', async () => {
    const c = cenarioComModelos({ updatePrice: [cotaDiaria()] });

    const r = await enviarPrecoDoItem(itemComModelos(), c.deps);

    expect(r).toMatchObject({
      tipo: 'pausa',
      pausa: 'cota-diaria',
      ate: proximaViradaDaCotaMs(AGORA_MS),
      retryAfterSeconds: null,
    });
    expect(c.db.writes).toEqual([]);
  });

  it('22 — um PARCIAL de `kind: reauth` ⇒ `fatal reauth` (o `kind` é lido ANTES das listas)', async () => {
    const c = cenarioComModelos({
      updatePrice: [
        parcial('invalid_access_token', { sucesso: [[MODELO_A, 12]] }, SHOPEE_ERROR_KIND.reauth),
      ],
    });

    const r = await enviarPrecoDoItem(itemComModelos(), c.deps);

    expect(r).toMatchObject({ tipo: 'fatal', motivo: 'reauth' });
    expect(c.db.writes).toEqual([]);
  });

  it('23 — ⚠️ (M58): a trava de PROMOÇÃO no topo ⇒ `pulado bloqueado-por-promocao` e ZERO escrita — o anúncio não está errado, o preço está congelado', async () => {
    const c = cenarioComModelos({
      updatePrice: [erroShopee('product.error_cannot_update_price_in_promotion', 'locked')],
    });

    const r = await enviarPrecoDoItem(itemComModelos(), c.deps);

    expect(r).toMatchObject({ tipo: 'pulado', motivo: 'bloqueado-por-promocao' });
    expect(linhaDe(r, MODELO_A)).toMatchObject({
      resultado: 'pulado',
      motivo: 'bloqueado-por-promocao',
      codigo: 'product.error_cannot_update_price_in_promotion',
    });
    expect(c.db.writes).toEqual([]);
  });

  it('24 — QUASE-IGUAL: a trava num MODELO (razão com `promotion`) ao lado de um aceito ⇒ `enviado`, só o aceito ganha o par; nem carimbo no travado nem patch limpo no item', async () => {
    const c = cenarioComModelos({
      modelos: modelos([
        [MODELO_A, 10],
        [MODELO_B, 20],
      ]),
      updatePrice: [
        envelope({
          sucesso: [[MODELO_A, 12]],
          falhas: [[MODELO_B, 'item is in promotion, price locked']],
        }),
      ],
    });

    const r = await enviarPrecoDoItem(itemComModelos(12, 22), c.deps);

    expect(r.tipo).toBe('enviado');
    expect(linhaDe(r, MODELO_B)).toMatchObject({
      resultado: 'pulado',
      motivo: 'bloqueado-por-promocao',
    });
    expect(caminhosEscritos(c.db)).toEqual([CAMINHO_VAR_A]);
  });

  it('25 — a penalidade da LOJA no topo ⇒ `fatal loja-com-penalidade`, nada escrito', async () => {
    const c = cenarioComModelos({
      updatePrice: [erroShopee('error_seller_under_penalty', 'penalty')],
    });

    const r = await enviarPrecoDoItem(itemComModelos(), c.deps);

    expect(r).toMatchObject({ tipo: 'fatal', motivo: 'loja-com-penalidade' });
    expect(c.db.writes).toEqual([]);
  });

  it('26 — ⚠️ (M61): um `ShopeeSchemaError` NUNCA vira linha — relançado, a mesma instância', async () => {
    const erro = new ShopeeSchemaError('corpo inesperado', { httpStatus: 200, path: CAMINHO });
    const c = cenarioComModelos({ updatePrice: [erro] });

    await expect(enviarPrecoDoItem(itemComModelos(), c.deps)).rejects.toBe(erro);
    expect(c.db.writes).toEqual([]);
  });

  it.each([
    ['na leitura de base (a credencial preguiçosa)', 'base' as const],
    ['na escrita', 'escrita' as const],
  ])(
    '27 — PAR: uma classe de CONTA lançada %s ⇒ `fatal conta-nao-configurada`, nada escrito',
    async (_nome, onde) => {
      const erro =
        onde === 'base'
          ? new ShopeeSemCredencialError('sem credencial')
          : new ShopeeCredencialInvalidaError('credencial ilegível', ['access_token']);
      const c =
        onde === 'base'
          ? cenarioComModelos({ base: erro })
          : cenarioComModelos({ updatePrice: [erro] });

      const r = await enviarPrecoDoItem(itemComModelos(), c.deps);

      expect(r).toMatchObject({
        tipo: 'fatal',
        motivo: 'conta-nao-configurada',
        erro: `${erro.name}: ${erro.message}`,
      });
      expect(c.db.writes).toEqual([]);
    },
  );

  it('28 — QUASE-IGUAL: a renovação do token EM ANDAMENTO não é uma conta inutilizável — relançada', async () => {
    const erro = new ShopeeRefreshEmAndamentoError('renovação em andamento', AGORA_MS + 30_000);
    const c = cenarioComModelos({ updatePrice: [erro] });

    await expect(enviarPrecoDoItem(itemComModelos(), c.deps)).rejects.toBe(erro);
    expect(c.db.writes).toEqual([]);
  });

  it('29 — um parcial cujas listas NÃO relêem ⇒ o código do TOPO fala por cada modelo enviado (com um aviso)', async () => {
    const c = cenarioComModelos({
      updatePrice: [
        parcial(CODIGO_RECUSADO, {}, SHOPEE_ERROR_KIND.other, { response: 'ilegível' }),
      ],
    });

    const r = await enviarPrecoDoItem(itemComModelos(12, 22), c.deps);

    expect(r).toMatchObject({ tipo: 'falha', motivo: 'preco-recusado', codigo: CODIGO_RECUSADO });
    expect(avisos.some((a) => JSON.stringify(a).includes('parcial-ilegivel'))).toBe(true);
  });
});

describe('enviarPrecoDoItem — a razão POR MODELO que a tabela chama de conta ou de soluço', () => {
  it.each([
    ['um soluço (`error_system_busy`)', 'error_system_busy', 'modelo-sem-resposta'],
    ['a penalidade da loja', 'error_seller_under_penalty', 'loja-com-penalidade'],
  ])(
    '32b — %s NUMA linha de `failure_list` não relança nem encerra a conta: a linha fica `falha` SEM carimbo, e o aceito ao lado ainda ganha o seu par',
    async (_nome, razao, motivo) => {
      const c = cenarioComModelos({
        modelos: modelos([
          [MODELO_A, 10],
          [MODELO_B, 20],
        ]),
        updatePrice: [envelope({ sucesso: [[MODELO_A, 12]], falhas: [[MODELO_B, razao]] })],
      });

      const r = await enviarPrecoDoItem(itemComModelos(12, 22), c.deps);

      expect(r).toMatchObject({ tipo: 'falha', motivo: 'envio-parcial', carimbado: false });
      expect(linhaDe(r, MODELO_B)).toMatchObject({ resultado: 'falha', motivo, codigo: razao });
      expect(caminhosEscritos(c.db)).toEqual([CAMINHO_VAR_A]);
    },
  );
});

describe('enviarPrecoDoItem — o parcial RELIDO', () => {
  it('29b — ⚠️ PAR (C-5): as listas de um parcial LANÇADO passam pelo schema do pacote — o eco cru SEM `model_id` e com o preço entre aspas (`"15"`) casa com o `0` enviado e confirma; afirmado por cast, não casaria', async () => {
    const cru = {
      request_id: 'req-1',
      error: CODIGO_RECUSADO,
      message: FRASE_RECUSADO,
      warning: null,
      response: { success_list: [{ original_price: '15' }], failure_list: [] },
    };
    const c = cenario({
      updatePrice: [parcial(CODIGO_RECUSADO, {}, SHOPEE_ERROR_KIND.other, cru)],
    });

    const r = await enviarPrecoDoItem(itemSemModelo(15), c.deps);

    // Every sent model accepted: the top-level code speaks for NO model.
    expect(r.tipo).toBe('enviado');
    expect(unicoPatch(c.db, CAMINHO_LINK)).toEqual(patchLimpo(15));
  });
});

describe('enviarPrecoDoItem — G10, a atribuição por modelo', () => {
  it('30 — ⚠️ (M56): um modelo enviado que NENHUMA lista nomeia ⇒ `falha modelo-sem-resposta`, SEM carimbo no filho (e o aceito ao lado ⇒ `envio-parcial`)', async () => {
    const c = cenarioComModelos({
      modelos: modelos([
        [MODELO_A, 10],
        [MODELO_B, 20],
      ]),
      updatePrice: [envelope({ sucesso: [[MODELO_A, 12]] })],
    });

    const r = await enviarPrecoDoItem(itemComModelos(12, 22), c.deps);

    expect(r).toMatchObject({
      tipo: 'falha',
      motivo: 'envio-parcial',
      codigo: null,
      carimbado: false,
    });
    expect(linhaDe(r, MODELO_B)).toMatchObject({
      resultado: 'falha',
      motivo: 'modelo-sem-resposta',
      codigo: null,
    });
    // Only A's success pair; B untouched, and the item doc untouched (no stamping row).
    expect(caminhosEscritos(c.db)).toEqual([CAMINHO_VAR_A]);
  });

  it('31 — ⚠️ QUASE-IGUAL (C-4): num item COM modelos um eco SEM `model_id` não é atribuído a ninguém — cada enviado lê `modelo-sem-resposta`, nunca um palpite', async () => {
    const c = cenarioComModelos({ updatePrice: [envelope({ sucesso: [[null, 12]] })] });

    const r = await enviarPrecoDoItem(itemComModelos(12, 22), c.deps);

    expect(r).toMatchObject({ tipo: 'falha', motivo: 'modelo-sem-resposta', carimbado: false });
    expect(linhaDe(r, MODELO_A)).toMatchObject({
      resultado: 'falha',
      motivo: 'modelo-sem-resposta',
    });
    expect(c.db.writes).toEqual([]);
  });

  it('32 — uma recusa NOMEADA vence um eco do mesmo modelo: nunca registrado como enviado', async () => {
    const c = cenarioComModelos({
      updatePrice: [
        envelope({ sucesso: [[MODELO_A, 12]], falhas: [[MODELO_A, RAZAO_MODELO_INEXISTENTE]] }),
      ],
    });

    const r = await enviarPrecoDoItem(itemComModelos(12, 22), c.deps);

    expect(linhaDe(r, MODELO_A)).toMatchObject({ resultado: 'falha', motivo: 'modelo-invalido' });
    expect(patchesEm(c.db, CAMINHO_VAR_A)).toEqual([
      {
        precoRecusaEm: AGORA_MS,
        precoRecusaCodigo: RAZAO_MODELO_INEXISTENTE,
        ultimaModificacao: AGORA_MS,
      },
    ]);
  });
});

/**
 * Review L1-1: a `failure_list` reason the table does NOT know (T14 — the
 * page's own sample `"fail"`, or an empty reason) says nothing about WHY, so a
 * KNOWN top-level code thrown with the lists speaks for that row. The fold
 * here is "which reading wins": the pairs must come out equal to the plain
 * (list-less) refusal; the near-misses — a KNOWN reason, an UNKNOWN top-level
 * code — must keep the row's own reason.
 */
describe('enviarPrecoDoItem — a razão DESCONHECIDA de um modelo cede ao código CONHECIDO do topo (L1-1)', () => {
  const PROMOCAO = 'product.error_cannot_update_price_in_promotion';
  const TRAVA_DE_PRECO = 'product.error_in_item_promotion_item_price_lock';

  it.each([
    [
      'o código de promoção COM listas e a razão genérica `"fail"`',
      () => parcial(PROMOCAO, { falhas: [[MODELO_A, 'fail']] }),
      PROMOCAO,
    ],
    [
      'o código de promoção COM listas e a razão VAZIA',
      () => parcial(PROMOCAO, { falhas: [[MODELO_A, '']] }),
      PROMOCAO,
    ],
    [
      'a trava de preço da promoção COM listas e `"fail"`',
      () => parcial(TRAVA_DE_PRECO, { falhas: [[MODELO_A, 'fail']] }),
      TRAVA_DE_PRECO,
    ],
    [
      'o MESMO código de promoção SEM listas (o teste 23)',
      () => erroShopee(PROMOCAO, 'locked'),
      PROMOCAO,
    ],
  ])(
    '32c — ⚠️ PAR: %s ⇒ `pulado bloqueado-por-promocao` com o código do TOPO na linha e ZERO escrita — um anúncio saudável nunca é carimbado pela duração da promoção',
    async (_nome, resposta, codigoDoTopo) => {
      const c = cenarioComModelos({ updatePrice: [resposta()] });

      const r = await enviarPrecoDoItem(itemComModelos(12, 22), c.deps);

      expect(r).toMatchObject({ tipo: 'pulado', motivo: 'bloqueado-por-promocao' });
      expect(linhaDe(r, MODELO_A)).toEqual(
        expect.objectContaining({
          resultado: 'pulado',
          motivo: 'bloqueado-por-promocao',
          codigo: codigoDoTopo,
        }),
      );
      expect(c.db.writes).toEqual([]);
    },
  );

  it.each([
    [
      'COM listas e a razão genérica `"fail"`',
      () => parcial(CODIGO_RECUSADO, { falhas: [[MODELO_A, 'fail']] }),
    ],
    ['COM listas e a razão VAZIA', () => parcial(CODIGO_RECUSADO, { falhas: [[MODELO_A, '']] })],
    ['SEM listas (o teste 16)', () => erroShopee(CODIGO_RECUSADO)],
  ])(
    '32d — ⚠️ PAR: `product.error_update_price_fail` %s ⇒ `falha preco-recusado`, o filho e o item carimbados com o código VERBATIM do TOPO e a frase da Shopee',
    async (_nome, resposta) => {
      const erro = resposta();
      const c = cenarioComModelos({ updatePrice: [erro] });

      const r = await enviarPrecoDoItem(itemComModelos(12, 22), c.deps);

      expect(r).toMatchObject({
        tipo: 'falha',
        motivo: 'preco-recusado',
        codigo: CODIGO_RECUSADO,
        mensagem: erro.message,
        carimbado: true,
      });
      expect(linhaDe(r, MODELO_A)).toMatchObject({
        resultado: 'falha',
        motivo: 'preco-recusado',
        codigo: CODIGO_RECUSADO,
      });
      expect(caminhosEscritos(c.db)).toEqual([CAMINHO_VAR_A, CAMINHO_LINK]);
      expect(unicoPatch(c.db, CAMINHO_VAR_A)).toEqual({
        precoRecusaEm: AGORA_MS,
        precoRecusaCodigo: CODIGO_RECUSADO,
        ultimaModificacao: AGORA_MS,
      });
      expect(unicoPatch(c.db, CAMINHO_LINK)).toEqual({
        precoRecusaEm: AGORA_MS,
        precoRecusaCodigo: CODIGO_RECUSADO,
        precoRecusaMotivo: 'preco-recusado',
        precoRecusaMensagem: erro.message,
        ultimaModificacao: AGORA_MS,
      });
    },
  );

  it('32e — ⛔ QUASE-IGUAL: uma razão CONHECIDA (`model ID not exist in sku`) sob o MESMO código do topo ainda vence ⇒ `modelo-invalido` no filho, carimbado com a razão', async () => {
    const c = cenarioComModelos({
      updatePrice: [parcial(CODIGO_RECUSADO, { falhas: [[MODELO_A, RAZAO_MODELO_INEXISTENTE]] })],
    });

    const r = await enviarPrecoDoItem(itemComModelos(12, 22), c.deps);

    expect(r).toMatchObject({
      tipo: 'falha',
      motivo: 'modelo-invalido',
      codigo: RAZAO_MODELO_INEXISTENTE,
      carimbado: true,
    });
    expect(linhaDe(r, MODELO_A)).toMatchObject({
      resultado: 'falha',
      motivo: 'modelo-invalido',
      codigo: RAZAO_MODELO_INEXISTENTE,
    });
    expect(unicoPatch(c.db, CAMINHO_VAR_A)).toEqual({
      precoRecusaEm: AGORA_MS,
      precoRecusaCodigo: RAZAO_MODELO_INEXISTENTE,
      ultimaModificacao: AGORA_MS,
    });
  });

  it('32f — ⛔ QUASE-IGUAL: um código de topo DESCONHECIDO não tem leitura melhor a oferecer ⇒ `falha recusa-desconhecida` com a RAZÃO guardada na linha, no filho e no item', async () => {
    const c = cenarioComModelos({
      updatePrice: [parcial('product.error_nunca_visto', { falhas: [[MODELO_A, 'fail']] })],
    });

    const r = await enviarPrecoDoItem(itemComModelos(12, 22), c.deps);

    expect(r).toMatchObject({
      tipo: 'falha',
      motivo: 'recusa-desconhecida',
      codigo: 'fail',
      mensagem: null,
      carimbado: true,
    });
    expect(linhaDe(r, MODELO_A)).toMatchObject({
      resultado: 'falha',
      motivo: 'recusa-desconhecida',
      codigo: 'fail',
    });
    expect(unicoPatch(c.db, CAMINHO_VAR_A)).toMatchObject({ precoRecusaCodigo: 'fail' });
    expect(unicoPatch(c.db, CAMINHO_LINK)).toMatchObject({
      precoRecusaCodigo: 'fail',
      precoRecusaMotivo: 'recusa-desconhecida',
      precoRecusaMensagem: null,
    });
  });

  /** A top-level reading with NO code — a shape the transport never builds (`error: ''` is a success there). */
  function parcialSemCodigo(frase: string): ShopeeApiPartialError {
    return new ShopeeApiPartialError(frase, {
      code: '',
      kind: SHOPEE_ERROR_KIND.other,
      httpStatus: 200,
      path: CAMINHO,
      parsed: corpoBruto({ falhas: [[MODELO_A, 'fail']] }),
    });
  }

  it('32g — PAR com o 32c: um topo que lê promoção mas NÃO traz código ⇒ a razão desconhecida vira a EVIDÊNCIA da linha (e nada é escrito)', async () => {
    const c = cenarioComModelos({
      updatePrice: [parcialSemCodigo('item price locked by promotion')],
    });

    const r = await enviarPrecoDoItem(itemComModelos(12, 22), c.deps);

    expect(linhaDe(r, MODELO_A)).toMatchObject({
      resultado: 'pulado',
      motivo: 'bloqueado-por-promocao',
      codigo: 'fail',
    });
    expect(c.db.writes).toEqual([]);
  });

  it('32h — o mesmo topo SEM código numa leitura que CARIMBA (a agulha de modelo inexistente na frase) ⇒ o filho é carimbado com a razão, nunca com um código vazio', async () => {
    const c = cenarioComModelos({
      updatePrice: [parcialSemCodigo('model ID not exist in sku for this item')],
    });

    const r = await enviarPrecoDoItem(itemComModelos(12, 22), c.deps);

    expect(linhaDe(r, MODELO_A)).toMatchObject({
      resultado: 'falha',
      motivo: 'modelo-invalido',
      codigo: 'fail',
    });
    expect(unicoPatch(c.db, CAMINHO_VAR_A)).toMatchObject({ precoRecusaCodigo: 'fail' });
  });
});

/* -------------------------------------------------------------------------- */
/*  (6) G11 — the verification                                                 */
/* -------------------------------------------------------------------------- */

describe('enviarPrecoDoItem — G11, a conferência', () => {
  it('33 — ⚠️ QUASE-IGUAL (M57): o eco a UM centavo do enviado (`12.01` por `12`) ⇒ `falha preco-nao-atualizado` e ZERO escrita — nem sucesso, nem recusa', async () => {
    const c = cenarioComModelos({ updatePrice: [envelope({ sucesso: [[MODELO_A, 12.01]] })] });

    const r = await enviarPrecoDoItem(itemComModelos(12, 22), c.deps);

    expect(r).toMatchObject({
      tipo: 'falha',
      motivo: 'preco-nao-atualizado',
      codigo: null,
      carimbado: false,
    });
    expect(linhaDe(r, MODELO_A)).toMatchObject({
      resultado: 'falha',
      motivo: 'preco-nao-atualizado',
    });
    expect(c.db.writes).toEqual([]);
  });

  it('34 — PAR: o eco no MESMO centavo (`12.004` por `12`) confirma ⇒ enviado e o patch limpo', async () => {
    const c = cenarioComModelos({ updatePrice: [envelope({ sucesso: [[MODELO_A, 12.004]] })] });

    const r = await enviarPrecoDoItem(itemComModelos(12, 22), c.deps);

    expect(r.tipo).toBe('enviado');
    expect(caminhosEscritos(c.db)).toEqual([CAMINHO_VAR_A, CAMINHO_LINK]);
  });

  it('35 — uma confirmação SEM número conta como confirmada, com UM aviso que nomeia o anúncio', async () => {
    const c = cenarioComModelos({ updatePrice: [envelope({ sucesso: [[MODELO_A, null]] })] });

    const r = await enviarPrecoDoItem(itemComModelos(12, 22), c.deps);

    expect(r.tipo).toBe('enviado');
    const aviso = avisos.find((a) => JSON.stringify(a).includes('eco-sem-preco'));
    expect(aviso?.[1]).toEqual({ evento: 'eco-sem-preco', itemId: ITEM_ID, ecosNulos: 1 });
  });
});

/* -------------------------------------------------------------------------- */
/*  (7) S1 — the completeness                                                  */
/* -------------------------------------------------------------------------- */

describe('S1 — uma linha por alvo, na mesma ordem', () => {
  const linha = (
    modelId: number,
    produtoId: string,
    varLinkDocId: string | null,
  ): LinhaModeloPreco => ({
    modelId,
    produtoId,
    varLinkDocId,
    precoAlvo: 1,
    precoAnterior: null,
    resultado: 'pulado',
    motivo: 'preco-igual',
    codigo: null,
  });

  it('36 — PAR: as linhas espelham os alvos ⇒ passa; QUASE-IGUAL: uma linha a menos, ou a ordem trocada ⇒ Error', () => {
    const item = itemComModelos();
    const certas = [linha(MODELO_A, FILHO_A, VAR_A), linha(MODELO_B, FILHO_B, VAR_B)];
    expect(() => conferirCompletudeDoItemDePreco(item, certas)).not.toThrow();
    expect(() => conferirCompletudeDoItemDePreco(item, certas.slice(1))).toThrow(
      /linhas incompletas/,
    );
    expect(() => conferirCompletudeDoItemDePreco(item, [...certas].reverse())).toThrow(
      /linhas incompletas/,
    );
  });

  const cenarios: readonly (readonly [string, () => Cenario, ItemDePreco])[] = [
    ['G0', () => cenarioComModelos(), itemComModelos(null, null)],
    ['G1 ausente', () => cenarioComModelos({ base: null }), itemComModelos()],
    [
      'decisão pular',
      () => cenarioComModelos({ base: base({ has_model: true, item_status: 'BANNED' }) }),
      itemComModelos(),
    ],
    [
      'decisão falhar',
      () => cenarioComModelos({ modelos: modelos([[MODELO_A, 10, 'SGD']]) }),
      itemComModelos(),
    ],
    [
      'enviado',
      () => cenarioComModelos({ updatePrice: [envelope({ sucesso: [[MODELO_A, 12]] })] }),
      itemComModelos(),
    ],
    [
      'recusa do topo',
      () => cenarioComModelos({ updatePrice: [erroShopee(CODIGO_RECUSADO)] }),
      itemComModelos(),
    ],
    [
      'sem modelo',
      () => cenario({ updatePrice: [envelope({ sucesso: [[null, 15]] })] }),
      itemSemModelo(),
    ],
  ];

  it.each(cenarios)(
    '37 — %s: cada resultado com linhas traz UMA linha por alvo, na ordem dos alvos',
    async (_n, fazer, item) => {
      const r = await enviarPrecoDoItem(item, fazer().deps);
      expect(comLinhas(r).map((l) => [l.modelId, l.produtoId, l.varLinkDocId])).toEqual(
        item.alvos.map((a) => [a.modelId, a.produtoId, a.varLinkDocId]),
      );
    },
  );

  describe('com uma decisão que PERDEU uma linha', () => {
    afterEach(() => {
      vi.doUnmock('./decisaoPreco');
      vi.resetModules();
    });

    it('38 — ⚠️ (M64): o remetente LANÇA antes do fio — zero `update_price`, zero escrita', async () => {
      vi.resetModules();
      vi.doMock('./decisaoPreco', async (importOriginal) => {
        const real = await importOriginal<typeof import('./decisaoPreco')>();
        return {
          ...real,
          decidirEnvioDePreco: (...args: Parameters<typeof real.decidirEnvioDePreco>) => {
            const decisao = real.decidirEnvioDePreco(...args);
            return { ...decisao, linhas: decisao.linhas.slice(1) };
          },
        };
      });
      const { enviarPrecoDoItem: enviarComDecisaoQuebrada } = await import('./enviarPreco');
      const c = cenarioComModelos({ updatePrice: [envelope({ sucesso: [[MODELO_A, 12]] })] });

      await expect(enviarComDecisaoQuebrada(itemComModelos(), c.deps)).rejects.toThrow(
        /linhas incompletas/,
      );
      expect(c.updatePrice).not.toHaveBeenCalled();
      expect(c.db.writes).toEqual([]);
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  (8) the source                                                             */
/* -------------------------------------------------------------------------- */

describe('enviarPreco.ts — FONTE', () => {
  it('39 — ⚠️ a ORDEM da escada: limite → reauth → parcial → a classe BASE (todas estendem `ShopeeApiError`)', () => {
    const posicao = (padrao: RegExp): number => {
      const m = padrao.exec(FONTE);
      expect(m, String(padrao)).not.toBeNull();
      return m?.index ?? -1;
    };
    const limite = posicao(/instanceof ShopeeRateLimitError\b/);
    const reautorizacao = posicao(/instanceof ShopeeReauthRequiredError\b/);
    const parcialIdx = posicao(/instanceof ShopeeApiPartialError\b/);
    const baseIdx = posicao(/instanceof ShopeeApiError\b/);
    expect(limite).toBeLessThan(reautorizacao);
    expect(reautorizacao).toBeLessThan(parcialIdx);
    expect(parcialIdx).toBeLessThan(baseIdx);
  });

  it('40 — UM casador de eco (`modeloDoEco`), UMA grafia `erp:` (`codigoDoErpDePreco`), as listas RELIDAS e nunca afirmadas, e nenhum acesso direto ao Firestore', () => {
    expect(FONTE).toMatch(/\bmodeloDoEco,[^;]*from '\.\/verificacaoPreco'/);
    expect(FONTE).toMatch(/\bmodeloDoEco\(f, item\.semModelos\)/);
    expect(FONTE).toMatch(/\bmodeloDoEco\(s, item\.semModelos\)/);
    expect(FONTE).toMatch(/\bcodigoDoErpDePreco\(/);
    expect(FONTE).toMatch(/shopeeUpdatePriceSchema\.safeParse\(err\.parsed\)/);
    // No second matcher: nothing here compares a wire `model_id` itself.
    expect(FONTE).not.toMatch(/\.model_id\s*===/);
    // No `erp:` spelled by hand.
    expect(FONTE).not.toMatch(/`erp:\$\{/);
    expect(FONTE).not.toMatch(/'erp:/);
    expect(FONTE).not.toMatch(/as ShopeeUpdatePrice\b/);
    expect(FONTE).not.toMatch(/@delfrance\/data/);
  });
});
