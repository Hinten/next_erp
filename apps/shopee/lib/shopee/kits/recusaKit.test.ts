import { describe, expect, it, vi } from 'vitest';

import {
  SHOPEE_ADD_KIT_ITEM_PATH,
  SHOPEE_ERROR_KIND,
  SHOPEE_SURFACE,
  ShopeeApiError,
  ShopeeApiPartialError,
  ShopeeConfigError,
  ShopeeHttpError,
  ShopeeNetworkError,
  ShopeeOperacaoNaoServidaError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  ShopeeSchemaError,
  type ShopeeAddKitItemRequest,
  type ShopeeClient,
  createShopeeClient,
  resolveShopeeHosts,
  shopeeErrorFromEnvelope,
} from '@delfrance/integrations-shopee';

import { MOTIVO_PROBLEMA_PUBLICACAO } from '../anuncios/errosPublicacao';
import { problemasDeErroShopee } from '../anuncios/problemasPublicacao';
import { fraseCanonicaShopee } from '../core/recusaShopee';
import { lerFixture } from '../fixtures/wireCorpus';
import {
  MOTIVO_RECUSA_KIT_TRANSITORIO,
  TABELA_RECUSA_KIT,
  classificarRecusaKit,
  desfechoDeCriacaoDeKit,
  problemasDaRecusaKit,
  type MotivoRecusaKit,
} from './recusaKit';

/* -------------------------------------------------------------------------- */
/*  Fixtures — ids by ROLE (kit 2500139870/2000458820, A 2500139871/2000458821,  */
/*  B 2500139872 with hidden model 2000458829); never a real id or credential. */
/* -------------------------------------------------------------------------- */

/** The committed `__wire__` bodies this suite serves (W2b's names, reconcile §2.4). */
const FX = {
  addKitSucesso: 'add_kit_item.sg.json',
  addKitInstavel: 'add_kit_item.sg-too-many-connections.json',
  addKitCorpoVazio: 'add_kit_item.sg-corpo-vazio.json',
  addKitDoisPrincipais: 'add_kit_item.sg-dois-principais.json',
  updateKitSemItemId: 'update_kit_item.sg-sem-item-id.json',
  updateKitParcial: 'update_kit_item.sg-parcial.json',
  updateKitAnexar: 'update_kit_item.sg-anexar.json',
  updateKitQuantidadeIgnorada: 'update_kit_item.sg-quantidade-ignorada.json',
  kitInfoQuantidadeIgnorada: 'get_kit_item_info.sg-quantidade-ignorada.json',
  kitInfoNaoKit: 'get_kit_item_info.sg-nao-kit.json',
  imagemDesligada: 'generate_kit_image.sg-toggle-fechado.json',
  imagemChavesDoDoc: 'generate_kit_image.sg-chaves-do-doc.json',
  imagemSemModelId: 'generate_kit_image.sg-sem-model-id.json',
  imagemUmComponente: 'generate_kit_image.sg-um-componente.json',
  estoqueDeKit: 'update_stock.sg-kit.json',
  excluirKit: 'delete_item.sg-kit.json',
  precoDeKit: 'update_price.sg-kit.json',
  despublicarKit: 'unlist_item.sg-kit.json',
} as const;

const KIT = 2500139870;
const MODELO_KIT = 2000458820;
const ITEM_A = 2500139871;
const MODELO_A = 2000458821;
const ITEM_B = 2500139872;
const MODELO_OCULTO_B = 2000458829;

/** A create the package guards accept: ONE tier, ONE model, ONE main across the kit. */
const CRIAR_KIT: ShopeeAddKitItemRequest = {
  sync_setting: { auto_sync_dts: true },
  item_setting: {
    item_name: 'Kit de teste',
    images: { image_id_list: ['br-11134207-7r98o-lzri4neb5vcv18'] },
    description_type: 'normal',
    description: 'Descrição do kit de teste',
    logistic_info: [{ logistic_id: 90003, enabled: true }],
    weight: 1.5,
    item_sku: 'SONDA-KIT',
    tier_variation_list: [{ name: 'Kit', option_list: [{ option: 'Padrão' }] }],
    model_list: [
      {
        tier_index: [0],
        original_price: 49.9,
        model_sku: 'SONDA-KIT-M1',
        component_list: [
          {
            component_item_id: ITEM_A,
            component_model_id: MODELO_A,
            quantity: 1,
            main_component: true,
          },
          { component_item_id: ITEM_B, quantity: 2 },
        ],
      },
    ],
  },
};

