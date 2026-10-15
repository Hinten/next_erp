import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';

import { shopeeItemBaseInfoRowSchema } from '@delfrance/integrations-shopee';
import { importacaoShopeeOptionsSchema, type ImportacaoShopeeOptions } from '@delfrance/schemas';

import { FakeBucket, asBucket } from '../testing/fakeBucket';
import { FakeDb, asDb } from '../testing/fakeDb';
import {
  ShopeeImagemError,
  idsDeImagemJaImportados,
  importarFotosShopee,
  urlDeImagemSegura,
} from './fotosShopee';
import type { ItemLido } from './itemLido';
import {
  planejarImportacaoShopee,
  type ParDeImagemShopee,
  type PreparoImportacaoShopee,
} from './planoImportacao';

/* ---------------------------------- fixtures ------------------------------ */

const ITEM_ID = 2500139861;
const PRODUTO = 'prod-1';
const INTEGRACAO = 'int-1';
const INTEG_REF = `documents/integracao/${INTEGRACAO}`;
const AGORA = 1_757_000_000_000;

const PRECO_BRL = [{ currency: 'BRL', original_price: 99.9, current_price: 49.9 }];

/**
 * ⚠️ Toda URL de fixture carrega um segredo no CAMINHO e na QUERY — a loja e o
 * anúncio, que é exatamente o que o log NÃO pode levar. Um teste que usasse
 * `https://cf.shopee.com.br/a.jpg` não conseguiria distinguir "logou o host" de
 * "logou a URL inteira".
 */
const HOST_BR = 'cf.shopee.com.br';
const URL_1 = `https://${HOST_BR}/file/abc123segredo?shop=987654`;
const URL_2 = `https://${HOST_BR}/file/def456segredo?shop=987654`;

const sha512De = (corpo: string) => createHash('sha512').update(Buffer.from(corpo)).digest('hex');

function opcoes(parcial: Partial<ImportacaoShopeeOptions> = {}): ImportacaoShopeeOptions {
  return importacaoShopeeOptionsSchema.parse(parcial);
}

function item(parcial: Record<string, unknown> = {}): ItemLido {
  return {
    base: shopeeItemBaseInfoRowSchema.parse({
      item_id: ITEM_ID,
      item_name: 'Camiseta Básica',
      price_info: PRECO_BRL,
      ...parcial,
    }),
    models: null,
    taxInfo: null,
    kit: null,
    itemId: ITEM_ID,
  };
}

function preparo(parcial: Partial<PreparoImportacaoShopee> = {}): PreparoImportacaoShopee {
  return {
    entrada: item(),
    integracaoId: INTEGRACAO,
    nowMs: AGORA,
    options: opcoes(),
    tabelaNormalOuterRef: 'documents/listaDePrecos/tab-normal',
    tabelaPromocionalOuterRef: 'documents/listaDePrecos/tab-promo',
    depositoOuterRef: 'documents/depositos/dep-1',
    pai: {
      existente: null,
      extraData: null,
      linkSobFilho: false,
      jaTemFilhos: false,
      estoque: null,
    },
    filhos: [],
    linkPai: null,
    grupos: { docs: [] },
    categorias: [],
    imagensJaCacheadas: [],
    ...parcial,
  };
}

/** Os pares que o PLANO puro entrega ao uploader, para as URLs e ids dados. */
function paresDoPlano(
  urls: string[],
  ids: string[],
  cacheadas: string[] = [],
): readonly ParDeImagemShopee[] {
  const plano = planejarImportacaoShopee(
    preparo({
      entrada: item({ image: { image_url_list: urls, image_id_list: ids } }),
      imagensJaCacheadas: cacheadas,
    }),
  );
  return plano.fotos.baixar;
}

type RespostaFake =
  | { status?: number; contentType?: string; body?: string; location?: string }
  | 'erro-de-rede';

/** ⚠️ Uma URL sem entrada no mapa LANÇA: um fetch a mais é visível, nunca mudo. */
function fakeFetch(mapa: Record<string, RespostaFake>) {
  return vi.fn((url: string | URL) => {
    const entrada = mapa[String(url)];
    if (!entrada) throw new TypeError(`sem duplo para ${String(url)}`);
    if (entrada === 'erro-de-rede') throw new TypeError('fetch failed');
    const status = entrada.status ?? 200;
    const bytes = Buffer.from(entrada.body ?? 'imgbytes');
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (h: string) => {
          const nome = h.toLowerCase();
          // ⚠️ O alvo do redirecionamento EXISTE na resposta — é o que torna
          // "o log nunca leva o Location" uma asserção de verdade.
          if (nome === 'location') return entrada.location ?? null;
          return nome === 'content-type' ? (entrada.contentType ?? 'image/jpeg') : null;
        },
      },
      arrayBuffer: () =>
        Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)),
    } as unknown as Response);
  }) as unknown as typeof globalThis.fetch;
}

