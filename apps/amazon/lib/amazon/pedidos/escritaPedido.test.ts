/**
 * The import batch against the fake db, which models the batch's all-or-nothing
 * commit and per-write preconditions (and nothing shaped like a transaction).
 * The REAL batch semantics run in `importarPedido.firestore.test.ts`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { pagamentoCollection } from '@delfrance/data/admin/collections';
import { ESTADO_PEDIDO, STATUS_PAGAMENTO } from '@delfrance/schemas';

import { FakeDb, asDb } from '../testing/fakeDb';
import {
  depois,
  linhaAmazon,
  pedidoAmazon,
  type OpcoesPedidoTeste,
} from '../testing/pedidoWireAmazon';
import { AmazonPedidoEmConflitoError } from './erros';
import {
  MAX_TENTATIVAS_ESCRITA_PEDIDO_AMAZON,
  decidirPagamentosAmazon,
  gravarPedidoAmazon,
  lerPedidoEPagamentoAmazon,
  type DecidirPagamentosAmazon,
} from './escritaPedido';
import { makePedidoIdAmazon } from './orderIds';
import { mapearPedidoAmazon, type EntradasPedidoAmazon } from './pedidoMapeamento';

const CONTA = 'conta-1';
const ORDER = '171-9876543-2109876';
const PEDIDO = makePedidoIdAmazon(CONTA, ORDER);
const CAMINHO = `pedidos/${PEDIDO}`;
const NOW_US = 1_900_000_000_000_000;

const ENTRADAS: EntradasPedidoAmazon = {
  integracaoPedidoOuterRef: `documents/integracao/${CONTA}`,
  operacaoPedidoOuterRef: null,
  clientePedidoOuterRef: null,
  enderecoFreteOuterReference: null,
  integracaoFreteOuterRef: null,
  modalidadeFreteImportacao: null,
  vinculos: new Map(),
};

let db: FakeDb;

beforeEach(() => {
  db = new FakeDb();
});

/** One write of `opcoes`' order, through the real reader (step 1 of an attempt). */
async function gravar(
  opcoes: OpcoesPedidoTeste = {},
  extra: { decidirPagamentos?: DecidirPagamentosAmazon; mapeamentos?: { n: number } } = {},
) {
  const order = pedidoAmazon(opcoes);
  const primeiraLeitura = await lerPedidoEPagamentoAmazon(asDb(db), PEDIDO);
  return gravarPedidoAmazon(asDb(db), {
    contaId: CONTA,
    orderId: ORDER,
    pedidoId: PEDIDO,
    primeiraLeitura,
    nowUs: NOW_US,
    mapear: () => {
      if (extra.mapeamentos !== undefined) extra.mapeamentos.n += 1;
      return mapearPedidoAmazon(order, ENTRADAS);
    },
    ...(extra.decidirPagamentos === undefined
      ? {}
      : { decidirPagamentos: extra.decidirPagamentos }),
  });
}

