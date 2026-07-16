import { describe, expect, it } from 'vitest';
import { pedidoSchema, type ItemDoPedido, type Pedido } from '@delfrance/schemas';
import { createFakeDevolucaoPort } from './fakePort';
import { PedidoConflictError } from './usecases';
import { PEDIDO_COUNTER_PATH } from './numero';
import {
  DEVOLUCAO_INTEGRAL_STRIP_KEYS,
  PEDIDO_PATH,
  buildDevolucaoIntegralSeed,
  buildDevolucaoPedido,
  collectChNFeReferenciadas,
  criarEntradaDevolucaoIntegral,
  criarSaidaComDevolucao,
  novosOriginsDeTroca,
  prepareDevolucaoSave,
  registrarIncidenteDeDevolucaoIntegral,
  registrarIncidentesDeTroca,
  resolveDevolucaoOperacao,
} from './devolucao';

const NOW = 1_700_000_000_000_000; // the fake port's default µs clock

const item = (produtoUid: string | null, quantidade: number, precoDeVenda = 10): ItemDoPedido =>
  ({ produtoUid, quantidade, precoDeVenda }) as unknown as ItemDoPedido;

/** Resolved saída form values, as the PedidoForm resolver would hand them over. */
const saidaValues = (over: Record<string, unknown> = {}): Pedido =>
  pedidoSchema.parse({
    ehSaida: true,
    estado: 'pago',
    itens: { p1: [item('p1', 1, 100)] },
    itensIds: ['p1'],
    clientePedidoOuterRef: 'documents/clientes/c1',
    enderecoFiscalOuterRef: 'documents/clientes/c1/enderecos/e1',
    listaDePrecosOuterRef: 'documents/listaDePrecos/l1',
    vendedorPedidoOuterRef: 'documents/usuarios/u1',
    integracaoPedidoOuterRef: null,
    ...over,
  });

const OPERACAO_DEVOLUCAO = { nome: 'Devolução', ehFiscal: true, finNFe: 4 };

const AUTO_COMENTARIO_RE =
  /^Incidente criado automaticamente pelo sistema em \d{2}\/\d{2}\/\d{4} as \d{2}:\d{2}\.$/;

describe('prepareDevolucaoSave', () => {
  const itensDev = {
    o1: { p1: [item('p1', 1, 50)] },
    o2: { p2: [item('p2', 2, 30)] },
    NONE: { p3: [item('p3', 1, 20)] },
  };

  it('collects the origin ids only (never the NONE avulso bucket) + baselines', async () => {
    const { port } = createFakeDevolucaoPort({
      docs: {
        'pedidos/o1': { numero: 'VEN-000001', entradasRelacionadas: null },
        'pedidos/o2': { numero: 'VEN-000002' },
      },
    });
    const prepared = await prepareDevolucaoSave(port, {
      values: saidaValues({ itensDevolvidos: itensDev }),
    });
    expect(prepared).not.toBeNull();
    expect(prepared?.originIds).toEqual(['o1', 'o2']);
    expect([...(prepared?.originBaselines.keys() ?? [])]).toEqual(['o1', 'o2']);
    expect(prepared?.temOutraDevolucao).toBe(false);
  });

  it('excludes the empty-string key like NONE (it would make an invalid doc ref)', async () => {
    const { port } = createFakeDevolucaoPort({
      docs: { 'pedidos/o1': { numero: 'VEN-000001' } },
    });
    const prepared = await prepareDevolucaoSave(port, {
      values: saidaValues({
        itensDevolvidos: { ...itensDev, '': { p9: [item('p9', 1, 5)] } },
      }),
    });
    expect(prepared?.originIds).toEqual(['o1', 'o2']);
  });

  it('flags temOutraDevolucao when an origin already links an entrada', async () => {
    const { port } = createFakeDevolucaoPort({
      docs: {
        'pedidos/o1': { entradasRelacionadas: ['dev-old'] },
        'pedidos/o2': { entradasRelacionadas: [] },
      },
    });
    const prepared = await prepareDevolucaoSave(port, {
      values: saidaValues({ itensDevolvidos: itensDev }),
    });
    expect(prepared?.temOutraDevolucao).toBe(true);
  });

  it('keeps a missing origin in originIds but with no baseline (legacy-faithful)', async () => {
    const { port } = createFakeDevolucaoPort({
      docs: { 'pedidos/o1': { numero: 'VEN-000001' } }, // o2 does not exist
    });
    const prepared = await prepareDevolucaoSave(port, {
      values: saidaValues({ itensDevolvidos: itensDev }),
    });
    expect(prepared?.originIds).toEqual(['o1', 'o2']);
    expect(prepared?.originBaselines.has('o2')).toBe(false);
    expect(prepared?.temOutraDevolucao).toBe(false);
  });

  it('returns null when the pedido is not a saída or has no itensDevolvidos', async () => {
    const { port } = createFakeDevolucaoPort();
    await expect(
      prepareDevolucaoSave(port, {
        values: saidaValues({ ehSaida: false, itensDevolvidos: itensDev }),
      }),
    ).resolves.toBeNull();
    await expect(
      prepareDevolucaoSave(port, { values: saidaValues({ itensDevolvidos: null }) }),
    ).resolves.toBeNull();
    await expect(
      prepareDevolucaoSave(port, { values: saidaValues({ itensDevolvidos: {} }) }),
    ).resolves.toBeNull();
  });
});

