import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SHOPEE_ERROR_KIND,
  ShopeeApiError,
  ShopeeRateLimitError,
  ShopeeSchemaError,
  type ShopeeClient,
  type ShopeeErrorKind,
  type ShopeeItemBaseInfo,
  type ShopeeItemViolationInfo,
  type ShopeeModelList,
} from '@delfrance/integrations-shopee';
import {
  ESTADO_ANUNCIO_SHOPEE,
  SHOPEE_ITEM_STATUS,
  SHOPEE_MODEL_STATUS,
  shopeeViolacaoSchema,
  type ShopeeViolacao,
} from '@delfrance/schemas';

import { FakeDb, asDb, increment } from '../testing/fakeDb';
import {
  MOTIVO_AVISO_ANUNCIO,
  avisarAnuncioComViolacao,
  chaveAnuncioComViolacao,
} from './avisoAnuncio';
import {
  ACAO_REVERIFICACAO,
  CAMPOS_DO_PATCH_DE_REVERIFICACAO,
  mesmasViolacoes,
  reverificarAnuncioShopee,
  type AlvoDeReverificacao,
  type ReverificarAnuncioDeps,
} from './reverificarAnuncio';

/* -------------------------------------------------------------------------- */
/*  Fixtures — invented ids only. Never a real partner, shop, item or buyer.   */
/* -------------------------------------------------------------------------- */

const INTEGRACAO = 'int-1';
const REF_CONTA = `documents/integracao/${INTEGRACAO}`;
const REF_OUTRA_CONTA = 'documents/integracao/int-2';

const PAI = 'prod-pai';
const FILHO_A = 'prod-filho-a';
const FILHO_B = 'prod-filho-b';
const LINK_PAI = 'link-1';
const CAMINHO_LINK = `produtos/${PAI}/prodshopee/${LINK_PAI}`;

const ITEM_ID = 2500139861;
const MODEL_A = 2000458802;
const MODEL_B = 2000458803;

const AGORA = 1_757_000_000_000;
/** Wire SECONDS, comfortably past the 2020-01-01 floor. */
const PRAZO_S = 1_788_973_354;
const PRAZO_MS = PRAZO_S * 1000;

/** Recognisable stand-ins for the provider PROSE that must never reach a log line. */
const PROSA_RAZAO = 'PROSA-RAZAO: o titulo deste anuncio copia o de outra loja';
const PROSA_SUGESTAO = 'PROSA-SUGESTAO: mova o anuncio para a categoria sugerida';

function semearLink(db: FakeDb, extra: Record<string, unknown> = {}): void {
  db.seed(CAMINHO_LINK, {
    contaProdutoShopeeOuterRef: REF_CONTA,
    item_name: 'Camiseta Básica',
    item_id: ITEM_ID,
    category_id: 100_017,
    logistic_info: [{ logistic_id: 11_006, enabled: true }],
    ...extra,
  });
}

function semearFilho(db: FakeDb, filhoId: string): void {
  db.seed(`produtos/${filhoId}`, { nome: 'Camiseta Básica P', paiId: PAI });
}

function semearLinkFilho(db: FakeDb, filhoId: string, extra: Record<string, unknown> = {}): void {
  db.seed(`produtos/${filhoId}/variashopee/v-1`, {
    contaVariacaoShopeeOuterRef: REF_CONTA,
    produtoShopeeOuterRef: `documents/${CAMINHO_LINK}`,
    model_id: MODEL_A,
    tier_index: [0],
    model_status: SHOPEE_MODEL_STATUS.normal,
    ...extra,
  });
}

/* ------------------------------ the wire doubles --------------------------- */

function linhaBase(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    item_id: ITEM_ID,
    item_name: 'Camiseta Básica',
    item_status: SHOPEE_ITEM_STATUS.normal,
    condition: 'NEW',
    deboost: false,
    has_model: false,
    scheduled_publish_time: null,
    category_id: 100_017,
    ...over,
  };
}

function baseInfo(linhas: readonly (Record<string, unknown> | null)[]): ShopeeItemBaseInfo {
  return { item_list: linhas } as unknown as ShopeeItemBaseInfo;
}

function detalhe(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    violation_type: 'Spam',
    violation_reason: PROSA_RAZAO,
    suggestion: PROSA_SUGESTAO,
    fix_deadline_time: PRAZO_S,
    update_time: PRAZO_S - 3600,
    ...over,
  };
}

function violationInfo(over: Record<string, unknown> = {}): ShopeeItemViolationInfo {
  return {
    item_list: [
      {
        item_id: ITEM_ID,
        item_name: 'Camiseta Básica',
        item_status: SHOPEE_ITEM_STATUS.normal,
        deboost: false,
        item_status_details: [detalhe()],
        deboost_details: null,
        deboosted_details: null,
        fail_error: null,
        fail_message: null,
        ...over,
      },
    ],
  } as unknown as ShopeeItemViolationInfo;
}