function deps(db: FakeDb, bucket: FakeBucket | null, fetchImpl: typeof globalThis.fetch) {
  return {
    db: asDb(db),
    ...(bucket === null ? {} : { bucket: asBucket(bucket) }),
    integracaoId: INTEGRACAO,
    fetchImpl,
  };
}

function semearProduto(db: FakeDb, fotos: unknown[] = []): void {
  db.seed(`produtos/${PRODUTO}`, { nome: 'Camiseta Básica', paiId: null, fotos });
}

/** Os patches que caíram no PRODUTO (os de `arquivos/` são do uploader). */
function patchesDoProduto(db: FakeDb) {
  return db.patches.filter((p) => p.path === `produtos/${PRODUTO}`);
}

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------- 1. o par URL ↔ image_id, ponta a ponta ---------------- */

describe('o par URL ↔ `image_id` — o que o plano entrega ao uploader', () => {
  it('cada URL viaja com o `image_id` de MESMO índice até o `externalIds` do arquivo', async () => {
    const db = new FakeDb();
    const bucket = new FakeBucket();
    semearProduto(db);
    const fetch = fakeFetch({
      [URL_1]: { body: 'bytes-1' },
      [URL_2]: { body: 'bytes-2' },
    });

    const res = await importarFotosShopee(
      deps(db, bucket, fetch),
      PRODUTO,
      paresDoPlano([URL_1, URL_2], ['i1', 'i2']),
    );

    expect(res).toEqual({ importadas: 2, ignoradas: 0, falhas: 0 });
    const externos = (corpo: string) =>
      db.store[`arquivos/${PRODUTO}_${sha512De(corpo)}`]?.data.externalIds;
    expect(externos('bytes-1')).toEqual([{ externalId: 'i1', integracaoPath: INTEG_REF }]);
    expect(externos('bytes-2')).toEqual([{ externalId: 'i2', integracaoPath: INTEG_REF }]);
  });

  it('uma URL a mais que os ids: a foto entra com `externalIds` VAZIO — importável, nunca dedupável', async () => {
    const db = new FakeDb();
    const bucket = new FakeBucket();
    semearProduto(db);
    const fetch = fakeFetch({ [URL_1]: { body: 'bytes-1' }, [URL_2]: { body: 'bytes-2' } });

    const pares = paresDoPlano([URL_1, URL_2], ['i1']);
    expect(pares).toEqual([
      { url: URL_1, imageId: 'i1' },
      { url: URL_2, imageId: null },
    ]);

    const res = await importarFotosShopee(deps(db, bucket, fetch), PRODUTO, pares);
    expect(res).toEqual({ importadas: 2, ignoradas: 0, falhas: 0 });
    expect(db.store[`arquivos/${PRODUTO}_${sha512De('bytes-2')}`]?.data.externalIds).toEqual([]);
  });

  it('⛔ um id a mais que as URLs não é foto nenhuma: o id excedente não chega a lugar nenhum', async () => {
    const db = new FakeDb();
    const bucket = new FakeBucket();
    semearProduto(db);
    const fetch = fakeFetch({ [URL_1]: { body: 'bytes-1' } });

    const res = await importarFotosShopee(
      deps(db, bucket, fetch),
      PRODUTO,
      paresDoPlano([URL_1], ['i1', 'i2']),
    );

    expect(res).toEqual({ importadas: 1, ignoradas: 0, falhas: 0 });
    expect(bucket.caminhos).toHaveLength(1);
    expect(JSON.stringify(db.store)).not.toContain('i2');
  });
});

/* --------------- 2. o dedup: os ids já cacheados NESTA integração ---------- */

