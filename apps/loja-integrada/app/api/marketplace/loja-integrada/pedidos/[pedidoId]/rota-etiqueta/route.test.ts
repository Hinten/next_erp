/**
 * `PUT …/pedidos/[pedidoId]/rota-etiqueta` — the label routing route (master plan step 15,
 * #1825), through the real core (`lib/lojaIntegrada/pedidos/rotaEtiqueta.ts`) against the fake.
 *
 * It mocks the Admin singleton only (`verifyIdToken` and the Firestore handle) and stubs the
 * global `fetch` to THROW for the whole file: the route makes no call outside the ERP. Three more
 * module mocks are TRIPWIRES, not stand-ins: the Loja Integrada package, the context loader and
 * the read switch each flag themselves if anything in the route's module graph loads them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';
import { pedidoCollection } from '@delfrance/data/admin/collections';
import {
  CODIGO_ERRO_LI,
  erroContaLojaIntegradaSchema,
  respostaRotaEtiquetaLiSchema,
} from '@delfrance/schemas';

import { type DocData, FakeDb, asDb, grpc } from '@/lib/lojaIntegrada/testing/fakeDb';
import { espiarConsole, textoDe } from '@/lib/lojaIntegrada/testing/rotas';

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  db: undefined as unknown,
  carregados: [] as string[],
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => h.db,
}));
vi.mock('@delfrance/integrations-loja-integrada', () => {
  h.carregados.push('@delfrance/integrations-loja-integrada');
  return {};
});
vi.mock('@/lib/lojaIntegrada/core/contexto', () => {
  h.carregados.push('core/contexto');
  return {};
});
vi.mock('@/lib/lojaIntegrada/core/valvulas', () => {
  h.carregados.push('core/valvulas');
  return {};
});

const { PUT } = await import('./route');

const URL_PEDIDOS = 'http://localhost:3010/api/marketplace/loja-integrada/pedidos';
const PEDIDO = 'pedido-li-rota-http';
const CAMINHO = `pedidos/${PEDIDO}`;
const CONTA_REF = 'documents/integracao/conta-li-rota-http';
const DOC_LI = 'lojaIntegrada-conta-li-rota-http';
const MOTOBOY = 'motoboy-http';
const ENDERECO = 'documents/clientes/cliente-http/enderecos/endereco-http';
const SEGREDO = 'segredo-de-alvo-ZZZZ-4444';
const MOTO = { id: 777, code: 'MOTO', nome: 'Entrega local', tipo: 'Motoboy' } as const;

/** May buy (and so route) a label. */
const ROTEADOR = {
  uid: 'u-roteador',
  permissions: (PERM.frete.read | PERM.frete.write).toString(),
};
/** May only read freight configs. */
const LEITOR_FRETE = { uid: 'u-leitor-frete', permissions: PERM.frete.read.toString() };
/** May edit pedidos, but not freight. */
const EDITOR_PEDIDO = {
  uid: 'u-editor-pedido',
  permissions: (PERM.pedido.read | PERM.pedido.write).toString(),
};

function frete(over: DocData = {}): DocData {
  return {
    estado: 'iniciado',
    integracaoFreteOuterRef: `documents/int_frete/${DOC_LI}`,
    integracaoTargetOuterRef: null,
    externalOptionId: null,
    externalOptionData: MOTO,
    printLabelId: null,
    modalidade: '0',
    enderecoFreteOuterReference: ENDERECO,
    valorCobrado: 12,
    ...over,
  };
}

function semear(db: FakeDb, freteOver: DocData = {}, pedidoOver: DocData = {}): void {
  db.seed(`int_frete/${DOC_LI}`, {
    tipo: 'lojaIntegrada',
    nome: 'Loja HTTP',
    ativo: true,
    contaLojaIntegradaEnviosOuterRef: CONTA_REF,
    mapa: [
      {
        nomeOriginal: 'Entrega local - Motoboy',
        idOriginal: '777---MOTO',
        observacao: 'Origem: Pedido 1',
        nomeTarget: null,
        targetData: null,
        integracaoUid: MOTOBOY,
        targetTipoIntegracao: 'motoboy',
      },
    ],
  });
  db.seed(`int_frete/${MOTOBOY}`, {
    tipo: 'motoboy',
    nome: 'Motoboy da loja',
    ativo: true,
    chaveInterna: SEGREDO,
  });
  db.seed(CAMINHO, {
    estado: 'pago',
    integracaoPedidoOuterRef: CONTA_REF,
    numero: '42',
    freteInicial: frete(freteOver),
    ...pedidoOver,
  });
}

