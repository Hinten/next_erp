import { beforeEach, describe, expect, it } from 'vitest';
import { ORIGEM_INCIDENTE, TIPO_INCIDENTE } from '@delfrance/schemas';

import { FakeDb, asDb } from '../testing/fakeDb';
import { INCIDENTE_PEDIDO_AMAZON } from './codigosPedidoAmazon';
import {
  ID_INCIDENTE_CLIENTE_SEM_IDENTIDADE_AMAZON,
  idIncidenteDoCodigoAmazon,
  idIncidenteLinhaAmazon,
  registrarIncidentesDoPedidoAmazon,
} from './incidentesPedidoAmazon';

const PEDIDO = 'p'.repeat(64);
const ORDER = '171-9876543-2109876';
const NOW_US = 1_900_000_000_000_000;

let db: FakeDb;

beforeEach(() => {
  db = new FakeDb();
});

const caminho = (id: string) => `pedidos/${PEDIDO}/incidentes/${id}`;

function registrar(over: Partial<Parameters<typeof registrarIncidentesDoPedidoAmazon>[1]> = {}) {
  return registrarIncidentesDoPedidoAmazon(asDb(db), {
    pedidoId: PEDIDO,
    orderId: ORDER,
    linhasSemProduto: [],
    clienteSemIdentidade: false,
    codigos: [],
    nowUs: NOW_US,
    ...over,
  });
}

describe('registrarIncidentesDoPedidoAmazon — tier 0, never blocking', () => {
  it('one per unbound line, the cliente without identity, and each informational code', async () => {
    const criados = await registrar({
      linhasSemProduto: [
        { orderItemId: 'L1', via: 'unresolved' },
        { orderItemId: 'L2', via: 'amazon-vinculo-ambiguo' },
      ],
      clienteSemIdentidade: true,
      codigos: [INCIDENTE_PEDIDO_AMAZON.logisticaAmazon, INCIDENTE_PEDIDO_AMAZON.valorZerado],
    });
    expect(criados).toEqual([
      'amz-prod-L1',
      'amz-prod-L2',
      'amz-cliente-sem-identidade',
      'amz-logistica-amazon',
      'amz-valor-zerado',
    ]);
    expect(idIncidenteLinhaAmazon('L1')).toBe('amz-prod-L1');
    expect(idIncidenteDoCodigoAmazon(INCIDENTE_PEDIDO_AMAZON.possivelReembolso)).toBe(
      'amz-possivel-reembolso',
    );
    const linha = db.ler(caminho('amz-prod-L2'));
    expect(linha).toMatchObject({
      origem: ORIGEM_INCIDENTE.outros,
      tipo: TIPO_INCIDENTE.outros,
      subtipo: 'amazon-vinculo-ambiguo',
      externalId: 'L2',
      timestamp: NOW_US,
      resolucao: null,
    });
    expect(db.ler(caminho(ID_INCIDENTE_CLIENTE_SEM_IDENTIDADE_AMAZON))).toMatchObject({
      subtipo: 'amz-cliente-sem-identidade',
      externalId: null,
    });
    expect(db.ler(caminho('amz-logistica-amazon'))?.subtipo).toBe('logistica-amazon');
    expect(db.escritas.every((e) => e.verbo === 'create')).toBe(true);
  });

  it('★ a redelivery creates NOTHING and keeps the first row (ALREADY_EXISTS swallowed, never re-dated)', async () => {
    await registrar({ codigos: [INCIDENTE_PEDIDO_AMAZON.possivelReembolso] });
    const primeiro = db.ler(caminho('amz-possivel-reembolso'));
    const criados = await registrarIncidentesDoPedidoAmazon(asDb(db), {
      pedidoId: PEDIDO,
      orderId: ORDER,
      linhasSemProduto: [],
      clienteSemIdentidade: false,
      codigos: [INCIDENTE_PEDIDO_AMAZON.possivelReembolso],
      nowUs: NOW_US + 1,
    });
    expect(criados).toEqual([]);
    expect(db.ler(caminho('amz-possivel-reembolso'))).toEqual(primeiro);
  });

  it('any other failure rethrows (rule 6)', async () => {
    const falha = Object.assign(new Error('UNAVAILABLE'), { code: 14 });
    db.falharEscrita(caminho('amz-valor-zerado'), falha);
    await expect(registrar({ codigos: [INCIDENTE_PEDIDO_AMAZON.valorZerado] })).rejects.toBe(falha);
  });

  it('every informational code has a text naming only the order id (no SKU, no value)', async () => {
    const codigos = Object.values(INCIDENTE_PEDIDO_AMAZON);
    await registrar({ codigos, linhasSemProduto: [{ orderItemId: 'L1', via: 'unresolved' }] });
    for (const id of [...codigos.map(idIncidenteDoCodigoAmazon), 'amz-prod-L1']) {
      const texto = String(db.ler(caminho(id))?.motivoDoIncidente);
      expect(texto, id).toContain(ORDER);
      expect(texto, id).toMatch(/^\[Amazon\] /);
      expect(texto, id).not.toMatch(/SKU-|R\$|\d+[.,]\d{2}\b/);
    }
  });
});