describe('resolveDevolucaoOperacao', () => {
  it("resolves the integração's operacaoDevolucaoOuterRef", async () => {
    const { port } = createFakeDevolucaoPort({
      docs: {
        'integracao/i1': { operacaoDevolucaoOuterRef: 'documents/operacao/opDev' },
        'operacao/opDev': OPERACAO_DEVOLUCAO,
      },
      operacaoEntradaPadrao: { id: 'opFallback', data: { nome: 'Entrada' } },
    });
    const info = await resolveDevolucaoOperacao(port, {
      integracaoOuterRef: 'documents/integracao/i1',
    });
    expect(info).toEqual({
      outerRef: 'documents/operacao/opDev',
      id: 'opDev',
      nome: 'Devolução',
      fiscalCapable: true,
    });
  });

  it('falls back to the default entrada operação (no integração / dangling chain)', async () => {
    const padrao = { id: 'opE', data: { nome: 'Entrada padrão', ehFiscal: true, finNFe: 4 } };
    // No integração ref at all.
    const a = createFakeDevolucaoPort({ operacaoEntradaPadrao: padrao });
    expect(await resolveDevolucaoOperacao(a.port, { integracaoOuterRef: null })).toMatchObject({
      id: 'opE',
      nome: 'Entrada padrão',
      outerRef: 'documents/operacao/opE',
    });
    // Integração exists but its operação doc is gone.
    const b = createFakeDevolucaoPort({
      docs: { 'integracao/i1': { operacaoDevolucaoOuterRef: 'documents/operacao/gone' } },
      operacaoEntradaPadrao: padrao,
    });
    expect(
      await resolveDevolucaoOperacao(b.port, { integracaoOuterRef: 'documents/integracao/i1' }),
    ).toMatchObject({ id: 'opE' });
  });

  it('is all-null / not fiscal-capable when nothing resolves', async () => {
    const { port } = createFakeDevolucaoPort();
    expect(await resolveDevolucaoOperacao(port, { integracaoOuterRef: null })).toEqual({
      outerRef: null,
      id: null,
      nome: null,
      fiscalCapable: false,
    });
  });

  it('fiscalCapable truth table: needs ehFiscal !== false AND finNFe === 4', async () => {
    const capable = async (data: Record<string, unknown>): Promise<boolean> => {
      const { port } = createFakeDevolucaoPort({
        operacaoEntradaPadrao: { id: 'op', data: { nome: 'X', ...data } },
      });
      return (await resolveDevolucaoOperacao(port, { integracaoOuterRef: null })).fiscalCapable;
    };
    expect(await capable({ ehFiscal: false, finNFe: 4 })).toBe(false);
    expect(await capable({ ehFiscal: true, finNFe: 1 })).toBe(false);
    expect(await capable({ ehFiscal: true, finNFe: 4 })).toBe(true);
  });
});

