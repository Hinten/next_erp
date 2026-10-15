import { describe, expect, it } from 'vitest';
import type { Pedido } from '@delfrance/schemas';
import {
  PedidoEnderecoOrigemAusenteError,
  aplicarPlanoDeCopiaAoPatch,
  aplicarPlanoDeCopiaDeEndereco,
  buildEnderecoCopyOps,
  detectarEnderecosDeOutroCliente,
  planejarCopiasDeEndereco,
} from './enderecoCopy';

function pedido(overrides: Record<string, unknown> = {}): Pedido {
  return {
    clientePedidoOuterRef: 'documents/clientes/novo',
    enderecoFiscalOuterRef: null,
    freteInicial: null,
    ...overrides,
  } as unknown as Pedido;
}

describe('pedido endereço copy plan', () => {
  it('does nothing for the same owner, a missing client, or non-canonical legacy refs', () => {
    const same = pedido({
      enderecoFiscalOuterRef: 'documents/clientes/novo/enderecos/e1',
    });
    expect(detectarEnderecosDeOutroCliente(same)).toEqual([]);
    expect(planejarCopiasDeEndereco(same, () => 'copy')).toBeNull();

    expect(
      detectarEnderecosDeOutroCliente(
        pedido({
          clientePedidoOuterRef: null,
          enderecoFiscalOuterRef: 'documents/clientes/antigo/enderecos/e1',
        }),
      ),
    ).toEqual([]);
    expect(
      detectarEnderecosDeOutroCliente(
        pedido({ enderecoFiscalOuterRef: 'documents/enderecos/legado' }),
      ),
    ).toEqual([]);
  });

  it('plans two copies for distinct fiscal and delivery sources', () => {
    let id = 0;
    const values = pedido({
      enderecoFiscalOuterRef: 'documents/clientes/a/enderecos/fiscal',
      freteInicial: {
        enderecoFreteOuterReference: 'documents/clientes/b/enderecos/entrega',
      },
    });
    const plan = planejarCopiasDeEndereco(values, () => `copy${++id}`)!;
    expect(plan.copies).toHaveLength(2);
    expect(plan.copies.map((copy) => copy.targetPath)).toEqual([
      'clientes/novo/enderecos/copy1',
      'clientes/novo/enderecos/copy2',
    ]);
  });

  it('deduplicates one source used by fiscal and delivery and rewrites both refs', () => {
    const source = 'documents/clientes/antigo/enderecos/e1';
    const values = pedido({
      enderecoFiscalOuterRef: source,
      freteInicial: { modalidade: '9', enderecoFreteOuterReference: source },
    });
    const plan = planejarCopiasDeEndereco(values, () => 'copy')!;
    expect(plan.copies).toHaveLength(1);
    expect(plan.copies[0]?.usos).toEqual(['fiscal', 'entrega']);

    const rewritten = aplicarPlanoDeCopiaDeEndereco(values, plan);
    expect(rewritten.enderecoFiscalOuterRef).toBe('documents/clientes/novo/enderecos/copy');
    expect(rewritten.freteInicial?.enderecoFreteOuterReference).toBe(
      'documents/clientes/novo/enderecos/copy',
    );
    expect(rewritten.freteInicial).toMatchObject({ modalidade: '9' });

    const patch = aplicarPlanoDeCopiaAoPatch(
      { clientePedidoOuterRef: values.clientePedidoOuterRef },
      values,
      plan,
    );
    expect(patch).toMatchObject({
      enderecoFiscalOuterRef: 'documents/clientes/novo/enderecos/copy',
      freteInicial: { enderecoFreteOuterReference: 'documents/clientes/novo/enderecos/copy' },
    });
  });

  it('treats NAO_INFORMADO exactly like any other different owner', () => {
    const values = pedido({
      enderecoFiscalOuterRef: 'documents/clientes/NAO_INFORMADO/enderecos/e1',
    });
    expect(detectarEnderecosDeOutroCliente(values)).toMatchObject([
      { uso: 'fiscal', ownerClienteId: 'NAO_INFORMADO' },
    ]);
  });

  it('preserves source data, stamps the copy in milliseconds, and emits no delete', () => {
    const source = { nome: 'Casa', timestamp: 10, ultimaModificacao: 20, legado: { x: 1 } };
    const values = pedido({
      enderecoFiscalOuterRef: 'documents/clientes/antigo/enderecos/e1',
    });
    const plan = planejarCopiasDeEndereco(values, () => 'copy')!;
    const ops = buildEnderecoCopyOps(
      plan,
      new Map([['clientes/antigo/enderecos/e1', source]]),
      1_700_000_000_123_456,
    );

    expect(ops).toEqual([
      {
        type: 'set',
        path: 'clientes/novo/enderecos/copy',
        data: {
          nome: 'Casa',
          legado: { x: 1 },
          timestamp: 1_700_000_000_123,
          ultimaModificacao: 1_700_000_000_123,
        },
      },
    ]);
    expect(source).toEqual({
      nome: 'Casa',
      timestamp: 10,
      ultimaModificacao: 20,
      legado: { x: 1 },
    });
    expect(ops.some((op) => op.type === 'delete')).toBe(false);
  });

  it('throws a specific error when a confirmed source disappeared', () => {
    const plan = planejarCopiasDeEndereco(
      pedido({ enderecoFiscalOuterRef: 'documents/clientes/antigo/enderecos/e1' }),
      () => 'copy',
    )!;
    expect(() => buildEnderecoCopyOps(plan, new Map(), 1)).toThrow(
      PedidoEnderecoOrigemAusenteError,
    );
  });
});
