import { type Mock, afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  type ShopeeMultipartBody,
  type ShopeeMultipartFile,
  type ShopeeTransport,
  type ShopeeWarning,
  shopeeCall,
} from '../src/call';
import {
  ShopeeApiError,
  ShopeeApiPartialError,
  ShopeeNetworkError,
  ShopeeRateLimitError,
  ShopeeSchemaError,
} from '../src/errors';

/** ⚠️ Invented. Never a real Shopee partner key. */
const TEST_PARTNER_KEY = 'chave-de-teste-nao-e-credencial';
const TEST_PARTNER_ID = 1000001;
const TEST_SHOP_ID = 987654;
const NOW_MS = 1_767_000_000_000;

const UPLOAD_PATH = '/api/v2/media_space/upload_image';

/**
 * ⚠️ `call.ts` is INTERNAL (`index.ts` deliberately does not re-export it), so
 * these tests import it by path. They exercise the transport DIRECTLY rather
 * than through `uploadImage`: the multipart branch is one mechanism shared by
 * every future file-posting operation, and pinning it at the operation would
 * pin the operation's guards instead.
 */
function transporte(
  fetchImpl: typeof globalThis.fetch,
  onWarning?: (w: ShopeeWarning) => void,
): ShopeeTransport {
  return {
    partnerId: TEST_PARTNER_ID,
    partnerKey: TEST_PARTNER_KEY,
    apiHost: 'https://partner.test-stable.shopeemobile.com',
    fetch: fetchImpl,
    now: () => NOW_MS,
    ...(onWarning === undefined ? {} : { onWarning }),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The `upload_image` page's own response sample, with a fixture image id. */
const UPLOAD_BODY = {
  error: '',
  message: null,
  warning: null,
  request_id: 'req-upload',
  response: {
    image_info: {
      image_id: 'img-de-teste-0001',
      image_url_list: [{ image_url_region: 'BR', image_url: 'https://cf.shopee.com.br/file/x' }],
    },
  },
};

const uploadSchema = z
  .object({
    response: z
      .object({ image_info: z.object({ image_id: z.string() }).passthrough() })
      .passthrough(),
  })
  .passthrough();

const bytesPng = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function multipart(
  extra: {
    readonly file?: Partial<ShopeeMultipartFile>;
    readonly fields?: Readonly<Record<string, string | undefined>>;
  } = {},
): ShopeeMultipartBody {
  return {
    file: {
      field: 'image',
      filename: 'produto-1.png',
      contentType: 'image/png',
      bytes: bytesPng(),
      ...extra.file,
    },
    ...(extra.fields === undefined ? {} : { fields: extra.fields }),
  };
}

function chamarUpload(
  fetchImpl: typeof globalThis.fetch,
  corpo: ShopeeMultipartBody = multipart(),
  path = UPLOAD_PATH,
) {
  return shopeeCall(transporte(fetchImpl), {
    method: 'POST',
    path,
    call: { class: 'public' },
    schema: uploadSchema,
    surface: 'business',
    multipart: corpo,
  });
}

type FetchMock = Mock<typeof globalThis.fetch>;

/** The `init` the transport handed `fetch`, with its body narrowed to a form. */
function formEnviado(fetchMock: FetchMock): FormData {
  const [, init] = fetchMock.mock.calls[0]!;
  expect(init?.body).toBeInstanceOf(FormData);
  return init?.body as FormData;
}

function cabecalhosEnviados(fetchMock: FetchMock): Record<string, string> {
  const [, init] = fetchMock.mock.calls[0]!;
  return (init?.headers ?? {}) as Record<string, string>;
}

function urlEnviada(fetchMock: FetchMock): URL {
  return new URL(String(fetchMock.mock.calls[0]![0]));
}

afterEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/*                        O corpo multipart (upload_image)                     */
/* -------------------------------------------------------------------------- */

describe('shopeeCall — o corpo multipart', () => {
  it('T1 — POSTa multipart SEM cabeçalho Content-Type: quem escreve o boundary é o fetch', async () => {
    // ⚠️ A amostra PHP da própria página manda `Content-Type: multipart/form-data`
    // sem boundary nenhum. Copiá-la produz um corpo que a Shopee não consegue
    // separar, e a resposta é um erro de parâmetro — nunca "o seu Content-Type
    // está errado".
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(UPLOAD_BODY));
    await chamarUpload(fetchMock);

    const headers = cabecalhosEnviados(fetchMock);
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('content-type');
    expect(headers.Accept).toBe('application/json');
    expect(formEnviado(fetchMock)).toBeInstanceOf(FormData);
  });

  it('T2 (transporte) — o campo e o nome de arquivo informados são os que viajam, com o content-type no Blob', async () => {
    // ⚠️ Metade do M-02: o transporte manda o campo que RECEBEU. Que o campo do
    // `upload_image` seja `image` (e não o `file` da amostra Java) é a escolha
    // de `SHOPEE_UPLOAD_IMAGE_FIELD`, e quem a pina é o teste da operação.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(UPLOAD_BODY));
    await chamarUpload(fetchMock, multipart({ fields: { scene: 'normal' } }));

    const form = formEnviado(fetchMock);
    const parte = form.get('image');
    expect(parte).toBeInstanceOf(Blob);
    expect((parte as File).name).toBe('produto-1.png');
    expect((parte as Blob).type).toBe('image/png');
    expect(new Uint8Array(await (parte as Blob).arrayBuffer())).toEqual(bytesPng());
    expect(form.get('scene')).toBe('normal');
    expect(form.get('file')).toBeNull();
  });

  it('T8 — um campo de texto `undefined` é DESCARTADO, nunca vai como a string "undefined"', async () => {
    // `scene` é opcional (`normal | desc`). `FormData.append` faz `String(v)`, de
    // modo que um `undefined` viajaria como quatro letras que a Shopee não aceita.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(UPLOAD_BODY));
    await chamarUpload(fetchMock, multipart({ fields: { scene: undefined, ratio: '3:4' } }));

    const form = formEnviado(fetchMock);
    expect(form.has('scene')).toBe(false);
    expect(form.getAll('scene')).toEqual([]);
    expect(form.get('ratio')).toBe('3:4');
    // NEAR-MISS explícito: a forma errada é observável.
    expect(form.get('scene')).not.toBe('undefined');
  });

  it('o Blob carrega uma CÓPIA dos bytes desta view, não o buffer inteiro em volta', async () => {
    // ⚠️ Um `Uint8Array` é uma VIEW. `Buffer.from`/`Buffer.concat` devolvem views
    // sobre um buffer AGRUPADO — passar a view direto ao Blob mandaria os bytes
    // vizinhos de outra coisa qualquer junto com a foto.
    const pool = new Uint8Array([9, 9, 9, 1, 2, 3, 8, 8, 8]);
    const view = pool.subarray(3, 6);
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(UPLOAD_BODY));
    await chamarUpload(fetchMock, multipart({ file: { bytes: view } }));

    const parte = formEnviado(fetchMock).get('image') as Blob;
    expect(parte.size).toBe(3);
    expect(new Uint8Array(await parte.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('um corpo multipart continua sendo lido como envelope comum — erro, warning e schema', async () => {
    // A requisição muda; a leitura da resposta não. As duas etapas de parse, o
    // veredicto `error === ''` e o canal de warning são os mesmos do JSON.
    const avisos: ShopeeWarning[] = [];
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ ...UPLOAD_BODY, warning: 'imagem redimensionada' }),
    );
    const res = await shopeeCall(
      transporte(fetchMock, (w) => avisos.push(w)),
      {
        method: 'POST',
        path: UPLOAD_PATH,
        call: { class: 'public' },
        schema: uploadSchema,
        surface: 'business',
        multipart: multipart(),
      },
    );

    expect(res.response.image_info.image_id).toBe('img-de-teste-0001');
    expect(avisos).toEqual([
      { path: UPLOAD_PATH, warning: 'imagem redimensionada', requestId: 'req-upload' },
    ]);
  });

  it('um 2xx multipart sem envelope vira ShopeeSchemaError nomeando o campo', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ nada: 1 }));
    await expect(chamarUpload(fetchMock)).rejects.toBeInstanceOf(ShopeeSchemaError);
  });

  it('uma falha de rede no multipart nomeia o PATH e nada mais', async () => {
    // ⚠️ A `err.message` de um fetch abortado ecoa a URL da requisição, que numa
    // chamada shop-signed carrega o `access_token`.
    const fetchMock = vi.fn<typeof globalThis.fetch>(() => {
      throw new TypeError(`fetch failed: https://x/${UPLOAD_PATH}?access_token=segredo-inventado`);
    });
    await expect(chamarUpload(fetchMock)).rejects.toBeInstanceOf(ShopeeNetworkError);
    await expect(chamarUpload(fetchMock)).rejects.toThrow(
      /Falha de rede ao contatar a Shopee em \/api\/v2\/media_space\/upload_image\.$/,
    );
  });

  it('T5 — uma chamada PUBLIC não emite access_token nem shop_id na query', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(UPLOAD_BODY));
    await chamarUpload(fetchMock);

    const url = urlEnviada(fetchMock);
    expect([...url.searchParams.keys()].sort()).toEqual(['partner_id', 'sign', 'timestamp']);
    expect(url.pathname).toBe(UPLOAD_PATH);
  });

  it('T6 — a mesma chamada com assinatura SHOP emite access_token e shop_id', async () => {
    // O transporte é o mesmo; o que muda é a classe da assinatura. É assim que a
    // escotilha `signing: "shop"` do `upload_image` chega à Shopee.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(UPLOAD_BODY));
    await shopeeCall(transporte(fetchMock), {
      method: 'POST',
      path: UPLOAD_PATH,
      call: { class: 'shop', accessToken: 'token-inventado', shopId: TEST_SHOP_ID },
      schema: uploadSchema,
      surface: 'business',
      multipart: multipart(),
    });

    const url = urlEnviada(fetchMock);
    expect(url.searchParams.get('access_token')).toBe('token-inventado');
    expect(url.searchParams.get('shop_id')).toBe(String(TEST_SHOP_ID));
    expect(cabecalhosEnviados(fetchMock)['Content-Type']).toBeUndefined();
  });

  it('o ramo JSON continua intacto: Content-Type application/json e o corpo serializado', async () => {
    // NEAR-MISS do T1: os dois ramos são observáveis e diferentes. Se o multipart
    // tivesse "herdado" o cabeçalho do JSON, este par não os distinguiria.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ error: '', message: null, warning: null, request_id: 'r', response: {} }),
    );
    await shopeeCall(transporte(fetchMock), {
      method: 'POST',
      path: '/api/v2/product/unlist_item',
      call: { class: 'shop', accessToken: 'token-inventado', shopId: TEST_SHOP_ID },
      schema: z.object({}).passthrough(),
      surface: 'business',
      body: { item_list: [{ item_id: 2500139861, unlist: true }] },
    });

    expect(cabecalhosEnviados(fetchMock)['Content-Type']).toBe('application/json');
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.body).toBe('{"item_list":[{"item_id":2500139861,"unlist":true}]}');
    expect(init?.body).not.toBeInstanceOf(FormData);
  });
});

