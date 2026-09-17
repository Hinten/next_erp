import { afterEach, describe, expect, it, vi } from 'vitest';
import { FieldValue } from 'firebase-admin/firestore';

import {
  type ShopeeUploadImageResponse,
  type UploadImageParams,
  ShopeeApiError,
  ShopeeRateLimitError,
  SHOPEE_ITEM_IMAGE_MAX,
  SHOPEE_UPLOAD_IMAGE_MAX_BYTES,
  SHOPEE_UPLOAD_IMAGE_PATH,
  shopeeUploadImageSchema,
} from '@delfrance/integrations-shopee';
import { type Foto, toOuterRef } from '@delfrance/schemas';

import { FakeDb, asDb, grpc } from '../testing/fakeDb';
import {
  type DepsFotosPublicacao,
  HOSTS_DE_DOWNLOAD_ARQUIVO,
  ShopeeFotoPublicacaoError,
  criarResolvedorDeImagens,
  resolverImagensParaPublicar,
  urlDeDownloadSegura,
} from './fotosPublicacao';

/* ---------------------------------- fixtures ------------------------------ */

const PRODUTO = 'prod-1';
const INTEGRACAO = 'int-1';
const OUTRA_INTEGRACAO = 'int-2';
const HOST_STORAGE = 'firebasestorage.googleapis.com';

/**
 * ⚠️ Toda URL de fixture carrega um SEGREDO no caminho e na query — é
 * exatamente o que um link de download do Firebase carrega (um token). Um teste
 * que usasse `https://firebasestorage.googleapis.com/a.png` não conseguiria
 * distinguir "logou o host" de "logou a URL inteira".
 */
function urlDeArquivo(arquivoId: string): string {
  return `https://${HOST_STORAGE}/v0/b/balde-de-teste/o/produtos%2F${PRODUTO}%2Foriginals%2Fsegredo-${arquivoId}.png?alt=media&token=segredo-de-teste-${arquivoId}`;
}

function foto(arquivoId: string): Foto {
  return {
    arquivoOuterRef: `arquivos/${arquivoId}`,
    arquivo200pxOuterRef: null,
    arquivo400pxOuterRef: null,
    arquivoJpegOuterRef: null,
    grupoDeVariacoesOuterRef: null,
    variantePath: null,
  };
}

/** Um `arquivos/<id>` com url e, opcionalmente, ids já em cache. */
function semearArquivo(
  db: FakeDb,
  arquivoId: string,
  externalIds: Array<{ externalId: string; integracaoPath: string }> = [],
  url: string | null = urlDeArquivo(arquivoId),
): void {
  db.seed(`arquivos/${arquivoId}`, {
    filetype: 'image',
    filename: `${arquivoId}.png`,
    contentType: 'image/png',
    url,
    externalIds,
  });
}

const refCanonico = (id: string) => `documents/integracao/${id}`;
const refNua = (id: string) => `integracao/${id}`;

type RespostaFake =
  | { status?: number; contentType?: string; bytes?: Uint8Array; location?: string }
  | 'erro-de-rede';

/** ⚠️ Uma URL sem entrada no mapa LANÇA: um fetch a mais é visível, nunca mudo. */
function fakeFetch(mapa: Record<string, RespostaFake>) {
  return vi.fn((url: string | URL) => {
    const entrada = mapa[String(url)];
    if (!entrada) throw new TypeError(`sem duplo para ${String(url)}`);
    if (entrada === 'erro-de-rede') throw new TypeError('fetch failed');
    const status = entrada.status ?? 200;
    const bytes = entrada.bytes ?? new Uint8Array([1, 2, 3, 4]);
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (h: string) => {
          const nome = h.toLowerCase();
          // ⚠️ O alvo do redirecionamento EXISTE na resposta — é o que torna
          // "o log nunca leva o Location" uma asserção de verdade.
          if (nome === 'location') return entrada.location ?? null;
          return nome === 'content-type' ? (entrada.contentType ?? 'image/png') : null;
        },
      },
      arrayBuffer: () =>
        Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
    } as unknown as Response);
  }) as unknown as typeof globalThis.fetch;
}

/** Todas as URLs dos arquivos dados, cada uma respondendo 200 image/png. */
function fetchDe(arquivoIds: readonly string[], parcial: Record<string, RespostaFake> = {}) {
  const mapa: Record<string, RespostaFake> = {};
  for (const id of arquivoIds) mapa[urlDeArquivo(id)] = {};
  return fakeFetch({ ...mapa, ...parcial });
}

function envelope(resposta: Record<string, unknown>, warning = ''): ShopeeUploadImageResponse {
  return shopeeUploadImageSchema.parse({
    request_id: 'req-1',
    error: '',
    message: '',
    warning,
    response: resposta,
  });
}

