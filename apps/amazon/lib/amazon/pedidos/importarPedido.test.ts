/**
 * The order import end to end against the fake db (PR 5-d): the REAL context,
 * the real getOrder read through a scripted `fetch`, the real mappers, the real
 * batch writer, incidentes and avisos. `findOrCreateCliente` and
 * `ensureEndereco` are spies here (the fake models no transaction); the
 * emulator suite runs the real ones.
 *
 * ⚠️ D11: the global `fetch` refuses; the scripted one serves Amazon's model
 * shapes composed in test code. PLACEHOLDERS ONLY (public repository): every
 * document is made at run time, names and addresses are fictitious.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  ESTADO_PEDIDO,
  MODALIDADE_FRETE,
  MOTIVO_CONTA_AMAZON,
  MOTIVO_PEDIDO_AMAZON,
  TIPO_AVISO,
} from '@delfrance/schemas';

import {
  chaveContaPrecisaAtencao,
  chavePedidoPrecisaAtencao,
  relogioDoDocumentoUs,
} from '../avisos/avisos';
import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import type { DepsImportadorAmazon } from '../notificacoes/notificacao';
import { gerarCnpj, gerarCpf } from '../testing/documentos';
import { asDb, increment } from '../testing/fakeDb';
import { AGORA_MS, caminhoAviso, caminhoConta } from '../testing/fixtures';
import {
  CONTA_IMPORTADOR,
  harnessImportador,
  payloadPoll,
  payloadPush,
  registroTeste,
  respostaDoPedido,
  type HarnessImportador,
} from '../testing/importadorAmazon';
import {
  ATUALIZADO_US,
  ORDER_ID_TESTE,
  depois,
  linhaAmazon,
  pedidoAmazon,
  type OpcoesPedidoTeste,
} from '../testing/pedidoWireAmazon';
import {
  AmazonCancelamentoRecenteError,
  AmazonLeituraDefasadaError,
  AmazonPedidoEmConflitoError,
  PedidoAmazonIlegivelError,
} from './erros';
import {
  JANELA_CANCELAMENTO_RECENTE_AMAZON_US,
  clienteDoEnderecoAmazon,
  importarPedidoAmazon,
  motivosDaContaAmazon,
  motivosDoPedidoAmazon,
  parClienteEnderecoAmazon,
} from './importarPedido';
import { makePedidoIdAmazon } from './orderIds';

const m = vi.hoisted(() => ({ findOrCreateCliente: vi.fn(), ensureEndereco: vi.fn() }));

vi.mock('@delfrance/data/admin/clientes', async (original) => {
  const real = await original<typeof import('@delfrance/data/admin/clientes')>();
  return { ...real, findOrCreateCliente: m.findOrCreateCliente };
});
vi.mock('@delfrance/data/admin/enderecos', async (original) => {
  const real = await original<typeof import('@delfrance/data/admin/enderecos')>();
  return { ...real, ensureEndereco: m.ensureEndereco };
});

const PEDIDO_ID = makePedidoIdAmazon(CONTA_IMPORTADOR, ORDER_ID_TESTE);
const CAMINHO = `pedidos/${PEDIDO_ID}`;
const CLIENTE = 'documents/clientes/cli-1';
const ENDERECO = 'documents/clientes/cli-1/enderecos/end-1';

const rede: string[] = [];

beforeEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_MS);
  vi.stubGlobal('fetch', (input: unknown) => {
    rede.push(String(input));
    return Promise.reject(new Error('teste: nenhuma chamada de rede'));
  });
  m.findOrCreateCliente.mockReset();
  m.findOrCreateCliente.mockResolvedValue({
    clienteId: 'cli-1',
    created: true,
    matchedBy: null,
    rejected: [],
    dropped: [],
    idMercadoLivreConflito: null,
  });
  m.ensureEndereco.mockReset();
  m.ensureEndereco.mockResolvedValue('end-1');
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
  expect(rede).toEqual([]);
  rede.length = 0;
});

/* ------------------------------------ harness ------------------------------------ */

/** The buyer and the recipient of an approved order (placeholders, the CPF made at run time). */
function comprador(): Record<string, unknown> {
  return {
    buyer: { buyerName: 'Compradora Ficticia' },
    tax: { taxRegistrations: [{ entityType: 'BUYER', taxRegistrationNumber: gerarCpf() }] },
    recipient: {
      deliveryAddress: {
        name: 'Recebedor Ficticio',
        addressLine1: 'Rua Ficticia, 100',
        city: 'Cidade Ficticia',
        stateOrRegion: 'SP',
        postalCode: '01000-000',
        countryCode: 'BR',
        extendedFields: { streetName: 'Rua Ficticia', streetNumber: '100', neighborhood: 'Centro' },
      },
    },
  };
}

/** One order as getOrder sends it (the parsed builder, as JSON). */
function pedido(opcoes: OpcoesPedidoTeste = {}): Record<string, unknown> {
  return JSON.parse(JSON.stringify(pedidoAmazon(opcoes))) as Record<string, unknown>;
}

/** An ISO instant `ms` milliseconds before AGORA_MS, whole seconds. */
function antesDeAgora(ms: number): string {
  return new Date(AGORA_MS - ms).toISOString().replace('.000Z', 'Z');
}

interface Execucao {
  readonly h: HarnessImportador;
  agoras: number;
  deps(registro?: ReturnType<typeof registroTeste>): DepsImportadorAmazon;
  importar(
    corpo: Record<string, unknown>,
    opcoes?: { payload?: ReturnType<typeof payloadPush>; tentativa?: number | null },
  ): ReturnType<typeof importarPedidoAmazon>;
}

function montar(): Execucao {
  const h = harnessImportador();
  const ex: Execucao = {
    h,
    agoras: 0,
    deps: (registro = registroTeste(0)) => ({
      agora: () => {
        ex.agoras += 1;
        return AGORA_MS;
      },
      increment,
      logger: h.log.logger,
      viaCep: { buscarCep: () => Promise.resolve(null) },
      registro,
    }),
    async importar(corpo, opcoes = {}) {
      h.respostas = [respostaDoPedido(corpo)];
      const contexto = await h.contexto();
      return importarPedidoAmazon(
        asDb(h.db),
        contexto,
        opcoes.payload ?? payloadPush(),
        ex.deps(registroTeste(opcoes.tentativa === undefined ? 0 : opcoes.tentativa)),
      );
    },
  };
  return ex;
}

/** A live produto and its link doc for the conta + SKU. */
function vincular(ex: Execucao, produtoId: string, sku: string) {
  ex.h.db.seed(`produtos/${produtoId}`, { nome: `Produto ${produtoId}` });
  ex.h.db.seed(`produtos/${produtoId}/prodAmazon/l-${produtoId}`, {
    contaAmazonOuterRef: `documents/integracao/${CONTA_IMPORTADOR}`,
    sku,
  });
}

function intFrete(ex: Execucao) {
  ex.h.db.seed(`int_frete/amz-${CONTA_IMPORTADOR}`, {
    tipo: 'amz',
    contaAmazonContaFreteAmazonOuterRef: `documents/integracao/${CONTA_IMPORTADOR}`,
    ativo: true,
    dataCadastro: 1,
  });
}