/* -------------------------------------------------------------------------- */
/*          `erroAusenteEhSucesso` — a chave `error` AUSENTE, por operação      */
/* -------------------------------------------------------------------------- */

const VIOLACAO_PATH = '/api/v2/product/get_item_violation_info';

/**
 * O corpo VIVO do `get_item_violation_info`, medido no sandbox em 2026-09-17: as
 * quatro chaves do envelope MENOS `error`, que simplesmente não vem.
 */
const CORPO_SEM_ERROR = { message: null, request_id: 'req-violacao', response: { item_list: [] } };

/** O mesmo corpo sem `error` E sem `response`: um corpo que não dá para julgar. */
const CORPO_SEM_ERROR_NEM_RESPONSE = { message: null, request_id: 'req-violacao' };

/**
 * O schema da OPERAÇÃO, montado como o `wrappedOp` do `types.ts` monta os de
 * verdade: o envelope INTEIRO — `error` incluído, sem default — mais o
 * `response`.
 *
 * ⚠️ É isso que faz esta suíte exercitar as DUAS etapas do parse. Um schema de
 * teste que só declarasse `response` passaria com uma tolerância que valesse só
 * para a etapa 1 — e a chamada de verdade continuaria falhando na etapa 2, que
 * relê o mesmo corpo com o schema da operação.
 */