/** O upload feliz: um `image_info.image_id` derivado do nome do arquivo. */
function uploadOk() {
  return vi.fn((p: UploadImageParams) =>
    Promise.resolve(envelope({ image_info: { image_id: `img-${p.filename}` } })),
  );
}

function erroApi(code: string, kind: 'other' | 'transient' = 'other'): ShopeeApiError {
  return new ShopeeApiError(`shopee recusou (${code})`, {
    code,
    kind,
    httpStatus: 200,
    path: SHOPEE_UPLOAD_IMAGE_PATH,
  });
}

function deps(
  db: FakeDb,
  fetchImpl: typeof globalThis.fetch,
  enviarImagem: (p: UploadImageParams) => Promise<ShopeeUploadImageResponse>,
  extra: Partial<DepsFotosPublicacao> = {},
): DepsFotosPublicacao {
  return {
    db: asDb(db),
    integracaoId: INTEGRACAO,
    produtoId: PRODUTO,
    enviarImagem,
    fetchImpl,
    ...extra,
  };
}

function patchesDe(db: FakeDb, arquivoId: string) {
  return db.patches.filter((p) => p.path === `arquivos/${arquivoId}`);
}

function externalIdsArmazenados(db: FakeDb, arquivoId: string): Array<Record<string, unknown>> {
  const bruto = db.store[`arquivos/${arquivoId}`]?.data.externalIds;
  return Array.isArray(bruto) ? (bruto as Array<Record<string, unknown>>) : [];
}

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------- 1. o cache ------------------------------- */

describe('o cache de `image_id` em `arquivos.externalIds`', () => {
  it('um image_id já em cache para ESTA integração não gasta fetch nem upload', async () => {
    const db = new FakeDb();
    semearArquivo(db, 'arq-1', [
      { externalId: 'img-ja-subida', integracaoPath: refCanonico(INTEGRACAO) },
    ]);
    const fetch = fetchDe([]);
    const enviar = uploadOk();

    const res = await resolverImagensParaPublicar(deps(db, fetch, enviar), [foto('arq-1')]);

    expect(res.imageIds).toEqual(['img-ja-subida']);
    expect(res).toMatchObject({ reutilizadas: 1, enviadas: 0, consideradas: 1, falhas: [] });
    expect(fetch).not.toHaveBeenCalled();
    expect(enviar).not.toHaveBeenCalled();
    expect(db.patches).toEqual([]);
  });

  // ⚠️ PAR (M-69): as DUAS grafias do ref contam como cache. Uma comparação
  // estrita re-subiria toda foto de todo produto cujos arquivos foram escritos
  // na forma antiga.
  it('PAR: `documents/integracao/int-1` e `integracao/int-1` contam os DOIS', async () => {
    const db = new FakeDb();
    semearArquivo(db, 'arq-1', [
      { externalId: 'img-canonica', integracaoPath: refCanonico(INTEGRACAO) },
    ]);
    semearArquivo(db, 'arq-2', [{ externalId: 'img-nua', integracaoPath: refNua(INTEGRACAO) }]);
    const fetch = fetchDe([]);
    const enviar = uploadOk();

    const res = await resolverImagensParaPublicar(deps(db, fetch, enviar), [
      foto('arq-1'),
      foto('arq-2'),
    ]);

    expect(res.imageIds).toEqual(['img-canonica', 'img-nua']);
    expect(res.reutilizadas).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(enviar).not.toHaveBeenCalled();
  });

  // ⚠️ QUASE-PAR do teste acima: o cache é por CONTA.
  it('QUASE-PAR: um externalId de OUTRA integração não conta como cache', async () => {
    const db = new FakeDb();
    semearArquivo(db, 'arq-1', [
      { externalId: 'img-da-outra-conta', integracaoPath: refCanonico(OUTRA_INTEGRACAO) },
    ]);
    const fetch = fetchDe(['arq-1']);
    const enviar = uploadOk();

    const res = await resolverImagensParaPublicar(deps(db, fetch, enviar), [foto('arq-1')]);

    expect(res.imageIds).toEqual(['img-arq-1.png']);
    expect(res).toMatchObject({ reutilizadas: 0, enviadas: 1 });
    expect(enviar).toHaveBeenCalledTimes(1);
  });

  it('um externalId vazio não conta como cache', async () => {
    const db = new FakeDb();
    semearArquivo(db, 'arq-1', [{ externalId: '', integracaoPath: refCanonico(INTEGRACAO) }]);
    const enviar = uploadOk();

    const res = await resolverImagensParaPublicar(deps(db, fetchDe(['arq-1']), enviar), [
      foto('arq-1'),
    ]);

    expect(res).toMatchObject({ reutilizadas: 0, enviadas: 1 });
  });
});

/* -------------------------------- 2. o memo ------------------------------- */

