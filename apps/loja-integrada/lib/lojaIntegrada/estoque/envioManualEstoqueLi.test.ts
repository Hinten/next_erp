/**
 * `envioManualEstoqueLi.ts` (master plan step 12, PR 12-h): the manual push's reads, counted
 * against `testing/fakeDb.ts`; its tasks, through the REAL stock producer over a recording
 * transport that answers a repeated name with the SDK's own already-exists
 * (`testing/reconcileEstoqueLi.ts`'s `filaEstoqueGravadora`); its expansion query pinned against
 * `firestore.indexes.json`. Nothing reaches a network: the global `fetch` throws.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { MissingRegionError } from '@delfrance/core/region';
import {
  MOTIVO_ENVIO_ESTOQUE_LI,
  MODO_ESTOQUE_LI,
  ORIGEM_TAREFA_ESTOQUE_LI,
  RESULTADO_ENVIO_ESTOQUE_LI,
  TIPO_TAREFA_ESTOQUE_LI,
  respostaEnvioEstoqueLiSchema,
} from '@delfrance/schemas';

import { type DocData, FakeDb, asDb } from '../testing/fakeDb';
import { falhaDoFunctions } from '../testing/falhaDeEnfileiramento';
import { filaEstoqueGravadora, seedLinkFilho } from '../testing/reconcileEstoqueLi';
import { idDaTarefaEstoqueLi, janelaEstoqueLi } from './agendadorEstoque';
import {
  CAMPOS_FILHO_ENVIO_MANUAL_LI,
  CAMPOS_INDICE_FILHOS_ENVIO_MANUAL_LI,
  CAMPOS_PRODUTO_ENVIO_MANUAL_LI,
  CONCORRENCIA_ENVIO_MANUAL_ESTOQUE_LI,
  MAX_ALVOS_ENVIO_ESTOQUE_LI,
  MENSAGEM_ENFILEIRADO_LI,
  type ResultadoEnvioManualEstoqueLi,
  enviarEstoqueManualLi,
} from './envioManualEstoqueLi';

let fetchFalso: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchFalso = vi.fn(() => {
    throw new Error('envioManualEstoqueLi.test: o fetch global não pode ser chamado');
  });
  vi.stubGlobal('fetch', fetchFalso);
});
afterEach(() => {
  expect(fetchFalso).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

const CONTA = 'C1';
const OUTRA = 'C2';
/** 2027-01-15T15:00:10Z: a minute window the tests can stay inside. */
const AGORA = Date.UTC(2027, 0, 15, 15, 0, 10);

function seedPai(db: FakeDb, id: string, over: DocData = {}): void {
  db.seed(`produtos/${id}`, {
    nome: `Pai ${id}`,
    paiId: null,
    integracoesComProduto: [CONTA],
    ...over,
  });
  // The parent's own link: a root WITH grades (a parent row is never sent).
  db.seed(`produtos/${id}/produtolojaintegrada/l-${id}`, {
    contaLojaIntegrada: `documents/integracao/${CONTA}`,
    id: 900,
    paiProdutoIntegradaId: null,
    grades: [1],
    removido: false,
  });
}

function seedFilho(
  db: FakeDb,
  id: string,
  paiId: string | null,
  idLi: number | string | null,
  over: DocData = {},
): void {
  db.seed(`produtos/${id}`, {
    nome: `Filho ${id}`,
    paiId,
    integracoesComProduto: [CONTA],
    ...over,
  });
  if (idLi !== null) seedLinkFilho(db, id, `l-${id}`, CONTA, idLi);
}

async function enviar(
  db: FakeDb,
  produtoIds: readonly string[],
  o: {
    readonly fila?: ReturnType<typeof filaEstoqueGravadora>;
    readonly agoraMs?: number;
    readonly modo?: (typeof MODO_ESTOQUE_LI)[keyof typeof MODO_ESTOQUE_LI];
  } = {},
) {
  const fila = o.fila ?? filaEstoqueGravadora();
  const r = await enviarEstoqueManualLi(
    { contaId: CONTA, produtoIds, modo: o.modo ?? MODO_ESTOQUE_LI.on },
    { db: asDb(db), agendador: fila.agendador, agoraMs: () => o.agoraMs ?? AGORA },
  );
  return { r, fila };
}