/** The conta, re-seeded with extra fields (its stamp moves). */
function conta(ex: Execucao, extra: Record<string, unknown>) {
  ex.h.db.seed(caminhoConta(CONTA_IMPORTADOR), {
    ...(ex.h.db.ler(caminhoConta(CONTA_IMPORTADOR)) ?? {}),
    ...extra,
  });
}

const escritasEm = (ex: Execucao, prefixo: string) =>
  ex.h.db.escritas.filter((e) => e.caminho.startsWith(prefixo));
const linhasPedido = (ex: Execucao) =>
  ex.h.log.linhas.filter((l) => l.meta?.evento === 'pedido').map((l) => l.meta ?? {});
const avisoPedido = (
  ex: Execucao,
  motivo: (typeof MOTIVO_PEDIDO_AMAZON)[keyof typeof MOTIVO_PEDIDO_AMAZON],
) => ex.h.db.ler(caminhoAviso(chavePedidoPrecisaAtencao(CONTA_IMPORTADOR, ORDER_ID_TESTE, motivo)));
const incidente = (ex: Execucao, id: string) => ex.h.db.ler(`${CAMINHO}/incidentes/${id}`);

/* ------------------------------------- create ------------------------------------- */

describe('★ create', () => {
  it('the pedido at the digest: saída, numero, canonical integração ref, marketplace, explicit produtoUid, the amz freight seed, the accepted watermark', async () => {
    const ex = montar();
    vincular(ex, 'p1', 'SKU-TESTE-L1');
    intFrete(ex);
    const r = await ex.importar(
      pedido({
        status: 'UNSHIPPED',
        linhas: [
          linhaAmazon('L1', { qtd: 2, preco: '10.00' }),
          linhaAmazon('L2', { qtd: 1, preco: '5.00' }),
        ],
        extra: comprador(),
      }),
    );
    expect(r).toEqual({
      kind: 'importado',
      detalhe: {
        acao: 'criado',
        itens: 'escritas',
        linhasPreservadas: 0,
        linhasDivergentes: 0,
        linhasSemProduto: 1,
      },
    });
    const doc = ex.h.db.ler(CAMINHO) ?? {};
    expect(doc).toMatchObject({
      ehSaida: true,
      estado: 'pago',
      numero: ORDER_ID_TESTE,
      integracaoPedidoOuterRef: `documents/integracao/${CONTA_IMPORTADOR}`,
      clientePedidoOuterRef: CLIENTE,
      lastMarketplaceUpdate: ATUALIZADO_US,
      marketplace: { tipo: 'amazon', status: 'UNSHIPPED', statusEm: ATUALIZADO_US },
    });
    const itens = doc.itens as Record<string, { produtoUid: unknown; mktplaceId: unknown }[]>;
    expect(Object.keys(itens).sort()).toEqual(['NONE', 'p1']);
    expect(itens.p1?.[0]?.produtoUid).toBe('p1');
    expect(itens.NONE?.[0]).toMatchObject({ produtoUid: null, mktplaceId: 'L2' });
    expect(Object.hasOwn(itens.NONE?.[0] ?? {}, 'produtoUid')).toBe(true);
    const frete = doc.freteInicial as Record<string, unknown>;
    expect(frete).toMatchObject({
      externalOptionIntegracao: 'amz',
      integracaoFreteOuterRef: `documents/int_frete/amz-${CONTA_IMPORTADOR}`,
      enderecoFreteOuterReference: ENDERECO,
    });
    expect(typeof frete.prazoDespacho).toBe('number');
    // The unbound line's incidente; the bound one has none.
    expect(incidente(ex, 'amz-prod-L2')).toMatchObject({ subtipo: 'unresolved', externalId: 'L2' });
    expect(incidente(ex, 'amz-prod-L1')).toBeUndefined();
    // One batch.
    expect(escritasEm(ex, CAMINHO).filter((e) => e.caminho === CAMINHO)).toHaveLength(1);
  });

  it('★ deps.agora is read ONCE per import (one nowUs for every mapper and writer)', async () => {
    const ex = montar();
    await ex.importar(pedido({ status: 'UNSHIPPED', extra: comprador() }));
    expect(ex.agoras).toBe(1);
  });

  it('★ the conta is read UNCACHED: the operação, the freight modalidade and the intermediador document set after the context cached the conta are the ones used', async () => {
    const ex = montar();
    const cnpjAntigo = gerarCnpj('434567890001');
    const cnpjNovo = gerarCnpj('987654320001');
    // The context caches the conta WITHOUT an operação or a modalidade, with the OLD document…
    conta(ex, { cpf_cnpj: cnpjAntigo });
    await ex.h.contexto();
    // …then an operator changes all three.
    conta(ex, {
      operacaoOuterRef: 'documents/operacao/op-1',
      modalidadeFreteImportacao: MODALIDADE_FRETE.cif,
      cpf_cnpj: cnpjNovo,
    });
    // The order names the OLD document as the marketplace's: only the fresh one diverges.
    await ex.importar(
      pedido({
        status: 'PENDING',
        extra: {
          tax: {
            taxRegistrations: [{ entityType: 'MARKETPLACE', taxRegistrationNumber: cnpjAntigo }],
          },
        },
      }),
    );
    const doc = ex.h.db.ler(CAMINHO) ?? {};
    expect(doc.operacaoPedidoOuterRef).toBe('documents/operacao/op-1');
    // NEAR-MISS: the cached conta has no modalidade, which seeds FOB.
    expect((doc.freteInicial as Record<string, unknown>).modalidade).toBe(MODALIDADE_FRETE.cif);
    const divergente = ex.h.db.ler(
      caminhoAviso(
        chaveContaPrecisaAtencao(CONTA_IMPORTADOR, MOTIVO_CONTA_AMAZON.intermediadorDivergente),
      ),
    );
    expect(divergente?.resolvidoEm).toBeNull();
  });
});

/* ------------------------------- cliente and endereço ------------------------------ */

