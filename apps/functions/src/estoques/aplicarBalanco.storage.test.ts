import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { type DocumentData, type Firestore, getFirestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import { ESTADO_BALANCO, makeEstoqueUid } from '@delfrance/schemas';

import {
  BalancoNaoFinalizavelError,
  agregarContagemClassico,
  processarBalancoJob,
  tomarTravaBalanco,
  varrerDepositoClassico,
  type BalancoDeps,
} from './aplicarBalanco';
import type { BalancoScheduler } from './balancoTasks';

// Integration test — requires the firestore emulator. Drives the exported job
// core directly (the onCall/onTaskDispatched wrappers add auth + payload
// parsing, not behaviour). Skipped bare.
const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const projectId = process.env.GCLOUD_PROJECT ?? 'demo-erp';

function getDb(): Firestore {
  const app = getApps()[0] ?? initializeApp({ projectId });
  return getFirestore(app, process.env.FIREBASE_DATABASE_ID ?? 'default');
}

const USUARIO = 'documents/usuarios/uid-teste';

function novoId(prefixo: string): string {
  return `${prefixo}${randomUUID().replace(/-/g, '')}`;
}

/** Records enqueues instead of reaching Cloud Tasks. */
function recorder(): BalancoScheduler & { chamadas: string[] } {
  const chamadas: string[] = [];
  return {
    chamadas,
    async enqueue(payload) {
      chamadas.push(payload.balancoId);
    },
  };
}

function deps(db: Firestore, agora = () => 1_700_000_000_000): BalancoDeps {
  return {
    db,
    scheduler: recorder(),
    // The pipeline aggregate never runs in the emulator, so the classic
    // implementation is what this lane exercises. `reduzirContagem` — the piece
    // both share — is unit-tested on its own.
    agregar: agregarContagemClassico,
    varrer: varrerDepositoClassico,
    agora,
  };
}

interface Cenario {
  balancoId: string;
  depositoId: string;
}

async function criarBalanco(db: Firestore, nome = 'Contagem'): Promise<Cenario> {
  const balancoId = novoId('bal');
  const depositoId = novoId('dep');
  await db
    .collection('balanco')
    .doc(balancoId)
    .set({
      nome,
      depositoOuterRef: `documents/depositos/${depositoId}`,
      estado: null,
      dataFinalizado: null,
      finalizacao: null,
      timestamp: 1_700_000_000_000,
    });
  return { balancoId, depositoId };
}

async function criarProduto(db: Firestore, over: DocumentData = {}): Promise<string> {
  const produtoId = novoId('prod');
  await db
    .collection('produtos')
    .doc(produtoId)
    .set({ nome: `Produto ${produtoId}`, sku: produtoId.slice(0, 8), ehKit: false, ...over });
  return produtoId;
}

async function semearEstoque(
  db: Firestore,
  produtoId: string,
  depositoId: string,
  dados: { quantidade: number; quantidadeReservada?: number },
  docId?: string,
): Promise<void> {
  await db
    .collection('produtos')
    .doc(produtoId)
    .collection('estoques')
    .doc(docId ?? makeEstoqueUid(produtoId, depositoId))
    .set({
      parentId: produtoId,
      depositoOuterRef: `documents/depositos/${depositoId}`,
      quantidade: dados.quantidade,
      quantidadeReservada: dados.quantidadeReservada ?? 0,
      ultimaModificacao: 1,
      dataCriacao: 1,
    });
}

async function lancar(
  db: Firestore,
  balancoId: string,
  produtoId: string,
  quantidade: number,
  over: DocumentData = {},
): Promise<void> {
  await db
    .collection('balanco')
    .doc(balancoId)
    .collection('movimentos')
    .add({
      produtoOuterRef: `documents/produtos/${produtoId}`,
      produtoId,
      quantidade,
      usuarioOuterRef: USUARIO,
      removido: false,
      error: false,
      timestamp: 1_700_000_000_000,
      ...over,
    });
}

function estoqueRef(db: Firestore, produtoId: string, depositoId: string) {
  return db
    .collection('produtos')
    .doc(produtoId)
    .collection('estoques')
    .doc(makeEstoqueUid(produtoId, depositoId));
}

async function lerEstoque(db: Firestore, produtoId: string, depositoId: string) {
  const snap = await estoqueRef(db, produtoId, depositoId).get();
  return snap.exists ? (snap.data() as DocumentData) : null;
}

async function lerHistorico(
  db: Firestore,
  produtoId: string,
  depositoId: string,
): Promise<DocumentData[]> {
  const snap = await estoqueRef(db, produtoId, depositoId).collection('historicoEstoque').get();
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as DocumentData) }));
}