describe('one attempt', () => {
  it('★ a first import CREATES the pedido (never `set`) in ONE batch, parsed through the handle', async () => {
    const r = await gravar({ status: 'UNSHIPPED' });
    expect(r.tipo).toBe('gravado');
    expect(db.escritas.map((e) => [e.verbo, e.caminho, e.lote])).toEqual([['create', CAMINHO, 1]]);
    const doc = db.ler(CAMINHO);
    expect(doc?.estado).toBe('pago');
    expect(doc?.numero).toBe(ORDER);
    // The handle's parse filled the schema defaults the mapper leaves out.
    expect(Object.hasOwn(doc ?? {}, 'hasUserInteraction')).toBe(true);
    if (r.tipo !== 'gravado') throw new Error('esperava gravado');
    expect(r.writeTime?.isEqual(db.carimboDe(CAMINHO) as never)).toBe(true);
    expect(r.armazenado).toBeNull();
  });

  it('★ an update carries `lastUpdateTime` = the snapshot’s updateTime (tier 2)', async () => {
    await gravar({ status: 'PENDING' });
    const antes = db.carimboDe(CAMINHO);
    const r = await gravar({ status: 'UNSHIPPED', atualizadoEm: depois(60) });
    expect(r.tipo).toBe('gravado');
    const ultima = db.escritas.at(-1);
    expect(ultima?.verbo).toBe('update');
    expect(ultima?.comPrecondicao).toBe(true);
    expect(ultima?.dados?.estado).toBe('pago');
    expect(antes).not.toBeUndefined();
  });

  it('★ an equal redelivery ⇒ sem-mudanca and NO batch is committed (an empty batch never is)', async () => {
    await gravar({ status: 'UNSHIPPED' });
    const r = await gravar({ status: 'UNSHIPPED' });
    expect(r.tipo).toBe('sem-mudanca');
    if (r.tipo !== 'sem-mudanca') throw new Error('esperava sem-mudanca');
    expect(r.writeTime).toBeNull();
    expect(db.commitsDeLote).toHaveLength(1);
    expect(db.escritas).toHaveLength(1);
  });

  it('obsoleto (a newer write landed) ⇒ NOTHING written', async () => {
    await gravar({ status: 'UNSHIPPED', atualizadoEm: depois(60) });
    const r = await gravar({ status: 'PENDING' });
    expect(r).toMatchObject({ tipo: 'obsoleto', tentativas: 1 });
    expect(db.commitsDeLote).toHaveLength(1);
  });

  it('a first-seen order that is not imported ⇒ NOTHING written, and its motivo', async () => {
    expect(await gravar({ status: 'CANCELLED' })).toMatchObject({
      tipo: 'nao-importado',
      motivo: 'cancelado-nao-importado',
    });
    expect(await gravar({ status: 'SHIPPED', pacotes: ['RETURNED_TO_SELLER'] })).toMatchObject({
      tipo: 'nao-importado',
      motivo: 'reversao-nao-importada',
    });
    expect(db.commitsDeLote).toEqual([]);
    expect(db.ler(CAMINHO)).toBeUndefined();
  });

  it('reads the pedido AND its pagamento in one getAll (the CANCELLED predicate needs its status)', async () => {
    await lerPedidoEPagamentoAmazon(asDb(db), PEDIDO);
    expect(db.leituras).toEqual([CAMINHO, `${CAMINHO}/pagamentos/${PEDIDO}`]);
  });

  it('the PR-6 hook decides nothing yet', () => {
    expect(decidirPagamentosAmazon({} as never, {} as never)).toEqual([]);
  });
});