describe('o dedup — os `image_id` já cacheados NESTA integração', () => {
  function semearCacheada(db: FakeDb, integracaoPath: string, imageId = 'i1'): void {
    const arquivoId = `${PRODUTO}_hash-antigo`;
    semearProduto(db, [{ arquivoOuterRef: `arquivos/${arquivoId}` }]);
    db.seed(`arquivos/${arquivoId}`, {
      url: 'https://exemplo/x.jpeg',
      externalIds: [{ externalId: imageId, integracaoPath }],
    });
  }

  it('devolve o `image_id` cacheado num arquivo desta integração', async () => {
    const db = new FakeDb();
    semearCacheada(db, INTEG_REF);
    await expect(idsDeImagemJaImportados(asDb(db), PRODUTO, INTEGRACAO)).resolves.toEqual(['i1']);
  });

  it('⛔ um `image_id` cacheado por OUTRA integração não conta — e é isso que o plano lê', async () => {
    const db = new FakeDb();
    semearCacheada(db, 'documents/integracao/int-2');
    await expect(idsDeImagemJaImportados(asDb(db), PRODUTO, INTEGRACAO)).resolves.toEqual([]);
    // o que o plano faz com cada resposta: cacheada ⇒ ignorada, não cacheada ⇒ baixar
    expect(paresDoPlano([URL_1], ['i1'], [])).toEqual([{ url: URL_1, imageId: 'i1' }]);
    expect(paresDoPlano([URL_1], ['i1'], ['i1'])).toEqual([]);
  });

  it('aceita as DUAS grafias do ref da integração — a canônica e a nua', async () => {
    const db = new FakeDb();
    semearCacheada(db, `integracao/${INTEGRACAO}`);
    await expect(idsDeImagemJaImportados(asDb(db), PRODUTO, INTEGRACAO)).resolves.toEqual(['i1']);
  });

  it('produto inexistente: lista vazia e NENHUMA leitura de arquivo', async () => {
    const db = new FakeDb();
    await expect(idsDeImagemJaImportados(asDb(db), PRODUTO, INTEGRACAO)).resolves.toEqual([]);
    expect(db.opLog).toEqual([{ op: 'get', path: `produtos/${PRODUTO}` }]);
  });
});

/* ----------------------- 3. a allow-list de hosts ------------------------- */

describe('urlDeImagemSegura — a allow-list de hosts', () => {
  it('aceita um host da Shopee e devolve a URL intacta', () => {
    expect(urlDeImagemSegura(URL_1).toString()).toBe(URL_1);
    expect(urlDeImagemSegura('https://shopee.sg/a.jpg').hostname).toBe('shopee.sg');
  });

  it('aceita a CDN `susercontent.com`', () => {
    expect(urlDeImagemSegura('https://down-br.img.susercontent.com/file/x').hostname).toBe(
      'down-br.img.susercontent.com',
    );
  });

  it('sobe `http:` para `https:` antes de qualquer fetch', async () => {
    const db = new FakeDb();
    const bucket = new FakeBucket();
    semearProduto(db);
    expect(urlDeImagemSegura(`http://${HOST_BR}/file/x`).toString()).toBe(
      `https://${HOST_BR}/file/x`,
    );

    const fetch = fakeFetch({ [`https://${HOST_BR}/file/x`]: { body: 'bytes-1' } });
    const res = await importarFotosShopee(deps(db, bucket, fetch), PRODUTO, [
      { url: `http://${HOST_BR}/file/x`, imageId: 'i1' },
    ]);
    expect(res.importadas).toBe(1);
    expect(fetch).toHaveBeenCalledWith(`https://${HOST_BR}/file/x`, { redirect: 'manual' });
  });

  it('⛔ recusa um host de FORA — inclusive um que só PREFIXA o domínio da Shopee', () => {
    for (const host of [
      'evil.co',
      'shopee.com.evil.co',
      'evil-shopee.com',
      'notshopee.br',
      'susercontent.com.evil.co',
    ]) {
      expect(() => urlDeImagemSegura(`https://${host}/file/x`)).toThrow(ShopeeImagemError);
    }
  });

  it('recusa qualquer outro esquema, e uma URL que nem parseia', () => {
    expect(() => urlDeImagemSegura('file:///etc/passwd')).toThrow(ShopeeImagemError);
    expect(() => urlDeImagemSegura('data:image/png;base64,AAAA')).toThrow(ShopeeImagemError);
    expect(() => urlDeImagemSegura('nem-uma-url')).toThrow(ShopeeImagemError);
  });

  it('um host recusado NÃO é buscado — a guarda roda antes do fetch', async () => {
    const db = new FakeDb();
    const bucket = new FakeBucket();
    semearProduto(db);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetch = fakeFetch({});

    const res = await importarFotosShopee(deps(db, bucket, fetch), PRODUTO, [
      { url: 'https://shopee.com.evil.co/file/x', imageId: 'i1' },
    ]);

    expect(res).toEqual({ importadas: 0, ignoradas: 0, falhas: 1 });
    expect(fetch).not.toHaveBeenCalled();
    expect(bucket.saved).toEqual([]);
  });
});

