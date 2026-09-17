import { type Mock, afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  type ShopeeMultipartBody,
  type ShopeeMultipartFile,
  type ShopeeTransport,
  type ShopeeWarning,
  shopeeCall,
} from '../src/call';
import { ShopeeNetworkError, ShopeeSchemaError } from '../src/errors';

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