describe('o memo — um resolvedor por publicação', () => {
  it('o mesmo arquivo em duas fotos lê o doc UMA vez e sobe UMA vez', async () => {
    const db = new FakeDb();
    semearArquivo(db, 'arq-1');
    const fetch = fetchDe(['arq-1']);
    const enviar = uploadOk();

    const res = await resolverImagensParaPublicar(deps(db, fetch, enviar), [
      foto('arq-1'),
      foto('arq-1'),
    ]);

    expect(res.imageIds).toEqual(['img-arq-1.png', 'img-arq-1.png']);
    expect(res).toMatchObject({ enviadas: 1, reutilizadas: 0, consideradas: 2 });
    expect(db.opLog.filter((o) => o.path === 'arquivos/arq-1')).toHaveLength(1);
    expect(enviar).toHaveBeenCalledTimes(1);
  });

  // ⚠️ M-72: é POR ISSO que o módulo é uma fábrica. A passada do item e cada
  // passada de opção de tier-1 compartilham o memo — sem ele a segunda leria a
  // própria escrita de `arrayUnion` que a primeira acabou de fazer.
  it('resolver() chamado duas vezes no mesmo resolvedor compartilha o memo', async () => {
    const db = new FakeDb();
    semearArquivo(db, 'arq-1');
    const fetch = fetchDe(['arq-1']);
    const enviar = uploadOk();
    const resolvedor = criarResolvedorDeImagens(deps(db, fetch, enviar));

    const item = await resolvedor.resolver([foto('arq-1')]);
    const opcao = await resolvedor.resolver([foto('arq-1')], { cap: 1 });

    expect(item.imageIds).toEqual(['img-arq-1.png']);
    expect(opcao.imageIds).toEqual(['img-arq-1.png']);
    expect(item.enviadas).toBe(1);
    expect(opcao.enviadas).toBe(0);
    expect(opcao.reutilizadas).toBe(0);
    expect(db.opLog.filter((o) => o.path === 'arquivos/arq-1')).toHaveLength(1);
    expect(enviar).toHaveBeenCalledTimes(1);
  });

  it('resumo() soma os totais de TODAS as chamadas de resolver()', async () => {
    const db = new FakeDb();
    semearArquivo(db, 'arq-1');
    semearArquivo(db, 'arq-2', [
      { externalId: 'img-cacheada', integracaoPath: refCanonico(INTEGRACAO) },
    ]);
    const resolvedor = criarResolvedorDeImagens(deps(db, fetchDe(['arq-1']), uploadOk()));

    await resolvedor.resolver([foto('arq-1'), foto('arq-2'), foto('arq-ausente')]);
    await resolvedor.resolver([foto('arq-2')], { cap: 1 });

    expect(resolvedor.resumo()).toEqual({
      consideradas: 4,
      reutilizadas: 1,
      enviadas: 1,
      falhas: 1,
      descartadasPeloLimite: 0,
    });
  });
});

/* -------------------------------- 3. o teto ------------------------------- */

describe('o teto de fotos e a ORDEM', () => {
  // ⚠️ M-73: o `slice` vem ANTES de qualquer trabalho, nunca um `break` depois
  // de N sucessos — senão o descarte dependeria de quantas fotos falharam.
  it('um produto com 12 fotos considera 9 e reporta descartadasPeloLimite 3', async () => {
    const db = new FakeDb();
    const fotos: Foto[] = [];
    for (let i = 1; i <= 12; i += 1) {
      const id = `arq-${String(i)}`;
      semearArquivo(db, id, [
        { externalId: `img-${String(i)}`, integracaoPath: refCanonico(INTEGRACAO) },
      ]);
      fotos.push(foto(id));
    }

    const res = await resolverImagensParaPublicar(deps(db, fetchDe([]), uploadOk()), fotos);

    expect(SHOPEE_ITEM_IMAGE_MAX).toBe(9);
    expect(res.imageIds).toHaveLength(9);
    expect(res.consideradas).toBe(9);
    expect(res.descartadasPeloLimite).toBe(3);
    expect(res.imageIds[8]).toBe('img-9');
  });

  it('a passada de opção de tier-1 usa cap 1 e descarta o resto', async () => {
    const db = new FakeDb();
    semearArquivo(db, 'arq-1', [{ externalId: 'img-1', integracaoPath: refNua(INTEGRACAO) }]);
    semearArquivo(db, 'arq-2', [{ externalId: 'img-2', integracaoPath: refNua(INTEGRACAO) }]);

    const res = await criarResolvedorDeImagens(deps(db, fetchDe([]), uploadOk())).resolver(
      [foto('arq-1'), foto('arq-2')],
      { cap: 1 },
    );

    expect(res.imageIds).toEqual(['img-1']);
    expect(res.descartadasPeloLimite).toBe(1);
  });

  it('a ordem de imageIds é a ordem das fotos, menos as falhas', async () => {
    const db = new FakeDb();
    semearArquivo(db, 'arq-1', [{ externalId: 'img-1', integracaoPath: refNua(INTEGRACAO) }]);
    // `arq-2` não existe — falha contada, jamais reordena o resto.
    semearArquivo(db, 'arq-3', [{ externalId: 'img-3', integracaoPath: refNua(INTEGRACAO) }]);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const res = await resolverImagensParaPublicar(deps(db, fetchDe([]), uploadOk()), [
      foto('arq-1'),
      foto('arq-2'),
      foto('arq-3'),
    ]);

    expect(res.imageIds).toEqual(['img-1', 'img-3']);
    expect(res.falhas).toEqual([
      { arquivoId: 'arq-2', motivo: 'arquivo-ausente', mensagem: 'documento de arquivo ausente' },
    ]);
  });
});