function respondido(r: ResultadoEnvioManualEstoqueLi) {
  if (r.tipo !== 'respondido') throw new Error(`esperado respondido, veio ${r.tipo}`);
  return r.resposta;
}

/** The listings the push made: the produtos whose own links it listed. */
function listagens(db: FakeDb): string[] {
  return db.consultas
    .filter((c) => c.colecao.endsWith('/produtolojaintegrada'))
    .map((c) => c.colecao.split('/')[1] ?? '');
}

const expansoes = (db: FakeDb) => db.consultas.filter((c) => c.colecao === 'produtos');

describe('the anchor expansion and its reads', () => {
  it('an anchor with 3 linked children: ONE getAll, ONE expansion query, 3 listings, 0 produto doc reads, 3 tasks', async () => {
    const db = new FakeDb();
    seedPai(db, 'pai-1');
    seedFilho(db, 'f1', 'pai-1', 101);
    seedFilho(db, 'f2', 'pai-1', 102);
    seedFilho(db, 'f3', 'pai-1', '103');
    const getAll = vi.spyOn(db, 'getAll');

    const { r, fila } = await enviar(db, ['pai-1']);
    const resposta = respondido(r);

    expect(getAll).toHaveBeenCalledTimes(1);
    expect(getAll.mock.calls[0]?.at(-1)).toEqual({
      fieldMask: [...CAMPOS_PRODUTO_ENVIO_MANUAL_LI],
    });
    // The selection only: no child document is read (the expansion projects what it needs).
    expect(db.leituras).toEqual(['produtos/pai-1']);
    expect(expansoes(db)).toHaveLength(1);
    expect(listagens(db).sort()).toEqual(['f1', 'f2', 'f3']);
    expect(
      resposta.listings.map((l) => [l.produtoId, l.solicitadoId, l.idLi, l.resultado]),
    ).toEqual([
      ['f1', 'pai-1', '101', RESULTADO_ENVIO_ESTOQUE_LI.enfileirado],
      ['f2', 'pai-1', '102', RESULTADO_ENVIO_ESTOQUE_LI.enfileirado],
      ['f3', 'pai-1', '103', RESULTADO_ENVIO_ESTOQUE_LI.enfileirado],
    ]);
    // Each child is named by its OWN name, never the anchor's.
    expect(resposta.listings.map((l) => l.produtoNome)).toEqual([
      'Filho f1',
      'Filho f2',
      'Filho f3',
    ]);
    expect(resposta.produtosSemEnvio).toEqual([]);
    expect(resposta).toMatchObject({ contaId: CONTA, modo: MODO_ESTOQUE_LI.on, solicitados: 1 });
    expect(fila.enviadas.map((e) => e.tarefa)).toEqual(
      ['f1', 'f2', 'f3'].map((produtoId) => ({
        tipo: TIPO_TAREFA_ESTOQUE_LI.estoque,
        contaId: CONTA,
        produtoId,
        origem: ORIGEM_TAREFA_ESTOQUE_LI.manual,
        janela: janelaEstoqueLi(AGORA),
        estoqueId: null,
        apagado: false,
        estoqueIds: null,
        geracao: 0,
      })),
    );
    expect(r.contagens).toEqual({
      solicitados: 1,
      consultas: 1,
      alvos: 3,
      listagens: 3,
      enfileirados: 3,
      pulados: 0,
      falhas: 0,
    });
    // ⚠️ A queued row never says "sent": the send run decides later.
    expect(JSON.stringify(resposta)).not.toContain('enviado');
    expect(respostaEnvioEstoqueLiSchema.parse(resposta)).toEqual(resposta);
  });

  it('the expansion is EXACTLY paiId == <anchor> AND integracoesComProduto array-contains <conta>, projected, limit = bound + 1', async () => {
    const db = new FakeDb();
    seedPai(db, 'pai-1');
    seedFilho(db, 'f1', 'pai-1', 101);
    await enviar(db, ['pai-1']);
    expect(expansoes(db)).toEqual([
      {
        colecao: 'produtos',
        filtros: [
          ['paiId', '==', 'pai-1'],
          ['integracoesComProduto', 'array-contains', CONTA],
        ],
        ordens: [],
        limite: MAX_ALVOS_ENVIO_ESTOQUE_LI + 1,
        apos: null,
        selecao: [...CAMPOS_FILHO_ENVIO_MANUAL_LI],
      },
    ]);
  });

  it('⚠️ INDEX PIN: the expansion rides the declared COLLECTION index produtos (paiId, integracoesComProduto, __name__) — Enterprise full-scans an undeclared one', () => {
    let dir = dirname(fileURLToPath(import.meta.url));
    while (!existsSync(resolve(dir, 'pnpm-workspace.yaml'))) dir = dirname(dir);
    const { indexes } = JSON.parse(
      readFileSync(resolve(dir, 'firestore.indexes.json'), 'utf8'),
    ) as {
      indexes: {
        collectionGroup: string;
        queryScope: string;
        fields: { fieldPath: string; order?: string }[];
      }[];
    };
    expect(CAMPOS_INDICE_FILHOS_ENVIO_MANUAL_LI).toEqual(['paiId', 'integracoesComProduto']);
    const declarados = indexes.filter(
      (i) =>
        i.collectionGroup === 'produtos' &&
        i.queryScope === 'COLLECTION' &&
        JSON.stringify(i.fields.map((f) => f.fieldPath)) ===
          JSON.stringify([...CAMPOS_INDICE_FILHOS_ENVIO_MANUAL_LI, '__name__']),
    );
    expect(declarados).toHaveLength(1);
    // `array-contains` rides the ASC entry on Enterprise (the price sweeps' precedent).
    expect(declarados[0]?.fields.every((f) => f.order === 'ASCENDING')).toBe(true);
  });

  it('a selected CHILD is its own target: no expansion, ONE listing, ONE task under its own id', async () => {
    const db = new FakeDb();
    seedPai(db, 'pai-1');
    seedFilho(db, 'f1', 'pai-1', 101);
    seedFilho(db, 'f2', 'pai-1', 102);

    const { r, fila } = await enviar(db, ['f2']);
    const resposta = respondido(r);

    expect(expansoes(db)).toEqual([]);
    expect(listagens(db)).toEqual(['f2']);
    expect(resposta.listings).toEqual([
      {
        produtoId: 'f2',
        solicitadoId: 'f2',
        produtoNome: 'Filho f2',
        idLi: '102',
        resultado: RESULTADO_ENVIO_ESTOQUE_LI.enfileirado,
        motivo: null,
        mensagem: MENSAGEM_ENFILEIRADO_LI.on,
      },
    ]);
    expect(fila.enviadas.map((e) => e.tarefa.tipo === 'estoque' && e.tarefa.produtoId)).toEqual([
      'f2',
    ]);
  });

  it('a simple produto (a root with no child naming the conta) is its own target', async () => {
    const db = new FakeDb();
    seedFilho(db, 'simples', null, 77);
    const { r, fila } = await enviar(db, ['simples']);
    expect(respondido(r).listings.map((l) => [l.produtoId, l.resultado])).toEqual([
      ['simples', RESULTADO_ENVIO_ESTOQUE_LI.enfileirado],
    ]);
    expect(expansoes(db)).toHaveLength(1);
    expect(fila.enviadas).toHaveLength(1);
  });

  it('dedup: an anchor and one of its children both selected ⇒ ONE task for that child; a repeated id counts once', async () => {
    const db = new FakeDb();
    seedPai(db, 'pai-1');
    seedFilho(db, 'f1', 'pai-1', 101);
    seedFilho(db, 'f2', 'pai-1', 102);

    const { r, fila } = await enviar(db, ['f1', 'pai-1', 'f1', 'pai-1']);
    const resposta = respondido(r);

    expect(resposta.solicitados).toBe(2);
    expect(fila.tentativas).toHaveLength(2);
    expect(resposta.listings.map((l) => [l.produtoId, l.solicitadoId])).toEqual([
      ['f1', 'f1'],
      ['f2', 'pai-1'],
    ]);
    expect(resposta.produtosSemEnvio).toEqual([]);
    expect(db.leituras).toEqual(['produtos/f1', 'produtos/pai-1']);
  });
});