function violationInfoVazio(): ShopeeItemViolationInfo {
  return {
    item_list: [
      {
        item_id: ITEM_ID,
        item_status: SHOPEE_ITEM_STATUS.normal,
        deboost: false,
        item_status_details: null,
        deboost_details: null,
        deboosted_details: null,
        fail_error: null,
        fail_message: null,
      },
    ],
  } as unknown as ShopeeItemViolationInfo;
}

function modelList(modelos: readonly Record<string, unknown>[]): ShopeeModelList {
  return {
    tier_variation: null,
    standardise_tier_variation: null,
    model: modelos,
  } as unknown as ShopeeModelList;
}

function modelo(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model_id: MODEL_A,
    tier_index: [0],
    model_status: SHOPEE_MODEL_STATUS.normal,
    ...over,
  };
}

interface OpcoesCliente {
  readonly base?: (p: { itemIds: readonly number[] }) => ShopeeItemBaseInfo;
  readonly violacoes?: (p: { itemIds: readonly number[] }) => ShopeeItemViolationInfo;
  readonly modelos?: (p: { itemId: number }) => ShopeeModelList;
}

interface ClienteFake {
  readonly client: ShopeeClient;
  readonly ops: string[];
}

/**
 * A `ShopeeClient` answering only the three operations this module owns. An
 * operation the case did not arrange throws, so "never calls X" needs no spy.
 */
function clienteFake(op: OpcoesCliente = {}): ClienteFake {
  const ops: string[] = [];
  const client = {
    getItemBaseInfo: (p: { itemIds: readonly number[] }) => {
      ops.push('get_item_base_info');
      if (op.base === undefined) throw new Error('fixture: getItemBaseInfo inesperado');
      return Promise.resolve(op.base(p));
    },
    getItemViolationInfo: (p: { itemIds: readonly number[] }) => {
      ops.push('get_item_violation_info');
      if (op.violacoes === undefined) throw new Error('fixture: getItemViolationInfo inesperado');
      return Promise.resolve(op.violacoes(p));
    },
    getModelList: (p: { itemId: number }) => {
      ops.push('get_model_list');
      if (op.modelos === undefined) throw new Error('fixture: getModelList inesperado');
      return Promise.resolve(op.modelos(p));
    },
  } as unknown as ShopeeClient;
  return { client, ops };
}

/** The happy pair: a clean status read and one status violation row. */
function clientePadrao(over: OpcoesCliente = {}): ClienteFake {
  return clienteFake({
    base: () => baseInfo([linhaBase()]),
    violacoes: () => violationInfo(),
    ...over,
  });
}

function deps(client: ShopeeClient, nowMs = AGORA): ReverificarAnuncioDeps {
  return { clientFor: () => Promise.resolve(client), increment, nowMs };
}

function alvo(over: Partial<AlvoDeReverificacao> = {}): AlvoDeReverificacao {
  return { integracaoId: INTEGRACAO, produtoId: PAI, ...over };
}

function erroApi(code: string, kind: ShopeeErrorKind = SHOPEE_ERROR_KIND.other): ShopeeApiError {
  return new ShopeeApiError(`Shopee respondeu ${code} (HTTP 200)`, {
    code,
    kind,
    httpStatus: 200,
    path: '/api/v2/product/get_item_base_info',
  });
}

function patchesDoLink(db: FakeDb): Record<string, unknown>[] {
  return db.patches.filter((p) => p.path === CAMINHO_LINK).map((p) => p.patch);
}

function violacao(over: Partial<ShopeeViolacao> = {}): ShopeeViolacao {
  return shopeeViolacaoSchema.parse({
    violation_type: 'Spam',
    violation_reason: PROSA_RAZAO,
    suggestion: PROSA_SUGESTAO,
    fix_deadline_time: PRAZO_MS,
    update_time: PRAZO_MS - 3_600_000,
    kind: 'status',
    ...over,
  });
}

const infos: unknown[][] = [];
const avisos: unknown[][] = [];

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
    infos.push(args);
  });
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    avisos.push(args);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  infos.length = 0;
  avisos.length = 0;
});

function logInteiro(): string {
  return [...infos, ...avisos]
    .map((args) => args.map((a) => JSON.stringify(a)).join(' '))
    .join('|');
}

/* -------------------------------------------------------------------------- */
/*  (1) the happy path                                                         */
/* -------------------------------------------------------------------------- */

