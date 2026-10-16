/**
 * `incidentesPedidoLi.ts`: tier-0 incidentes at deterministic ids, created
 * once, never blocking, and never raised for a line already bound.
 */
import { describe, expect, it } from 'vitest';
import {
  ORIGEM_INCIDENTE,
  TIPO_INCIDENTE,
  classificarIncidenteBloqueante,
  incidenteSchema,
  itemDoPedidoSchema,
  type ItemDoPedido,
} from '@delfrance/schemas';

import { FakeDb, asDb, grpc } from '../testing/fakeDb';
import {
  ID_INCIDENTE_LI,
  SUBTIPO_INCIDENTE_LI,
  idIncidenteLinhaLi,
  registrarIncidentesDoPedidoLi,
  type IncidentesDoPedidoLi,
} from './incidentesPedidoLi';

const PEDIDO = 'pedido-inc';
/** A realistic µs instant: the schemas read a small number as another unit. */
const AGORA_US = 1_800_000_000_000_000;

function item(id: string, produtoUid: string | null = null, nome = 'Produto X'): ItemDoPedido {
  return itemDoPedidoSchema.parse({
    produtoUid,
    ordem: 1,
    ensureUniqueId: id,
    mktplaceId: '7001',
    sku: '12345678901234',
    gtin: null,
    nomeDeVenda: nome,
    precoDeVenda: 10,
    descontoUnitario: 0,
    quantidade: 1,
    custo: null,
    timestamp: 1,
  });
}

function entrada(over: Partial<IncidentesDoPedidoLi> = {}): IncidentesDoPedidoLi {
  return {
    pedidoId: PEDIDO,
    numero: '9001',
    linhasSemProduto: [{ item: item('501'), via: 'unresolved' }],
    jaVinculadas: new Set(),
    multiEnvio: false,
    clienteSemIdentidade: false,
    totaisDivergentes: false,
    nowUs: AGORA_US,
    ...over,
  };
}

const caminho = (id: string) => `pedidos/${PEDIDO}/incidentes/${id}`;

describe('the incidentes of one import', () => {
  it('one row per unbound line and per order-wide problem, at deterministic ids', async () => {
    const db = new FakeDb();
    const criados = await registrarIncidentesDoPedidoLi(
      asDb(db),
      entrada({ multiEnvio: true, clienteSemIdentidade: true, totaisDivergentes: true }),
    );
    expect(criados.sort()).toEqual(
      [
        idIncidenteLinhaLi('501'),
        ID_INCIDENTE_LI.multiEnvio,
        ID_INCIDENTE_LI.clienteSemIdentidade,
        ID_INCIDENTE_LI.totaisDivergentes,
      ].sort(),
    );
    expect(db.ler(caminho(idIncidenteLinhaLi('501')))).toMatchObject({
      subtipo: SUBTIPO_INCIDENTE_LI.produtoNaoVinculado,
      externalId: '7001',
      timestamp: AGORA_US,
      resolucao: null,
    });
    expect(db.ler(caminho(ID_INCIDENTE_LI.multiEnvio))?.subtipo).toBe('li-multi-envio');
  });

  it('never blocks: tipo and origem are both outros, which both gates refuse', async () => {
    const db = new FakeDb();
    await registrarIncidentesDoPedidoLi(asDb(db), entrada({ totaisDivergentes: true }));
    for (const id of db.idsEm(`pedidos/${PEDIDO}/incidentes`)) {
      const row = db.ler(caminho(id))!;
      expect(row.tipo).toBe(TIPO_INCIDENTE.outros);
      expect(row.origem).toBe(ORIGEM_INCIDENTE.outros);
      expect(classificarIncidenteBloqueante(incidenteSchema.parse(row))).toBeNull();
    }
  });

  it('a redelivery creates nothing and keeps the first timestamp; only ALREADY_EXISTS is swallowed', async () => {
    const db = new FakeDb();
    await registrarIncidentesDoPedidoLi(asDb(db), entrada());
    expect(await registrarIncidentesDoPedidoLi(asDb(db), entrada({ nowUs: AGORA_US + 5 }))).toEqual(
      [],
    );
    expect(db.ler(caminho(idIncidenteLinhaLi('501')))?.timestamp).toBe(AGORA_US);

    const falha = new FakeDb();
    falha.falharEscrita(caminho(idIncidenteLinhaLi('501')), grpc(14, 'UNAVAILABLE'));
    await expect(registrarIncidentesDoPedidoLi(asDb(falha), entrada())).rejects.toMatchObject({
      code: 14,
    });
  });

  it('a line already stored with a produto raises nothing; a bound incoming line raises nothing', async () => {
    const db = new FakeDb();
    const criados = await registrarIncidentesDoPedidoLi(
      asDb(db),
      entrada({
        linhasSemProduto: [
          { item: item('501'), via: 'unresolved' },
          { item: item('502', 'p-1'), via: 'unresolved' },
        ],
        jaVinculadas: new Set(['501']),
      }),
    );
    expect(criados).toEqual([]);
  });

  it('the message names the ambiguity, and a long name is cut so the row always parses', async () => {
    const db = new FakeDb();
    await registrarIncidentesDoPedidoLi(
      asDb(db),
      entrada({
        linhasSemProduto: [{ item: item('501', null, 'N'.repeat(1_990)), via: 'vinculo-ambiguo' }],
      }),
    );
    const motivo = db.ler(caminho(idIncidenteLinhaLi('501')))?.motivoDoIncidente as string;
    expect(motivo).toContain('mais de um');
    expect(motivo.length).toBeLessThan(2_000);
  });
});
