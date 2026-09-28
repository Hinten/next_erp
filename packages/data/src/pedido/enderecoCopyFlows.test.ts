import { describe, expect, it } from 'vitest';
import { ESTADO_PEDIDO, type Pedido } from '@delfrance/schemas';
import { criarPedidoComNumero } from './create';
import {
  PedidoEnderecoOrigemAusenteError,
  aplicarPlanoDeCopiaAoPatch,
  planejarCopiasDeEndereco,
} from './enderecoCopy';
import { createFakeDevolucaoPort } from './fakePort';
import { PedidoConflictError, savePedido } from './usecases';

const SOURCE_PATH = 'clientes/antigo/enderecos/e1';
const SOURCE_REF = `documents/${SOURCE_PATH}`;

function values(): Pedido {
  return {
    clientePedidoOuterRef: 'documents/clientes/novo',
    enderecoFiscalOuterRef: SOURCE_REF,
    freteInicial: { enderecoFreteOuterReference: SOURCE_REF },
    timestamp: null,
    estado: ESTADO_PEDIDO.carrinho,
    valorCobrado: 20,
  } as unknown as Pedido;
}

describe('atomic pedido/address-copy flows', () => {
  it('creates a numbered pedido and one deduplicated copy atomically', async () => {
    const fake = createFakeDevolucaoPort({
      docs: { [SOURCE_PATH]: { nome: 'Origem', timestamp: 1, ultimaModificacao: 2 } },
    });
    const pedidoValues = values();
    const plan = planejarCopiasDeEndereco(pedidoValues, () => 'copy')!;
    const created = await criarPedidoComNumero(fake.port, {
      values: pedidoValues,
      operacaoNome: 'Venda',
      enderecoCopyPlan: plan,
    });

    const createdDoc = fake.docs.get(`pedidos/${created.id}`)!;
    expect(created.numero).toBe('VEN-000001');
    expect(createdDoc.enderecoFiscalOuterRef).toBe('documents/clientes/novo/enderecos/copy');
    expect((createdDoc.freteInicial as Record<string, unknown>).enderecoFreteOuterReference).toBe(
      'documents/clientes/novo/enderecos/copy',
    );
    expect(fake.docs.get('clientes/novo/enderecos/copy')).toMatchObject({ nome: 'Origem' });
    expect(fake.docs.get(SOURCE_PATH)).toMatchObject({ timestamp: 1, ultimaModificacao: 2 });
  });

  it('edits the pedido and copies the address in the same transaction', async () => {
    const baseline = {
      clientePedidoOuterRef: 'documents/clientes/antigo',
      enderecoFiscalOuterRef: SOURCE_REF,
      freteInicial: { enderecoFreteOuterReference: SOURCE_REF },
      estado: ESTADO_PEDIDO.carrinho,
      valorCobrado: 20,
    };
    const fake = createFakeDevolucaoPort({
      docs: {
        'pedidos/p1': baseline,
        [SOURCE_PATH]: { nome: 'Origem', timestamp: 1, ultimaModificacao: 2 },
      },
    });
    const next = values();
    const plan = planejarCopiasDeEndereco(next, () => 'copy')!;
    const result = await savePedido(fake.port, {
      pedidoId: 'p1',
      // The use-case itself must apply the plan; callers do not have to smuggle
      // the rewritten refs into their patch for atomicity to hold.
      patch: { clientePedidoOuterRef: next.clientePedidoOuterRef, valorCobrado: 21 },
      baseline,
      enderecoCopyPlan: plan,
    });

    expect(fake.docs.get('clientes/novo/enderecos/copy')).toMatchObject({ nome: 'Origem' });
    expect(fake.docs.get('pedidos/p1')).toMatchObject({
      clientePedidoOuterRef: 'documents/clientes/novo',
      enderecoFiscalOuterRef: 'documents/clientes/novo/enderecos/copy',
      valorCobrado: 21,
    });
    expect(result).toEqual({ totalMudou: true, estadoGravado: ESTADO_PEDIDO.carrinho });
  });

  it('writes nothing when the pedido conflicts', async () => {
    const baseline = { clientePedidoOuterRef: 'documents/clientes/antigo', numero: 'A' };
    const fake = createFakeDevolucaoPort({
      docs: {
        'pedidos/p1': { ...baseline, numero: 'B' },
        [SOURCE_PATH]: { nome: 'Origem' },
      },
    });
    const next = values();
    const plan = planejarCopiasDeEndereco(next, () => 'copy')!;
    await expect(
      savePedido(fake.port, {
        pedidoId: 'p1',
        patch: aplicarPlanoDeCopiaAoPatch({}, next, plan),
        baseline,
        enderecoCopyPlan: plan,
      }),
    ).rejects.toBeInstanceOf(PedidoConflictError);
    expect(fake.docs.has('clientes/novo/enderecos/copy')).toBe(false);
    expect(fake.txWrites).toEqual([]);
  });

  it('writes nothing when the address source disappeared', async () => {
    const baseline = { clientePedidoOuterRef: 'documents/clientes/antigo' };
    const fake = createFakeDevolucaoPort({ docs: { 'pedidos/p1': baseline } });
    const next = values();
    const plan = planejarCopiasDeEndereco(next, () => 'copy')!;
    await expect(
      savePedido(fake.port, {
        pedidoId: 'p1',
        patch: aplicarPlanoDeCopiaAoPatch({}, next, plan),
        baseline,
        enderecoCopyPlan: plan,
      }),
    ).rejects.toBeInstanceOf(PedidoEnderecoOrigemAusenteError);
    expect(fake.docs.has('clientes/novo/enderecos/copy')).toBe(false);
    expect(fake.txWrites).toEqual([]);
  });
});