/** A partial price update — no tier list, one existing model (probe #2's shape). */
const ATUALIZAR_KIT = {
  item_id: KIT,
  item_setting: {
    model_list: [{ model_id: MODELO_KIT, tier_index: [0] as [number], original_price: 33 }],
  },
};

/**
 * The package's REAL client — signer, `shopeeCall`, envelope builder and every
 * guard — with only `fetch` doubled: it answers `corpo` (verbatim) at `status`
 * for any path, and records each path it was asked for.
 */
function clienteServindo(
  corpo: unknown,
  status = 200,
): { readonly client: ShopeeClient; readonly caminhos: string[] } {
  const caminhos: string[] = [];
  const transporte = vi.fn<typeof globalThis.fetch>((entrada) => {
    const url =
      typeof entrada === 'string' ? entrada : entrada instanceof URL ? entrada.href : entrada.url;
    caminhos.push(new URL(url).pathname);
    return Promise.resolve(
      new Response(typeof corpo === 'string' ? corpo : JSON.stringify(corpo), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  const client = createShopeeClient({
    partnerId: 1000001,
    partnerKey: 'chave-de-teste-nao-e-credencial',
    hosts: resolveShopeeHosts({ sandbox: true }),
    shopId: 987654,
    getAccessToken: () => Promise.resolve('access-inventado'),
    fetch: transporte,
  });
  return { client, caminhos };
}

/** What `p` rejected with — and a failure of the TEST when it resolved instead. */
function erroDe(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error('a operação deveria ter falhado');
    },
    (err: unknown) => err,
  );
}

/** The error the transport really builds for an envelope (HTTP 200, a business call). */
function doEnvelope(error: string, message: string | null): ShopeeApiError {
  return shopeeErrorFromEnvelope(
    { error, message, request_id: null, warning: null },
    { path: SHOPEE_ADD_KIT_ITEM_PATH, httpStatus: 200, surface: SHOPEE_SURFACE.business },
  );
}

const M = MOTIVO_PROBLEMA_PUBLICACAO;

/* -------------------------------- the table -------------------------------- */

describe('TABELA_RECUSA_KIT — D1 §3.2 verbatim, mais a linha P2-a', () => {
  it('os códigos e as agulhas na ordem de D1, salvo a #2 TRANSITÓRIA na frente, e "mupltiple main sku" por último', () => {
    expect(TABELA_RECUSA_KIT.map((l) => [l.codigo, l.agulha, l.motivo])).toEqual([
      ['error_busi', 'too many connections', 'instabilidade-shopee'],
      ['error_busi', 'invalid product setting', 'operacao-invalida-para-kit'],
      ['error_server', 'generate kit image toggle closed', 'imagem-de-kit-desligada'],
      ['.', 'product is not found', 'kit-inexistente'],
      ['error_busi_cannot_edit_vsku', null, 'kit-bloqueado-pela-shopee'],
      ['error_busi', 'the amount of component in this kit variation', 'faixa-de-componentes'],
      ['error_price_out_of_range', null, 'preco-fora-da-faixa'],
      ['error_param', 'the information you queried is not found', 'kit-inexistente'],
      ['error_busi', 'mupltiple main sku', 'kit-principal-duplicado'],
    ]);
  });

  it('a grafia da Shopee é BYTE A BYTE: "mupltiple", nunca o "multiple" corrigido', () => {
    const agulhas = TABELA_RECUSA_KIT.map((l) => l.agulha);
    expect(agulhas).toContain('mupltiple main sku');
    expect(agulhas).not.toContain('multiple main sku');
  });

  it('nenhuma agulha contém outra (toda linha casa pela própria agulha), e cada uma é ponto fixo da dobra', () => {
    const agulhas = TABELA_RECUSA_KIT.flatMap((l) => (l.agulha === null ? [] : [l.agulha]));
    expect(agulhas).toHaveLength(7);
    for (const a of agulhas) {
      expect(a.length, a).toBeGreaterThan(0);
      expect(fraseCanonicaShopee(a), a).toBe(a);
      for (const b of agulhas) {
        if (a !== b) expect(a.includes(b), `${a} ⊃ ${b}`).toBe(false);
      }
    }
  });

  it('o vocabulário DERIVADO: oito motivos, e só um é transitório', () => {
    const motivos = new Set<string>(TABELA_RECUSA_KIT.map((l) => l.motivo));
    expect([...motivos].sort()).toEqual([
      'faixa-de-componentes',
      'imagem-de-kit-desligada',
      'instabilidade-shopee',
      'kit-bloqueado-pela-shopee',
      'kit-inexistente',
      'kit-principal-duplicado',
      'operacao-invalida-para-kit',
      'preco-fora-da-faixa',
    ]);
    expect([...MOTIVO_RECUSA_KIT_TRANSITORIO]).toEqual(['instabilidade-shopee']);
    // Todo motivo da tabela é membro do vocabulário PERSISTIDO de problema.
    const vocabulario = new Set<string>(Object.values(M));
    for (const m of motivos) expect(vocabulario.has(m), m).toBe(true);
  });
});

/* ------------------- the committed captures, REAL ops ---------------------- */

describe('as capturas commitadas pelas operações REAIS do pacote (fetch → envelope → erro)', () => {
  const casos: readonly (readonly [
    string,
    (c: ShopeeClient) => Promise<unknown>,
    MotivoRecusaKit | null,
    'nao-criado' | 'incerto',
  ])[] = [
    // M68: o transitório MEDIDO — a criação pode ter acontecido.
    [FX.addKitInstavel, (c) => c.addKitItem(CRIAR_KIT), M.instabilidadeShopee, 'incerto'],
    // M73: a sonda #2 — dois principais no kit; nada foi criado.
    [
      FX.addKitDoisPrincipais,
      (c) => c.addKitItem(CRIAR_KIT),
      M.kitPrincipalDuplicado,
      'nao-criado',
    ],
    // Deriva de contrato (os guardas tornam inalcançável): desconhecido ⇒ incerto.
    [FX.addKitCorpoVazio, (c) => c.addKitItem(CRIAR_KIT), null, 'incerto'],
    [FX.updateKitSemItemId, (c) => c.updateKitItem(ATUALIZAR_KIT), M.kitInexistente, 'nao-criado'],
    [
      FX.kitInfoNaoKit,
      (c) => c.getKitItemInfo({ itemId: 2500139861 }),
      M.kitInexistente,
      'nao-criado',
    ],
    [
      FX.imagemDesligada,
      (c) =>
        c.generateKitImage({
          componentes: [
            { itemId: ITEM_A, modelId: MODELO_A },
            { itemId: ITEM_B, modelId: MODELO_OCULTO_B },
          ],
        }),
      M.imagemDeKitDesligada,
      'nao-criado',
    ],
    ...[FX.imagemChavesDoDoc, FX.imagemSemModelId, FX.imagemUmComponente].map(
      (fx) =>
        [
          fx,
          (c: ShopeeClient) =>
            c.generateKitImage({
              componentes: [
                { itemId: ITEM_A, modelId: MODELO_A },
                { itemId: ITEM_B, modelId: MODELO_OCULTO_B },
              ],
            }),
          null,
          'incerto',
        ] as const,
    ),
    [
      FX.estoqueDeKit,
      (c) =>
        c.updateStock({
          item_id: KIT,
          stock_list: [{ model_id: MODELO_KIT, seller_stock: [{ stock: 5 }] }],
        }),
      M.operacaoInvalidaParaKit,
      'nao-criado',
    ],
  ];

  it.each(casos)('%s', async (fixture, operar, motivo, desfecho) => {
    const { client, caminhos } = clienteServindo(lerFixture(fixture));

    const err = await erroDe(operar(client));

    expect(caminhos).toHaveLength(1);
    expect(err).toBeInstanceOf(ShopeeApiError);
    const api = err as ShopeeApiError;
    expect(classificarRecusaKit(api)).toBe(motivo);
    expect(desfechoDeCriacaoDeKit(api)).toBe(desfecho);
    const problemas = problemasDaRecusaKit(api);
    if (motivo === null) expect(problemas).toBeNull();
    else expect(problemas).toEqual([expect.objectContaining({ motivo })]);
  });

  it('o `update_stock` num kit é o PARCIAL da Shopee (falha + failure_list) — e ainda é a linha #1', async () => {
    const { client } = clienteServindo(lerFixture(FX.estoqueDeKit));
    const err = await erroDe(
      client.updateStock({
        item_id: KIT,
        stock_list: [{ model_id: MODELO_KIT, seller_stock: [{ stock: 5 }] }],
      }),
    );
    expect(err).toBeInstanceOf(ShopeeApiPartialError);
    expect(classificarRecusaKit(err as ShopeeApiError)).toBe(M.operacaoInvalidaParaKit);
  });

  it('R-j — a recusa da CHAVE desligada é `transient` no pacote: o classificador de passo 11 a descarta, o de kit não', async () => {
    const { client } = clienteServindo(lerFixture(FX.imagemDesligada));
    const err = (await erroDe(
      client.generateKitImage({
        componentes: [
          { itemId: ITEM_A, modelId: MODELO_A },
          { itemId: ITEM_B, modelId: MODELO_OCULTO_B },
        ],
      }),
    )) as ShopeeApiError;

    // `KIND_BY_CODE` fica como está (error_server ⇒ transient) — é por isso que o
    // braço de kit chama este classificador ANTES do de passo 11.
    expect(err.kind).toBe(SHOPEE_ERROR_KIND.transient);
    expect(problemasDeErroShopee(err)).toEqual([]);
    expect(problemasDaRecusaKit(err)).toEqual([
      {
        campo: 'image',
        motivo: 'imagem-de-kit-desligada',
        mensagem: 'a geração de imagem de kit está desligada nesta loja',
      },
    ]);
  });

  it('as respostas de SUCESSO resolvem pela operação real — um 200 nunca chega ao classificador', async () => {
    // P2-c: um 200 de `update_kit_item` não prova que a receita foi aplicada (a
    // quantidade é ignorada em silêncio); só uma releitura diz. Aqui só se
    // afirma que nenhum desses corpos é lido como falha.
    const resolvidos = [
      clienteServindo(lerFixture(FX.addKitSucesso)).client.addKitItem(CRIAR_KIT),
      clienteServindo(lerFixture(FX.updateKitParcial)).client.updateKitItem(ATUALIZAR_KIT),
      clienteServindo(lerFixture(FX.updateKitAnexar)).client.updateKitItem(ATUALIZAR_KIT),
      clienteServindo(lerFixture(FX.updateKitQuantidadeIgnorada)).client.updateKitItem(
        ATUALIZAR_KIT,
      ),
      clienteServindo(lerFixture(FX.kitInfoQuantidadeIgnorada)).client.getKitItemInfo({
        itemId: KIT,
      }),
      clienteServindo(lerFixture(FX.excluirKit)).client.deleteItem({ item_id: KIT }),
      clienteServindo(lerFixture(FX.precoDeKit)).client.updatePrice({
        item_id: KIT,
        price_list: [{ model_id: MODELO_KIT, original_price: 33 }],
      }),
      clienteServindo(lerFixture(FX.despublicarKit)).client.unlistItem({
        item_list: [{ item_id: KIT, unlist: true }],
      }),
    ];
    const criado = await resolvidos[0];
    expect(criado).toMatchObject({ response: { item_id: KIT } });
    await expect(Promise.all(resolvidos)).resolves.toHaveLength(8);
  });
});

/* ---------------------- PAIRS and NEAR-MISSES (#1372) --------------------- */

describe('classificarRecusaKit — PARES e QUASE-ACERTOS (escopo das duas dobras)', () => {
  it.each<[string, string, string | null, MotivoRecusaKit | null]>([
    // M66 — a frase da chave desligada só vale sob error_server.
    [
      'a chave desligada (par)',
      'product.error_server',
      'Internal error. generate kit image toggle closed.',
      'imagem-de-kit-desligada',
    ],
    [
      'M66 — a MESMA frase sob error_param',
      'product.error_param',
      'generate kit image toggle closed.',
      null,
    ],
    // M73 — "mupltiple main sku" só sob error_busi, e só na grafia da Shopee.
    [
      'P2-a (par)',
      'product.error_busi',
      'external error: mupltiple main sku itemId:ModelId',
      'kit-principal-duplicado',
    ],
    ['M73 — a MESMA frase sob error_param', 'product.error_param', 'mupltiple main sku', null],
    [
      'M73 — a grafia CORRIGIDA não é a frase medida',
      'product.error_busi',
      'multiple main sku',
      null,
    ],
    // As outras linhas, cada uma com a vizinha de código.
    [
      '#1 (par)',
      'product.error_busi',
      'Invalid product setting. Please verify.',
      'operacao-invalida-para-kit',
    ],
    ['#1 sob error_param', 'product.error_param', 'Invalid product setting. Please verify.', null],
    [
      '#1 em CAIXA ALTA (a frase dobra a caixa)',
      'error_busi',
      'INVALID PRODUCT SETTING',
      'operacao-invalida-para-kit',
    ],
    ['⛔ o CÓDIGO não dobra a caixa', 'Product.Error_Busi', 'Invalid product setting', null],
    [
      '#2 (par)',
      'product.error_busi',
      'database error|Error 1040: Too many connections>',
      'instabilidade-shopee',
    ],
    ['#2 sob error_server', 'product.error_server', 'Too many connections', null],
    ['#4 (par)', '.', 'product is not found : invalid GetVirtualSKUInfoRequest', 'kit-inexistente'],
    ['#4 com o ponto acolchoado', ' . ', 'product is not found', 'kit-inexistente'],
    ["#4 sob 'x.'", 'x.', 'product is not found', null],
    ["#4 sob '..'", '..', 'product is not found', null],
    ['#4 o ponto com OUTRA frase', '.', 'virtual sku setting is empty', null],
    ['#5 só pelo código', 'error_busi_cannot_edit_vsku', null, 'kit-bloqueado-pela-shopee'],
    [
      '#5 com o módulo',
      'product.error_busi_cannot_edit_vsku',
      'Can not use OpenAPI to edit/create VSKU, please connect with your manager',
      'kit-bloqueado-pela-shopee',
    ],
    ['#5 um sufixo a mais', 'error_busi_cannot_edit_vsku_x', null, null],
    [
      '#6 (par)',
      'product.error_busi',
      'The amount of component in this Kit Variation should be more than 2 and less than 10',
      'faixa-de-componentes',
    ],
    [
      '#6 sob error_param',
      'product.error_param',
      'The amount of component in this Kit Variation should be more than 2',
      null,
    ],
    [
      '#7 só pelo código',
      'product.error_price_out_of_range',
      'Price should be within 1 to 100',
      'preco-fora-da-faixa',
    ],
    ['#7 um sufixo a mais', 'product.error_price_out_of_range_x', 'Price should be within', null],
    [
      '#8 (par), com o prefixo do envelope e os pontos finais',
      'error_param',
      'Wrong parameters, detail: The information you queried is not found..',
      'kit-inexistente',
    ],
    ['#8 sob error_busi', 'product.error_busi', 'The information you queried is not found.', null],
    ['um error_busi qualquer', 'product.error_busi', 'Something else entirely', null],
    ['sem frase nenhuma', 'product.error_busi', null, null],
    ['frase vazia', 'product.error_busi', '', null],
  ])('%s', (_caso, error, message, esperado) => {
    expect(classificarRecusaKit(doEnvelope(error, message))).toBe(esperado);
  });

  it('M67 — ⛔ a agulha só na NOSSA frase (`.message`), com `providerMessage: null` ⇒ null', () => {
    // `.message` é o texto formatado do pacote; casar nele provaria o que NÓS
    // escrevemos, nunca o que a Shopee disse.
    const err = new ShopeeApiError(
      'Shopee /api/v2/product/add_kit_item respondeu product.error_busi (HTTP 200) — Too many connections',
      {
        code: 'product.error_busi',
        kind: SHOPEE_ERROR_KIND.other,
        httpStatus: 200,
        path: SHOPEE_ADD_KIT_ITEM_PATH,
        providerMessage: null,
      },
    );
    expect(err.message).toContain('Too many connections');
    expect(classificarRecusaKit(err)).toBeNull();

    // O PAR: a mesma frase em `providerMessage` classifica.
    const par = new ShopeeApiError('qualquer coisa', {
      code: 'product.error_busi',
      kind: SHOPEE_ERROR_KIND.other,
      httpStatus: 200,
      path: SHOPEE_ADD_KIT_ITEM_PATH,
      providerMessage: 'Too many connections',
    });
    expect(classificarRecusaKit(par)).toBe('instabilidade-shopee');
  });
});

/* ------------- DUAS agulhas do MESMO código: o transitório vence ------------ */

describe('uma frase com DUAS agulhas do mesmo código — o TRANSITÓRIO vence (review do PR #1866)', () => {
  // A primeira linha que casa decide. Nenhuma captura junta as duas frases; o
  // risco é o SENTIDO do erro: ler como recusa permanente um create que pode ter
  // acontecido dá `nao-criado`, e um write não idempotente seria reenviado às cegas.
  const MISTA =
    'Failed to create product : external error: Invalid product setting. database error|Error 1040: Too many connections>';

  it.each<[string, string, MotivoRecusaKit, 'nao-criado' | 'incerto']>([
    ['#1 + #2, a permanente PRIMEIRO na frase', MISTA, 'instabilidade-shopee', 'incerto'],
    [
      '#2 + #1, a transitória primeiro na frase',
      'Error 1040: Too many connections; Invalid product setting.',
      'instabilidade-shopee',
      'incerto',
    ],
    // QUASE-ACERTOS: sem a agulha transitória INTEIRA, a #1 continua permanente.
    [
      '#1 sozinha',
      'Invalid product setting. Please verify.',
      'operacao-invalida-para-kit',
      'nao-criado',
    ],
    [
      '#1 + um "too many" que não é a agulha',
      'Invalid product setting: too many components',
      'operacao-invalida-para-kit',
      'nao-criado',
    ],
  ])('%s', (_caso, frase, motivo, desfecho) => {
    const err = doEnvelope('product.error_busi', frase);
    expect(classificarRecusaKit(err)).toBe(motivo);
    expect(desfechoDeCriacaoDeKit(err)).toBe(desfecho);
  });

  it('pela operação REAL: um `add_kit_item` com as duas frases ⇒ incerto (re-ler antes de reenviar)', async () => {
    // Corpo SINTÉTICO (fica dentro deste teste): a forma da captura M68 com a
    // frase da #1 antes da do banco.
    const { client, caminhos } = clienteServindo({
      error: 'product.error_busi',
      message: MISTA,
      warning: '',
    });
    const err = await erroDe(client.addKitItem(CRIAR_KIT));
    expect(caminhos).toEqual([SHOPEE_ADD_KIT_ITEM_PATH]);
    expect(err).toBeInstanceOf(ShopeeApiError);
    expect(classificarRecusaKit(err as ShopeeApiError)).toBe(M.instabilidadeShopee);
    expect(desfechoDeCriacaoDeKit(err)).toBe('incerto');
    expect(problemasDaRecusaKit(err)).toEqual([
      expect.objectContaining({ motivo: M.instabilidadeShopee }),
    ]);
  });

  it('a TABELA inteira: todo par transitória × permanente do MESMO código lê a transitória', () => {
    let pares = 0;
    for (const t of TABELA_RECUSA_KIT) {
      if (!MOTIVO_RECUSA_KIT_TRANSITORIO.has(t.motivo)) continue;
      for (const p of TABELA_RECUSA_KIT) {
        if (p.codigo !== t.codigo || MOTIVO_RECUSA_KIT_TRANSITORIO.has(p.motivo)) continue;
        const err = doEnvelope(`product.${t.codigo}`, `${p.agulha ?? ''} ${t.agulha ?? ''}`);
        expect(classificarRecusaKit(err), `${p.rotulo} + ${t.rotulo}`).toBe(t.motivo);
        expect(desfechoDeCriacaoDeKit(err), `${p.rotulo} + ${t.rotulo}`).toBe('incerto');
        pares += 1;
      }
    }
    // #1, #6 e P2-a contra a #2 — nunca um laço vazio.
    expect(pares).toBe(3);
  });
});

/* --------------------------- desfechoDeCriacaoDeKit ------------------------- */

describe('desfechoDeCriacaoDeKit — re-ler, nunca reenviar no mesmo pedido', () => {
  it('cada linha da tabela: o transitório é `incerto`, todo o resto `nao-criado`', () => {
    for (const linha of TABELA_RECUSA_KIT) {
      const err = doEnvelope(`product.${linha.codigo}`, linha.agulha ?? 'qualquer frase');
      expect(classificarRecusaKit(err), linha.rotulo).toBe(linha.motivo);
      expect(desfechoDeCriacaoDeKit(err), linha.rotulo).toBe(
        MOTIVO_RECUSA_KIT_TRANSITORIO.has(linha.motivo) ? 'incerto' : 'nao-criado',
      );
    }
  });

  it('o nosso guarda (ShopeeConfigError, ANTES do fetch) ⇒ nao-criado', async () => {
    const { client, caminhos } = clienteServindo(lerFixture(FX.addKitSucesso));
    const doisPrincipais: ShopeeAddKitItemRequest = {
      ...CRIAR_KIT,
      item_setting: {
        ...CRIAR_KIT.item_setting,
        model_list: [
          {
            tier_index: [0],
            original_price: 49.9,
            component_list: [
              {
                component_item_id: ITEM_A,
                component_model_id: MODELO_A,
                quantity: 1,
                main_component: true,
              },
              { component_item_id: ITEM_B, quantity: 2, main_component: true },
            ],
          },
        ],
      },
    };
    const err = await erroDe(client.addKitItem(doisPrincipais));
    expect(err).toBeInstanceOf(ShopeeConfigError);
    expect(caminhos).toEqual([]);
    expect(desfechoDeCriacaoDeKit(err)).toBe('nao-criado');
  });

  it('o limite de taxa e a autorização morta (recusados antes do handler) ⇒ nao-criado', () => {
    const limite = new ShopeeRateLimitError('limite', {
      code: 'error_limit',
      kind: 'burst',
      httpStatus: 429,
      path: SHOPEE_ADD_KIT_ITEM_PATH,
    });
    const morta = new ShopeeReauthRequiredError('morta', {
      code: 'error_auth',
      kind: SHOPEE_ERROR_KIND.reauth,
      httpStatus: 200,
      path: SHOPEE_ADD_KIT_ITEM_PATH,
    });
    expect(desfechoDeCriacaoDeKit(limite)).toBe('nao-criado');
    expect(desfechoDeCriacaoDeKit(morta)).toBe('nao-criado');
  });

  it('M69 — um 2xx cujo corpo não validou (ShopeeSchemaError) ⇒ incerto, nunca nao-criado', async () => {
    // A Shopee respondeu 200 sem `response.item_id`: o kit pode existir.
    const { client } = clienteServindo({ error: '', message: '', warning: '', response: {} });
    const err = await erroDe(client.addKitItem(CRIAR_KIT));
    expect(err).toBeInstanceOf(ShopeeSchemaError);
    expect(desfechoDeCriacaoDeKit(err)).toBe('incerto');
  });

  it('a rede, um HTML de borda, o 404 do gateway, um código desconhecido e um erro alheio ⇒ incerto', async () => {
    const semRede = createShopeeClient({
      partnerId: 1000001,
      partnerKey: 'chave-de-teste-nao-e-credencial',
      hosts: resolveShopeeHosts({ sandbox: true }),
      shopId: 987654,
      getAccessToken: () => Promise.resolve('access-inventado'),
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    const rede = await erroDe(semRede.addKitItem(CRIAR_KIT));
    expect(rede).toBeInstanceOf(ShopeeNetworkError);

    const borda = await erroDe(
      clienteServindo('<html>bad gateway</html>', 502).client.addKitItem(CRIAR_KIT),
    );
    expect(borda).toBeInstanceOf(ShopeeHttpError);

    const gateway = await erroDe(
      clienteServindo({ error: 'error_not_found' }, 404).client.addKitItem(CRIAR_KIT),
    );
    expect(gateway).toBeInstanceOf(ShopeeOperacaoNaoServidaError);

    for (const err of [
      rede,
      borda,
      gateway,
      doEnvelope('product.error_server', 'Something wrong. Please try later.'),
      new TypeError('bug nosso'),
    ]) {
      expect(desfechoDeCriacaoDeKit(err)).toBe('incerto');
    }
  });
});

/* ----------------------------- problemasDaRecusaKit ------------------------ */

describe('problemasDaRecusaKit — UMA entrada, com o campo e a frase pt-BR VERBATIM', () => {
  const ESPERADO: Readonly<Record<MotivoRecusaKit, readonly [string | null, string]>> = {
    'operacao-invalida-para-kit': [
      null,
      "a Shopee recusou esta operação em um kit ('Invalid product setting')",
    ],
    'instabilidade-shopee': [
      null,
      "a Shopee respondeu com instabilidade ('Too many connections'); a operação pode ter sido feita — rode exatamente o mesmo comando de novo daqui a 4 minutos",
    ],
    'imagem-de-kit-desligada': ['image', 'a geração de imagem de kit está desligada nesta loja'],
    'kit-inexistente': ['item_id', 'a Shopee não encontrou este kit'],
    'kit-bloqueado-pela-shopee': [
      'shop',
      "a Shopee não permite criar ou editar kits por API nesta loja/aplicativo ('Can not use OpenAPI to edit/create VSKU') — peça a liberação ao seu gerente Shopee",
    ],
    'faixa-de-componentes': [
      'component_list',
      'a Shopee recusou a quantidade de componentes de uma variação do kit',
    ],
    'kit-principal-duplicado': [
      'main_component',
      "a Shopee recusou dois componentes principais no mesmo kit ('mupltiple main sku')",
    ],
    'preco-fora-da-faixa': [
      'original_price',
      'a Shopee recusou o preço de uma variação do kit: está fora da faixa de preço da categoria',
    ],
  };

  it('cada linha da tabela produz o seu problema', () => {
    for (const linha of TABELA_RECUSA_KIT) {
      const err = doEnvelope(`product.${linha.codigo}`, linha.agulha ?? 'qualquer frase');
      const [campo, mensagem] = ESPERADO[linha.motivo];
      expect(problemasDaRecusaKit(err), linha.rotulo).toEqual([
        { campo, motivo: linha.motivo, mensagem },
      ]);
    }
  });

  it('a instabilidade não promete busca por SKU (L10-R3: a frase é neutra quanto ao braço)', () => {
    const [, mensagem] = ESPERADO['instabilidade-shopee'];
    expect(mensagem).not.toContain('SKU');
  });

  it('⛔ null — "não é nosso, siga adiante" — para o que não é recusa de kit', () => {
    expect(problemasDaRecusaKit(new ShopeeNetworkError('fetch falhou'))).toBeNull();
    expect(problemasDaRecusaKit(new TypeError('bug nosso'))).toBeNull();
    expect(
      problemasDaRecusaKit(doEnvelope('product.error_param', 'Item name is too long')),
    ).toBeNull();
  });
});