/* -------------------------- 4. a allow-list de host ----------------------- */

describe('urlDeDownloadSegura — a allow-list ANCORADA', () => {
  it('aceita os dois hosts de Storage, em https', () => {
    expect(urlDeDownloadSegura(`https://${HOST_STORAGE}/v0/b/b/o/x.png?token=t`).host).toBe(
      HOST_STORAGE,
    );
    expect(urlDeDownloadSegura('https://storage.googleapis.com/b/o/x.png').host).toBe(
      'storage.googleapis.com',
    );
  });

  // ⚠️ QUASE-PAR (M-70): um sufixo permissivo é satisfeito por um domínio que
  // não é nosso, e este fetch corre no SERVIDOR.
  it('QUASE-PAR: firebasestorage.googleapis.com.evil.test é RECUSADO', () => {
    expect(() =>
      urlDeDownloadSegura('https://firebasestorage.googleapis.com.evil.test/v0/b/b/o/x.png'),
    ).toThrow(ShopeeFotoPublicacaoError);
    try {
      urlDeDownloadSegura('https://firebasestorage.googleapis.com.evil.test/x.png');
    } catch (err) {
      if (!(err instanceof ShopeeFotoPublicacaoError)) throw err;
      expect(err.motivo).toBe('host-nao-permitido');
    }
    expect(HOSTS_DE_DOWNLOAD_ARQUIVO.every((re) => re.source.endsWith('$'))).toBe(true);
  });

  it('http: é RECUSADO, nunca promovido a https', () => {
    try {
      urlDeDownloadSegura(`http://${HOST_STORAGE}/v0/b/b/o/x.png`);
      expect.unreachable('deveria ter recusado');
    } catch (err) {
      if (!(err instanceof ShopeeFotoPublicacaoError)) throw err;
      expect(err.motivo).toBe('esquema-nao-permitido');
    }
  });

  it('uma URL que não parseia é uma falha de foto, não um TypeError solto', () => {
    try {
      urlDeDownloadSegura('nao-e-uma-url');
      expect.unreachable('deveria ter recusado');
    } catch (err) {
      if (!(err instanceof ShopeeFotoPublicacaoError)) throw err;
      expect(err.motivo).toBe('esquema-nao-permitido');
      expect(err.host).toBeNull();
    }
  });

  // ⚠️ PAR + QUASE-PAR: a comparação do emulador é por ORIGEM EXATA.
  it('PAR: a origem do emulador injetada é aceita; a mesma porta errada NÃO é', () => {
    const origem = 'http://127.0.0.1:9199';
    expect(urlDeDownloadSegura(`${origem}/v0/b/b/o/x.png`, origem).port).toBe('9199');
    try {
      urlDeDownloadSegura('http://127.0.0.1:9198/v0/b/b/o/x.png', origem);
      expect.unreachable('deveria ter recusado');
    } catch (err) {
      if (!(err instanceof ShopeeFotoPublicacaoError)) throw err;
      expect(err.motivo).toBe('esquema-nao-permitido');
    }
  });

  it('um host fora da allow-list é uma falha contada, não um throw', async () => {
    const db = new FakeDb();
    semearArquivo(db, 'arq-1', [], 'https://cdn.exemplo.test/x.png');
    const avisos = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const res = await resolverImagensParaPublicar(deps(db, fetchDe([]), uploadOk()), [
      foto('arq-1'),
    ]);

    expect(res.imageIds).toEqual([]);
    expect(res.falhas).toHaveLength(1);
    expect(res.falhas[0]?.motivo).toBe('host-nao-permitido');
    expect(avisos).toHaveBeenCalledTimes(1);
  });

  it('um arquivo sem url é uma falha contada', async () => {
    const db = new FakeDb();
    semearArquivo(db, 'arq-1', [], null);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const res = await resolverImagensParaPublicar(deps(db, fetchDe([]), uploadOk()), [
      foto('arq-1'),
    ]);

    expect(res.falhas[0]).toMatchObject({ arquivoId: 'arq-1', motivo: 'sem-url' });
  });
});