describe('collectChNFeReferenciadas', () => {
  const nfes = {
    o1: [{ chave: 'CH1' }, { chave: 'CH2' }],
    o2: [{ chave: null }, { chave: 'CH3' }],
    o3: [],
  };

  it("'first' takes the first NON-EMPTY chave per origin", async () => {
    const { port } = createFakeDevolucaoPort({ nfesAprovadasByPedido: nfes });
    // o2's FIRST doc has a null chave → its second doc still contributes the
    // origin's reference; o3 has no approved NF-e and contributes nothing.
    expect(await collectChNFeReferenciadas(port, ['o1', 'o2', 'o3'], 'first')).toEqual([
      'CH1',
      'CH3',
    ]);
  });

  it('preserves the originIds order across origins', async () => {
    const { port } = createFakeDevolucaoPort({ nfesAprovadasByPedido: nfes });
    expect(await collectChNFeReferenciadas(port, ['o2', 'o1'], 'first')).toEqual(['CH3', 'CH1']);
    expect(await collectChNFeReferenciadas(port, ['o2', 'o1'], 'all')).toEqual([
      'CH3',
      'CH1',
      'CH2',
    ]);
  });

  it("'all' takes every approved chave, skipping null/empty ones", async () => {
    const { port } = createFakeDevolucaoPort({ nfesAprovadasByPedido: nfes });
    expect(await collectChNFeReferenciadas(port, ['o1', 'o2'], 'all')).toEqual([
      'CH1',
      'CH2',
      'CH3',
    ]);
  });
});

describe('fake port hasNFe', () => {
  it('falls back to the aprovadas map, overridable per pedido', async () => {
    const { port } = createFakeDevolucaoPort({
      nfesAprovadasByPedido: { o1: [{ chave: 'CH1' }] },
      hasNFeByPedido: { o2: true },
    });
    expect(await port.hasNFe('o1')).toBe(true); // via the aprovadas map
    expect(await port.hasNFe('o2')).toBe(true); // explicit override (non-aprovada NF-e)
    expect(await port.hasNFe('o3')).toBe(false);
  });
});