describe('★ the cliente and the endereço — approved orders only, fill-once, paired', () => {
  it('PENDING ⇒ neither spy is called; then UNSHIPPED ⇒ both filled', async () => {
    const ex = montar();
    await ex.importar(pedido({ status: 'PENDING', extra: comprador() }));
    expect(m.findOrCreateCliente).not.toHaveBeenCalled();
    expect(m.ensureEndereco).not.toHaveBeenCalled();
    expect(ex.h.db.ler(CAMINHO)?.clientePedidoOuterRef).toBeNull();

    await ex.importar(
      pedido({ status: 'UNSHIPPED', atualizadoEm: depois(60), extra: comprador() }),
    );
    expect(m.findOrCreateCliente).toHaveBeenCalledTimes(1);
    expect(m.findOrCreateCliente.mock.calls[0]?.[1]).toMatchObject({ nowMs: AGORA_MS });
    expect(m.ensureEndereco.mock.calls[0]?.[1]).toBe('cli-1');
    expect(m.ensureEndereco.mock.calls[0]?.[2]).toMatchObject({
      nome: 'Recebedor Ficticio',
      cpf_cnpj: null,
      telefone: null,
    });
    const doc = ex.h.db.ler(CAMINHO) ?? {};
    expect(doc.clientePedidoOuterRef).toBe(CLIENTE);
    expect((doc.freteInicial as Record<string, unknown>).enderecoFreteOuterReference).toBe(
      ENDERECO,
    );
  });

  it('★ a STORED cliente is never replaced, and the endereço is stored UNDER it (an operator’s cliente included)', async () => {
    const ex = montar();
    await ex.importar(pedido({ status: 'PENDING' }));
    ex.h.db.seed(CAMINHO, {
      ...(ex.h.db.ler(CAMINHO) ?? {}),
      clientePedidoOuterRef: 'documents/clientes/operador',
    });
    await ex.importar(
      pedido({ status: 'UNSHIPPED', atualizadoEm: depois(60), extra: comprador() }),
    );
    expect(m.findOrCreateCliente).not.toHaveBeenCalled();
    expect(m.ensureEndereco.mock.calls[0]?.[1]).toBe('operador');
    const doc = ex.h.db.ler(CAMINHO) ?? {};
    expect(doc.clientePedidoOuterRef).toBe('documents/clientes/operador');
    expect((doc.freteInicial as Record<string, unknown>).enderecoFreteOuterReference).toBe(
      'documents/clientes/operador/enderecos/end-1',
    );
  });

  it('★ a stored freight endereço is never replaced (and ensureEndereco is not even called)', async () => {
    const ex = montar();
    await ex.importar(pedido({ status: 'PENDING' }));
    const doc0 = ex.h.db.ler(CAMINHO) ?? {};
    ex.h.db.seed(CAMINHO, {
      ...doc0,
      freteInicial: {
        ...(doc0.freteInicial as object),
        enderecoFreteOuterReference: 'documents/clientes/cli-1/enderecos/do-operador',
      },
    });
    await ex.importar(
      pedido({ status: 'UNSHIPPED', atualizadoEm: depois(60), extra: comprador() }),
    );
    expect(m.ensureEndereco).not.toHaveBeenCalled();
    const doc = ex.h.db.ler(CAMINHO) ?? {};
    expect((doc.freteInicial as Record<string, unknown>).enderecoFreteOuterReference).toBe(
      'documents/clientes/cli-1/enderecos/do-operador',
    );
    // Its owner IS the resolved cliente: the cliente pairs, and is filled.
    expect(doc.clientePedidoOuterRef).toBe(CLIENTE);
  });

  it('★ PAIRING: a stored freight endereço of ANOTHER cliente ⇒ the resolved cliente is NOT filled beside it', async () => {
    const ex = montar();
    await ex.importar(pedido({ status: 'PENDING' }));
    const doc0 = ex.h.db.ler(CAMINHO) ?? {};
    ex.h.db.seed(CAMINHO, {
      ...doc0,
      freteInicial: {
        ...(doc0.freteInicial as object),
        enderecoFreteOuterReference: 'documents/clientes/outro/enderecos/x',
      },
    });
    await ex.importar(
      pedido({ status: 'UNSHIPPED', atualizadoEm: depois(60), extra: comprador() }),
    );
    expect(ex.h.db.ler(CAMINHO)?.clientePedidoOuterRef).toBeNull();
    // NEAR-MISS against "no identity": the buyer HAD one, so that incidente would lie.
    expect(m.findOrCreateCliente).toHaveBeenCalledTimes(1);
    expect(incidente(ex, 'amz-cliente-sem-identidade')).toBeUndefined();
  });

  it('★ PAIRING per attempt: a cliente linked between the read and the batch ⇒ the endereço resolved under another one is NOT filled', async () => {
    const ex = montar();
    await ex.importar(pedido({ status: 'PENDING' }));
    ex.h.db.antesDaProximaEscrita(CAMINHO, () => {
      ex.h.db.seed(CAMINHO, {
        ...(ex.h.db.ler(CAMINHO) ?? {}),
        clientePedidoOuterRef: 'documents/clientes/operador',
      });
    });
    const r = await ex.importar(
      pedido({ status: 'UNSHIPPED', atualizadoEm: depois(60), extra: comprador() }),
    );
    expect(r.kind).toBe('importado');
    const doc = ex.h.db.ler(CAMINHO) ?? {};
    expect(doc.clientePedidoOuterRef).toBe('documents/clientes/operador');
    expect((doc.freteInicial as Record<string, unknown>).enderecoFreteOuterReference).toBeNull();
  });

  it('a buyer without a usable identity ⇒ no cliente call, and the approved pedido gets amz-cliente-sem-identidade', async () => {
    const ex = montar();
    await ex.importar(
      pedido({ status: 'UNSHIPPED', extra: { buyer: { buyerName: 'Sem Documento' } } }),
    );
    expect(m.findOrCreateCliente).not.toHaveBeenCalled();
    expect(incidente(ex, 'amz-cliente-sem-identidade')).toMatchObject({
      subtipo: 'amz-cliente-sem-identidade',
    });
  });

  it('★ …decided from the WINNING snapshot: a cliente linked between the read and the batch (the buyer still without identity) ⇒ NO such incidente', async () => {
    const ex = montar();
    await ex.importar(pedido({ status: 'PENDING' }));
    ex.h.db.antesDaProximaEscrita(CAMINHO, () => {
      ex.h.db.seed(CAMINHO, {
        ...(ex.h.db.ler(CAMINHO) ?? {}),
        clientePedidoOuterRef: 'documents/clientes/operador',
      });
    });
    const r = await ex.importar(
      pedido({
        status: 'UNSHIPPED',
        atualizadoEm: depois(60),
        extra: { buyer: { buyerName: 'Sem Documento' } },
      }),
    );
    expect(r.kind).toBe('importado');
    expect(m.findOrCreateCliente).not.toHaveBeenCalled();
    expect(ex.h.db.ler(CAMINHO)?.clientePedidoOuterRef).toBe('documents/clientes/operador');
    // NEAR-MISS: decided from the first read (no cliente), the incidente would be filed.
    expect(incidente(ex, 'amz-cliente-sem-identidade')).toBeUndefined();
  });

  it('NEAR-MISS: a PENDING pedido without a cliente gets NO such incidente', async () => {
    const ex = montar();
    await ex.importar(pedido({ status: 'PENDING' }));
    expect(incidente(ex, 'amz-cliente-sem-identidade')).toBeUndefined();
  });

  it('the shared resolver’s "no strong identity" is caught NARROWLY; anything else rethrows (rule 6)', async () => {
    const { ClienteSemIdentidadeForteError } = await import('@delfrance/data/admin/clientes');
    const ex = montar();
    m.findOrCreateCliente.mockRejectedValueOnce(
      new (ClienteSemIdentidadeForteError as unknown as new () => Error)(),
    );
    const r = await ex.importar(pedido({ status: 'UNSHIPPED', extra: comprador() }));
    expect(r.kind).toBe('importado');
    expect(incidente(ex, 'amz-cliente-sem-identidade')).toBeDefined();

    const outra = montar();
    const falha = new TypeError('bug');
    m.findOrCreateCliente.mockRejectedValueOnce(falha);
    await expect(outra.importar(pedido({ status: 'UNSHIPPED', extra: comprador() }))).rejects.toBe(
      falha,
    );
    expect(outra.h.db.ler(CAMINHO)).toBeUndefined();
  });
});

/* -------------------------- the decisions that write nothing -------------------------- */