describe('the pre-filter: the produto-side conta list', () => {
  it('a mixed selection — 150 families of another channel × 8 children plus ONE child of this conta: 1 getAll, no expansion and no listing for the others, 1 task, no refusal', async () => {
    const db = new FakeDb();
    const outros: string[] = [];
    for (let f = 0; f < 150; f += 1) {
      const pai = `ml-${String(f)}`;
      outros.push(pai);
      db.seed(`produtos/${pai}`, { nome: pai, paiId: null, integracoesComProduto: ['ML1'] });
      for (let c = 0; c < 8; c += 1) {
        db.seed(`produtos/${pai}-c${String(c)}`, {
          nome: 'x',
          paiId: pai,
          integracoesComProduto: ['ML1'],
        });
      }
    }
    seedPai(db, 'pai-li');
    seedFilho(db, 'f-li', 'pai-li', 55);
    const getAll = vi.spyOn(db, 'getAll');

    const { r, fila } = await enviar(db, [...outros, 'f-li']);
    const resposta = respondido(r);

    expect(getAll).toHaveBeenCalledTimes(1);
    expect(expansoes(db)).toEqual([]);
    expect(listagens(db)).toEqual(['f-li']);
    expect(fila.enviadas).toHaveLength(1);
    expect(resposta.listings).toHaveLength(1);
    // ONE entry per selected id of the other channel — never one per child.
    expect(resposta.produtosSemEnvio).toHaveLength(150);
    expect(new Set(resposta.produtosSemEnvio.map((p) => p.motivo))).toEqual(
      new Set([MOTIVO_ENVIO_ESTOQUE_LI.semVinculo]),
    );
  });

  it('⚠️ NEAR-MISS: another conta’s id, a prefix of this one, a non-array or an absent list are not this conta', async () => {
    const db = new FakeDb();
    seedFilho(db, 'a', null, 1, { integracoesComProduto: [OUTRA] });
    seedFilho(db, 'b', null, 2, { integracoesComProduto: ['C10'] });
    seedFilho(db, 'c', null, 3, { integracoesComProduto: CONTA });
    seedFilho(db, 'd', null, 4, { integracoesComProduto: null });
    const { r, fila } = await enviar(db, ['a', 'b', 'c', 'd']);
    expect(respondido(r).produtosSemEnvio.map((p) => [p.produtoId, p.motivo])).toEqual([
      ['a', MOTIVO_ENVIO_ESTOQUE_LI.semVinculo],
      ['b', MOTIVO_ENVIO_ESTOQUE_LI.semVinculo],
      ['c', MOTIVO_ENVIO_ESTOQUE_LI.semVinculo],
      ['d', MOTIVO_ENVIO_ESTOQUE_LI.semVinculo],
    ]);
    expect(listagens(db)).toEqual([]);
    expect(fila.tentativas).toEqual([]);
  });

  it('a missing produto ⇒ ONE produto-ausente entry, in selection order among the others', async () => {
    const db = new FakeDb();
    seedFilho(db, 'sem', null, 1, { integracoesComProduto: [] });
    seedFilho(db, 'ok', null, 2);
    const { r } = await enviar(db, ['nao-existe', 'ok', 'sem']);
    const resposta = respondido(r);
    expect(resposta.produtosSemEnvio.map((p) => [p.produtoId, p.motivo])).toEqual([
      ['nao-existe', MOTIVO_ENVIO_ESTOQUE_LI.produtoAusente],
      ['sem', MOTIVO_ENVIO_ESTOQUE_LI.semVinculo],
    ]);
    expect(resposta.listings.map((l) => l.produtoId)).toEqual(['ok']);
  });
});