describe('buildDevolucaoPedido', () => {
  it('re-keys items by produtoUid across all buckets (incl. NONE), dropping qty <= 0', () => {
    const { port } = createFakeDevolucaoPort();
    const doc = buildDevolucaoPedido(port, {
      saida: saidaValues(),
      itensDevolvidos: {
        o1: { p1: [item('p1', 1, 50)] },
        o2: { p1: [item('p1', 2, 50)], p2: [item('p2', 0, 30)] },
        NONE: { p3: [item('p3', 1, 20)], NONE: [item(null, 1, 5)] },
      },
      operacaoOuterRef: 'documents/operacao/opDev',
      chNFeReferenciadas: [],
      saidasRelacionadas: ['o1', 'o2'],
    });
    const itens = doc.itens as Record<string, ItemDoPedido[]>;
    // Same produto under two origins → merged, origin order preserved.
    expect(itens.p1?.map((i) => i.quantidade)).toEqual([1, 2]);
    expect(itens.p3).toHaveLength(1);
    // No-produto avulso item lands in the NONE bucket; qty-0 p2 is dropped.
    expect(itens.NONE).toHaveLength(1);
    expect(itens.p2).toBeUndefined();
    expect(doc.itensIds).toEqual(['p1', 'p3', 'NONE']);
  });

  it('builds an entrada pago copying the saída refs, with derived totals + port.now stamps', () => {
    const { port } = createFakeDevolucaoPort();
    const doc = buildDevolucaoPedido(port, {
      saida: saidaValues({ integracaoPedidoOuterRef: 'documents/integracao/i1' }),
      itensDevolvidos: { o1: { p1: [item('p1', 2, 50)] } },
      operacaoOuterRef: 'documents/operacao/opDev',
      chNFeReferenciadas: ['CH1'],
      saidasRelacionadas: ['o1'],
    });
    expect(doc.ehSaida).toBe(false);
    expect(doc.estado).toBe('pago');
    expect(doc.clientePedidoOuterRef).toBe('documents/clientes/c1');
    expect(doc.enderecoFiscalOuterRef).toBe('documents/clientes/c1/enderecos/e1');
    expect(doc.listaDePrecosOuterRef).toBe('documents/listaDePrecos/l1');
    expect(doc.vendedorPedidoOuterRef).toBe('documents/usuarios/u1');
    expect(doc.integracaoPedidoOuterRef).toBe('documents/integracao/i1');
    expect(doc.operacaoPedidoOuterRef).toBe('documents/operacao/opDev');
    expect(doc.chNFeReferenciadas).toEqual(['CH1']);
    expect(doc.saidasRelacionadas).toEqual(['o1']);
    expect(doc.valorCobrado).toBe(100); // (50 − 0) × 2, the derived total
    expect(doc.timestamp).toBe(NOW);
    expect(doc.ultimaModificacao).toBe(NOW);
    // Schema defaults are filled — nullable fields are null, never undefined.
    expect(doc.numero).toBeNull();
    expect(doc.freteInicial).toBeNull();
  });

  it('stores chNFeReferenciadas as null when the collected list is empty', () => {
    const { port } = createFakeDevolucaoPort();
    const doc = buildDevolucaoPedido(port, {
      saida: saidaValues(),
      itensDevolvidos: { o1: { p1: [item('p1', 1, 50)] } },
      operacaoOuterRef: null,
      chNFeReferenciadas: [],
      saidasRelacionadas: ['o1'],
    });
    expect(doc.chNFeReferenciadas).toBeNull();
    expect(doc.operacaoPedidoOuterRef).toBeNull();
  });
});