describe('★ zero writes of any kind', () => {
  it('a first-seen CANCELLED OLDER than the window ⇒ cancelado-nao-importado', async () => {
    const ex = montar();
    const r = await ex.importar(pedido({ status: 'CANCELLED', extra: comprador() }));
    expect(r).toEqual({ kind: 'cancelado-nao-importado' });
    expect(ex.h.db.escritas).toEqual([]);
    expect(m.findOrCreateCliente).not.toHaveBeenCalled();
  });

  it('a first-seen CANCELLED YOUNGER than the window ⇒ AmazonCancelamentoRecenteError (retry), zero writes, one WARNING', async () => {
    const ex = montar();
    await expect(
      ex.importar(pedido({ status: 'CANCELLED', atualizadoEm: antesDeAgora(5 * 60_000) })),
    ).rejects.toBeInstanceOf(AmazonCancelamentoRecenteError);
    expect(ex.h.db.escritas).toEqual([]);
    expect(linhasPedido(ex)).toEqual([
      expect.objectContaining({
        codigo: 'cancelamento-recente',
        idadeS: 300,
        conta: CONTA_IMPORTADOR,
      }),
    ]);
  });

  it('NEAR-MISS on the window edge: exactly 15 min ⇒ skipped; one second younger ⇒ waits', async () => {
    expect(JANELA_CANCELAMENTO_RECENTE_AMAZON_US).toBe(15 * 60 * 1_000_000);
    const ex = montar();
    await expect(
      ex.importar(pedido({ status: 'CANCELLED', atualizadoEm: antesDeAgora(15 * 60_000) })),
    ).resolves.toEqual({ kind: 'cancelado-nao-importado' });
    await expect(
      ex.importar(pedido({ status: 'CANCELLED', atualizadoEm: antesDeAgora(15 * 60_000 - 1000) })),
    ).rejects.toBeInstanceOf(AmazonCancelamentoRecenteError);
  });

  it('★ a first-seen SHIPPED + RETURNED_TO_SELLER past the window ⇒ reversao-nao-importada, zero writes (decision 44)', async () => {
    const ex = montar();
    const r = await ex.importar(
      pedido({
        status: 'SHIPPED',
        pacotes: ['RETURNED_TO_SELLER'],
        atualizadoEm: antesDeAgora(15 * 60_000),
        extra: comprador(),
      }),
    );
    expect(r).toEqual({ kind: 'reversao-nao-importada' });
    expect(ex.h.db.escritas).toEqual([]);
    expect(m.findOrCreateCliente).not.toHaveBeenCalled();
    expect(linhasPedido(ex)).toEqual([
      expect.objectContaining({ codigo: 'reversao-nao-importada' }),
    ]);
  });

  it('★ NEAR-MISS: the same reversal one second inside the window WAITS like a CANCELLED (retry, zero writes)', async () => {
    const ex = montar();
    await expect(
      ex.importar(
        pedido({
          status: 'SHIPPED',
          pacotes: ['RETURNED_TO_SELLER'],
          atualizadoEm: antesDeAgora(15 * 60_000 - 1000),
          extra: comprador(),
        }),
      ),
    ).rejects.toBeInstanceOf(AmazonCancelamentoRecenteError);
    expect(ex.h.db.escritas).toEqual([]);
    expect(m.findOrCreateCliente).not.toHaveBeenCalled();
    expect(linhasPedido(ex)).toEqual([
      expect.objectContaining({ codigo: 'cancelamento-recente', idadeS: 899 }),
    ]);
  });

  it('★ obsoleto ⇒ zero writes: no batch, no cliente, no incidente, no aviso', async () => {
    const ex = montar();
    await ex.importar(
      pedido({ status: 'UNSHIPPED', atualizadoEm: depois(60), por: 'NONE_OF_THEM' }),
    );
    const escritas = ex.h.db.escritas.length;
    const r = await ex.importar(
      pedido({ status: 'UNSHIPPED', por: 'NONE_OF_THEM', extra: comprador() }),
    );
    expect(r).toEqual({ kind: 'obsoleto' });
    expect(ex.h.db.escritas).toHaveLength(escritas);
    expect(m.findOrCreateCliente).not.toHaveBeenCalled();
  });

  it('★ obsoleto found on a RETRY (a newer import landed between the read and the batch) ⇒ no incidente, no aviso', async () => {
    const ex = montar();
    await ex.importar(pedido({ status: 'PENDING' }));
    const escritas = ex.h.db.escritas.length;
    // Another importer commits a NEWER Amazon read right before this batch.
    ex.h.db.antesDaProximaEscrita(CAMINHO, () => {
      const atual = ex.h.db.ler(CAMINHO) ?? {};
      ex.h.db.seed(CAMINHO, { ...atual, lastMarketplaceUpdate: ATUALIZADO_US + 600_000_000 });
    });
    const r = await ex.importar(
      pedido({
        status: 'UNSHIPPED',
        por: null,
        atualizadoEm: depois(60),
        linhas: [linhaAmazon('L1', { qtd: 0, preco: '10.00' })],
        extra: comprador(),
      }),
    );
    expect(r).toEqual({ kind: 'obsoleto' });
    // The cliente/endereço of steps 4–6 may have run; nothing ELSE was written.
    expect(
      ex.h.db.escritas
        .slice(escritas)
        .filter((e) => e.caminho.startsWith('avisos/') || e.caminho.includes('/incidentes/')),
    ).toEqual([]);
  });

  it('★ an equal-stamp redelivery ⇒ sem-mudanca, ZERO writes (no standing motivo on a conta with an operação)', async () => {
    const ex = montar();
    conta(ex, { operacaoOuterRef: 'documents/operacao/op-1' });
    await ex.importar(pedido({ status: 'UNSHIPPED', extra: comprador() }));
    const escritas = ex.h.db.escritas.length;
    const r = await ex.importar(pedido({ status: 'UNSHIPPED', extra: comprador() }));
    expect(r).toEqual({
      kind: 'sem-mudanca',
      detalhe: expect.objectContaining({ acao: null, itens: 'mantidas' }),
    });
    expect(ex.h.db.escritas).toHaveLength(escritas);
  });

  it('NEAR-MISS: a STANDING motivo is re-raised (one occurrence bump, the shared writer’s repeat) — the pedido is still not written', async () => {
    const ex = montar();
    await ex.importar(pedido({ status: 'UNSHIPPED', extra: comprador() }));
    const escritas = ex.h.db.escritas.length;
    await ex.importar(pedido({ status: 'UNSHIPPED', extra: comprador() }));
    const novas = ex.h.db.escritas.slice(escritas);
    expect(novas.map((e) => e.caminho)).toEqual([
      caminhoAviso(
        chaveContaPrecisaAtencao(CONTA_IMPORTADOR, MOTIVO_CONTA_AMAZON.contaSemOperacao),
      ),
    ]);
  });

  it('★ …and the same redelivery after a link doc appeared ⇒ the NONE line bound', async () => {
    const ex = montar();
    await ex.importar(pedido({ status: 'UNSHIPPED', extra: comprador() }));
    expect(Object.keys((ex.h.db.ler(CAMINHO)?.itens ?? {}) as object)).toEqual(['NONE']);
    vincular(ex, 'p1', 'SKU-TESTE-L1');
    const r = await ex.importar(pedido({ status: 'UNSHIPPED', extra: comprador() }));
    expect(r.kind).toBe('importado');
    const itens = ex.h.db.ler(CAMINHO)?.itens as Record<string, { produtoUid: unknown }[]>;
    expect(Object.keys(itens)).toEqual(['p1']);
    expect(itens.p1?.[0]?.produtoUid).toBe('p1');
  });
});