/* ----------------------------- 5. o download ----------------------------- */

describe('o download — redirecionamento, HTTP, content-type e tamanho', () => {
  // ⚠️ M-71: sem `redirect: 'manual'` o host CONECTADO é o que o host permitido
  // respondeu, e a allow-list nunca roda de novo.
  it('um 302 é recusado nomeando o status e o host pedido, nunca o Location', async () => {
    const db = new FakeDb();
    semearArquivo(db, 'arq-1');
    const fetch = fetchDe([], {
      [urlDeArquivo('arq-1')]: { status: 302, location: 'https://evil.test/roubado.png' },
    });
    const avisos = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const res = await resolverImagensParaPublicar(deps(db, fetch, uploadOk()), [foto('arq-1')]);

    expect(res.imageIds).toEqual([]);
    expect(res.falhas[0]?.motivo).toBe('redirecionamento');
    expect(res.falhas[0]?.mensagem).toContain('302');
    expect(res.falhas[0]?.mensagem).toContain(HOST_STORAGE);
    expect(JSON.stringify(avisos.mock.calls)).not.toContain('evil.test');
    expect(res.falhas[0]?.mensagem).not.toContain('evil.test');
  });

  // ⚠️ M-71: a recusa acima só é ALCANÇÁVEL porque o 3xx chega a NÓS. Sem
  // `redirect: 'manual'` o `fetch` segue o desvio e o host CONECTADO passa a ser
  // o que o host permitido respondeu — e a allow-list nunca roda de novo. A
  // opção é a única coisa observável, então é ela que o teste afirma.
  it('M-71: o fetch é emitido com `redirect: manual`, sempre', async () => {
    const db = new FakeDb();
    semearArquivo(db, 'arq-1');
    const fetch = fetchDe(['arq-1']);

    await resolverImagensParaPublicar(deps(db, fetch, uploadOk()), [foto('arq-1')]);

    expect(fetch).toHaveBeenCalledWith(urlDeArquivo('arq-1'), { redirect: 'manual' });
  });

  it('um 404 é uma falha contada com motivo http', async () => {
    const db = new FakeDb();
    semearArquivo(db, 'arq-1');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const res = await resolverImagensParaPublicar(
      deps(db, fetchDe([], { [urlDeArquivo('arq-1')]: { status: 404 } }), uploadOk()),
      [foto('arq-1')],
    );

    expect(res.falhas[0]).toMatchObject({ motivo: 'http' });
  });

  it('uma falha de rede (TypeError) é uma falha contada, não uma publicação perdida', async () => {
    const db = new FakeDb();
    semearArquivo(db, 'arq-1');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const res = await resolverImagensParaPublicar(
      deps(db, fetchDe([], { [urlDeArquivo('arq-1')]: 'erro-de-rede' }), uploadOk()),
      [foto('arq-1')],
    );

    expect(res.falhas[0]).toMatchObject({ motivo: 'http' });
    expect(res.imageIds).toEqual([]);
  });

  it('um content-type image/webp é uma falha contada', async () => {
    const db = new FakeDb();
    semearArquivo(db, 'arq-1');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const res = await resolverImagensParaPublicar(
      deps(db, fetchDe([], { [urlDeArquivo('arq-1')]: { contentType: 'image/webp' } }), uploadOk()),
      [foto('arq-1')],
    );

    expect(res.falhas[0]).toMatchObject({ motivo: 'content-type' });
  });

  it('um content-type com charset e caixa alta ainda é aceito', async () => {
    const db = new FakeDb();
    semearArquivo(db, 'arq-1');
    const enviar = uploadOk();

    const res = await resolverImagensParaPublicar(
      deps(
        db,
        fetchDe([], { [urlDeArquivo('arq-1')]: { contentType: 'IMAGE/JPEG; charset=binary' } }),
        enviar,
      ),
      [foto('arq-1')],
    );

    expect(res.enviadas).toBe(1);
    expect(enviar.mock.calls[0]?.[0].contentType).toBe('image/jpeg');
  });

  it('um arquivo de 10 MB + 1 byte é uma falha contada, não um ShopeeConfigError', async () => {
    const db = new FakeDb();
    semearArquivo(db, 'arq-1');
    const enviar = uploadOk();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const res = await resolverImagensParaPublicar(
      deps(
        db,
        fetchDe([], {
          [urlDeArquivo('arq-1')]: {
            bytes: new Uint8Array(SHOPEE_UPLOAD_IMAGE_MAX_BYTES + 1),
          },
        }),
        enviar,
      ),
      [foto('arq-1')],
    );

    expect(res.falhas[0]).toMatchObject({ motivo: 'tamanho' });
    expect(enviar).not.toHaveBeenCalled();
  });
});

/* ------------------------------ 6. o upload ------------------------------ */