describe('the classification: the send run’s own link-only plan', () => {
  it('pai / nao-suportado / vinculo-ambiguo / paridade ⇒ pulado with that motivo and NO task; only vinculado is queued', async () => {
    const db = new FakeDb();
    // A parent none of whose children names the conta: its links say `pai`.
    seedPai(db, 'so-pai');
    db.seed('produtos/so-pai-c', { nome: 'x', paiId: 'so-pai', integracoesComProduto: [OUTRA] });
    // A root link with no grades: a simple store product.
    seedFilho(db, 'simples', null, null);
    db.seed('produtos/simples/produtolojaintegrada/l', {
      contaLojaIntegrada: `documents/integracao/${CONTA}`,
      id: 5,
      paiProdutoIntegradaId: null,
      removido: false,
    });
    // Two store ids of the conta on one produto.
    seedFilho(db, 'ambiguo', null, 6);
    seedLinkFilho(db, 'ambiguo', 'l2', CONTA, 7);
    // The operator switched stock off for this listing (its own parity entry).
    seedFilho(db, 'paridade', null, 8, {
      statusProdutosMarketplace: { [`${CONTA}_8`]: { enviarEstoque: false } },
    });
    // Another listing's entry, and a `'false'` text, both SEND (near-misses).
    seedFilho(db, 'envia', null, 9, {
      statusProdutosMarketplace: {
        [`${CONTA}_10`]: { enviarEstoque: false },
        [`${CONTA}_9`]: { enviarEstoque: 'false' },
      },
    });

    const { r, fila } = await enviar(db, ['so-pai', 'simples', 'ambiguo', 'paridade', 'envia']);
    const resposta = respondido(r);

    expect(resposta.listings.map((l) => [l.produtoId, l.resultado, l.motivo, l.idLi])).toEqual([
      ['so-pai', RESULTADO_ENVIO_ESTOQUE_LI.pulado, MOTIVO_ENVIO_ESTOQUE_LI.pai, null],
      ['simples', RESULTADO_ENVIO_ESTOQUE_LI.pulado, MOTIVO_ENVIO_ESTOQUE_LI.naoSuportado, null],
      ['ambiguo', RESULTADO_ENVIO_ESTOQUE_LI.pulado, MOTIVO_ENVIO_ESTOQUE_LI.vinculoAmbiguo, null],
      ['paridade', RESULTADO_ENVIO_ESTOQUE_LI.pulado, MOTIVO_ENVIO_ESTOQUE_LI.paridade, '8'],
      ['envia', RESULTADO_ENVIO_ESTOQUE_LI.enfileirado, null, '9'],
    ]);
    expect(fila.enviadas.map((e) => e.tarefa.tipo === 'estoque' && e.tarefa.produtoId)).toEqual([
      'envia',
    ]);
    expect(r.contagens).toMatchObject({ pulados: 4, enfileirados: 1 });
  });

  it('the parity of an EXPANDED child comes from the expansion’s projection (no child doc read)', async () => {
    const db = new FakeDb();
    seedPai(db, 'pai-1');
    seedFilho(db, 'f1', 'pai-1', 101, {
      statusProdutosMarketplace: { [`${CONTA}_101`]: { enviarEstoque: false } },
    });
    seedFilho(db, 'f2', 'pai-1', 102);
    const { r, fila } = await enviar(db, ['pai-1']);
    expect(respondido(r).listings.map((l) => [l.produtoId, l.motivo])).toEqual([
      ['f1', MOTIVO_ENVIO_ESTOQUE_LI.paridade],
      ['f2', null],
    ]);
    expect(fila.enviadas).toHaveLength(1);
    expect(db.leituras).toEqual(['produtos/pai-1']);
  });

  it('a family whose listed children have no counting link (trashed links) ⇒ exactly ONE sem-vinculo entry, no rows, no task', async () => {
    const db = new FakeDb();
    seedPai(db, 'pai-1');
    for (const id of ['f1', 'f2', 'f3']) {
      seedFilho(db, id, 'pai-1', null);
      seedLinkFilho(db, id, `l-${id}`, CONTA, 100, { removido: true });
    }
    const { r, fila } = await enviar(db, ['pai-1']);
    const resposta = respondido(r);
    expect(resposta.listings).toEqual([]);
    expect(resposta.produtosSemEnvio).toEqual([
      {
        produtoId: 'pai-1',
        produtoNome: 'Pai pai-1',
        motivo: MOTIVO_ENVIO_ESTOQUE_LI.semVinculo,
        mensagem: expect.any(String) as string,
      },
    ]);
    expect(listagens(db)).toHaveLength(3);
    expect(fila.tentativas).toEqual([]);
  });
});