/* ------------- 3b. o redirecionamento: a allow-list vale no fio ----------- */

describe('o redirecionamento — a guarda vale para o host que CONECTA, não só para o pedido', () => {
  /** O alvo clássico de SSRF: o metadata service do runtime. Nunca pode vazar. */
  const ALVO = 'http://169.254.169.254/latest/meta-data/';

  it('o fetch é emitido com `redirect: manual` — a resposta 3xx chega a nós, não ao curl', async () => {
    const db = new FakeDb();
    const bucket = new FakeBucket();
    semearProduto(db);
    const fetch = fakeFetch({ [URL_1]: { body: 'bytes-1' } });

    await importarFotosShopee(deps(db, bucket, fetch), PRODUTO, [{ url: URL_1, imageId: 'i1' }]);

    expect(fetch).toHaveBeenCalledWith(URL_1, { redirect: 'manual' });
  });

  it('um 302 de um host PERMITIDO é recusado: conta em `falhas`, nada sobe, e o log leva o status e o host — nunca o `Location`', async () => {
    const db = new FakeDb();
    const bucket = new FakeBucket();
    semearProduto(db);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetch = fakeFetch({ [URL_1]: { status: 302, location: ALVO } });

    const res = await importarFotosShopee(deps(db, bucket, fetch), PRODUTO, [
      { url: URL_1, imageId: 'i1' },
    ]);

    expect(res).toEqual({ importadas: 0, ignoradas: 0, falhas: 1 });
    expect(bucket.saved).toEqual([]);
    expect(db.idsEm('arquivos')).toEqual([]);
    expect(patchesDoProduto(db)).toEqual([]);

    const causa = String((warn.mock.calls[0]?.[1] as { causa?: unknown } | undefined)?.causa);
    expect(causa).toContain('302');
    expect(causa).toContain(HOST_BR);
    const linha = JSON.stringify(warn.mock.calls[0]);
    expect(linha).not.toContain('169.254.169.254');
    expect(linha).not.toContain('meta-data');
    expect(linha).not.toContain('abc123segredo');
  });

  it('um 301 conta igual a um 302 — a recusa é de QUALQUER 3xx, não de um status', async () => {
    const db = new FakeDb();
    const bucket = new FakeBucket();
    semearProduto(db);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetch = fakeFetch({ [URL_1]: { status: 301, location: ALVO }, [URL_2]: { status: 307 } });

    const res = await importarFotosShopee(deps(db, bucket, fetch), PRODUTO, [
      { url: URL_1, imageId: 'i1' },
      { url: URL_2, imageId: 'i2' },
    ]);

    expect(res).toEqual({ importadas: 0, ignoradas: 0, falhas: 2 });
    expect(bucket.saved).toEqual([]);
    const causas = warn.mock.calls.map((c) => String((c[1] as { causa?: unknown }).causa));
    expect(causas[0]).toContain('301');
    expect(causas[0]).toContain(HOST_BR);
    expect(causas[1]).toContain('307');
    expect(causas[1]).toContain(HOST_BR);
  });

  it('⛔ um 200 do MESMO host permitido continua importando — a recusa é do 3xx, não do host', async () => {
    const db = new FakeDb();
    const bucket = new FakeBucket();
    semearProduto(db);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetch = fakeFetch({ [URL_1]: { status: 200, body: 'bytes-1' } });

    const res = await importarFotosShopee(deps(db, bucket, fetch), PRODUTO, [
      { url: URL_1, imageId: 'i1' },
    ]);

    expect(res).toEqual({ importadas: 1, ignoradas: 0, falhas: 0 });
    expect(bucket.caminhos).toEqual([`produtos/${PRODUTO}/originals/${sha512De('bytes-1')}.jpeg`]);
    expect(warn).not.toHaveBeenCalled();
  });
});

/* ------------------------ 4. o download e o arquivo ----------------------- */