describe('o upload e a leitura do image_id', () => {
  // ⚠️ M-77: o nome do arquivo é DETERMINÍSTICO. O exportador legado usava
  // `image<microsecondsSinceEpoch>`; não há relógio nenhum sob `anuncios/`.
  it('o filename é determinístico (o id do arquivo), sem relógio', async () => {
    const db = new FakeDb();
    semearArquivo(db, 'arq-1');
    semearArquivo(db, 'arq-2');
    const enviar = uploadOk();

    await resolverImagensParaPublicar(deps(db, fetchDe(['arq-1']), enviar), [foto('arq-1')]);
    await resolverImagensParaPublicar(deps(db, fetchDe(['arq-2']), enviar), [foto('arq-2')]);

    expect(enviar.mock.calls.map((c) => c[0].filename)).toEqual(['arq-1.png', 'arq-2.png']);
  });

  it('o mesmo arquivo em duas publicações produz o MESMO filename', async () => {
    const db = new FakeDb();
    semearArquivo(db, 'arq-1');
    const enviar = uploadOk();

    await resolverImagensParaPublicar(deps(db, fetchDe(['arq-1']), enviar), [foto('arq-1')]);
    // A segunda publicação ignora o cache porque o arquivo foi re-semeado.
    semearArquivo(db, 'arq-1');
    await resolverImagensParaPublicar(deps(db, fetchDe(['arq-1']), enviar), [foto('arq-1')]);

    expect(enviar.mock.calls[0]?.[0].filename).toBe(enviar.mock.calls[1]?.[0].filename);
  });

  it('o image_id vem de image_info quando o Shopee usa a posição de arquivo único', async () => {
    const db = new FakeDb();
    semearArquivo(db, 'arq-1');
    const enviar = vi.fn(() =>
      Promise.resolve(envelope({ image_info: { image_id: 'img-unica' } })),
    );

    const res = await resolverImagensParaPublicar(deps(db, fetchDe(['arq-1']), enviar), [
      foto('arq-1'),
    ]);

    expect(res.imageIds).toEqual(['img-unica']);
  });

  it('o image_id vem da primeira entrada SEM error de image_info_list', async () => {
    const db = new FakeDb();
    semearArquivo(db, 'arq-1');
    const enviar = vi.fn(() =>
      Promise.resolve(
        envelope({
          image_info: null,
          image_info_list: [
            { id: 0, error: 'error_param', message: 'ignorado', image_info: null },
            { id: 1, error: '', message: '', image_info: { image_id: 'img-da-lista' } },
          ],
        }),
      ),
    );

    const res = await resolverImagensParaPublicar(deps(db, fetchDe(['arq-1']), enviar), [
      foto('arq-1'),
    ]);

    expect(res.imageIds).toEqual(['img-da-lista']);
  });

  it('um erro por índice em image_info_list é uma falha contada, com o CODE e não a prosa', async () => {
    const db = new FakeDb();
    semearArquivo(db, 'arq-1');
    const avisos = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const enviar = vi.fn(() =>
      Promise.resolve(
        envelope({
          image_info: null,
          image_info_list: [
            {
              id: 0,
              error: 'error_image_size',
              message: 'a prosa do provedor que nao deve aparecer',
              image_info: null,
            },
          ],
        }),
      ),
    );

    const res = await resolverImagensParaPublicar(deps(db, fetchDe(['arq-1']), enviar), [
      foto('arq-1'),
    ]);

    expect(res.imageIds).toEqual([]);
    expect(res.falhas[0]).toMatchObject({ motivo: 'upload-recusado' });
    expect(res.falhas[0]?.mensagem).toContain('error_image_size');
    expect(JSON.stringify(avisos.mock.calls)).not.toContain('prosa do provedor');
    expect(res.falhas[0]?.mensagem).not.toContain('prosa do provedor');
  });

  it('um upload aceito sem image_id nenhum é uma falha sem-image-id', async () => {
    const db = new FakeDb();
    semearArquivo(db, 'arq-1');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const enviar = vi.fn(() => Promise.resolve(envelope({ image_info: null })));

    const res = await resolverImagensParaPublicar(deps(db, fetchDe(['arq-1']), enviar), [
      foto('arq-1'),
    ]);

    expect(res.falhas[0]).toMatchObject({ motivo: 'sem-image-id' });
    expect(db.patches).toEqual([]);
  });
});

/* ---------------------- 7. a divisão de falhas (O8) ---------------------- */