async function lerRelatorio(db: Firestore, balancoId: string) {
  const snap = await db.collection('balanco').doc(balancoId).collection('relatorios').get();
  const itens: Record<string, DocumentData> = {};
  for (const doc of snap.docs) {
    Object.assign(itens, (doc.data() as DocumentData).itens ?? {});
  }
  return { shards: snap.size, itens };
}

/** Take the lock the way the callable does, then run the job to completion. */
async function finalizar(
  db: Firestore,
  cenario: Cenario,
  zerarNaoContados: boolean,
  d: BalancoDeps = deps(db),
): Promise<void> {
  await tomarTravaBalanco(
    db,
    d.scheduler,
    { balancoId: cenario.balancoId, zerarNaoContados },
    USUARIO,
    1_700_000_000_000,
  );
  const resultado = await processarBalancoJob(d, { balancoId: cenario.balancoId }, 0);
  expect(resultado).toBe('finalizado');
}

describe.skipIf(!EMULATED)('aplicarBalanco (emulator)', () => {
  it('applies a count as an absolute set and records the SIGNED delta', async () => {
    const db = getDb();
    const cenario = await criarBalanco(db, 'Contagem Janeiro');
    const produtoId = await criarProduto(db);
    await semearEstoque(db, produtoId, cenario.depositoId, { quantidade: 8 });
    await lancar(db, cenario.balancoId, produtoId, 3);
    await lancar(db, cenario.balancoId, produtoId, 2);

    await finalizar(db, cenario, false);

    const estoque = await lerEstoque(db, produtoId, cenario.depositoId);
    expect(estoque?.quantidade).toBe(5);

    const historico = await lerHistorico(db, produtoId, cenario.depositoId);
    expect(historico).toHaveLength(1);
    // ADR 0014: `movimento` is the signed delta on EVERY row, a balanço
    // included. v1 stored the counted absolute here, which silently poisoned
    // the ML sweep's `atual − Σmovimento` reconstruction.
    expect(historico[0]?.movimento).toBe(-3);
    expect(historico[0]?.movimento).not.toBe(5);
    expect(historico[0]?.saldo).toBe(5);
    // The aggregate's group keys — without them the row is invisible to the
    // sweep's grouped aggregate.
    expect(historico[0]?.parentId).toBe(produtoId);
    expect(historico[0]?.depositoOuterRef).toBe(`documents/depositos/${cenario.depositoId}`);
    // Stamped from the balanço doc and the caller's auth, never from a payload.
    expect(historico[0]?.tipo).toBe('balanco');
    expect(historico[0]?.motivo).toBe('Balanço Contagem Janeiro');
    expect(historico[0]?.usuarioOuterRef).toBe(USUARIO);

    const balanco = (await db.collection('balanco').doc(cenario.balancoId).get()).data();
    expect(balanco?.estado).toBe(ESTADO_BALANCO.finalizado);
    expect(balanco?.dataFinalizado).toBeTypeOf('number');
    expect(balanco?.finalizacao?.produtosAplicados).toBe(1);
  });

  it('never writes a null movimento', async () => {
    // A null passes the sweep's `exists('movimento')` fail-open probe while
    // `sum` skips it — the window then looks unmoved and a real change is
    // silently skipped. An absent key fails open; a null fails silently.
    const db = getDb();
    const cenario = await criarBalanco(db);
    const produtoId = await criarProduto(db);
    await semearEstoque(db, produtoId, cenario.depositoId, { quantidade: 2 });
    await lancar(db, cenario.balancoId, produtoId, 9);

    await finalizar(db, cenario, false);

    const historico = await lerHistorico(db, produtoId, cenario.depositoId);
    expect(historico[0]?.movimento).toBeTypeOf('number');
    expect(Number.isFinite(historico[0]?.movimento)).toBe(true);
  });

  it('bumps ultimaModificacao so the stock sweep sees the change', async () => {
    // Legacy wrote the estoque doc raw and never bumped this, so a balanço-
    // applied change was invisible to anything keyed on it.
    const db = getDb();
    const cenario = await criarBalanco(db);
    const produtoId = await criarProduto(db);
    await semearEstoque(db, produtoId, cenario.depositoId, { quantidade: 1 });

    await lancar(db, cenario.balancoId, produtoId, 4);
    await finalizar(
      db,
      cenario,
      false,
      deps(db, () => 1_700_000_500_000),
    );

    const estoque = await lerEstoque(db, produtoId, cenario.depositoId);
    expect(estoque?.ultimaModificacao).toBe(1_700_000_500_000);
    // `minimum(now)` — the original creation time wins.
    expect(estoque?.dataCriacao).toBe(1);
  });

  it('preserves quantidadeReservada on update and defaults it to 0 on create', async () => {
    const db = getDb();
    const cenario = await criarBalanco(db);
    const comReserva = await criarProduto(db);
    const semDoc = await criarProduto(db);
    await semearEstoque(db, comReserva, cenario.depositoId, {
      quantidade: 10,
      quantidadeReservada: 3,
    });
    await lancar(db, cenario.balancoId, comReserva, 7);
    await lancar(db, cenario.balancoId, semDoc, 4);

    await finalizar(db, cenario, false);

    const atualizado = await lerEstoque(db, comReserva, cenario.depositoId);
    expect(atualizado).toMatchObject({ quantidade: 7, quantidadeReservada: 3 });
    const criado = await lerEstoque(db, semDoc, cenario.depositoId);
    expect(criado).toMatchObject({ quantidade: 4, quantidadeReservada: 0 });
  });

  it('ignores error and removed movimentos in the total', async () => {
    const db = getDb();
    const cenario = await criarBalanco(db);
    const produtoId = await criarProduto(db);
    await semearEstoque(db, produtoId, cenario.depositoId, { quantidade: 0 });
    await lancar(db, cenario.balancoId, produtoId, 5);
    await lancar(db, cenario.balancoId, produtoId, 5, { removido: true });
    await lancar(db, cenario.balancoId, produtoId, 5, { error: true });

    await finalizar(db, cenario, false);

    expect((await lerEstoque(db, produtoId, cenario.depositoId))?.quantidade).toBe(5);
  });

  it('writes nothing at all when the count confirms the stored quantity', async () => {
    const db = getDb();
    const cenario = await criarBalanco(db);
    const produtoId = await criarProduto(db);
    await semearEstoque(db, produtoId, cenario.depositoId, { quantidade: 6 });
    await lancar(db, cenario.balancoId, produtoId, 6);

    await finalizar(db, cenario, false);

    const estoque = await lerEstoque(db, produtoId, cenario.depositoId);
    // Untouched: no ledger row, and no ultimaModificacao bump that would make
    // it an ML sweep candidate for the next 24h for no information.
    expect(estoque?.ultimaModificacao).toBe(1);
    expect(await lerHistorico(db, produtoId, cenario.depositoId)).toHaveLength(0);
    // The report still explains it — that is where "counted and matched" lives.
    const { itens } = await lerRelatorio(db, cenario.balancoId);
    expect(itens[produtoId]).toMatchObject({ estoque: 6, contado: 6 });
  });

  it('zerar=false leaves uncounted produtos alone', async () => {
    const db = getDb();
    const cenario = await criarBalanco(db);
    const contado = await criarProduto(db);
    const naoContado = await criarProduto(db);
    await semearEstoque(db, contado, cenario.depositoId, { quantidade: 8 });
    await semearEstoque(db, naoContado, cenario.depositoId, { quantidade: 9 });
    await lancar(db, cenario.balancoId, contado, 2);

    await finalizar(db, cenario, false);

    expect((await lerEstoque(db, contado, cenario.depositoId))?.quantidade).toBe(2);
    expect((await lerEstoque(db, naoContado, cenario.depositoId))?.quantidade).toBe(9);
    expect(await lerHistorico(db, naoContado, cenario.depositoId)).toHaveLength(0);
  });

  it('zerar=true zeroes stocked produtos that were never counted, but never a kit', async () => {
    const db = getDb();
    const cenario = await criarBalanco(db);
    const contado = await criarProduto(db);
    const naoContado = await criarProduto(db);
    const kit = await criarProduto(db, { ehKit: true });
    await semearEstoque(db, contado, cenario.depositoId, { quantidade: 8 });
    await semearEstoque(db, naoContado, cenario.depositoId, { quantidade: 9 });
    await semearEstoque(db, kit, cenario.depositoId, { quantidade: 4 });
    await lancar(db, cenario.balancoId, contado, 2);

    await finalizar(db, cenario, true);

    expect((await lerEstoque(db, contado, cenario.depositoId))?.quantidade).toBe(2);
    expect((await lerEstoque(db, naoContado, cenario.depositoId))?.quantidade).toBe(0);
    // A kit holds no stock of its own (ADR 0014) and its quantity ADDS to the
    // component-derived availability — zeroing it would change what the app
    // believes is sellable.
    expect((await lerEstoque(db, kit, cenario.depositoId))?.quantidade).toBe(4);

    const { itens } = await lerRelatorio(db, cenario.balancoId);
    // Never counted stays distinguishable from counted-and-empty.
    expect(itens[naoContado]).toMatchObject({ contado: null, estoque: 9 });
    expect(itens[kit]).toBeUndefined();
  });

  it('consolidates duplicate estoque docs without deleting them, and reports them', async () => {
    const db = getDb();
    const cenario = await criarBalanco(db);
    const produtoId = await criarProduto(db);
    await semearEstoque(db, produtoId, cenario.depositoId, { quantidade: 8 });
    await semearEstoque(db, produtoId, cenario.depositoId, { quantidade: 3 }, 'legado-aleatorio');
    await lancar(db, cenario.balancoId, produtoId, 5);

    await finalizar(db, cenario, true);

    // The count lands on the canonical doc...
    expect((await lerEstoque(db, produtoId, cenario.depositoId))?.quantidade).toBe(5);
    // ...and the anomaly survives. Legacy DELETED it, losing its reservation,
    // its localização and its history with no record that it existed.
    const extra = await db
      .collection('produtos')
      .doc(produtoId)
      .collection('estoques')
      .doc('legado-aleatorio')
      .get();
    expect(extra.exists).toBe(true);
    const { itens } = await lerRelatorio(db, cenario.balancoId);
    expect(itens[produtoId]?.estoquesExtras).toBe(1);
  });

  it('refuses a second finalize instead of silently doing nothing', async () => {
    const db = getDb();
    const cenario = await criarBalanco(db);
    const produtoId = await criarProduto(db);
    await semearEstoque(db, produtoId, cenario.depositoId, { quantidade: 8 });
    await lancar(db, cenario.balancoId, produtoId, 5);

    await finalizar(db, cenario, false);

    // Legacy aborted silently here; the operator could not tell a no-op from a
    // successful run.
    await expect(
      tomarTravaBalanco(
        db,
        recorder(),
        { balancoId: cenario.balancoId, zerarNaoContados: false },
        USUARIO,
        1_700_000_000_000,
      ),
    ).rejects.toThrow(BalancoNaoFinalizavelError);
    expect((await lerEstoque(db, produtoId, cenario.depositoId))?.quantidade).toBe(5);
    expect(await lerHistorico(db, produtoId, cenario.depositoId)).toHaveLength(1);
  });

  it('resumes a crashed run without applying anything twice', async () => {
    const db = getDb();
    const cenario = await criarBalanco(db);
    const produtoId = await criarProduto(db);
    await semearEstoque(db, produtoId, cenario.depositoId, { quantidade: 8 });
    await lancar(db, cenario.balancoId, produtoId, 5);

    await finalizar(db, cenario, false);

    // Simulate the crash window: the writes landed but the cursor advance and
    // the finalizado flip did not.
    await db.collection('balanco').doc(cenario.balancoId).update({
      estado: ESTADO_BALANCO.finalizando,
      dataFinalizado: null,
      'finalizacao.shardCursor': 0,
      'finalizacao.produtosAplicados': 0,
    });
    // Something else moved the stock in between — the resume must not treat
    // that as the new "before" and mint a second delta against it.
    await estoqueRef(db, produtoId, cenario.depositoId).update({ quantidade: 2 });

    expect(await processarBalancoJob(deps(db), { balancoId: cenario.balancoId }, 0)).toBe(
      'finalizado',
    );

    // ⚠️ The QUANTITY is the assertion that bites, not the row count. Because
    // the history id is deterministic, a re-apply overwrites its own row rather
    // than appending — so the count stays 1 either way, while the ledger
    // silently gains a delta computed against a value this job already moved.
    // (Verified by negative control: dropping the marker check leaves the row
    // count at 1 and the quantity at 5.)
    expect((await lerEstoque(db, produtoId, cenario.depositoId))?.quantidade).toBe(2);
    expect(await lerHistorico(db, produtoId, cenario.depositoId)).toHaveLength(1);
    expect((await lerHistorico(db, produtoId, cenario.depositoId))[0]?.movimento).toBe(-3);
    const balanco = (await db.collection('balanco').doc(cenario.balancoId).get()).data();
    expect(balanco?.finalizacao?.produtosAplicados).toBe(0);
  });

  it('parks the balanço in erro on the last attempt instead of leaving it stuck', async () => {
    // Legacy's dead end: a crash after the state flip left `gerandoFinalizacao`
    // forever, unfinalizable and uncountable, with no way out in the UI.
    const db = getDb();
    const cenario = await criarBalanco(db);
    const produtoId = await criarProduto(db);
    await lancar(db, cenario.balancoId, produtoId, 5);

    const quebrado: BalancoDeps = {
      ...deps(db),
      agregar: async () => {
        throw new Error('falha simulada no agregado');
      },
    };
    await tomarTravaBalanco(
      db,
      quebrado.scheduler,
      { balancoId: cenario.balancoId, zerarNaoContados: false },
      USUARIO,
      1_700_000_000_000,
    );

    // Not the last attempt → rethrow so Cloud Tasks retries.
    await expect(
      processarBalancoJob(quebrado, { balancoId: cenario.balancoId }, 0),
    ).rejects.toThrow(/falha simulada/);
    // Last attempt → park.
    expect(await processarBalancoJob(quebrado, { balancoId: cenario.balancoId }, 4)).toBe('parado');

    const balanco = (await db.collection('balanco').doc(cenario.balancoId).get()).data();
    expect(balanco?.estado).toBe(ESTADO_BALANCO.erro);
    expect(balanco?.finalizacao?.erro).toMatch(/falha simulada/);

    // ...and a parked balanço can be retried, which legacy could not.
    await expect(
      tomarTravaBalanco(
        db,
        recorder(),
        { balancoId: cenario.balancoId, zerarNaoContados: false },
        USUARIO,
        1_700_000_100_000,
      ),
    ).resolves.toMatchObject({ retomado: true });
  });

  it('ignores a redelivered task once the balanço is no longer finalizando', async () => {
    const db = getDb();
    const cenario = await criarBalanco(db);
    const produtoId = await criarProduto(db);
    await semearEstoque(db, produtoId, cenario.depositoId, { quantidade: 8 });
    await lancar(db, cenario.balancoId, produtoId, 5);
    await finalizar(db, cenario, false);

    expect(await processarBalancoJob(deps(db), { balancoId: cenario.balancoId }, 0)).toBe(
      'ignorado',
    );
    expect(await lerHistorico(db, produtoId, cenario.depositoId)).toHaveLength(1);
  });
});