interface OpcoesPut {
  readonly corpo?: unknown;
  readonly corpoBruto?: string;
  readonly semAuth?: boolean;
}

function put(pedidoId: string, opts: OpcoesPut = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.semAuth !== true) headers.authorization = 'Bearer id-token-de-teste';
  const body =
    opts.corpoBruto ?? JSON.stringify(opts.corpo === undefined ? { escolha: null } : opts.corpo);
  const req = new Request(`${URL_PEDIDOS}/${encodeURIComponent(pedidoId)}/rota-etiqueta`, {
    method: 'PUT',
    headers,
    body,
  });
  return PUT(req, { params: Promise.resolve({ pedidoId }) });
}

async function corpoDe(res: Response): Promise<unknown> {
  return (await res.json()) as unknown;
}

function refPedido(db: FakeDb) {
  return pedidoCollection.docRef(asDb(db), {}, PEDIDO);
}

let db: FakeDb;
let fetchFalso: ReturnType<typeof vi.fn>;
let console_: ReturnType<typeof espiarConsole>;

beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeDb();
  h.db = asDb(db);
  h.verifyIdToken.mockResolvedValue(ROTEADOR);
  fetchFalso = vi.fn(() => {
    throw new Error('a rota de etiqueta não chama nada fora do ERP');
  });
  vi.stubGlobal('fetch', fetchFalso);
  console_ = espiarConsole();
});