describe('o download, o hash e o arquivo', () => {
  it('o id do arquivo e o nome do objeto são o sha512 dos BYTES baixados', async () => {
    const db = new FakeDb();
    const bucket = new FakeBucket();
    semearProduto(db);
    const corpo = 'imgbytes-1';
    const fetch = fakeFetch({ [URL_1]: { body: corpo, contentType: 'image/png' } });

    await importarFotosShopee(deps(db, bucket, fetch), PRODUTO, [{ url: URL_1, imageId: 'i1' }]);

    const hash = sha512De(corpo);
    expect(db.store[`arquivos/${PRODUTO}_${hash}`]).toBeDefined();
    expect(bucket.caminhos).toEqual([`produtos/${PRODUTO}/originals/${hash}.png`]);
    // ⚠️ o que foi hasheado é o que subiu: gravar só o caminho deixaria passar um
    // mutante que trocasse os bytes.
    expect(bucket.saved[0]?.bytes.toString()).toBe(corpo);
  });

  it('grava `resizeState: pending` e o `externalIds` desta integração; o objeto leva o `arquivoId`', async () => {
    const db = new FakeDb();
    const bucket = new FakeBucket();
    semearProduto(db);
    const fetch = fakeFetch({ [URL_1]: { body: 'imgbytes-1' } });

    await importarFotosShopee(deps(db, bucket, fetch), PRODUTO, [{ url: URL_1, imageId: 'i1' }]);

    const docId = `${PRODUTO}_${sha512De('imgbytes-1')}`;
    expect(db.store[`arquivos/${docId}`]?.data).toMatchObject({
      filetype: 'image',
      contentType: 'image/jpeg',
      resizeState: 'pending',
      externalIds: [{ externalId: 'i1', integracaoPath: INTEG_REF }],
    });
    expect(db.store[`arquivos/${docId}`]?.data.url).toEqual(expect.stringContaining(bucket.name));
    expect(bucket.saved[0]?.contentType).toBe('image/jpeg');
    expect(
      (bucket.saved[0]?.metadata as { metadata?: { arquivoId?: string } } | undefined)?.metadata
        ?.arquivoId,
    ).toBe(docId);
  });

  it('recusa um `content-type` que não é `image/*` — nada sobe ao bucket', async () => {
    const db = new FakeDb();
    const bucket = new FakeBucket();
    semearProduto(db);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetch = fakeFetch({
      [URL_1]: { contentType: 'text/html; charset=utf-8', body: '<html>' },
    });

    const res = await importarFotosShopee(deps(db, bucket, fetch), PRODUTO, [
      { url: URL_1, imageId: 'i1' },
    ]);

    expect(res).toEqual({ importadas: 0, ignoradas: 0, falhas: 1 });
    expect(bucket.saved).toEqual([]);
    expect(db.idsEm('arquivos')).toEqual([]);
  });
});

/* -------------------------- 5. o append no produto ------------------------ */

describe('o append no produto', () => {
  it('UM único `update`, com `arrayUnion` em `fotos` e em `fotosArquivosIds`', async () => {
    const db = new FakeDb();
    const bucket = new FakeBucket();
    semearProduto(db);
    const fetch = fakeFetch({ [URL_1]: { body: 'bytes-1' }, [URL_2]: { body: 'bytes-2' } });

    await importarFotosShopee(deps(db, bucket, fetch), PRODUTO, [
      { url: URL_1, imageId: 'i1' },
      { url: URL_2, imageId: 'i2' },
    ]);

    const patches = patchesDoProduto(db);
    expect(patches).toHaveLength(1);
    const foto = (corpo: string) => {
      const id = `${PRODUTO}_${sha512De(corpo)}`;
      return {
        arquivoOuterRef: `arquivos/${id}`,
        arquivo200pxOuterRef: `arquivos/${id}_200`,
        arquivo400pxOuterRef: `arquivos/${id}_400`,
        arquivoJpegOuterRef: `arquivos/${id}_jpeg`,
        grupoDeVariacoesOuterRef: null,
        variantePath: null,
      };
    };
    const patch = patches[0]?.patch as Record<string, FieldValue>;
    expect(patch.fotos?.isEqual(FieldValue.arrayUnion(foto('bytes-1'), foto('bytes-2')))).toBe(
      true,
    );
    const idsDerivados = (corpo: string) => {
      const id = `${PRODUTO}_${sha512De(corpo)}`;
      return [id, `${id}_200`, `${id}_400`];
    };
    // ⚠️ o derivado jpeg fica de FORA do denorm — a forma de wire do legado.
    expect(
      patch.fotosArquivosIds?.isEqual(
        FieldValue.arrayUnion(...idsDerivados('bytes-1'), ...idsDerivados('bytes-2')),
      ),
    ).toBe(true);
    expect((db.store[`produtos/${PRODUTO}`]?.data.fotos as unknown[]).length).toBe(2);
  });

  it('nenhuma foto importada ⇒ NENHUM update no produto', async () => {
    const db = new FakeDb();
    const bucket = new FakeBucket();
    semearProduto(db);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetch = fakeFetch({ [URL_1]: { status: 404 } });

    const res = await importarFotosShopee(deps(db, bucket, fetch), PRODUTO, [
      { url: URL_1, imageId: 'i1' },
    ]);

    expect(res).toEqual({ importadas: 0, ignoradas: 0, falhas: 1 });
    expect(patchesDoProduto(db)).toEqual([]);
  });
});

