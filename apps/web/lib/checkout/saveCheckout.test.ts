import { describe, expect, it } from 'vitest';
import {
  ESTADO_PEDIDO,
  freteDoPedidoSchema,
  itemDoPedidoSchema,
  type EngineProduto,
  type ExpectedItem,
  type FreteDoPedido,
  type ItemDoPedido,
  type ScanLogEntry,
} from '@delfrance/schemas';
import { buildCheckoutDoc, evaluatePreSave, type EvaluatePreSaveInput } from './saveCheckout';

const frete = (estado: string, over: Record<string, unknown> = {}): FreteDoPedido =>
  freteDoPedidoSchema.parse({ estado, ...over });
const item = (uid: string, qty: number, ordem: number): ItemDoPedido =>
  itemDoPedidoSchema.parse({ produtoUid: uid, quantidade: qty, ordem, precoDeVenda: 10 });
const ep = (id: string): EngineProduto => ({
  id,
  nome: id,
  sku: null,
  ehKit: false,
  componentesKit: null,
  fotos: null,
});
const logEntry = (over: Partial<ScanLogEntry> = {}): ScanLogEntry => ({
  uid: 'u1',
  produtoId: 'p1',
  produtoNome: 'P1',
  produtoSku: null,
  quantidade: 1,
  kind: 'unit',
  targetKey: 'exp-0',
  componentProdutoId: null,
  error: null,
  timestampMs: 1000,
  excluidoMs: null,
  ...over,
});
const expItem = (over: Partial<ExpectedItem> = {}): ExpectedItem => ({
  key: 'exp-0',
  pos: 0,
  produtoUid: 'p1',
  nomeDeVenda: 'P1',
  sku: null,
  quantidade: 1,
  ehKit: false,
  componentes: null,
  launched: 0,
  concluido: false,
  error: null,
  ...over,
});

// All-gates-pass baseline; each test overrides one field to trip one gate.
const base = (): EvaluatePreSaveInput => ({
  loaded: { estado: ESTADO_PEDIDO.pago, itens: [], freteInicial: frete('despachoAutorizado') },
  fresh: { estado: ESTADO_PEDIDO.pago, numero: '100', freteInicial: frete('despachoAutorizado') },
  freshItens: [],
  expected: [],
  log: [],
  produtos: new Map(),
  existingCheckout: null,
  confirmed: new Set(),
});