describe('★ a lost precondition aborts everything; the retry re-reads and RE-DERIVES', () => {
  it('a concurrent operator edit between the read and the commit ⇒ attempt 2 decides from the NEW snapshot', async () => {
    await gravar({ status: 'PENDING' });
    db.antesDaProximaEscrita(CAMINHO, () => {
      const atual = db.ler(CAMINHO) ?? {};
      db.seed(CAMINHO, { ...atual, hasUserInteraction: true });
    });
    const mapeamentos = { n: 0 };
    const r = await gravar(
      {
        status: 'UNSHIPPED',
        atualizadoEm: depois(60),
        linhas: [linhaAmazon('L1', { qtd: 3, preco: '10.00' })],
      },
      { mapeamentos },
    );
    expect(r.tipo).toBe('gravado');
    if (r.tipo !== 'gravado') throw new Error('esperava gravado');
    expect(r.tentativas).toBe(2);
    expect(mapeamentos.n).toBe(2);
    // Re-derived from the operator's snapshot: the lines are now the operator's.
    expect(r.escrita.decisao.itens).toBe('congeladas');
    expect(db.ler(CAMINHO)?.hasUserInteraction).toBe(true);
    expect(db.commitsDeLote).toHaveLength(3);
  });

  it('a create racing another importer’s create ⇒ 6, then the update path over the winner', async () => {
    db.antesDaProximaEscrita(CAMINHO, async () => {
      const outro = await gravarPedidoAmazon(asDb(db), {
        contaId: CONTA,
        orderId: ORDER,
        pedidoId: PEDIDO,
        primeiraLeitura: await lerPedidoEPagamentoAmazon(asDb(db), PEDIDO),
        nowUs: NOW_US,
        mapear: () => mapearPedidoAmazon(pedidoAmazon({ status: 'PENDING' }), ENTRADAS),
      });
      expect(outro.tipo).toBe('gravado');
    });
    const r = await gravar({ status: 'UNSHIPPED', atualizadoEm: depois(60) });
    expect(r).toMatchObject({ tipo: 'gravado', tentativas: 2 });
    expect(db.ler(CAMINHO)?.estado).toBe('pago');
  });

  it(`three losses in a row ⇒ AmazonPedidoEmConflitoError after EXACTLY ${String(MAX_TENTATIVAS_ESCRITA_PEDIDO_AMAZON)} commits, NOTHING written`, async () => {
    await gravar({ status: 'PENDING' });
    const antes = db.ler(CAMINHO);
    const escritasAntes = db.escritas.length;
    for (let i = 0; i < MAX_TENTATIVAS_ESCRITA_PEDIDO_AMAZON + 1; i += 1) {
      db.antesDaProximaEscrita(CAMINHO, () => {
        db.seed(CAMINHO, { ...(db.ler(CAMINHO) ?? {}) });
      });
    }
    // The bound is a literal: a test relative to the constant would pass any value.
    expect(MAX_TENTATIVAS_ESCRITA_PEDIDO_AMAZON).toBe(3);
    await expect(gravar({ status: 'UNSHIPPED', atualizadoEm: depois(60) })).rejects.toSatisfy(
      (e: unknown) => e instanceof AmazonPedidoEmConflitoError && e.tentativas === 3,
    );
    // The first import's commit + exactly three refused attempts.
    expect(db.commitsDeLote).toHaveLength(1 + 3);
    expect(db.escritas).toHaveLength(escritasAntes);
    expect(db.ler(CAMINHO)).toEqual(antes);
  });

  it('★ the retry re-reads the PAGAMENTO too: one approved between the read and the commit (beside a pedido change) ⇒ attempt 2 decides estornadoIntegralmente, and the hook sees the re-read snapshot', async () => {
    await gravar({ status: 'UNSHIPPED' });
    expect(db.ler(`${CAMINHO}/pagamentos/${PEDIDO}`)).toBeUndefined();
    db.antesDaProximaEscrita(CAMINHO, () => {
      db.seed(CAMINHO, { ...(db.ler(CAMINHO) ?? {}) });
      db.seed(`${CAMINHO}/pagamentos/${PEDIDO}`, { status: STATUS_PAGAMENTO.aprovado });
    });
    const pagamentosVistos: boolean[] = [];
    const r = await gravar(
      { status: 'CANCELLED', atualizadoEm: depois(60) },
      {
        decidirPagamentos: (snap) => {
          pagamentosVistos.push(snap.exists);
          return [];
        },
      },
    );
    expect(r).toMatchObject({ tipo: 'gravado', tentativas: 2 });
    // NEAR-MISS: from the first read's ABSENT pagamento the predicate answers `cancelado`.
    expect(db.ler(CAMINHO)?.estado).toBe(ESTADO_PEDIDO.estornadoIntegralmente);
    expect(pagamentosVistos).toEqual([false, true]);
  });

  it('RESIDUE until PR 6 (module header): a change to the PAGAMENTO alone between the read and the commit is not seen — no 5-d write carries its precondition', async () => {
    await gravar({ status: 'UNSHIPPED' });
    db.seed(`${CAMINHO}/pagamentos/${PEDIDO}`, { status: STATUS_PAGAMENTO.aprovado });
    db.antesDaProximaEscrita(CAMINHO, () => {
      db.seed(`${CAMINHO}/pagamentos/${PEDIDO}`, { status: STATUS_PAGAMENTO.em_disputa });
    });
    const r = await gravar({ status: 'CANCELLED', atualizadoEm: depois(60) });
    expect(r).toMatchObject({ tipo: 'gravado', tentativas: 1 });
    // Decided from the read's `aprovado`. The committed `em_disputa` would decide
    // `cancelado` + `pagamento-divergente`; PR 6's pagamento carrier flips this test.
    expect(db.ler(CAMINHO)?.estado).toBe(ESTADO_PEDIDO.estornadoIntegralmente);
  });

  it('a non-precondition failure is rethrown at once — never retried', async () => {
    const falha = Object.assign(new Error('UNAVAILABLE'), { code: 14 });
    db.falharEscrita(CAMINHO, falha);
    await expect(gravar({ status: 'UNSHIPPED' })).rejects.toBe(falha);
    expect(db.commitsDeLote).toHaveLength(1);
  });
});