describe('a divisão de falhas — o que PULA e o que DERRUBA a publicação', () => {
  // ⚠️ O8 (par 1/2): a sondagem de 2026-09-17 mediu `product.error_param:
  // image is invalid or not supported` para um PNG 16×16 — recusa de CONTEÚDO.
  it('O8: um `product.error_param` do upload PULA a foto e conta a falha', async () => {
    const db = new FakeDb();
    semearArquivo(db, 'arq-1');
    semearArquivo(db, 'arq-2');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const enviar = vi.fn((p: UploadImageParams) =>
      p.filename === 'arq-1.png'
        ? Promise.reject(erroApi('product.error_param'))
        : Promise.resolve(envelope({ image_info: { image_id: 'img-ok' } })),
    );

    const res = await resolverImagensParaPublicar(deps(db, fetchDe(['arq-1', 'arq-2']), enviar), [
      foto('arq-1'),
      foto('arq-2'),
    ]);

    expect(res.imageIds).toEqual(['img-ok']);
    expect(res.falhas[0]).toMatchObject({ arquivoId: 'arq-1', motivo: 'upload-recusado' });
    expect(res.falhas[0]?.mensagem).toContain('product.error_param');
  });

  it('O8: um `error_image_invalid` sem prefixo de módulo também PULA', async () => {
    const db = new FakeDb();
    semearArquivo(db, 'arq-1');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const enviar = vi.fn(() => Promise.reject(erroApi('error_image_invalid')));

    const res = await resolverImagensParaPublicar(deps(db, fetchDe(['arq-1']), enviar), [
      foto('arq-1'),
    ]);

    expect(res.falhas[0]).toMatchObject({ motivo: 'upload-recusado' });
  });

  // ⚠️ M-76 / O8 (par 2/2): QUALQUER outro erro do Shopee PROPAGA. Um anúncio
  // criado ao vivo com metade das fotos porque o app foi estrangulado é pior
  // que uma publicação que falhou e pode ser repetida.
  it('M-76: um ShopeeApiError que NÃO é recusa de conteúdo PROPAGA', async () => {
    const db = new FakeDb();
    semearArquivo(db, 'arq-1');
    const enviar = vi.fn(() => Promise.reject(erroApi('product.error_busi')));

    await expect(
      resolverImagensParaPublicar(deps(db, fetchDe(['arq-1']), enviar), [foto('arq-1')]),
    ).rejects.toBeInstanceOf(ShopeeApiError);
  });

  it('M-76: um limite de taxa do upload PROPAGA', async () => {
    const db = new FakeDb();
    semearArquivo(db, 'arq-1');
    const enviar = vi.fn(() =>
      Promise.reject(
        new ShopeeRateLimitError('estrangulado', {
          code: 'error_limit',
          kind: 'burst',
          httpStatus: 200,
          path: SHOPEE_UPLOAD_IMAGE_PATH,
          retryAfterSeconds: 30,
        }),
      ),
    );

    await expect(
      resolverImagensParaPublicar(deps(db, fetchDe(['arq-1']), enviar), [foto('arq-1')]),
    ).rejects.toBeInstanceOf(ShopeeRateLimitError);
  });

  it('QUASE-PAR de O8: um error_param de kind transient PROPAGA', async () => {
    const db = new FakeDb();
    semearArquivo(db, 'arq-1');
    const enviar = vi.fn(() => Promise.reject(erroApi('product.error_param', 'transient')));

    await expect(
      resolverImagensParaPublicar(deps(db, fetchDe(['arq-1']), enviar), [foto('arq-1')]),
    ).rejects.toBeInstanceOf(ShopeeApiError);
  });

  // ⚠️ M-79: o vazio NÃO lança aqui. O publicador recusa com `sem-fotos` antes
  // do `add_item`, onde o vocabulário bloqueado vive.
  it('M-79: zero fotos utilizáveis devolve imageIds vazio e NÃO lança', async () => {
    const db = new FakeDb();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const res = await resolverImagensParaPublicar(deps(db, fetchDe([]), uploadOk()), [
      foto('arq-ausente-1'),
      foto('arq-ausente-2'),
    ]);

    expect(res.imageIds).toEqual([]);
    expect(res.falhas.map((f) => f.motivo)).toEqual(['arquivo-ausente', 'arquivo-ausente']);
  });

  it('uma lista de fotos VAZIA devolve imageIds vazio e não lê nada', async () => {
    const db = new FakeDb();

    const res = await resolverImagensParaPublicar(deps(db, fetchDe([]), uploadOk()), []);

    expect(res).toEqual({
      imageIds: [],
      reutilizadas: 0,
      enviadas: 0,
      falhas: [],
      consideradas: 0,
      descartadasPeloLimite: 0,
    });
    expect(db.opLog).toEqual([]);
  });
});

/* --------------------- 8. a gravação do cache (tier 0) ------------------- */

