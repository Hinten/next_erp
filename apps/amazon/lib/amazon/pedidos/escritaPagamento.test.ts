/**
 * PR 6's hook: the pure pagamento decision → batch writes against THAT
 * attempt's pagamento snapshot, and the pagamento's precondition CARRIER.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { FORMA_PAGAMENTO, STATUS_PAGAMENTO } from '@delfrance/schemas';

import { FakeDb, asDb } from '../testing/fakeDb';
import {
  CAMPOS_PORTADOR_PAGAMENTO_AMAZON,
  decidirPagamentosAmazon,
  portadorDoPagamentoAmazon,
} from './escritaPagamento';
import { lerPedidoEPagamentoAmazon, type EscritaPedidoDecididaAmazon } from './escritaPedido';
import type { EscritaPagamentoPuraAmazon } from './pagamentoAmazon';

const PEDIDO = 'p1';
const PAGAMENTO = `pedidos/${PEDIDO}/pagamentos/${PEDIDO}`;

let db: FakeDb;

beforeEach(() => {
  db = new FakeDb();
});

/** A pedido decision of `tipo` carrying `pagamento` (the rest is not read by the hook). */
function escrita(
  tipo: EscritaPedidoDecididaAmazon['tipo'],
  pagamento: EscritaPagamentoPuraAmazon,
): EscritaPedidoDecididaAmazon {
  return { tipo, pagamento, decisao: {}, corpo: {}, patch: {}, grupos: [] } as never;
}

async function snapshot() {
  return (await lerPedidoEPagamentoAmazon(asDb(db), PEDIDO)).pagamento;
}

const CORPO = {
  id: 'o-1',
  forma_de_pagamento: FORMA_PAGAMENTO.pix,
  status_pagamento: STATUS_PAGAMENTO.aprovado,
  cartao: null,
  valor: 20,
};

describe('decidirPagamentosAmazon', () => {
  it('a decided create ⇒ a create on the snapshot’s ref, parsed through the handle (defaults filled)', async () => {
    const [w] = decidirPagamentosAmazon(
      await snapshot(),
      escrita('criar', { tipo: 'criar', corpo: CORPO }),
    );
    expect(w?.tipo).toBe('criar');
    expect(w?.ref.path).toBe(PAGAMENTO);
    expect(w?.dados).toMatchObject({ ...CORPO, marketplace: null, liquidacao: null, parcelas: 1 });
    expect(Object.hasOwn(w?.dados ?? {}, 'linkPagamentoId')).toBe(false);
  });

  it('a create that does not parse refuses before any write (ZodError)', async () => {
    await expect(async () =>
      decidirPagamentosAmazon(
        await snapshot(),
        escrita('criar', { tipo: 'criar', corpo: { ...CORPO, valor: -1 } }),
      ),
    ).rejects.toThrow();
  });

  it('a decided update ⇒ `parseMerge`d, under the snapshot’s OWN updateTime', async () => {
    const carimbo = db.seed(PAGAMENTO, { status_pagamento: 4 });
    const [w] = decidirPagamentosAmazon(
      await snapshot(),
      escrita('atualizar', {
        tipo: 'atualizar',
        patch: { status_pagamento: STATUS_PAGAMENTO.estornado },
        campos: ['status_pagamento'],
      }),
    );
    expect(w).toMatchObject({
      tipo: 'atualizar',
      dados: { status_pagamento: STATUS_PAGAMENTO.estornado },
      portador: false,
    });
    expect(w?.tipo === 'atualizar' && w.lastUpdateTime.isEqual(carimbo as never)).toBe(true);
  });

  it('★ nothing decided, the PEDIDO writes, the pagamento exists ⇒ the CARRIER: its status re-written as read, under its own updateTime', async () => {
    const carimbo = db.seed(PAGAMENTO, { status_pagamento: STATUS_PAGAMENTO.em_disputa, valor: 3 });
    for (const tipo of ['criar', 'atualizar'] as const) {
      const [w] = decidirPagamentosAmazon(await snapshot(), escrita(tipo, { tipo: 'nada' }));
      expect(w).toMatchObject({
        tipo: 'atualizar',
        dados: { status_pagamento: STATUS_PAGAMENTO.em_disputa },
        portador: true,
      });
      expect(w?.tipo === 'atualizar' && w.lastUpdateTime.isEqual(carimbo as never)).toBe(true);
    }
  });

  it('★ no carrier when the pedido writes nothing (no batch), or when no pagamento exists (the documented residue)', async () => {
    expect(
      decidirPagamentosAmazon(await snapshot(), escrita('atualizar', { tipo: 'nada' })),
    ).toEqual([]);
    db.seed(PAGAMENTO, { status_pagamento: 4 });
    expect(
      decidirPagamentosAmazon(await snapshot(), escrita('sem-mudanca', { tipo: 'nada' })),
    ).toEqual([]);
  });
});

describe('the carrier’s field', () => {
  it('★ the first stored field of the preference list, raw — status_pagamento first', () => {
    expect(CAMPOS_PORTADOR_PAGAMENTO_AMAZON[0]).toBe('status_pagamento');
    expect(portadorDoPagamentoAmazon({ valor: 1, status_pagamento: 4, id: 'x' })).toEqual({
      status_pagamento: 4,
    });
    // A legacy document without a status: the next field it does hold, as read (a null too).
    expect(portadorDoPagamentoAmazon({ valor: 20.5, id: 'o-1' })).toEqual({ id: 'o-1' });
    expect(portadorDoPagamentoAmazon({ status_pagamento: null })).toEqual({
      status_pagamento: null,
    });
    expect(portadorDoPagamentoAmazon({ ultimaModificacao: { x: 1 } })).toEqual({
      ultimaModificacao: { x: 1 },
    });
    // None of them (no such document is known): no carrier.
    expect(portadorDoPagamentoAmazon({ 'a.b': 1, outro: 2 })).toBeNull();
  });
});