describe('the tasks: named per minute, rejections as the producer’s contract', () => {
  it('a double click in ONE minute names the same tasks — the second meets them (already-exists) and still answers enfileirado; the next minute names new ones', async () => {
    const db = new FakeDb();
    seedPai(db, 'pai-1');
    seedFilho(db, 'f1', 'pai-1', 101);
    seedFilho(db, 'f2', 'pai-1', 102);
    const fila = filaEstoqueGravadora();

    const primeiro = await enviar(db, ['pai-1'], { fila, agoraMs: AGORA });
    const segundo = await enviar(db, ['pai-1'], { fila, agoraMs: AGORA + 40_000 });

    expect(fila.tentativas).toHaveLength(4);
    expect(fila.tentativas.slice(0, 2)).toEqual(fila.tentativas.slice(2));
    expect(fila.enviadas).toHaveLength(2);
    for (const { r } of [primeiro, segundo]) {
      expect(respondido(r).listings.map((l) => l.resultado)).toEqual([
        RESULTADO_ENVIO_ESTOQUE_LI.enfileirado,
        RESULTADO_ENVIO_ESTOQUE_LI.enfileirado,
      ]);
    }
    expect(fila.tentativas[0]).toBe(
      idDaTarefaEstoqueLi({
        origem: ORIGEM_TAREFA_ESTOQUE_LI.manual,
        contaId: CONTA,
        produtoId: 'f1',
        apagado: false,
        janela: janelaEstoqueLi(AGORA),
      }),
    );

    await enviar(db, ['pai-1'], { fila, agoraMs: AGORA + 60_000 });
    expect(fila.enviadas).toHaveLength(4);
  });

  it('a transient Cloud Tasks failure on child 2 of 3 is THAT row’s falha (fila-indisponivel); 1 and 3 are queued', async () => {
    const db = new FakeDb();
    seedPai(db, 'pai-1');
    seedFilho(db, 'f1', 'pai-1', 101);
    seedFilho(db, 'f2', 'pai-1', 102);
    seedFilho(db, 'f3', 'pai-1', 103);
    const fila = filaEstoqueGravadora({
      falhar: (t) =>
        t.tipo === 'estoque' && t.produtoId === 'f2'
          ? falhaDoFunctions('unknown-error', 503)
          : null,
    });

    const { r } = await enviar(db, ['pai-1'], { fila });

    expect(respondido(r).listings.map((l) => [l.produtoId, l.resultado, l.motivo])).toEqual([
      ['f1', RESULTADO_ENVIO_ESTOQUE_LI.enfileirado, null],
      ['f2', RESULTADO_ENVIO_ESTOQUE_LI.falha, MOTIVO_ENVIO_ESTOQUE_LI.filaIndisponivel],
      ['f3', RESULTADO_ENVIO_ESTOQUE_LI.enfileirado, null],
    ]);
    expect(r.contagens).toMatchObject({ enfileirados: 2, falhas: 1 });
  });

  it('⚠️ anything else — the root’s region guard, a strict-parse refusal — REJECTS the whole call (never a row)', async () => {
    const db = new FakeDb();
    seedPai(db, 'pai-1');
    seedFilho(db, 'f1', 'pai-1', 101);
    seedFilho(db, 'f2', 'pai-1', 102);
    const semRegiao = filaEstoqueGravadora({
      falhar: () =>
        new MissingRegionError('sem região', ['LOJA_INTEGRADA_TASKS_REGION', 'FUNCTIONS_REGION']),
    });
    await expect(enviar(db, ['pai-1'], { fila: semRegiao })).rejects.toBeInstanceOf(
      MissingRegionError,
    );
    // A produto id the strict task schema refuses (a reserved id) never leaves.
    seedFilho(db, '__x__', 'pai-1', 103);
    await expect(enviar(db, ['__x__'])).rejects.toBeInstanceOf(ZodError);
  });

  it('dry-run: the same tasks, and the copy says test mode — nothing in the answer says sent', async () => {
    const db = new FakeDb();
    seedFilho(db, 'f1', null, 101);
    const { r, fila } = await enviar(db, ['f1'], { modo: MODO_ESTOQUE_LI.dryRun });
    const resposta = respondido(r);
    expect(resposta.modo).toBe(MODO_ESTOQUE_LI.dryRun);
    expect(resposta.listings[0]?.mensagem).toBe(MENSAGEM_ENFILEIRADO_LI['dry-run']);
    expect(resposta.listings[0]?.mensagem).toContain('modo de teste');
    expect(fila.enviadas).toHaveLength(1);
    const texto = JSON.stringify(resposta);
    expect(texto).not.toContain('enviado');
    expect(texto).not.toContain('será enviado');
  });
});