describe('criarSaidaComDevolucao', () => {
  const itensDev = {
    o1: { p1: [item('p1', 1, 50)] },
    o2: { p2: [item('p2', 2, 30)] },
  };

  async function setup(mutate?: (docs: Map<string, Record<string, unknown> | null>) => void) {
    const fake = createFakeDevolucaoPort({
      docs: {
        'counters/pedido': { value: 10 },
        'pedidos/o1': { numero: 'VEN-000001', entradasRelacionadas: ['prev'] },
        'pedidos/o2': { numero: 'VEN-000002', entradasRelacionadas: null },
      },
      operacaoEntradaPadrao: { id: 'opDev', data: OPERACAO_DEVOLUCAO },
    });
    const values = saidaValues({ itensDevolvidos: itensDev });
    const prepared = await prepareDevolucaoSave(fake.port, { values });
    if (prepared === null) throw new Error('prepared must not be null');
    mutate?.(fake.docs);
    return { ...fake, values, prepared };
  }

  it('creates saída + devolução + origin links in exactly one transaction', async () => {
    const { port, docs, txWrites, values, prepared } = await setup();
    const result = await criarSaidaComDevolucao(port, {
      values,
      prepared,
      saidaOperacaoNome: 'Venda',
    });

    expect(txWrites).toHaveLength(1);
    // Counter bumped by 2, numeros sequential with per-pedido prefixes.
    expect(docs.get(PEDIDO_COUNTER_PATH)).toEqual({ value: 12 });
    expect(result.saidaNumero).toBe('VEN-000011');
    expect(result.devolucaoNumero).toBe('DEV-000012');

    // Origin links: union preserves the pre-existing entry.
    expect(docs.get(PEDIDO_PATH('o1'))).toMatchObject({
      entradasRelacionadas: ['prev', result.devolucaoId],
      ultimaModificacao: NOW,
    });
    expect(docs.get(PEDIDO_PATH('o2'))).toMatchObject({
      entradasRelacionadas: [result.devolucaoId],
    });

    const saida = docs.get(PEDIDO_PATH(result.saidaId));
    expect(saida).toMatchObject({ numero: 'VEN-000011', ehSaida: true });
    expect(saida?.entradasRelacionadas).toEqual([result.devolucaoId]);

    const devolucao = docs.get(PEDIDO_PATH(result.devolucaoId));
    expect(devolucao).toMatchObject({ numero: 'DEV-000012', ehSaida: false, estado: 'pago' });
    expect(devolucao?.saidasRelacionadas).toEqual(['o1', 'o2']);
  });

  it('rejects with PedidoConflictError (zero writes) when an origin drifted', async () => {
    const { port, docs, txWrites, values, prepared } = await setup((d) => {
      const o1 = { ...(d.get('pedidos/o1') ?? {}), numero: 'VEN-999999' };
      d.set('pedidos/o1', o1);
    });
    await expect(
      criarSaidaComDevolucao(port, { values, prepared, saidaOperacaoNome: 'Venda' }),
    ).rejects.toBeInstanceOf(PedidoConflictError);
    expect(txWrites).toHaveLength(0);
    expect(docs.get(PEDIDO_COUNTER_PATH)).toEqual({ value: 10 });
    expect(docs.get(PEDIDO_PATH('o2'))).toMatchObject({ entradasRelacionadas: null });
  });

  it('ignores stamp-only (ultimaModificacao/timestamp) differences', async () => {
    const { port, txWrites, values, prepared } = await setup((d) => {
      const o1 = { ...(d.get('pedidos/o1') ?? {}), ultimaModificacao: 123, timestamp: 456 };
      d.set('pedidos/o1', o1);
    });
    await criarSaidaComDevolucao(port, { values, prepared, saidaOperacaoNome: 'Venda' });
    expect(txWrites).toHaveLength(1);
  });

  it('rejects with PedidoConflictError when an origin was deleted after prepare', async () => {
    const { port, values, prepared } = await setup((d) => {
      d.delete('pedidos/o1');
    });
    const err = await criarSaidaComDevolucao(port, {
      values,
      prepared,
      saidaOperacaoNome: 'Venda',
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PedidoConflictError);
    expect((err as PedidoConflictError).current).toBeNull();
  });
});

describe('novosOriginsDeTroca', () => {
  const oldItens = { o1: { p1: [item('p1', 1)] } };

  it('returns every non-NONE key when there was no previous map', () => {
    expect(novosOriginsDeTroca(null, { o1: {}, o2: {}, NONE: {} })).toEqual(['o1', 'o2']);
    expect(novosOriginsDeTroca(undefined, { o1: {} })).toEqual(['o1']);
  });

  it('is empty for identical keys / null new map', () => {
    expect(novosOriginsDeTroca(oldItens, { o1: {} })).toEqual([]);
    expect(novosOriginsDeTroca(oldItens, null)).toEqual([]);
  });

  it('returns exactly the added origin, never NONE or the empty key', () => {
    expect(novosOriginsDeTroca(oldItens, { o1: {}, o2: {}, NONE: {}, '': {} })).toEqual(['o2']);
  });
});

describe('registrarIncidentesDeTroca', () => {
  it('writes one troca incidente per origin, pointing back at the saída', async () => {
    const { port, committed } = createFakeDevolucaoPort();
    await registrarIncidentesDeTroca(port, {
      saidaPedidoId: 'sd1',
      saidaNumero: 'VEN-000011',
      originIds: ['o1', 'o2'],
    });
    expect(committed).toHaveLength(2);
    expect(committed[0]).toEqual({
      type: 'set',
      path: 'pedidos/o1/incidentes/id1',
      data: {
        origem: 3,
        tipo: 't',
        motivoDoIncidente: 'Troca criada com o pedido #VEN-000011',
        comentarios: expect.stringMatching(AUTO_COMENTARIO_RE) as unknown,
        externalId: 'sd1',
        timestamp: NOW,
        ultimaModificacao: NOW,
      },
    });
    expect(committed[1]).toMatchObject({ path: 'pedidos/o2/incidentes/id2' });
  });

  it('falls back to the saída id in the motivo when there is no numero', async () => {
    const { port, committed } = createFakeDevolucaoPort();
    await registrarIncidentesDeTroca(port, {
      saidaPedidoId: 'sd1',
      saidaNumero: null,
      originIds: ['o1'],
    });
    expect(committed[0]).toMatchObject({
      data: { motivoDoIncidente: 'Troca criada com o pedido #sd1' },
    });
  });

  it('writes nothing for an empty origin list (re-save with no new origin)', async () => {
    const { port, committed } = createFakeDevolucaoPort();
    await registrarIncidentesDeTroca(port, {
      saidaPedidoId: 'sd1',
      saidaNumero: 'VEN-000011',
      originIds: [],
    });
    expect(committed).toEqual([]);
  });
});

describe('buildDevolucaoIntegralSeed', () => {
  const origin = {
    ehSaida: true,
    estado: 'pago',
    numero: 'VEN-000010',
    itens: { p1: [item('p1', 3, 25)] },
    itensIds: ['p1'],
    clientePedidoOuterRef: 'documents/clientes/c1',
    integracaoPedidoOuterRef: 'documents/integracao/i1',
    entradasRelacionadas: ['x'],
    saidasRelacionadas: ['y'],
    itensDevolvidos: { o0: { p1: [item('p1', 1, 25)] } },
    estoqueAplicado: { depositoId: 'd1', ehSaida: true },
    observacoesInternas: 'nota interna',
    error: 'boom',
    dtImpressao: 111,
    lastMarketplaceUpdate: 222,
    ultimaModificacao: 333,
    timestamp: 444,
    foiImpresso: true,
  };

  function setup() {
    return createFakeDevolucaoPort({
      docs: {
        'pedidos/o1': origin,
        'integracao/i1': { operacaoDevolucaoOuterRef: 'documents/operacao/opDev' },
        'operacao/opDev': OPERACAO_DEVOLUCAO,
      },
      nfesAprovadasByPedido: { o1: [{ chave: 'CH1' }, { chave: 'CH2' }] },
    });
  }

  it('strips the state/print/error/notes metadata back to defaults', async () => {
    const { port } = setup();
    const { values } = await buildDevolucaoIntegralSeed(port, {
      originId: 'o1',
      usuarioRef: 'documents/usuarios/u9',
    });
    expect(values.estado).toBe('iniciado');
    // `foiImpresso` pairs with `dtImpressao` and refills to the schema default
    // `false` — carrying the origin's `true` over would mark a never-printed
    // entrada as printed.
    expect(values.foiImpresso).toBe(false);
    const refilledToNull = DEVOLUCAO_INTEGRAL_STRIP_KEYS.filter(
      (k) => k !== 'estado' && k !== 'foiImpresso',
    );
    for (const key of refilledToNull) {
      expect(values[key]).toBeNull();
    }
  });

  it('seeds an entrada with the origin items, ALL approved chaves + the resolved operação', async () => {
    const { port } = setup();
    const { values, operacao, originNumero } = await buildDevolucaoIntegralSeed(port, {
      originId: 'o1',
      usuarioRef: 'documents/usuarios/u9',
    });
    expect(values.ehSaida).toBe(false);
    expect(values.vendedorPedidoOuterRef).toBe('documents/usuarios/u9');
    expect(values.chNFeReferenciadas).toEqual(['CH1', 'CH2']);
    expect(values.operacaoPedidoOuterRef).toBe('documents/operacao/opDev');
    expect(values.clientePedidoOuterRef).toBe('documents/clientes/c1');
    const itens = values.itens as Record<string, ItemDoPedido[]>;
    expect(itens.p1?.map((i) => [i.quantidade, i.precoDeVenda])).toEqual([[3, 25]]);
    // Deliberate cleanup: no origin links / stock snapshot / numero on the seed.
    expect(values.entradasRelacionadas).toBeNull();
    expect(values.saidasRelacionadas).toBeNull();
    expect(values.itensDevolvidos).toBeNull();
    expect(values.estoqueAplicado).toBeNull();
    expect(values.numero).toBeNull();
    expect(operacao).toMatchObject({ id: 'opDev', fiscalCapable: true });
    expect(originNumero).toBe('VEN-000010');
  });

  it('throws PedidoConflictError when the origin no longer exists', async () => {
    const { port } = createFakeDevolucaoPort();
    await expect(
      buildDevolucaoIntegralSeed(port, { originId: 'gone', usuarioRef: null }),
    ).rejects.toBeInstanceOf(PedidoConflictError);
  });
});

describe('criarEntradaDevolucaoIntegral', () => {
  const entradaValues = (): Pedido =>
    saidaValues({ ehSaida: false, estado: 'iniciado', itensDevolvidos: null });

  it('mints the numero, writes the entrada and union-updates the origin atomically', async () => {
    const { port, docs, txWrites } = createFakeDevolucaoPort({
      docs: {
        'counters/pedido': { value: 5 },
        'pedidos/o1': { numero: 'VEN-000001', entradasRelacionadas: ['prev'] },
      },
    });
    const { entradaId, numero } = await criarEntradaDevolucaoIntegral(port, {
      values: entradaValues(),
      originId: 'o1',
      operacaoNome: 'Devolução',
    });
    expect(txWrites).toHaveLength(1);
    expect(numero).toBe('DEV-000006');
    expect(docs.get(PEDIDO_COUNTER_PATH)).toEqual({ value: 6 });
    expect(docs.get(PEDIDO_PATH(entradaId))).toMatchObject({
      numero: 'DEV-000006',
      ehSaida: false,
      saidasRelacionadas: ['o1'],
    });
    expect(docs.get(PEDIDO_PATH('o1'))).toMatchObject({
      entradasRelacionadas: ['prev', entradaId],
      ultimaModificacao: NOW,
    });
  });

  it('rejects with PedidoConflictError (zero writes) when the origin is gone', async () => {
    const { port, docs, txWrites } = createFakeDevolucaoPort({
      docs: { 'counters/pedido': { value: 5 } },
    });
    await expect(
      criarEntradaDevolucaoIntegral(port, {
        values: entradaValues(),
        originId: 'o1',
        operacaoNome: 'Devolução',
      }),
    ).rejects.toBeInstanceOf(PedidoConflictError);
    expect(txWrites).toHaveLength(0);
    expect(docs.get(PEDIDO_COUNTER_PATH)).toEqual({ value: 5 });
  });
});

describe('registrarIncidenteDeDevolucaoIntegral', () => {
  it('writes one devolução incidente on the origin, pointing at the entrada', async () => {
    const { port, committed } = createFakeDevolucaoPort();
    await registrarIncidenteDeDevolucaoIntegral(port, {
      originId: 'o1',
      entradaId: 'ent1',
      entradaNumero: 'DEV-000006',
    });
    expect(committed).toEqual([
      {
        type: 'set',
        path: 'pedidos/o1/incidentes/id1',
        data: {
          origem: 4,
          tipo: 'returns',
          motivoDoIncidente: 'Devolução criada com o pedido #DEV-000006',
          comentarios: expect.stringMatching(AUTO_COMENTARIO_RE) as unknown,
          externalId: 'ent1',
          timestamp: NOW,
          ultimaModificacao: NOW,
        },
      },
    ]);
  });

  it('falls back to the entrada id in the motivo when there is no numero', async () => {
    const { port, committed } = createFakeDevolucaoPort();
    await registrarIncidenteDeDevolucaoIntegral(port, {
      originId: 'o1',
      entradaId: 'ent1',
      entradaNumero: null,
    });
    expect(committed[0]).toMatchObject({
      data: { motivoDoIncidente: 'Devolução criada com o pedido #ent1' },
    });
  });
});