describe('the pagamento slot (PR 6 fills the hook)', () => {
  const pagamentoRef = () => pagamentoCollection.docRef(asDb(db), { pedidoId: PEDIDO }, PEDIDO);

  it('★ an EMPTY pedido patch beside a pagamento write ⇒ the precondition CARRIER (the raw stamp, under the pedido’s precondition)', async () => {
    await gravar({ status: 'UNSHIPPED' });
    const bruto = db.ler(CAMINHO)?.lastMarketplaceUpdate;
    const r = await gravar(
      { status: 'UNSHIPPED' },
      { decidirPagamentos: () => [{ tipo: 'criar', ref: pagamentoRef(), dados: { status: 4 } }] },
    );
    expect(r).toMatchObject({ tipo: 'gravado', portador: true });
    const lote = db.escritas.filter((e) => e.lote === 2);
    expect(lote.map((e) => [e.verbo, e.caminho, e.comPrecondicao])).toEqual([
      ['update', CAMINHO, true],
      ['create', `${CAMINHO}/pagamentos/${PEDIDO}`, false],
    ]);
    expect(lote[0]?.dados).toEqual({ lastMarketplaceUpdate: bruto });
  });

  it('★ the carrier’s precondition lost ⇒ the pagamento is NOT written either', async () => {
    await gravar({ status: 'UNSHIPPED' });
    for (let i = 0; i < MAX_TENTATIVAS_ESCRITA_PEDIDO_AMAZON; i += 1) {
      db.antesDaProximaEscrita(CAMINHO, () => {
        db.seed(CAMINHO, { ...(db.ler(CAMINHO) ?? {}) });
      });
    }
    await expect(
      gravar(
        { status: 'UNSHIPPED' },
        { decidirPagamentos: () => [{ tipo: 'criar', ref: pagamentoRef(), dados: { status: 4 } }] },
      ),
    ).rejects.toBeInstanceOf(AmazonPedidoEmConflitoError);
    expect(db.ler(`${CAMINHO}/pagamentos/${PEDIDO}`)).toBeUndefined();
  });

  it('a pagamento update rides its OWN snapshot’s precondition, beside the pedido’s', async () => {
    await gravar({ status: 'PENDING' });
    const carimboPagamento = db.seed(`${CAMINHO}/pagamentos/${PEDIDO}`, { status: 4 });
    const r = await gravar(
      { status: 'UNSHIPPED', atualizadoEm: depois(60) },
      {
        decidirPagamentos: (snap) => {
          expect(snap.updateTime?.isEqual(carimboPagamento as never)).toBe(true);
          return [
            {
              tipo: 'atualizar',
              ref: pagamentoRef(),
              dados: { status: 8 },
              lastUpdateTime: snap.updateTime as never,
            },
          ];
        },
      },
    );
    expect(r).toMatchObject({ tipo: 'gravado', portador: false });
    expect(db.escritas.filter((e) => e.lote === 2).map((e) => e.comPrecondicao)).toEqual([
      true,
      true,
    ]);
  });
});