/* -------------------------- 6. a divisão das falhas ----------------------- */

describe('a divisão das falhas', () => {
  it('uma falha de FOTO pula e conta, e a foto seguinte ainda entra', async () => {
    const db = new FakeDb();
    const bucket = new FakeBucket();
    semearProduto(db);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetch = fakeFetch({ [URL_1]: 'erro-de-rede', [URL_2]: { body: 'bytes-2' } });

    const res = await importarFotosShopee(deps(db, bucket, fetch), PRODUTO, [
      { url: URL_1, imageId: 'i1' },
      { url: URL_2, imageId: 'i2' },
    ]);

    expect(res).toEqual({ importadas: 1, ignoradas: 0, falhas: 1 });
    expect(bucket.caminhos).toEqual([`produtos/${PRODUTO}/originals/${sha512De('bytes-2')}.jpeg`]);
  });

  it('uma falha de INFRAESTRUTURA (o Storage) PROPAGA e falha o item', async () => {
    const db = new FakeDb();
    const bucket = new FakeBucket();
    semearProduto(db);
    const caminho = `produtos/${PRODUTO}/originals/${sha512De('bytes-1')}.jpeg`;
    bucket.falhaAoSalvar.set(caminho, new Error('storage indisponível'));
    const fetch = fakeFetch({ [URL_1]: { body: 'bytes-1' } });

    await expect(
      importarFotosShopee(deps(db, bucket, fetch), PRODUTO, [{ url: URL_1, imageId: 'i1' }]),
    ).rejects.toThrow('storage indisponível');
    expect(patchesDoProduto(db)).toEqual([]);
  });

  it('o log de uma foto ignorada leva o host e o `image_id` e NUNCA a URL', async () => {
    const db = new FakeDb();
    const bucket = new FakeBucket();
    semearProduto(db);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetch = fakeFetch({ [URL_1]: { contentType: 'text/html', body: '<html>' } });

    await importarFotosShopee(deps(db, bucket, fetch), PRODUTO, [{ url: URL_1, imageId: 'i1' }]);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      produtoId: PRODUTO,
      imageId: 'i1',
      host: HOST_BR,
    });
    const linha = JSON.stringify(warn.mock.calls[0]);
    expect(linha).not.toContain('abc123segredo');
    expect(linha).not.toContain('987654');
    expect(linha).not.toContain('/file/');
  });
});

/* ------------------------------ 7. sem bucket ----------------------------- */

describe('sem bucket, e sem fotos', () => {
  it('sem bucket: pula as fotos do item inteiro com UMA linha de log, zero fetch', async () => {
    const db = new FakeDb();
    semearProduto(db);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetch = fakeFetch({});

    const res = await importarFotosShopee(
      deps(db, null, fetch),
      PRODUTO,
      [
        { url: URL_1, imageId: 'i1' },
        { url: URL_2, imageId: 'i2' },
      ],
      3,
    );

    // ⚠️ as 3 que o PLANO já ignorou continuam ignoradas — as 2 se somam a elas.
    expect(res).toEqual({ importadas: 0, ignoradas: 5, falhas: 0 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(patchesDoProduto(db)).toEqual([]);
  });

  it('plano sem fotos: nem o bucket é consultado, e as ignoradas do plano voltam intactas', async () => {
    const db = new FakeDb();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetch = fakeFetch({});

    const res = await importarFotosShopee(deps(db, null, fetch), PRODUTO, [], 4);

    expect(res).toEqual({ importadas: 0, ignoradas: 4, falhas: 0 });
    expect(warn).not.toHaveBeenCalled();
    expect(db.writes).toEqual([]);
  });
});