afterEach(() => {
  console_.restaurar();
  expect(fetchFalso).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe('PUT …/pedidos/[pedidoId]/rota-etiqueta — the caller', () => {
  it('401 without a bearer token; 403 for frete.read only and for pedido.write without frete.write — none of them reads anything', async () => {
    semear(db);

    expect((await put(PEDIDO, { semAuth: true })).status).toBe(401);
    h.verifyIdToken.mockResolvedValue(LEITOR_FRETE);
    expect((await put(PEDIDO)).status).toBe(403);
    h.verifyIdToken.mockResolvedValue(EDITOR_PEDIDO);
    expect((await put(PEDIDO)).status).toBe(403);
    expect(db.leituras).toEqual([]);
    expect(db.escritas).toEqual([]);

    // The near-miss: frete.write is exactly what routes.
    h.verifyIdToken.mockResolvedValue(ROTEADOR);
    expect((await put(PEDIDO)).status).toBe(200);
    expect(db.escritasEm(CAMINHO)).toHaveLength(1);
  });

  it.each(['..', '.', 'a/b'])(
    '400 LI_ID_INVALIDO for the id %j, before the body and before any read',
    async (id) => {
      const res = await put(id, { corpoBruto: 'não é json' });

      expect(res.status).toBe(400);
      expect(erroContaLojaIntegradaSchema.parse(await corpoDe(res))).toMatchObject({
        code: CODIGO_ERRO_LI.idInvalido,
      });
      expect(db.leituras).toEqual([]);
    },
  );

  it('400 LI_CORPO_INVALIDO for a body that is not JSON: a FIXED sentence, before any read', async () => {
    semear(db);

    const res = await put(PEDIDO, { corpoBruto: '{"escolha": ' });

    expect(res.status).toBe(400);
    expect(await corpoDe(res)).toEqual({
      error: 'O corpo da requisição não é um JSON válido.',
      code: CODIGO_ERRO_LI.corpoInvalido,
    });
    expect(db.leituras).toEqual([]);
  });

  it.each([
    ['an unknown key', { escolha: null, extra: 1 }, '(raiz)'],
    ['an escolha that is a path', { escolha: 'int_frete/x' }, 'escolha'],
    ['an empty escolha', { escolha: '' }, 'escolha'],
    ['no escolha at all', {}, 'escolha'],
  ])(
    '400 LI_CORPO_INVALIDO for %s — field paths only, never a value',
    async (_caso, corpo, campo) => {
      semear(db);

      const res = await put(PEDIDO, { corpo });

      expect(res.status).toBe(400);
      const envelope = erroContaLojaIntegradaSchema.parse(await corpoDe(res));
      expect(envelope.code).toBe(CODIGO_ERRO_LI.corpoInvalido);
      expect(envelope.issues).toEqual([campo]);
      expect(JSON.stringify(envelope)).not.toContain('int_frete/x');
      expect(db.leituras).toEqual([]);
    },
  );
});

describe('PUT …/pedidos/[pedidoId]/rota-etiqueta — the answers', () => {
  it('200 roteado: exactly the shared contract — never the target document', async () => {
    semear(db);

    const res = await put(PEDIDO);

    expect(res.status).toBe(200);
    const texto = await res.text();
    const corpo: unknown = JSON.parse(texto);
    expect(corpo).toEqual({
      tipo: 'roteado',
      alvo: { id: MOTOBOY, tipo: 'motoboy', nome: 'Motoboy da loja' },
      rota: {
        integracaoFreteOuterRef: `documents/int_frete/${MOTOBOY}`,
        externalOptionId: null,
        integracaoTargetOuterRef: null,
        estado: 'iniciado',
      },
    });
    expect(respostaRotaEtiquetaLiSchema.parse(corpo)).toEqual(corpo);
    expect(texto).not.toContain(SEGREDO);
    expect(texto).not.toContain(ENDERECO);
    expect(db.ler(CAMINHO)?.freteInicial).toEqual(
      frete({ integracaoFreteOuterRef: `documents/int_frete/${MOTOBOY}` }),
    );
    // A success logs nothing.
    expect(console_.argumentos()).toEqual([]);
  });

  it('200 ja-roteado on a re-click with an escolha: nothing written', async () => {
    semear(db, { integracaoFreteOuterRef: `documents/int_frete/${MOTOBOY}` });

    const res = await put(PEDIDO, { corpo: { escolha: MOTOBOY } });

    expect(res.status).toBe(200);
    expect(await corpoDe(res)).toMatchObject({ tipo: 'ja-roteado', alvo: { id: MOTOBOY } });
    expect(db.escritas).toEqual([]);
  });

  it('200 recusado is a decision, not an error — and ONE log line with ids only: the pedido, the motivo, the attempts', async () => {
    semear(db, { enderecoFreteOuterReference: null });

    const res = await put(PEDIDO);

    expect(res.status).toBe(200);
    expect(await corpoDe(res)).toEqual({ tipo: 'recusado', motivo: 'sem-endereco' });
    expect(db.escritas).toEqual([]);
    const linhas = console_.argumentos();
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.[1]).toEqual({ pedidoId: PEDIDO, motivo: 'sem-endereco', tentativas: 1 });
    expect(textoDe(linhas)).not.toContain('Loja HTTP');
    expect(textoDe(linhas)).not.toContain('Motoboy da loja');
    expect(textoDe(linhas)).not.toContain('cliente-http');
  });

  it('404 LI_PEDIDO_NAO_ENCONTRADO, in the error envelope', async () => {
    const res = await put(PEDIDO);

    expect(res.status).toBe(404);
    expect(erroContaLojaIntegradaSchema.parse(await corpoDe(res))).toMatchObject({
      code: CODIGO_ERRO_LI.pedidoNaoEncontrado,
    });
    expect(db.escritas).toEqual([]);
  });

  it('503 LI_ROTA_EM_CONFLITO after three lost races — none of ours landed — and one log line with ids only', async () => {
    semear(db);
    // A fixture write bumps the stamp before each of ours (it consumes no other hook).
    for (let i = 0; i < 3; i += 1) {
      db.antesDaProximaEscrita(CAMINHO, () => {
        const atual = db.ler(CAMINHO) ?? {};
        db.seed(CAMINHO, { ...atual, observacoesInternas: `edição ${String(i)}` });
      });
    }

    const res = await put(PEDIDO);

    expect(res.status).toBe(503);
    expect(erroContaLojaIntegradaSchema.parse(await corpoDe(res))).toMatchObject({
      code: CODIGO_ERRO_LI.rotaEmConflito,
    });
    expect(db.escritas).toEqual([]);
    expect(db.ler(CAMINHO)?.freteInicial).toEqual(frete());
    const linhas = console_.argumentos();
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.[1]).toEqual({ pedidoId: PEDIDO, tentativas: 3 });
  });

  it('the pedido removed between the read and the write ⇒ 404 on the re-read', async () => {
    semear(db);
    db.antesDaProximaEscrita(CAMINHO, async () => {
      await refPedido(db).delete();
    });

    expect((await put(PEDIDO)).status).toBe(404);
    expect(db.ler(CAMINHO)).toBeUndefined();
  });

  it('a failure that is not a lost race is rethrown, never answered as a decision', async () => {
    semear(db);
    const indisponivel = grpc(14, 'UNAVAILABLE');
    db.antesDaProximaEscrita(CAMINHO, () => {
      throw indisponivel;
    });

    await expect(put(PEDIDO)).rejects.toBe(indisponivel);
  });

  it('the route’s module graph never loaded the Loja Integrada package, the context loader or the read switch', () => {
    expect(h.carregados).toEqual([]);
  });
});