describe('reverificarAnuncioShopee — a leitura', () => {
  it('lê base info + violation info e escreve status, deboost e violações', async () => {
    const db = new FakeDb();
    semearLink(db, { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado });
    const fake = clientePadrao();

    const res = await reverificarAnuncioShopee(asDb(db), alvo(), deps(fake.client));

    expect(fake.ops).toEqual(['get_item_base_info', 'get_item_violation_info']);
    expect(res).toMatchObject({
      acao: ACAO_REVERIFICACAO.atualizado,
      produtoId: PAI,
      linkDocId: LINK_PAI,
      itemId: ITEM_ID,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
      itemStatus: SHOPEE_ITEM_STATUS.normal,
      deboost: false,
      violacoesLidas: true,
      modelos: null,
      chamadasShopee: 2,
    });
    expect(res?.violacoes).toHaveLength(1);
    // ⚠️ MILLISECONDS out of the shared builder — never converted a second time.
    expect(res?.violacoes[0]?.fix_deadline_time).toBe(PRAZO_MS);
    expect(res?.violacoes[0]?.kind).toBe('status');
    expect(patchesDoLink(db)[0]).toMatchObject({
      item_status: SHOPEE_ITEM_STATUS.normal,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
      deboost: false,
      condition: 'NEW',
      violacoesLidasEm: AGORA,
      ultimaModificacao: AGORA,
    });
  });

  it('⚠️ o handler não escreve item_name, category_id nem logistic_info', async () => {
    const db = new FakeDb();
    semearLink(db, { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado });
    const fake = clientePadrao();

    await reverificarAnuncioShopee(asDb(db), alvo(), deps(fake.client));

    const patch = patchesDoLink(db)[0];
    expect(patch).toBeDefined();
    // ⚠️ The key SET against the exported literal list: a field added here shows up
    // in this suite instead of silently overwriting the importer's or the
    // publisher's work.
    for (const chave of Object.keys(patch ?? {})) {
      expect(CAMPOS_DO_PATCH_DE_REVERIFICACAO as readonly string[]).toContain(chave);
    }
    for (const proibida of ['item_name', 'category_id', 'logistic_info', 'attributes']) {
      expect(Object.keys(patch ?? {})).not.toContain(proibida);
    }
  });

  it('o patch de ciclo de vida é PLANO — só escalares e arrays', async () => {
    const db = new FakeDb();
    semearLink(db, { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado });
    const fake = clientePadrao();

    await reverificarAnuncioShopee(asDb(db), alvo(), deps(fake.client));

    for (const [chave, valor] of Object.entries(patchesDoLink(db)[0] ?? {})) {
      expect(chave).not.toContain('.');
      expect(valor === null || typeof valor !== 'object' || Array.isArray(valor)).toBe(true);
    }
  });

  it('a prosa da violação é ARMAZENADA e NUNCA aparece numa linha de log', async () => {
    const db = new FakeDb();
    semearLink(db, { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado });
    const fake = clientePadrao();

    await reverificarAnuncioShopee(asDb(db), alvo(), deps(fake.client));

    expect(logInteiro()).not.toContain('PROSA-RAZAO');
    expect(logInteiro()).not.toContain('PROSA-SUGESTAO');
  });

  it('o link de outra conta não é reverificado', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO_LINK, {
      contaProdutoShopeeOuterRef: REF_OUTRA_CONTA,
      item_name: 'Camiseta Básica',
      item_id: ITEM_ID,
    });
    const fake = clienteFake();

    const res = await reverificarAnuncioShopee(asDb(db), alvo(), deps(fake.client));

    expect(res).toBeNull();
    expect(fake.ops).toEqual([]);
    expect(db.patches).toEqual([]);
  });

  it('um linkDocId de outra conta também responde null — a conta filtra primeiro', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO_LINK, {
      contaProdutoShopeeOuterRef: REF_OUTRA_CONTA,
      item_name: 'Camiseta Básica',
      item_id: ITEM_ID,
    });
    const fake = clienteFake();

    const res = await reverificarAnuncioShopee(
      asDb(db),
      alvo({ linkDocId: LINK_PAI }),
      deps(fake.client),
    );

    expect(res).toBeNull();
  });

  it('um link sem item_id responde ignorado-sem-item-id e não gasta chamada', async () => {
    const db = new FakeDb();
    semearLink(db, { item_id: null, estadoAnuncio: null });
    const fake = clienteFake();

    const res = await reverificarAnuncioShopee(asDb(db), alvo(), deps(fake.client));

    expect(res).toMatchObject({
      acao: ACAO_REVERIFICACAO.ignoradoSemItemId,
      itemId: null,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.desconhecido,
      chamadasShopee: 0,
    });
    expect(fake.ops).toEqual([]);
    expect(db.patches).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  (2)(3) the `removido` arm                                                  */
/* -------------------------------------------------------------------------- */

describe('reverificarAnuncioShopee — a listagem que a Shopee não tem mais', () => {
  it('⚠️ error_item_not_found ⇒ removido, e o item_status NÃO é escrito', async () => {
    const db = new FakeDb();
    semearLink(db, { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo, item_status: 'NORMAL' });
    const fake = clienteFake({
      base: () => {
        throw erroApi('error_item_not_found');
      },
    });

    const res = await reverificarAnuncioShopee(asDb(db), alvo(), deps(fake.client));

    expect(res).toMatchObject({
      acao: ACAO_REVERIFICACAO.removido,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido,
      // ⚠️ Nothing was READ, so nothing is reported and nothing is stamped.
      itemStatus: null,
      chamadasShopee: 1,
    });
    expect(patchesDoLink(db)).toEqual([
      {
        estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido,
        violacoesLidasEm: AGORA,
        ultimaModificacao: AGORA,
      },
    ]);
    expect(Object.keys(patchesDoLink(db)[0] ?? {})).not.toContain('item_status');
    // The STORED status is left exactly as it was.
    expect(db.store[CAMINHO_LINK]?.data.item_status).toBe('NORMAL');
  });

  it('⚠️ o código com PREFIXO DE MÓDULO é o MESMO veredito', async () => {
    // A sonda mediu o prefixo `product.` real no fio (2026-09-17) e
    // `ShopeeApiError.code` guarda a string do envelope VERBATIM — comparar só a
    // forma nua devolveria um 5xx para a listagem que a Shopee apagou, deixando
    // `estadoAnuncio` no valor velho e o aviso aberto.
    const db = new FakeDb();
    semearLink(db, { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo, item_status: 'NORMAL' });
    const fake = clienteFake({
      base: () => {
        throw erroApi('product.error_item_not_found');
      },
    });

    const res = await reverificarAnuncioShopee(asDb(db), alvo(), deps(fake.client));

    expect(res).toMatchObject({
      acao: ACAO_REVERIFICACAO.removido,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido,
      itemStatus: null,
    });
    expect(patchesDoLink(db)).toEqual([
      {
        estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido,
        violacoesLidasEm: AGORA,
        ultimaModificacao: AGORA,
      },
    ]);
  });

  it('⚠️ QUASE: um código de DOIS prefixos NÃO é removido — ele SOBE', async () => {
    // A tira remove UM segmento só, de propósito: uma tira gulosa faria qualquer
    // código que apenas TERMINE em `error_item_not_found` apagar um anúncio vivo.
    const db = new FakeDb();
    semearLink(db, { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo });
    const fake = clienteFake({
      base: () => {
        throw erroApi('a.product.error_item_not_found');
      },
    });

    await expect(reverificarAnuncioShopee(asDb(db), alvo(), deps(fake.client))).rejects.toThrow(
      ShopeeApiError,
    );
    expect(db.patches).toEqual([]);
  });

  it('⚠️ NEAR-MISS: uma leitura VAZIA (nenhuma linha para o id) é o MESMO removido', async () => {
    const db = new FakeDb();
    semearLink(db, { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo });
    const fake = clienteFake({ base: () => baseInfo([]) });

    const res = await reverificarAnuncioShopee(asDb(db), alvo(), deps(fake.client));

    expect(res?.acao).toBe(ACAO_REVERIFICACAO.removido);
    expect(res?.estadoAnuncio).toBe(ESTADO_ANUNCIO_SHOPEE.removido);
  });

  it('⚠️ NEAR-MISS: uma linha ILEGÍVEL (o sentinela null) também é removido', async () => {
    const db = new FakeDb();
    semearLink(db, { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo });
    const fake = clienteFake({ base: () => baseInfo([null]) });

    const res = await reverificarAnuncioShopee(asDb(db), alvo(), deps(fake.client));

    expect(res?.acao).toBe(ACAO_REVERIFICACAO.removido);
  });

  it('⚠️ NEAR-MISS: um erro transitório NÃO é removido — ele SOBE', async () => {
    const db = new FakeDb();
    semearLink(db, { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo });
    const fake = clienteFake({
      base: () => {
        throw erroApi('error_server', SHOPEE_ERROR_KIND.transient);
      },
    });

    await expect(reverificarAnuncioShopee(asDb(db), alvo(), deps(fake.client))).rejects.toThrow(
      ShopeeApiError,
    );
    expect(db.patches).toEqual([]);
  });

  it('⚠️ NEAR-MISS: error_item_not_found de outro KIND também SOBE', async () => {
    const db = new FakeDb();
    semearLink(db, { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo });
    const fake = clienteFake({
      base: () => {
        throw erroApi('error_item_not_found', SHOPEE_ERROR_KIND.transient);
      },
    });

    await expect(reverificarAnuncioShopee(asDb(db), alvo(), deps(fake.client))).rejects.toThrow(
      ShopeeApiError,
    );
  });

  it('removido resolve o aviso com motivo anuncio-removido', async () => {
    const db = new FakeDb();
    semearLink(db, { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo });
    await avisarAnuncioComViolacao(
      asDb(db),
      {
        integracaoId: INTEGRACAO,
        produtoId: PAI,
        itemId: ITEM_ID,
        motivo: MOTIVO_AVISO_ANUNCIO.violacao,
        violacaoTipo: 'Spam',
        prazoMs: PRAZO_MS,
      },
      { increment, nowMs: AGORA - 1000 },
    );
    const fake = clienteFake({
      base: () => {
        throw erroApi('error_item_not_found');
      },
    });

    const res = await reverificarAnuncioShopee(asDb(db), alvo(), deps(fake.client));

    expect(res?.avisoResolvido).toBe(true);
    const aviso = db.store[`avisos/${chaveAnuncioComViolacao(INTEGRACAO, PAI)}`]?.data;
    expect(aviso?.resolucaoMotivo).toBe('anuncio-removido');
    expect(aviso?.resolvidoEm).not.toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*  (4)(5)(6) the best-effort violation pull                                   */
/* -------------------------------------------------------------------------- */

describe('reverificarAnuncioShopee — o detalhe de violação é melhor-esforço', () => {
  it('"item_status does not match latest violation" mantém as violações ARMAZENADAS, e violacoesLidas é false', async () => {
    const db = new FakeDb();
    const armazenada = violacao({ violation_type: 'Counterfeit' });
    semearLink(db, {
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado,
      violations: [armazenada],
    });
    const fake = clienteFake({
      base: () => baseInfo([linhaBase()]),
      violacoes: () => {
        throw new ShopeeApiError(
          'Shopee /product/get_item_violation_info respondeu error_param (HTTP 200) — ' +
            'item_status does not match latest violation',
          {
            code: 'error_param',
            kind: SHOPEE_ERROR_KIND.other,
            httpStatus: 200,
            path: '/api/v2/product/get_item_violation_info',
          },
        );
      },
    });

    const res = await reverificarAnuncioShopee(asDb(db), alvo(), deps(fake.client));

    expect(res?.violacoesLidas).toBe(false);
    expect(res?.violacoes).toHaveLength(1);
    expect(res?.violacoes[0]?.violation_type).toBe('Counterfeit');
    // The stored rows are left EXACTLY as they were: neither key rides the patch.
    const patch = patchesDoLink(db)[0];
    expect(Object.keys(patch ?? {})).not.toContain('violations');
    expect(Object.keys(patch ?? {})).not.toContain('violacoesLidasEm');
    expect(avisos.some((args) => String(args[0]).includes('recusou'))).toBe(true);
    // The warn carries the CODE and no body.
    expect(logInteiro()).toContain('error_param');
    expect(logInteiro()).not.toContain('does not match latest violation');
  });

  it('um fail_error por ENTRADA vale o mesmo que a recusa de envelope', async () => {
    const db = new FakeDb();
    const armazenada = violacao({ violation_type: 'Counterfeit' });
    semearLink(db, {
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado,
      violations: [armazenada],
    });
    const fake = clienteFake({
      base: () => baseInfo([linhaBase()]),
      violacoes: () => violationInfo({ fail_error: 'error_item_not_found', fail_message: null }),
    });

    const res = await reverificarAnuncioShopee(asDb(db), alvo(), deps(fake.client));

    expect(res?.violacoesLidas).toBe(false);
    expect(res?.violacoes[0]?.violation_type).toBe('Counterfeit');
    expect(logInteiro()).toContain('error_item_not_found');
  });

  it('uma resposta SEM linha para o id vale o mesmo — nem leitura, nem erro', async () => {
    const db = new FakeDb();
    semearLink(db, { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado });
    const fake = clienteFake({
      base: () => baseInfo([linhaBase()]),
      violacoes: () => ({ item_list: [] }) as unknown as ShopeeItemViolationInfo,
    });

    const res = await reverificarAnuncioShopee(asDb(db), alvo(), deps(fake.client));

    expect(res?.violacoesLidas).toBe(false);
    expect(res?.violacoes).toEqual([]);
  });

  it('⚠️ um erro transitório do violation info SOBE — ele não é best-effort para tudo', async () => {
    const db = new FakeDb();
    semearLink(db, { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado });
    const fake = clienteFake({
      base: () => baseInfo([linhaBase()]),
      violacoes: () => {
        throw new ShopeeRateLimitError('Shopee respondeu error_limit (HTTP 200)', {
          code: 'error_limit',
          kind: 'burst',
          httpStatus: 200,
          path: '/api/v2/product/get_item_violation_info',
        });
      },
    });

    await expect(reverificarAnuncioShopee(asDb(db), alvo(), deps(fake.client))).rejects.toThrow(
      ShopeeRateLimitError,
    );
    expect(db.patches).toEqual([]);
  });

  it('⚠️ um ShopeeSchemaError do violation info SOBE também', async () => {
    const db = new FakeDb();
    semearLink(db, { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado });
    const fake = clienteFake({
      base: () => baseInfo([linhaBase()]),
      violacoes: () => {
        throw new ShopeeSchemaError('corpo fora do formato', {
          campos: ['response.item_list'],
          httpStatus: 200,
          path: '/api/v2/product/get_item_violation_info',
        });
      },
    });

    await expect(reverificarAnuncioShopee(asDb(db), alvo(), deps(fake.client))).rejects.toThrow(
      ShopeeSchemaError,
    );
  });

  it('as duas grafias de deboost chegam pela MESMA função compartilhada', async () => {
    const db = new FakeDb();
    semearLink(db, { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo, deboost: false });
    const fake = clienteFake({
      base: () => baseInfo([linhaBase({ deboost: 'TRUE' })]),
      violacoes: () =>
        violationInfo({
          item_status_details: null,
          deboost_details: null,
          // ⚠️ Push 18's SAMPLE spelling — declared, never folded into the other.
          deboosted_details: [detalhe({ violation_type: 'PoorImage' })],
        }),
    });

    const res = await reverificarAnuncioShopee(asDb(db), alvo(), deps(fake.client));

    expect(res?.violacoes).toHaveLength(1);
    expect(res?.violacoes[0]?.kind).toBe('deboost');
    expect(res?.deboost).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  (7)(8)(9) the model leg                                                    */
/* -------------------------------------------------------------------------- */

describe('reverificarAnuncioShopee — a perna de modelos', () => {
  it('has_model ⇒ get_model_list, e os filhos são atualizados POR model_id', async () => {
    const db = new FakeDb();
    semearLink(db, { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado });
    semearFilho(db, FILHO_A);
    semearLinkFilho(db, FILHO_A, { model_status: SHOPEE_MODEL_STATUS.unavailable });
    const fake = clienteFake({
      base: () => baseInfo([linhaBase({ has_model: true })]),
      // The row order is INVERTED relative to the stored tier_index: position must
      // decide nothing.
      modelos: () => modelList([modelo({ model_id: MODEL_B, tier_index: [1] }), modelo()]),
      violacoes: () => violationInfoVazio(),
    });

    const res = await reverificarAnuncioShopee(asDb(db), alvo(), deps(fake.client));

    expect(fake.ops).toEqual(['get_item_base_info', 'get_model_list', 'get_item_violation_info']);
    expect(res?.modelos).toEqual({ total: 2, atualizados: 1, ausentes: 0 });
    expect(db.store[`produtos/${FILHO_A}/variashopee/v-1`]?.data).toMatchObject({
      model_status: SHOPEE_MODEL_STATUS.normal,
      tier_index: [0],
      modeloAusenteEm: null,
    });
  });

  it('⚠️ um modelo que sumiu é MARCADO MODEL_UNAVAILABLE com carimbo, NUNCA apagado', async () => {
    const db = new FakeDb();
    semearLink(db, { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado });
    semearFilho(db, FILHO_A);
    semearLinkFilho(db, FILHO_A);
    const fake = clienteFake({
      base: () => baseInfo([linhaBase({ has_model: true })]),
      // MODEL_A is gone; only MODEL_B answers.
      modelos: () => modelList([modelo({ model_id: MODEL_B, tier_index: [1] })]),
      violacoes: () => violationInfoVazio(),
    });

    const res = await reverificarAnuncioShopee(asDb(db), alvo(), deps(fake.client));

    const caminhoFilho = `produtos/${FILHO_A}/variashopee/v-1`;
    // ⚠️ The document STAYS: a delete throws away the member's sku and attributes
    // that a republish would have to rebuild from nothing.
    expect(db.store[caminhoFilho]).toBeDefined();
    expect(db.store[caminhoFilho]?.data).toMatchObject({
      model_id: MODEL_A,
      model_status: SHOPEE_MODEL_STATUS.unavailable,
      modeloAusenteEm: AGORA,
    });
    expect(res?.modelos).toEqual({ total: 1, atualizados: 0, ausentes: 1 });
  });

  it('⚠️ NEAR-MISS: um modelo que voltou limpa modeloAusenteEm em vez de deixar a marca', async () => {
    const db = new FakeDb();
    semearLink(db, { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado });
    semearFilho(db, FILHO_A);
    semearLinkFilho(db, FILHO_A, {
      model_status: SHOPEE_MODEL_STATUS.unavailable,
      modeloAusenteEm: AGORA - 86_400_000,
    });
    const fake = clienteFake({
      base: () => baseInfo([linhaBase({ has_model: true })]),
      modelos: () => modelList([modelo()]),
      violacoes: () => violationInfoVazio(),
    });

    const res = await reverificarAnuncioShopee(asDb(db), alvo(), deps(fake.client));

    expect(db.store[`produtos/${FILHO_A}/variashopee/v-1`]?.data).toMatchObject({
      model_status: SHOPEE_MODEL_STATUS.normal,
      modeloAusenteEm: null,
    });
    expect(res?.modelos).toEqual({ total: 1, atualizados: 1, ausentes: 0 });
  });

  it('⚠️ NEAR-MISS: has_model FALSO não gasta get_model_list', async () => {
    const db = new FakeDb();
    semearLink(db, { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado });
    semearFilho(db, FILHO_A);
    semearLinkFilho(db, FILHO_A);
    const fake = clientePadrao({ base: () => baseInfo([linhaBase({ has_model: false })]) });

    const res = await reverificarAnuncioShopee(asDb(db), alvo(), deps(fake.client));

    expect(fake.ops).toEqual(['get_item_base_info', 'get_item_violation_info']);
    expect(res?.modelos).toBeNull();
  });

  it('chamadasShopee conta 2 sem modelos e 3 com', async () => {
    const dbSem = new FakeDb();
    semearLink(dbSem, { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado });
    const semModelos = clientePadrao();
    const a = await reverificarAnuncioShopee(asDb(dbSem), alvo(), deps(semModelos.client));
    expect(a?.chamadasShopee).toBe(2);

    const dbCom = new FakeDb();
    semearLink(dbCom, { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado });
    semearFilho(dbCom, FILHO_B);
    semearLinkFilho(dbCom, FILHO_B);
    const comModelos = clienteFake({
      base: () => baseInfo([linhaBase({ has_model: true })]),
      modelos: () => modelList([modelo()]),
      violacoes: () => violationInfoVazio(),
    });
    const b = await reverificarAnuncioShopee(asDb(dbCom), alvo(), deps(comModelos.client));
    expect(b?.chamadasShopee).toBe(3);
  });

  it('a recusa do violation info AINDA conta como chamada gasta', async () => {
    const db = new FakeDb();
    semearLink(db, { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado });
    const fake = clienteFake({
      base: () => baseInfo([linhaBase()]),
      violacoes: () => {
        throw erroApi('error_param');
      },
    });

    const res = await reverificarAnuncioShopee(asDb(db), alvo(), deps(fake.client));

    expect(res?.chamadasShopee).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/*  (10) the diff                                                              */
/* -------------------------------------------------------------------------- */

describe('reverificarAnuncioShopee — o diff campo a campo', () => {
  it('uma leitura idêntica à armazenada escreve NADA e responde ignorado-sem-mudanca', async () => {
    const db = new FakeDb();
    semearLink(db, { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado });
    const fake = clientePadrao();

    const primeiro = await reverificarAnuncioShopee(asDb(db), alvo(), deps(fake.client));
    expect(primeiro?.acao).toBe(ACAO_REVERIFICACAO.atualizado);
    const escritasDepoisDoPrimeiro = patchesDoLink(db).length;

    // The SAME reading again — the wire did not move and neither does the document.
    const segundo = await reverificarAnuncioShopee(
      asDb(db),
      alvo(),
      deps(fake.client, AGORA + 5000),
    );

    expect(segundo?.acao).toBe(ACAO_REVERIFICACAO.ignoradoSemMudanca);
    expect(patchesDoLink(db)).toHaveLength(escritasDepoisDoPrimeiro);
    // ⚠️ `ultimaModificacao` did NOT advance: an empty patch is never sent.
    expect(db.store[CAMINHO_LINK]?.data.ultimaModificacao).toBe(AGORA);
  });

  it('só o campo que mudou entra no patch — mais ultimaModificacao', async () => {
    const db = new FakeDb();
    semearLink(db, { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado });
    const fake = clientePadrao();
    await reverificarAnuncioShopee(asDb(db), alvo(), deps(fake.client));

    // Only the condition moves on the second read.
    const outro = clientePadrao({ base: () => baseInfo([linhaBase({ condition: 'USED' })]) });
    const res = await reverificarAnuncioShopee(asDb(db), alvo(), deps(outro.client, AGORA + 1000));

    expect(res?.acao).toBe(ACAO_REVERIFICACAO.atualizado);
    expect(patchesDoLink(db).at(-1)).toEqual({
      condition: 'USED',
      ultimaModificacao: AGORA + 1000,
    });
  });

  it('um `violations` armazenado ILEGÍVEL é sempre DIFERENTE — ele é substituído', async () => {
    const db = new FakeDb();
    semearLink(db, {
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
      item_status: SHOPEE_ITEM_STATUS.normal,
      deboost: false,
      condition: 'NEW',
      // Not an array of objects at all — a migrated row nobody can parse.
      violations: 'lixo',
    });
    const fake = clientePadrao();

    const res = await reverificarAnuncioShopee(asDb(db), alvo(), deps(fake.client));

    expect(res?.acao).toBe(ACAO_REVERIFICACAO.atualizado);
    expect(patchesDoLink(db)[0]).toMatchObject({ violacoesLidasEm: AGORA });
  });

  it('⚠️ PAR: duas leituras de violação iguais são IGUAIS para mesmasViolacoes', () => {
    expect(mesmasViolacoes([violacao()], [violacao()])).toBe(true);
    expect(mesmasViolacoes([], [])).toBe(true);
  });

  it.each([
    ['o prazo um milissegundo à frente', violacao({ fix_deadline_time: PRAZO_MS + 1 })],
    ['o tipo com outra caixa', violacao({ violation_type: 'spam' })],
    ['o kind do outro array', violacao({ kind: 'deboost' })],
    ['uma categoria sugerida', violacao({ suggested_category: [] })],
  ])('⚠️ NEAR-MISS: %s é DISTINTO', (_nome, outra) => {
    expect(mesmasViolacoes([violacao()], [outra])).toBe(false);
  });

  it('⚠️ NEAR-MISS: as MESMAS duas linhas em ORDEM diferente são DISTINTAS', () => {
    const a = violacao({ violation_type: 'Spam' });
    const b = violacao({ violation_type: 'Counterfeit', kind: 'deboost' });
    expect(mesmasViolacoes([a, b], [b, a])).toBe(false);
    expect(mesmasViolacoes([a, b], [a, b])).toBe(true);
  });

  it('⚠️ NEAR-MISS: suggested_category null e [] são DIFERENTES', () => {
    expect(
      mesmasViolacoes(
        [violacao({ suggested_category: null })],
        [violacao({ suggested_category: [] })],
      ),
    ).toBe(false);
  });

  it('⚠️ NEAR-MISS: uma categoria sugerida com outro NOME é DISTINTA', () => {
    const base = [{ category_id: 100_017, category_name: 'Camisetas' }];
    const outra = [{ category_id: 100_017, category_name: 'Regatas' }];
    expect(
      mesmasViolacoes(
        [violacao({ suggested_category: base })],
        [violacao({ suggested_category: outra })],
      ),
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  (11) the aviso resolver                                                    */
/* -------------------------------------------------------------------------- */

describe('reverificarAnuncioShopee — o aviso', () => {
  async function comAvisoAberto(db: FakeDb): Promise<void> {
    await avisarAnuncioComViolacao(
      asDb(db),
      {
        integracaoId: INTEGRACAO,
        produtoId: PAI,
        itemId: ITEM_ID,
        motivo: MOTIVO_AVISO_ANUNCIO.violacao,
        violacaoTipo: 'Spam',
        prazoMs: PRAZO_MS,
      },
      { increment, nowMs: AGORA - 1000 },
    );
  }

  it('NORMAL e sem deboost RESOLVE o aviso', async () => {
    const db = new FakeDb();
    semearLink(db, { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado });
    await comAvisoAberto(db);
    const fake = clienteFake({
      base: () => baseInfo([linhaBase()]),
      violacoes: () => violationInfoVazio(),
    });

    const res = await reverificarAnuncioShopee(asDb(db), alvo(), deps(fake.client));

    expect(res?.avisoResolvido).toBe(true);
    const aviso = db.store[`avisos/${chaveAnuncioComViolacao(INTEGRACAO, PAI)}`]?.data;
    expect(aviso?.resolucaoMotivo).toBe('anuncio-normalizado');
  });

  it('⚠️ NEAR-MISS: NORMAL COM deboost não resolve', async () => {
    const db = new FakeDb();
    semearLink(db, { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo });
    await comAvisoAberto(db);
    const fake = clienteFake({
      base: () => baseInfo([linhaBase({ deboost: true })]),
      violacoes: () => violationInfoVazio(),
    });

    const res = await reverificarAnuncioShopee(asDb(db), alvo(), deps(fake.client));

    expect(res?.avisoResolvido).toBe(false);
    expect(
      db.store[`avisos/${chaveAnuncioComViolacao(INTEGRACAO, PAI)}`]?.data.resolvidoEm,
    ).toBeNull();
  });

  it('⚠️ NEAR-MISS: NORMAL com uma violação lida não resolve', async () => {
    const db = new FakeDb();
    semearLink(db, { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo });
    await comAvisoAberto(db);
    const fake = clientePadrao();

    const res = await reverificarAnuncioShopee(asDb(db), alvo(), deps(fake.client));

    expect(res?.avisoResolvido).toBe(false);
  });

  it('o resolvido é uma TRANSIÇÃO — sem aviso aberto responde false', async () => {
    const db = new FakeDb();
    semearLink(db, { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado });
    const fake = clienteFake({
      base: () => baseInfo([linhaBase()]),
      violacoes: () => violationInfoVazio(),
    });

    const res = await reverificarAnuncioShopee(asDb(db), alvo(), deps(fake.client));

    expect(res?.avisoResolvido).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  the write mechanism                                                        */
/* -------------------------------------------------------------------------- */

describe('reverificarAnuncioShopee — a escrita', () => {
  it('o merge é mergeIfExists — um link apagado no meio não é ressuscitado', async () => {
    const db = new FakeDb();
    semearLink(db, { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado });
    const fake = clienteFake({
      base: () => baseInfo([linhaBase()]),
      violacoes: () => {
        delete db.store[CAMINHO_LINK];
        return violationInfoVazio();
      },
    });

    const res = await reverificarAnuncioShopee(asDb(db), alvo(), deps(fake.client));

    expect(db.store[CAMINHO_LINK]).toBeUndefined();
    expect(avisos.some((args) => String(args[0]).includes('desapareceu'))).toBe(true);
    expect(res?.acao).toBe(ACAO_REVERIFICACAO.atualizado);
  });
});