/* ----------------------------------- divergence ----------------------------------- */

describe('★ a divergence on an approved pedido', () => {
  it('⇒ our [amazon] error, the lines untouched, the crítico aviso, result importado/divergencia-itens-aprovado', async () => {
    const ex = montar();
    await ex.importar(pedido({ status: 'UNSHIPPED', extra: comprador() }));
    const itensAntes = ex.h.db.ler(CAMINHO)?.itens;
    const r = await ex.importar(
      pedido({
        status: 'UNSHIPPED',
        atualizadoEm: depois(60),
        linhas: [linhaAmazon('L1', { qtd: 3, preco: '10.00' })],
        extra: comprador(),
      }),
    );
    expect(r).toEqual({
      kind: 'importado',
      detalhe: expect.objectContaining({
        acao: 'atualizado',
        itens: 'divergencia-itens-aprovado',
        linhasDivergentes: 1,
      }),
    });
    const doc = ex.h.db.ler(CAMINHO) ?? {};
    expect(doc.estado).toBe('error');
    expect(String(doc.error)).toMatch(/^\[amazon\] /);
    expect(doc.itens).toEqual(itensAntes);
    expect(avisoPedido(ex, MOTIVO_PEDIDO_AMAZON.divergenciaItens)).toMatchObject({
      tipo: TIPO_AVISO.amazonPedidoPrecisaAtencao,
      severidade: 'critico',
      resolvidoEm: null,
    });
  });

  it('★ the same on a stored `finalizado` ⇒ the estado is KEPT, the aviso still raised', async () => {
    const ex = montar();
    await ex.importar(pedido({ status: 'UNSHIPPED', extra: comprador() }));
    ex.h.db.seed(CAMINHO, { ...(ex.h.db.ler(CAMINHO) ?? {}), estado: 'finalizado' });
    await ex.importar(
      pedido({
        status: 'UNSHIPPED',
        atualizadoEm: depois(60),
        linhas: [linhaAmazon('L1', { qtd: 3, preco: '10.00' })],
        extra: comprador(),
      }),
    );
    expect(ex.h.db.ler(CAMINHO)?.estado).toBe('finalizado');
    expect(avisoPedido(ex, MOTIVO_PEDIDO_AMAZON.divergenciaItens)?.resolvidoEm).toBeNull();
  });

  it('★ an executed line cancellation on an order still to ship ⇒ BLOCK + its OWN `cancelamento-parcial` log line (decision 6)', async () => {
    const ex = montar();
    await ex.importar(pedido({ status: 'UNSHIPPED', extra: comprador() }));
    await ex.importar(
      pedido({
        status: 'UNSHIPPED',
        atualizadoEm: depois(60),
        linhas: [linhaAmazon('L1', { qtd: 0, preco: '10.00', execucao: true })],
        extra: comprador(),
      }),
    );
    expect(ex.h.db.ler(CAMINHO)?.estado).toBe('error');
    const parcial = linhasPedido(ex).filter((l) => l.codigo === 'cancelamento-parcial');
    expect(parcial).toHaveLength(1);
    expect(parcial[0]).toMatchObject({
      evento: 'pedido',
      pedido: ORDER_ID_TESTE,
      conta: CONTA_IMPORTADOR,
      linhasDivergentes: 1,
    });
    // Ids and counts only: no price, no buyer datum.
    expect(JSON.stringify(parcial[0])).not.toMatch(/10\.00|Compradora|Recebedor/);
  });

  it('★ TWO mapper events on one import ⇒ one log line EACH (never one line, never the first code repeated)', async () => {
    const ex = montar();
    await ex.importar(
      pedido({
        status: 'UNSHIPPED',
        linhas: [
          linhaAmazon('L1', { qtd: 1, preco: '10.00', unidade: 'KILOGRAM' }),
          linhaAmazon('L2', { qtd: 0, preco: '5.00', execucao: true }),
        ],
        extra: comprador(),
      }),
    );
    const codigos = linhasPedido(ex).map((l) => l.codigo);
    expect(codigos.filter((c) => c === 'cancelamento-parcial')).toHaveLength(1);
    expect(codigos.filter((c) => c === 'medida-nao-unitaria')).toHaveLength(1);
  });

  it('★ a first-seen executed line cancellation still to ship ⇒ created blocked, with the log line too', async () => {
    const ex = montar();
    await ex.importar(
      pedido({
        status: 'UNSHIPPED',
        linhas: [
          linhaAmazon('L1', { qtd: 1, preco: '10.00' }),
          linhaAmazon('L2', { qtd: 0, preco: '5.00', execucao: true }),
        ],
        extra: comprador(),
      }),
    );
    expect(ex.h.db.ler(CAMINHO)?.estado).toBe('error');
    expect(linhasPedido(ex).map((l) => l.codigo)).toContain('cancelamento-parcial');
  });
});

/* ------------------------------ races and retries ------------------------------ */

describe('★ a lost precondition re-reads and re-derives; steps 4–6 run once', () => {
  it('attempt 1 loses, attempt 2 wins — the cliente, the link read and the freight lookup ran ONCE', async () => {
    const ex = montar();
    vincular(ex, 'p1', 'SKU-TESTE-L1');
    intFrete(ex);
    await ex.importar(pedido({ status: 'PENDING' }));
    const consultasAntes = ex.h.db.consultas.length;
    ex.h.db.antesDaProximaEscrita(CAMINHO, () => {
      ex.h.db.seed(CAMINHO, { ...(ex.h.db.ler(CAMINHO) ?? {}) });
    });
    const r = await ex.importar(
      pedido({ status: 'UNSHIPPED', atualizadoEm: depois(60), extra: comprador() }),
    );
    expect(r.kind).toBe('importado');
    expect(m.findOrCreateCliente).toHaveBeenCalledTimes(1);
    expect(m.ensureEndereco).toHaveBeenCalledTimes(1);
    const novas = ex.h.db.consultas.slice(consultasAntes).map((c) => c.colecao);
    // L1 was bound by the first import: no link read at all now; one freight lookup.
    expect(novas.filter((c) => c === 'prodAmazon')).toHaveLength(0);
    expect(novas.filter((c) => c === 'int_frete')).toHaveLength(1);
    expect(linhasPedido(ex)).toContainEqual(
      expect.objectContaining({ codigo: 'precondicao-perdida', tentativas: 2 }),
    );
  });

  it('the link read runs once per SKU across retries too', async () => {
    const ex = montar();
    ex.h.db.antesDaProximaEscrita(CAMINHO, () => {
      ex.h.db.seed(CAMINHO, { qualquer: 1 });
    });
    // The create loses to another writer's document, the retry updates over it.
    await ex.importar(pedido({ status: 'PENDING' }));
    expect(ex.h.db.consultas.filter((c) => c.colecao === 'prodAmazon')).toHaveLength(1);
  });

  it('three losses ⇒ AmazonPedidoEmConflitoError: no pedido write, NO incidente, NO aviso', async () => {
    const ex = montar();
    await ex.importar(pedido({ status: 'PENDING' }));
    const escritas = ex.h.db.escritas.length;
    for (let i = 0; i < 3; i += 1) {
      ex.h.db.antesDaProximaEscrita(CAMINHO, () => {
        ex.h.db.seed(CAMINHO, { ...(ex.h.db.ler(CAMINHO) ?? {}) });
      });
    }
    await expect(
      ex.importar(pedido({ status: 'UNSHIPPED', atualizadoEm: depois(60), extra: { buyer: {} } })),
    ).rejects.toBeInstanceOf(AmazonPedidoEmConflitoError);
    expect(ex.h.db.escritas).toHaveLength(escritas);
  });
});