describe('evaluatePreSave — gates in order', () => {
  it('passes cleanly → ok, estadoContinuar null (allowed frete estado)', () => {
    expect(evaluatePreSave(base())).toEqual({ ok: true, estadoContinuar: null });
  });

  it('1. blocks when the pedido was deleted', () => {
    const r = evaluatePreSave({ ...base(), fresh: null });
    expect(r).toMatchObject({ ok: false, decision: 'block', kind: 'pedido-deleted' });
  });

  it('2. blocks when estado changed since load', () => {
    const r = evaluatePreSave({
      ...base(),
      fresh: { ...base().fresh!, estado: ESTADO_PEDIDO.iniciado },
    });
    expect(r).toMatchObject({ decision: 'block', kind: 'estado-changed' });
  });

  it('3. blocks when itens changed since load', () => {
    const r = evaluatePreSave({ ...base(), freshItens: [item('A', 1, 1)] });
    expect(r).toMatchObject({ decision: 'block', kind: 'itens-changed' });
  });

  it('4. asks to confirm when frete changed; proceeds once confirmed', () => {
    const changed: EvaluatePreSaveInput = {
      ...base(),
      fresh: { ...base().fresh!, freteInicial: frete('emSeparacao') },
    };
    expect(evaluatePreSave(changed)).toMatchObject({ decision: 'confirm', kind: 'frete-changed' });
    expect(evaluatePreSave({ ...changed, confirmed: new Set(['frete-changed']) })).toMatchObject({
      ok: true,
    });
  });

  it('5. blocks on an expected-item error', () => {
    const r = evaluatePreSave({
      ...base(),
      expected: [expItem({ error: 'Produto não encontrado' })],
    });
    expect(r).toMatchObject({ decision: 'block', kind: 'expected-error' });
  });

  it('6. blocks when the frete was deleted', () => {
    const r = evaluatePreSave({
      ...base(),
      loaded: { estado: ESTADO_PEDIDO.pago, itens: [], freteInicial: null },
      fresh: { estado: ESTADO_PEDIDO.pago, numero: '100', freteInicial: null },
    });
    expect(r).toMatchObject({ decision: 'block', kind: 'frete-null' });
  });

  it('7. blocks on a launched row with an unresolved error', () => {
    const r = evaluatePreSave({
      ...base(),
      log: [logEntry({ kind: 'error', targetKey: null, error: 'Produto não esperado' })],
    });
    expect(r).toMatchObject({ decision: 'block', kind: 'log-error' });
  });

  it('8. blocks (not confirm) on an incomplete scan', () => {
    const r = evaluatePreSave({
      ...base(),
      loaded: {
        estado: ESTADO_PEDIDO.pago,
        itens: [item('A', 2, 1)],
        freteInicial: frete('despachoAutorizado'),
      },
      freshItens: [item('A', 2, 1)],
      produtos: new Map([['A', ep('A')]]),
      log: [], // A needs 2, launched 0
    });
    expect(r).toMatchObject({ decision: 'block', kind: 'incompleto' });
  });

  it('10. blocks a reverso frete', () => {
    const rev = frete('despachoAutorizado', { ehReverso: true });
    const r = evaluatePreSave({
      ...base(),
      loaded: { estado: ESTADO_PEDIDO.pago, itens: [], freteInicial: rev },
      fresh: { estado: ESTADO_PEDIDO.pago, numero: '77', freteInicial: rev },
    });
    expect(r).toMatchObject({ decision: 'block', kind: 'reverso' });
  });

  it('11. blocks when a checkout already exists, carrying its timestamp', () => {
    const r = evaluatePreSave({ ...base(), existingCheckout: { timestampMs: 1_700_000_000_000 } });
    expect(r).toMatchObject({
      decision: 'block',
      kind: 'checkout-existente',
      atMs: 1_700_000_000_000,
    });
  });

  it('9. confirms an out-of-allowed-set frete estado; captures estadoContinuar', () => {
    const cf = frete('checkFinalizado');
    const input: EvaluatePreSaveInput = {
      ...base(),
      loaded: { estado: ESTADO_PEDIDO.pago, itens: [], freteInicial: cf },
      fresh: { estado: ESTADO_PEDIDO.pago, numero: '100', freteInicial: cf },
    };
    expect(evaluatePreSave(input)).toMatchObject({ decision: 'confirm', kind: 'frete-estado' });
    expect(evaluatePreSave({ ...input, confirmed: new Set(['frete-estado']) })).toEqual({
      ok: true,
      estadoContinuar: 'checkFinalizado',
    });
  });

  it('12. blocks a non-Pago pedido (estado unchanged since load)', () => {
    const r = evaluatePreSave({
      ...base(),
      loaded: {
        estado: ESTADO_PEDIDO.iniciado,
        itens: [],
        freteInicial: frete('despachoAutorizado'),
      },
      fresh: {
        estado: ESTADO_PEDIDO.iniciado,
        numero: '100',
        freteInicial: frete('despachoAutorizado'),
      },
    });
    expect(r).toMatchObject({ decision: 'block', kind: 'nao-pago' });
  });
});

describe('buildCheckoutDoc', () => {
  it('maps to the wire shape — usuario ref, itens in order, ms timestamp, fresh frete snapshot', () => {
    const f = frete('checkFinalizado');
    const doc = buildCheckoutDoc({
      numero: '100',
      frete: f,
      uid: 'uid-9',
      log: [
        logEntry({ uid: 'a', produtoId: 'p1' }),
        logEntry({ uid: 'b', produtoId: 'p2', kind: 'kit' }),
      ],
      nowMs: 1_700_000_000_000,
    });
    expect(doc.title).toBe('100');
    expect(doc.obs).toBeNull();
    expect(doc.ehDoFreteInicial).toBe(true);
    expect(doc.usuarioCheckoutFretePedidoOuterRef).toBe('documents/usuarios/uid-9');
    expect(doc.timestamp).toBe(1_700_000_000_000);
    expect(doc.itensCheckout).toHaveLength(2);
    expect(doc.itensCheckout?.[0]?.produtoCheckoutPedidoOuterRef).toBe('documents/produtos/p1');
    expect(doc.itensCheckout?.[1]?.produtoCheckoutPedidoOuterRef).toBe('documents/produtos/p2');
    expect(doc.freteNoMomentoDoCheckout.estado).toBe('checkFinalizado');
  });
});