const violacaoSchema = z
  .object({
    request_id: z.string().nullable().default(null),
    error: z.string(),
    message: z.string().nullable().default(null),
    warning: z.string().nullable().default(null),
    response: z.object({}).passthrough(),
  })
  .passthrough();

function chamarViolacao(
  fetchImpl: typeof globalThis.fetch,
  opcoes: { readonly erroAusenteEhSucesso?: boolean } = {},
) {
  return shopeeCall(transporte(fetchImpl), {
    method: 'GET',
    path: VIOLACAO_PATH,
    call: { class: 'shop', accessToken: 'token-inventado', shopId: TEST_SHOP_ID },
    schema: violacaoSchema,
    surface: 'business',
    ...opcoes,
  });
}

describe('shopeeCall — a tolerância por operação para um `error` AUSENTE', () => {
  it('T9 — com a flag, um corpo SEM a chave `error` mas COM `response` é lido como sucesso', async () => {
    // ⚠️ A forma MEDIDA em 2026-09-17 (register 73). Sem a flag, o parse de
    // etapa 1 recusa e o pull inteiro falha — que foi o que o probe viu.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(CORPO_SEM_ERROR));
    const res = await chamarViolacao(fetchMock, { erroAusenteEhSucesso: true });

    expect(res.response).toEqual({ item_list: [] });
    // ⚠️ A chave ausente chega ao chamador como `''` — e o resto do corpo chega
    // inteiro: o conserto preenche UMA chave, não reescreve a resposta.
    expect(res.error).toBe('');
    expect(res.request_id).toBe('req-violacao');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('T10 — com a flag, um corpo sem `error` E sem `response` continua RECUSADO, nomeando `error`', async () => {
    // ⚠️ É esta condição que torna a tolerância estreita o bastante para ser
    // segura: um corpo que não traz NENHUMA das duas chaves é injulgável, e
    // lê-lo como sucesso seria exatamente o que o envelope sem `.default('')`
    // existe para impedir.
    //
    // ⚠️ A asserção é sobre os CAMPOS, não só sobre a classe: se a condição do
    // `response` sumir, este corpo passa a "ter sucesso" na etapa 1 e morre na
    // etapa 2 — também com um ShopeeSchemaError, mas nomeando `response`. Sem a
    // linha do `campos`, a mutação ficaria VERDE.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse(CORPO_SEM_ERROR_NEM_RESPONSE),
    );
    const erro = await chamarViolacao(fetchMock, { erroAusenteEhSucesso: true }).catch(
      (e: unknown) => e,
    );

    expect(erro).toBeInstanceOf(ShopeeSchemaError);
    expect((erro as ShopeeSchemaError).campos).toContain('error');
    expect((erro as ShopeeSchemaError).campos).not.toContain('response');
  });

  it('T11 — ⛔ QUASE-IGUAL: SEM a flag, o MESMO corpo sem `error` é recusado — o padrão não mudou', async () => {
    // ⚠️ O par do T9. A tolerância é opt-in por CALL SITE; se ela virasse global,
    // todo corpo sem `error` passaria a ser sucesso em TODA operação, e nada
    // além desta linha diria isso.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(CORPO_SEM_ERROR));
    const erro = await chamarViolacao(fetchMock).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ShopeeSchemaError);
    expect((erro as ShopeeSchemaError).campos).toContain('error');
  });

  it('T12 — com a flag, um `error` REAL continua sendo ShopeeApiError: a tolerância nunca esconde erro', async () => {
    // O parse estrito SUCEDE quando a chave existe, então o ramo tolerante nem é
    // alcançado — o veredicto `error === ''` decide como sempre.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({
        error: 'error_param',
        message: 'item_id_list is invalid',
        request_id: 'req-violacao',
        response: null,
      }),
    );
    const erro = await chamarViolacao(fetchMock, { erroAusenteEhSucesso: true }).catch(
      (e: unknown) => e,
    );

    expect(erro).toBeInstanceOf(ShopeeApiError);
    expect((erro as ShopeeApiError).code).toBe('error_param');
  });
});