/* ----------------------------------- the read ----------------------------------- */

describe('★ the read checks, before any pedido read', () => {
  it.each<[string, Record<string, unknown>, string]>([
    ['a wrong orderId', { orderId: '171-9876543-2109877' }, 'pedido-divergente'],
    [
      'an offset-less lastUpdatedTime',
      { lastUpdatedTime: '2026-10-01T12:00:00' },
      'instante-ilegivel',
    ],
    [
      'a duplicate orderItemId',
      { orderItems: [linhaAmazon('L1', { qtd: 1 }), linhaAmazon('L1', { qtd: 1 })] },
      'linha-duplicada',
    ],
  ])(
    '%s ⇒ PedidoAmazonIlegivelError, no pedido read, nothing written',
    async (_c, over, motivo) => {
      const ex = montar();
      await expect(ex.importar({ ...pedido(), ...over })).rejects.toSatisfy(
        (e: unknown) => e instanceof PedidoAmazonIlegivelError && e.motivo === motivo,
      );
      expect(ex.h.db.leituras.filter((c) => c.startsWith('pedidos/'))).toEqual([]);
      expect(ex.h.db.escritas).toEqual([]);
    },
  );

  it('a poll payload newer than the read: a queue attempt retries; a sweep re-drive imports with ONE count line', async () => {
    const ex = montar();
    await expect(
      ex.importar(pedido({ status: 'PENDING' }), {
        payload: payloadPoll(ATUALIZADO_US + 1),
        tentativa: 0,
      }),
    ).rejects.toBeInstanceOf(AmazonLeituraDefasadaError);
    expect(ex.h.db.escritas).toEqual([]);
    const r = await ex.importar(pedido({ status: 'PENDING' }), {
      payload: payloadPoll(ATUALIZADO_US + 1),
      tentativa: null,
    });
    expect(r.kind).toBe('importado');
    expect(linhasPedido(ex).filter((l) => l.codigo === 'leitura-defasada-aceita')).toHaveLength(1);
  });

  it('a non-BR marketplace ⇒ marketplace-estrangeiro, nothing read or written', async () => {
    const ex = montar();
    const r = await ex.importar({
      ...pedido(),
      salesChannel: { marketplaceId: 'ATVPDKIKX0DER', channelName: 'AMAZON' },
    });
    expect(r).toEqual({ kind: 'marketplace-estrangeiro' });
    expect(ex.h.db.leituras.filter((c) => c.startsWith('pedidos/'))).toEqual([]);
  });

  it('a 401 on getOrder ⇒ exactly one forced refresh, one retry, then the import', async () => {
    const ex = montar();
    ex.h.respostas = [
      { status: 401, corpo: { errors: [{ code: 'Unauthorized', message: 'x' }] } },
      respostaDoPedido(pedido({ status: 'PENDING' })),
    ];
    const contexto = await ex.h.contexto();
    const r = await importarPedidoAmazon(asDb(ex.h.db), contexto, payloadPush(), ex.deps());
    expect(r.kind).toBe('importado');
    expect(ex.h.gets).toHaveLength(2);
    expect(ex.h.lwa).toBe(1);
  });

  it('a conta deleted after the context loaded ⇒ the conta refusal (dropped by the classifier)', async () => {
    const ex = montar();
    const contexto = await ex.h.contexto();
    ex.h.db.apagar(caminhoConta(CONTA_IMPORTADOR));
    ex.h.respostas = [respostaDoPedido(pedido())];
    await expect(
      importarPedidoAmazon(asDb(ex.h.db), contexto, payloadPush(), ex.deps()),
    ).rejects.toMatchObject({ name: 'ContaAmazonNaoEncontradaError' });
  });
});

/* ------------------------------------ avisos ------------------------------------ */