describe('a gravação do cache — arrayUnion, e o NOT_FOUND rebaixado', () => {
  // ⚠️ M-74: `arrayUnion` (regra 7, tier 0). O array é COMPARTILHADO entre
  // contas: um `set` do array inteiro derrubaria a entrada de outra conta.
  it('o externalIds é gravado com arrayUnion, nunca sobrescrito', async () => {
    const db = new FakeDb();
    semearArquivo(db, 'arq-1', [
      { externalId: 'img-da-outra-conta', integracaoPath: refCanonico(OUTRA_INTEGRACAO) },
    ]);
    const enviar = uploadOk();

    await resolverImagensParaPublicar(deps(db, fetchDe(['arq-1']), enviar), [foto('arq-1')]);

    // A entrada da OUTRA conta sobreviveu — é isto que um `set` perderia.
    expect(externalIdsArmazenados(db, 'arq-1')).toEqual([
      { externalId: 'img-da-outra-conta', integracaoPath: refCanonico(OUTRA_INTEGRACAO) },
      { externalId: 'img-arq-1.png', integracaoPath: toOuterRef(`integracao/${INTEGRACAO}`) },
    ]);
    // E o que foi ESCRITO é o sentinela, não um array pronto.
    const patch = patchesDe(db, 'arq-1')[0]?.patch.externalIds;
    expect(patch).toBeInstanceOf(FieldValue);
    expect(Array.isArray(patch)).toBe(false);
  });

  it('uma segunda publicação do mesmo par não duplica a entrada', async () => {
    const db = new FakeDb();
    semearArquivo(db, 'arq-1');
    const enviar = uploadOk();

    await resolverImagensParaPublicar(deps(db, fetchDe(['arq-1']), enviar), [foto('arq-1')]);
    const res = await resolverImagensParaPublicar(deps(db, fetchDe([]), enviar), [foto('arq-1')]);

    expect(res.reutilizadas).toBe(1);
    expect(externalIdsArmazenados(db, 'arq-1')).toHaveLength(1);
  });

  // ⚠️ M-75 (par 1/2): tier 3 REBAIXADO a um log — o id já foi cunhado e é
  // usável; só a entrada de cache se perdeu (a varredura de órfãos apaga
  // arquivos exatamente assim).
  it('M-75: um NOT_FOUND na gravação do cache não derruba a publicação', async () => {
    const db = new FakeDb();
    semearArquivo(db, 'arq-1');
    db.falhasDeUpdate.set('arquivos/arq-1', grpc(5, 'NOT_FOUND'));
    const avisos = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const res = await resolverImagensParaPublicar(deps(db, fetchDe(['arq-1']), uploadOk()), [
      foto('arq-1'),
    ]);

    expect(res.imageIds).toEqual(['img-arq-1.png']);
    expect(res.enviadas).toBe(1);
    expect(res.falhas).toEqual([]);
    expect(avisos).toHaveBeenCalledTimes(1);
  });

  // ⚠️ M-75 (par 2/2): o estreitamento é pelo CÓDIGO, nunca pela classe — um
  // erro do Firestore que não seja NOT_FOUND derruba a publicação.
  it('M-75 QUASE-PAR: um PERMISSION_DENIED (7) na gravação do cache PROPAGA', async () => {
    const db = new FakeDb();
    semearArquivo(db, 'arq-1');
    db.falhasDeUpdate.set('arquivos/arq-1', grpc(7, 'PERMISSION_DENIED'));

    await expect(
      resolverImagensParaPublicar(deps(db, fetchDe(['arq-1']), uploadOk()), [foto('arq-1')]),
    ).rejects.toThrow('PERMISSION_DENIED');
  });
});

/* ------------------------------ 9. o log line ---------------------------- */

describe('o log de uma foto pulada', () => {
  // ⚠️ M-78: uma URL de download do Firebase carrega um TOKEN. O log leva o
  // host, o produto, a integração, o arquivo e o motivo — nada mais.
  it('M-78: o log de uma foto pulada não carrega a URL', async () => {
    const db = new FakeDb();
    semearArquivo(db, 'arq-1');
    const avisos = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await resolverImagensParaPublicar(
      deps(db, fetchDe([], { [urlDeArquivo('arq-1')]: { status: 403 } }), uploadOk()),
      [foto('arq-1')],
    );

    const registrado = JSON.stringify(avisos.mock.calls);
    expect(registrado).not.toContain('?alt=media');
    expect(registrado).not.toContain('token=');
    expect(registrado).not.toContain('segredo-');
    expect(avisos).toHaveBeenCalledTimes(1);
    expect(avisos.mock.calls[0]?.[1]).toEqual({
      produtoId: PRODUTO,
      integracaoId: INTEGRACAO,
      arquivoId: 'arq-1',
      host: HOST_STORAGE,
      motivo: 'http',
    });
  });

  it('uma falha sem host nenhum registra host null, nunca a URL', async () => {
    const db = new FakeDb();
    const avisos = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await resolverImagensParaPublicar(deps(db, fetchDe([]), uploadOk()), [foto('arq-1')]);

    expect(avisos.mock.calls[0]?.[1]).toMatchObject({ host: null, motivo: 'arquivo-ausente' });
  });
});