/* -------------------------------------------------------------------------- */
/*        `payloadNoErro` — o erro e a carga no MESMO corpo, por operação       */
/* -------------------------------------------------------------------------- */

const ESTOQUE_PATH = '/api/v2/product/update_stock';
const MODEL_ID = 2000458802;

/**
 * O schema da OPERAÇÃO, montado como o `wrappedOp` do `types.ts` monta os de
 * verdade: o envelope INTEIRO mais o `response`.
 *
 * ⚠️ `response` é EXIGIDO, sem default — é isso que faz um corpo de falha comum
 * (uma cota diária, uma autorização morta) reprovar aqui e sair pela classe de
 * sempre. A tolerância não é uma escolha do transporte: é o schema da operação
 * decidindo se aquele corpo tem carga.
 */
const estoqueSchema = z
  .object({
    request_id: z.string().nullable().default(null),
    error: z.string(),
    message: z.string().nullable().default(null),
    warning: z.string().nullable().default(null),
    response: z
      .object({
        failure_list: z
          .array(
            z
              .object({
                model_id: z.number(),
                failed_reason: z.string().nullable().default(null),
              })
              .passthrough(),
          )
          .default([]),
        success_list: z.array(z.object({ model_id: z.number() }).passthrough()).default([]),
      })
      .passthrough(),
  })
  .passthrough();