describe('★ avisos — after the commit, from the winning attempt, on the Firestore timeline', () => {
  it('a per-pedido raise is clocked by the batch commit time, never the order µs', async () => {
    const ex = montar();
    await ex.importar(pedido({ status: 'UNSHIPPED', por: null, extra: comprador() }));
    const aviso = avisoPedido(ex, MOTIVO_PEDIDO_AMAZON.logisticaDesconhecida);
    const commit = ex.h.db.escritasEm(CAMINHO)[0]?.writeTime;
    expect(commit).toBeDefined();
    expect(aviso?.relogioEvento).toBe(relogioDoDocumentoUs(commit!));
    expect(aviso?.relogioEvento).not.toBe(ATUALIZADO_US);
  });

  it('a re-import at an EQUAL order clock that no longer derives a motivo resolves it (the snapshot read time is newer)', async () => {
    const ex = montar();
    await ex.importar(
      pedido({
        status: 'UNSHIPPED',
        linhas: [linhaAmazon('L1', { qtd: 2, preco: '10.00', solicitacao: true })],
        extra: comprador(),
      }),
    );
    expect(avisoPedido(ex, MOTIVO_PEDIDO_AMAZON.cancelamentoSolicitado)?.resolvidoEm).toBeNull();
    // The same clock, the request gone: the pedido does not change, the row closes.
    const r = await ex.importar(pedido({ status: 'UNSHIPPED', extra: comprador() }));
    expect(r.kind).toBe('sem-mudanca');
    expect(
      avisoPedido(ex, MOTIVO_PEDIDO_AMAZON.cancelamentoSolicitado)?.resolvidoEm,
    ).not.toBeNull();
  });

  it('a printed pedido with a request ⇒ cancelado + aceitar-cancelamento; Amazon’s CANCELLED then resolves it', async () => {
    const ex = montar();
    await ex.importar(pedido({ status: 'UNSHIPPED', extra: comprador() }));
    ex.h.db.seed(CAMINHO, { ...(ex.h.db.ler(CAMINHO) ?? {}), foiImpresso: true });
    await ex.importar(
      pedido({
        status: 'UNSHIPPED',
        atualizadoEm: depois(60),
        linhas: [linhaAmazon('L1', { qtd: 2, preco: '10.00', solicitacao: true })],
        extra: comprador(),
      }),
    );
    expect(ex.h.db.ler(CAMINHO)?.estado).toBe('cancelado');
    expect(avisoPedido(ex, MOTIVO_PEDIDO_AMAZON.aceitarCancelamento)?.resolvidoEm).toBeNull();
    await ex.importar(
      pedido({ status: 'CANCELLED', atualizadoEm: depois(120), extra: comprador() }),
    );
    expect(avisoPedido(ex, MOTIVO_PEDIDO_AMAZON.aceitarCancelamento)?.resolvidoEm).not.toBeNull();
  });

  it('cancelado-so-no-erp: raised on an ERP-side cancel Amazon still has to ship; RESOLVED by Amazon SHIPPED (the 2026-10-22 answer: "No" to keeping it)', async () => {
    const ex = montar();
    await ex.importar(pedido({ status: 'UNSHIPPED', extra: comprador() }));
    ex.h.db.seed(CAMINHO, { ...(ex.h.db.ler(CAMINHO) ?? {}), estado: 'cancelado' });
    await ex.importar(
      pedido({ status: 'UNSHIPPED', atualizadoEm: depois(60), extra: comprador() }),
    );
    expect(avisoPedido(ex, MOTIVO_PEDIDO_AMAZON.canceladoSoNoErp)?.resolvidoEm).toBeNull();
    // NEAR-MISS: a PENDING read leaves it as it is.
    await ex.importar(pedido({ status: 'PENDING', atualizadoEm: depois(90), extra: comprador() }));
    expect(avisoPedido(ex, MOTIVO_PEDIDO_AMAZON.canceladoSoNoErp)?.resolvidoEm).toBeNull();
    await ex.importar(pedido({ status: 'SHIPPED', atualizadoEm: depois(120), extra: comprador() }));
    expect(avisoPedido(ex, MOTIVO_PEDIDO_AMAZON.canceladoSoNoErp)?.resolvidoEm).not.toBeNull();
    expect(ex.h.db.ler(CAMINHO)?.estado).toBe('cancelado');
  });

  it('★ cancelado-so-no-erp is resolved from the WINNING snapshot: the pedido reopened between the read and the batch ⇒ the row closes', async () => {
    const ex = montar();
    await ex.importar(pedido({ status: 'UNSHIPPED', extra: comprador() }));
    ex.h.db.seed(CAMINHO, { ...(ex.h.db.ler(CAMINHO) ?? {}), estado: 'cancelado' });
    await ex.importar(
      pedido({ status: 'UNSHIPPED', atualizadoEm: depois(60), extra: comprador() }),
    );
    expect(avisoPedido(ex, MOTIVO_PEDIDO_AMAZON.canceladoSoNoErp)?.resolvidoEm).toBeNull();
    // An operator reopens the pedido right before the next import's batch lands.
    ex.h.db.antesDaProximaEscrita(CAMINHO, () => {
      ex.h.db.seed(CAMINHO, { ...(ex.h.db.ler(CAMINHO) ?? {}), estado: 'pago' });
    });
    const r = await ex.importar(
      pedido({ status: 'UNSHIPPED', atualizadoEm: depois(120), extra: comprador() }),
    );
    expect(r.kind).toBe('importado');
    expect(ex.h.db.ler(CAMINHO)?.estado).toBe('pago');
    // NEAR-MISS: the first read's estado (`cancelado`, still to ship) keeps the row open.
    expect(avisoPedido(ex, MOTIVO_PEDIDO_AMAZON.canceladoSoNoErp)?.resolvidoEm).not.toBeNull();
  });

  it('★ a sem-mudanca after a lost precondition is clocked by the WINNING read, later than the concurrent commit', async () => {
    const ex = montar();
    await ex.importar(pedido({ status: 'UNSHIPPED', extra: comprador() }));
    // Another importer of the SAME order clock, whose read still shows the buyer's
    // request, commits right before this batch and raises cancelamento-solicitado.
    ex.h.db.antesDaProximaEscrita(CAMINHO, async () => {
      const outro = await ex.importar(
        pedido({
          status: 'UNSHIPPED',
          atualizadoEm: depois(60),
          linhas: [linhaAmazon('L1', { qtd: 2, preco: '10.00', solicitacao: true })],
          extra: comprador(),
        }),
      );
      expect(outro.kind).toBe('importado');
      expect(avisoPedido(ex, MOTIVO_PEDIDO_AMAZON.cancelamentoSolicitado)?.resolvidoEm).toBeNull();
    });
    const r = await ex.importar(
      pedido({ status: 'UNSHIPPED', atualizadoEm: depois(60), extra: comprador() }),
    );
    expect(r.kind).toBe('sem-mudanca');
    // NEAR-MISS: clocked by the first read (before that commit), the resolve is dropped.
    expect(
      avisoPedido(ex, MOTIVO_PEDIDO_AMAZON.cancelamentoSolicitado)?.resolvidoEm,
    ).not.toBeNull();
  });

  it('per conta: conta-sem-operacao raised by the uncached conta read, clocked by its read time; resolved once the conta has one', async () => {
    const ex = montar();
    await ex.importar(pedido({ status: 'PENDING' }));
    const chave = caminhoAviso(
      chaveContaPrecisaAtencao(CONTA_IMPORTADOR, MOTIVO_CONTA_AMAZON.contaSemOperacao),
    );
    expect(ex.h.db.ler(chave)?.resolvidoEm).toBeNull();
    // The conta was read BEFORE the batch: its clock is older than the commit's.
    const commit = ex.h.db.escritasEm(CAMINHO)[0]?.writeTime;
    expect(commit).toBeDefined();
    expect(ex.h.db.ler(chave)?.relogioEvento).toBeLessThan(relogioDoDocumentoUs(commit!));
    conta(ex, { operacaoOuterRef: 'documents/operacao/op-1' });
    await ex.importar(pedido({ status: 'PENDING', atualizadoEm: depois(60) }));
    expect(ex.h.db.ler(chave)?.resolvidoEm).not.toBeNull();
  });

  it('★ an import whose conta read PREDATES the operator’s fix cannot reopen conta-sem-operacao once a later import resolved it', async () => {
    const ex = montar();
    const chave = caminhoAviso(
      chaveContaPrecisaAtencao(CONTA_IMPORTADOR, MOTIVO_CONTA_AMAZON.contaSemOperacao),
    );
    await ex.importar(pedido({ status: 'PENDING' }));
    expect(ex.h.db.ler(chave)?.resolvidoEm).toBeNull();
    // Import X reads the conta (no operação yet). Right before its batch lands, the
    // operator sets the operação and import Y, of ANOTHER order, resolves the row.
    const outroOrderId = '171-1111111-2222222';
    ex.h.db.antesDaProximaEscrita(CAMINHO, async () => {
      conta(ex, { operacaoOuterRef: 'documents/operacao/op-1' });
      const y = await ex.importar(
        { ...pedido({ status: 'PENDING' }), orderId: outroOrderId },
        { payload: payloadPush(outroOrderId) },
      );
      expect(y.kind).toBe('importado');
      expect(ex.h.db.ler(chave)?.resolvidoEm).not.toBeNull();
    });
    const x = await ex.importar(pedido({ status: 'PENDING', atualizadoEm: depois(60) }));
    expect(x.kind).toBe('importado');
    // X committed AFTER Y; its raise carries X's OLDER conta read time and is dropped.
    // NEAR-MISS: clocked by X's commit, it would reopen the row.
    expect(ex.h.db.ler(chave)?.resolvidoEm).not.toBeNull();
  });

  it('incidentes and avisos come AFTER the commit: a batch that fails writes neither', async () => {
    // An order that derives BOTH: a zero quantity (incidente `valor-zerado`) and no
    // logistics (aviso `logistica-desconhecida`); the conta has its operação.
    const order = pedido({
      status: 'UNSHIPPED',
      por: null,
      linhas: [linhaAmazon('L1', { qtd: 0, preco: '10.00' })],
    });
    // The conta has NO operação: the per-conta row would be raised too.
    const controle = montar();
    await controle.importar(order);
    expect(incidente(controle, 'amz-valor-zerado')).toBeDefined();
    expect(avisoPedido(controle, MOTIVO_PEDIDO_AMAZON.logisticaDesconhecida)).toBeDefined();
    expect(
      controle.h.db.ler(
        caminhoAviso(
          chaveContaPrecisaAtencao(CONTA_IMPORTADOR, MOTIVO_CONTA_AMAZON.contaSemOperacao),
        ),
      ),
    ).toBeDefined();

    const ex = montar();
    const falha = Object.assign(new Error('UNAVAILABLE'), { code: 14 });
    ex.h.db.falharEscrita(CAMINHO, falha);
    await expect(ex.importar(order)).rejects.toBe(falha);
    expect(ex.h.db.escritas.filter((e) => e.caminho.startsWith('avisos/'))).toEqual([]);
    expect(ex.h.db.escritas.filter((e) => e.caminho.includes('/incidentes/'))).toEqual([]);
  });
});