describe('the bound', () => {
  function familia(db: FakeDb, pai: string, filhos: number): void {
    seedPai(db, pai);
    for (let i = 0; i < filhos; i += 1) seedFilho(db, `${pai}-f${String(i)}`, pai, 1000 + i);
  }

  it(`exactly ${String(MAX_ALVOS_ENVIO_ESTOQUE_LI)} targets are queued`, async () => {
    const db = new FakeDb();
    familia(db, 'pai', MAX_ALVOS_ENVIO_ESTOQUE_LI);
    const { r, fila } = await enviar(db, ['pai']);
    expect(r.tipo).toBe('respondido');
    expect(fila.enviadas).toHaveLength(MAX_ALVOS_ENVIO_ESTOQUE_LI);
  });

  it(`⚠️ NEAR-MISS: ${String(MAX_ALVOS_ENVIO_ESTOQUE_LI + 1)} ⇒ excede-limite, refused WHOLE before any listing or enqueue — never truncated`, async () => {
    const db = new FakeDb();
    familia(db, 'pai', MAX_ALVOS_ENVIO_ESTOQUE_LI + 5);
    const { r, fila } = await enviar(db, ['pai']);
    expect(r).toMatchObject({
      tipo: 'excede-limite',
      limite: MAX_ALVOS_ENVIO_ESTOQUE_LI,
      alvos: MAX_ALVOS_ENVIO_ESTOQUE_LI + 1,
    });
    expect(listagens(db)).toEqual([]);
    expect(fila.tentativas).toEqual([]);
    // The query's own limit bounds what one family costs to find out.
    expect(expansoes(db)[0]?.limite).toBe(MAX_ALVOS_ENVIO_ESTOQUE_LI + 1);
  });

  it('several families over the bound together are refused too; the expansion stops at the round that passes it', async () => {
    const db = new FakeDb();
    const pais = Array.from(
      { length: CONCORRENCIA_ENVIO_MANUAL_ESTOQUE_LI + 1 },
      (_, i) => `p${String(i)}`,
    );
    for (const p of pais) familia(db, p, 2);
    const { r, fila } = await enviar(db, pais);
    expect(r.tipo).toBe('excede-limite');
    expect(expansoes(db)).toHaveLength(CONCORRENCIA_ENVIO_MANUAL_ESTOQUE_LI);
    expect(listagens(db)).toEqual([]);
    expect(fila.tentativas).toEqual([]);
  });
});