/**
 * O corpo que a própria página do `update_stock` descreve: o `error` de lote
 * CONVIVENDO com o `failure_list` que o explica — *"Update stock failed, please
 * check failure_list for detailed reason"*.
 */
function corpoParcial(error = 'error_busi_update_stock_failed') {
  return {
    error,
    message: 'Update stock failed, please check failure_list for detailed reason',
    warning: null,
    request_id: 'req-estoque',
    response: {
      failure_list: [
        { model_id: MODEL_ID, failed_reason: 'Total stock must be more than reserved stock.' },
      ],
      success_list: [],
    },
  };
}

function chamarEstoque(
  fetchImpl: typeof globalThis.fetch,
  opcoes: { readonly payloadNoErro?: boolean } = {},
) {
  return shopeeCall(transporte(fetchImpl), {
    method: 'POST',
    path: ESTOQUE_PATH,
    call: { class: 'shop', accessToken: 'token-inventado', shopId: TEST_SHOP_ID },
    schema: estoqueSchema,
    surface: 'business',
    body: {
      item_id: 2500139861,
      stock_list: [{ model_id: MODEL_ID, seller_stock: [{ stock: 3 }] }],
    },
    ...opcoes,
  });
}

describe('shopeeCall — `payloadNoErro`, a carga que viaja junto com a falha', () => {
  it('T13 — PAR: com a flag, um `error` de lote chega como ShopeeApiPartialError com o failure_list dentro', async () => {
    // ⚠️ Sem isto o `shopeeErrorFromEnvelope` joga o corpo fora e sobram
    // code/message/requestId/warning — o item inteiro falha como um bloco só,
    // sem atribuição por modelo. É o defeito do app legado, letra por letra.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(corpoParcial()));
    const erro = await chamarEstoque(fetchMock, { payloadNoErro: true }).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ShopeeApiPartialError);
    // ⚠️ Continua sendo uma FALHA da família de sempre: a flag não muda veredicto
    // nenhum, só para de descartar a prova.
    expect(erro).toBeInstanceOf(ShopeeApiError);
    expect((erro as ShopeeApiError).code).toBe('error_busi_update_stock_failed');
    expect((erro as ShopeeApiError).kind).toBe('other');
    expect((erro as ShopeeApiError).requestId).toBe('req-estoque');

    // A carga é a saída do schema da OPERAÇÃO, envelope incluído — exatamente o
    // que o caminho de sucesso teria devolvido.
    const carga = estoqueSchema.parse((erro as ShopeeApiPartialError).parsed);
    expect(carga.response.failure_list).toHaveLength(1);
    expect(carga.response.failure_list[0]!.model_id).toBe(MODEL_ID);
    expect(carga.response.success_list).toEqual([]);
    expect(carga.error).toBe('error_busi_update_stock_failed');
  });

  it('T14 — ⛔ QUASE-IGUAL: SEM a flag, o MESMO corpo é a classe BASE e não carrega `parsed`', async () => {
    // O par do T13. A tolerância é opt-in por CALL SITE: se ela virasse global,
    // toda operação passaria a carregar corpo de falha em log e em erro, e nada
    // além desta linha diria isso.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(corpoParcial()));
    const erro = await chamarEstoque(fetchMock).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ShopeeApiError);
    expect(erro).not.toBeInstanceOf(ShopeeApiPartialError);
    expect(erro).not.toHaveProperty('parsed');
    expect((erro as ShopeeApiError).code).toBe('error_busi_update_stock_failed');
  });

  it('T15 — ⛔ QUASE-IGUAL: com a flag, um erro cujo corpo NÃO é o da operação cai na classe BASE', async () => {
    // ⚠️ A condição inteira da tolerância. `wrappedOp` exige `response`, e um
    // corpo de falha comum não traz nenhum — então o schema reprova e a flag não
    // fabrica carga nenhuma. Construir o parcial mesmo com o parse falhando
    // entregaria `parsed: undefined` a um chamador que já o narrou.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({
        error: 'error_param',
        message: 'Wrong model_id.',
        warning: null,
        request_id: 'req-estoque',
      }),
    );
    const erro = await chamarEstoque(fetchMock, { payloadNoErro: true }).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ShopeeApiError);
    expect(erro).not.toBeInstanceOf(ShopeeApiPartialError);
    expect((erro as ShopeeApiError).code).toBe('error_param');
  });

  it('T16 — ⛔ QUASE-IGUAL: um envelope de SUCESSO com a flag volta normalmente, nunca como parcial', async () => {
    // ⚠️ O ramo parcial vive DEPOIS do veredicto `error === ''` e só no lado da
    // falha. Movê-lo para cima transformaria toda resposta boa numa exceção.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({
        error: '',
        message: null,
        warning: null,
        request_id: 'req-estoque',
        response: { failure_list: [], success_list: [{ model_id: MODEL_ID }] },
      }),
    );
    const res = await chamarEstoque(fetchMock, { payloadNoErro: true });

    expect(res.response.success_list).toHaveLength(1);
    expect(res.error).toBe('');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('T17 — a flag é CEGA ao código: o mesmo corpo com `product.` na frente se comporta igual', async () => {
    // ⚠️ A Shopee imprime o mesmo código das duas formas, às vezes na mesma
    // página. Quem decide o que é parcial é a OPERAÇÃO, não o transporte — e o
    // `code` continua verbatim, com prefixo, porque é o que o app loga.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse(corpoParcial('product.error_busi_update_stock_failed')),
    );
    const erro = await chamarEstoque(fetchMock, { payloadNoErro: true }).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ShopeeApiPartialError);
    expect((erro as ShopeeApiError).code).toBe('product.error_busi_update_stock_failed');
    expect(
      estoqueSchema.parse((erro as ShopeeApiPartialError).parsed).response.failure_list,
    ).toHaveLength(1);
  });

  it('T18 — ⛔ QUASE-IGUAL: um limite de requisições com a flag continua ShopeeRateLimitError', async () => {
    // ⚠️ O parcial SUBSTITUI a subclasse que o envelope teria produzido, de modo
    // que as classes não se excluem por construção — o que guarda esta quina é o
    // SCHEMA: um corpo estrangulado não traz `response` e reprova. Se um dia a
    // Shopee mandar `response` junto com `error_limit`, a escada que ler só a
    // classe perde a cota diária; quem precisa do veredicto de retentativa lê
    // `kind`. Esta linha é o aviso, e ela falha no dia em que a quina mudar.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({
        error: 'error_limit',
        message: 'The total API call number made by your APP has reached the daily API call limit',
        warning: null,
        request_id: 'req-estoque',
      }),
    );
    const erro = await chamarEstoque(fetchMock, { payloadNoErro: true }).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ShopeeRateLimitError);
    expect(erro).not.toBeInstanceOf(ShopeeApiPartialError);
    expect((erro as ShopeeRateLimitError).kind).toBe('daily');
  });
});