/* -------------------------------- the pure pieces -------------------------------- */

describe('motivosDoPedidoAmazon — the resolvers (decision 26 as amended)', () => {
  const base = { avisos: [], motivoEstado: null } as const;

  it('a derived motivo is raised, never resolved; every other importer motivo is resolved', () => {
    const r = motivosDoPedidoAmazon({
      decisao: { ...base, avisos: ['status-desconhecido'] },
      fase: 'desconhecida',
      estadoFinal: ESTADO_PEDIDO.pago,
    });
    expect(r.levantar).toEqual(['status-desconhecido']);
    expect(r.resolver).not.toContain('status-desconhecido');
    expect(r.resolver).toEqual(
      expect.arrayContaining([
        'logistica-desconhecida',
        'cancelamento-solicitado',
        'aceitar-cancelamento',
      ]),
    );
    // PR 7's motivos are never touched here.
    expect(r.resolver).not.toContain('pacote-status-desconhecido');
    expect(r.resolver).not.toContain('coleta-cancelada');
  });

  it('divergencia-itens is NOT resolved while the import kept the stored estado (the block stands)', () => {
    expect(
      motivosDoPedidoAmazon({
        decisao: { ...base, motivoEstado: 'manter' },
        fase: 'apr',
        estadoFinal: ESTADO_PEDIDO.error,
      }).resolver,
    ).not.toContain('divergencia-itens');
    expect(
      motivosDoPedidoAmazon({
        decisao: { ...base, motivoEstado: 'sem-mudanca' },
        fase: 'apr',
        estadoFinal: ESTADO_PEDIDO.pago,
      }).resolver,
    ).toContain('divergencia-itens');
  });

  it.each<[string, Parameters<typeof motivosDoPedidoAmazon>[0], boolean]>([
    [
      'Amazon CANCELLED',
      { decisao: base, fase: 'cancelado', estadoFinal: ESTADO_PEDIDO.cancelado },
      true,
    ],
    ['Amazon SHIPPED', { decisao: base, fase: 'env', estadoFinal: ESTADO_PEDIDO.cancelado }, true],
    [
      'the pedido no longer terminal',
      { decisao: base, fase: 'apr', estadoFinal: ESTADO_PEDIDO.pago },
      true,
    ],
    [
      'still to ship, still cancelled',
      { decisao: base, fase: 'apr', estadoFinal: ESTADO_PEDIDO.cancelado },
      false,
    ],
    [
      'PENDING, still cancelled',
      { decisao: base, fase: 'pre', estadoFinal: ESTADO_PEDIDO.estornadoIntegralmente },
      false,
    ],
    [
      'an unknown status, still cancelled',
      { decisao: base, fase: 'desconhecida', estadoFinal: ESTADO_PEDIDO.cancelado },
      false,
    ],
  ])('cancelado-so-no-erp — %s ⇒ resolved: %s', (_c, entrada, resolve) => {
    expect(motivosDoPedidoAmazon(entrada).resolver.includes('cancelado-so-no-erp')).toBe(resolve);
  });
});

describe('motivosDaContaAmazon', () => {
  it('conta-sem-operacao by the conta; intermediador-divergente by the verdict, untouched without one', () => {
    expect(motivosDaContaAmazon(null, 'diverge')).toEqual({
      levantar: ['conta-sem-operacao', 'intermediador-divergente'],
      resolver: [],
    });
    expect(motivosDaContaAmazon('documents/operacao/op', 'confere')).toEqual({
      levantar: [],
      resolver: ['conta-sem-operacao', 'intermediador-divergente'],
    });
    expect(motivosDaContaAmazon('documents/operacao/op', 'sem-veredito')).toEqual({
      levantar: [],
      resolver: ['conta-sem-operacao'],
    });
  });
});

describe('parClienteEnderecoAmazon — never a cliente beside another cliente’s endereço', () => {
  const resolvido = { clienteRef: CLIENTE, enderecoRef: ENDERECO };

  it('nothing stored ⇒ both filled; a stored cliente ⇒ only an endereço under IT', () => {
    expect(parClienteEnderecoAmazon(null, resolvido)).toEqual({
      cliente: CLIENTE,
      endereco: ENDERECO,
    });
    expect(
      parClienteEnderecoAmazon({ clientePedidoOuterRef: 'documents/clientes/outro' }, resolvido),
    ).toEqual({ cliente: null, endereco: null });
    expect(
      parClienteEnderecoAmazon(
        { clientePedidoOuterRef: 'documents/clientes/outro' },
        { clienteRef: CLIENTE, enderecoRef: 'documents/clientes/outro/enderecos/e' },
      ),
    ).toEqual({ cliente: null, endereco: 'documents/clientes/outro/enderecos/e' });
  });

  it('a stored freight endereço of another cliente ⇒ no cliente filled; of the same ⇒ filled', () => {
    expect(
      parClienteEnderecoAmazon(
        { freteInicial: { enderecoFreteOuterReference: 'documents/clientes/outro/enderecos/e' } },
        resolvido,
      ),
    ).toEqual({ cliente: null, endereco: null });
    expect(
      parClienteEnderecoAmazon(
        { freteInicial: { enderecoFreteOuterReference: 'documents/clientes/cli-1/enderecos/e' } },
        resolvido,
      ),
    ).toEqual({ cliente: CLIENTE, endereco: null });
  });

  it('the bare stored form of a ref pairs with the canonical one', () => {
    expect(clienteDoEnderecoAmazon('clientes/cli-1/enderecos/end-1')).toBe(CLIENTE);
    expect(clienteDoEnderecoAmazon('pedidos/x/enderecos/y')).toBeNull();
    expect(
      parClienteEnderecoAmazon({ clientePedidoOuterRef: 'clientes/cli-1' }, resolvido),
    ).toEqual({ cliente: null, endereco: ENDERECO });
  });
});
