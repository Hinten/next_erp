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
  EFEITO_ESTOQUE_NENHUM,
  ESTADO_PEDIDO,
  MODALIDADE_FRETE,
  MOTIVO_CONTA_AMAZON,
  MOTIVO_PEDIDO_AMAZON,
  ORIGEM_INCIDENTE,
  STATUS_PAGAMENTO,
  TIPO_AVISO,
  TIPO_INCIDENTE,
  efeitoEstoquePedido,
  estadoFreteSchema,
  estadoPedidoSchema,
  motivoPedidoAmazonSchema,
} from '@delfrance/schemas';

import { enfileirarAgendamentoDoAceiteAmazon } from '../agendamento/entradasAgendamento';
import {
  ORIGEM_AGENDAMENTO_AMAZON,
  idDaTarefaDeAgendamentoAmazon,
} from '../agendamento/tarefaAgendamento';
import {
  chaveContaPrecisaAtencao,
  chavePedidoPrecisaAtencao,
  relogioDoDocumentoUs,
  sincronizarAvisosDoPedidoAmazon,
} from '../avisos/avisos';
import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import { AmazonTarefasTransitoriasError } from '../core/filaTarefas';
import { avisarNfeAmazon, chaveAvisoNfeAmazon } from '../nfe/avisoNfe';
import { carimbarFreteNfeAmazon } from '../nfe/carimboFreteNfe';
import type { DepsImportadorAmazon } from '../notificacoes/notificacao';
import { gerarCnpj, gerarCpf } from '../testing/documentos';
import { asDb, grpc, increment } from '../testing/fakeDb';
import { falhaDoFunctions } from '../testing/falhaDeEnfileiramento';
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
  brl,
  depois,
  execucaoAmazon,
  linhaAmazon,
  pacoteAmazon,
  pedidoAmazon,
  type OpcoesPedidoTeste,
} from '../testing/pedidoWireAmazon';
import {
  AmazonCancelamentoRecenteError,
  AmazonLeituraDefasadaError,
  AmazonPedidoEmConflitoError,
  PedidoAmazonIlegivelError,
} from './erros';
import { TEXTO_ERRO_AMAZON } from './estadoPedidoAmazon';
import {
  JANELA_CANCELAMENTO_RECENTE_AMAZON_US,
  MOTIVOS_AGENDAMENTO_PEDIDO_AMAZON,
  MOTIVOS_PEDIDO_DO_IMPORTADOR_AMAZON,
  clienteDoEnderecoAmazon,
  condicoesNfeDoPedidoAmazon,
  importarPedidoAmazon,
  motivosDaContaAmazon,
  motivosDoPedidoAmazon,
  parClienteEnderecoAmazon,
  transicoesNfeDoPedidoAmazon,
} from './importarPedido';
import { ID_INCIDENTE_NFE_PEDIDO_CANCELADO_AMAZON } from './incidentesPedidoAmazon';
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
  /** The CEP lookup the next `deps()` hands in: a null-answering fake unless a test swaps it. */
  viaCep: DepsImportadorAmazon['viaCep'];
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
    viaCep: { buscarCep: () => Promise.resolve(null) },
    deps: (registro = registroTeste(0)) => ({
      agora: () => {
        ex.agoras += 1;
        return AGORA_MS;
      },
      increment,
      logger: h.log.logger,
      viaCep: ex.viaCep,
      agendamento: h.agendamentos.produtor,
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

  it('★ an unknown UF is recovered through deps.viaCep — the INJECTED lookup, once, with the order’s CEP — and the endereço stores the recovered estado', async () => {
    const ex = montar();
    const consultas: string[] = [];
    ex.viaCep = {
      buscarCep: (cep) => {
        consultas.push(cep);
        return Promise.resolve({
          logradouro: 'Rua Ficticia',
          bairro: 'Centro',
          cidade: 'Cidade Ficticia',
          estado: 'MG',
          codigoMunicipio: '0000000',
        });
      },
    };
    const extra = comprador();
    const recipient = extra.recipient as { deliveryAddress: Record<string, unknown> };
    recipient.deliveryAddress.stateOrRegion = 'Estado Inexistente';
    const r = await ex.importar(pedido({ status: 'UNSHIPPED', extra }));
    expect(r.kind).toBe('importado');
    expect(consultas).toEqual(['01000000']);
    expect(m.ensureEndereco).toHaveBeenCalledTimes(1);
    expect(m.ensureEndereco.mock.calls[0]?.[2]).toMatchObject({ estado: 'MG', cep: '01000000' });
    // Recovered, so no `uf-nao-resolvida` line.
    expect(linhasPedido(ex).map((l) => l.codigo)).not.toContain('uf-nao-resolvida');
  });

  it('NEAR-MISS: a MAPPED UF never calls the lookup; a lookup that answers nothing keeps the AC fallback and logs uf-nao-resolvida', async () => {
    const ex = montar();
    const consultas: string[] = [];
    ex.viaCep = {
      buscarCep: (cep) => {
        consultas.push(cep);
        return Promise.resolve(null);
      },
    };
    await ex.importar(pedido({ status: 'UNSHIPPED', extra: comprador() }));
    expect(consultas).toEqual([]);
    expect(m.ensureEndereco.mock.calls[0]?.[2]).toMatchObject({ estado: 'SP' });

    const outra = montar();
    outra.viaCep = ex.viaCep;
    const extra = comprador();
    const recipient = extra.recipient as { deliveryAddress: Record<string, unknown> };
    recipient.deliveryAddress.stateOrRegion = 'Estado Inexistente';
    await outra.importar(pedido({ status: 'UNSHIPPED', extra }));
    expect(consultas).toEqual(['01000000']);
    expect(m.ensureEndereco.mock.calls[1]?.[2]).toMatchObject({ estado: 'AC' });
    expect(linhasPedido(outra).map((l) => l.codigo)).toContain('uf-nao-resolvida');
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

  it('★ PR 5-f: an INVOICE_UNCONFIRMED read between the block and the next UNSHIPPED read keeps the pedido BLOCKED (row 10 again, never row 9’s mirror); divergencia-itens stays open', async () => {
    const ex = montar();
    await ex.importar(pedido({ status: 'UNSHIPPED', extra: comprador() }));
    const antes = ex.h.db.ler(CAMINHO) ?? {};
    const divergentes = [linhaAmazon('L1', { qtd: 3, preco: '10.00' })];
    await ex.importar(
      pedido({
        status: 'UNSHIPPED',
        atualizadoEm: depois(60),
        linhas: divergentes,
        extra: comprador(),
      }),
    );
    const bloqueado = ex.h.db.ler(CAMINHO) ?? {};
    expect(bloqueado.estado).toBe('error');
    await ex.importar(
      pedido({
        status: 'INVOICE_UNCONFIRMED',
        atualizadoEm: depois(120),
        linhas: divergentes,
        extra: comprador(),
      }),
    );
    expect(ex.h.db.ler(CAMINHO)).toMatchObject({ estado: 'error', error: bloqueado.error });
    expect(avisoPedido(ex, MOTIVO_PEDIDO_AMAZON.statusDesconhecido)?.resolvidoEm).toBeNull();
    const r = await ex.importar(
      pedido({
        status: 'UNSHIPPED',
        atualizadoEm: depois(180),
        linhas: divergentes,
        extra: comprador(),
      }),
    );
    expect(r).toEqual({
      kind: 'importado',
      detalhe: expect.objectContaining({
        itens: 'divergencia-itens-aprovado',
        linhasDivergentes: 1,
      }),
    });
    const doc = ex.h.db.ler(CAMINHO) ?? {};
    expect(doc).toMatchObject({
      estado: 'error',
      error: bloqueado.error,
      valorCobrado: antes.valorCobrado,
      marketplace: { status: 'UNSHIPPED' },
    });
    expect(doc.itens).toEqual(antes.itens);
    expect(avisoPedido(ex, MOTIVO_PEDIDO_AMAZON.divergenciaItens)?.resolvidoEm).toBeNull();
    // The known status resolves the read's own motivo.
    expect(avisoPedido(ex, MOTIVO_PEDIDO_AMAZON.statusDesconhecido)?.resolvidoEm).not.toBeNull();
  });

  it('★ NEAR-MISS (decision 5 unchanged): a pedido CREATED at an unknown status was never approved — its first UNSHIPPED read mirrors the lines and clears our error', async () => {
    const ex = montar();
    await ex.importar(pedido({ status: 'INVOICE_UNCONFIRMED', extra: comprador() }));
    expect(ex.h.db.ler(CAMINHO)).toMatchObject({
      estado: 'error',
      marketplace: { status: 'INVOICE_UNCONFIRMED' },
    });
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
      detalhe: expect.objectContaining({ itens: 'espelhadas' }),
    });
    expect(ex.h.db.ler(CAMINHO)).toMatchObject({
      estado: 'pago',
      error: null,
      valorCobrado: 30,
      marketplace: { status: 'UNSHIPPED' },
    });
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

  it('a printed pedido with a request ⇒ the predicate’s target (its pagamento aprovado ⇒ estornadoIntegralmente, the pagamento estornado with it, PR 6) + aceitar-cancelamento; Amazon’s CANCELLED then resolves it', async () => {
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
    expect(ex.h.db.ler(CAMINHO)?.estado).toBe('estornadoIntegralmente');
    expect(ex.h.db.ler(`${CAMINHO}/pagamentos/${PEDIDO_ID}`)?.status_pagamento).toBe(8);
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
  const base = { avisos: [], motivoEstado: null, itensConferem: true } as const;

  it('a derived motivo is raised, never resolved; every other importer motivo is resolved', () => {
    const r = motivosDoPedidoAmazon({
      decisao: { ...base, avisos: ['status-desconhecido'] },
      fase: 'desconhecida',
      estadoFinal: ESTADO_PEDIDO.pago,
      agendamentoEncerrado: false,
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
    // PR 7: the two freight motivos join the list — resolved when not derived.
    expect(r.resolver).toEqual(
      expect.arrayContaining(['pacote-status-desconhecido', 'coleta-cancelada']),
    );
  });

  it('★ PR 7: a derived freight motivo is RAISED and never resolved, while its condition holds (each one alone, and both)', () => {
    for (const avisos of [
      ['pacote-status-desconhecido'],
      ['coleta-cancelada'],
      ['coleta-cancelada', 'pacote-status-desconhecido'],
    ] as const) {
      for (const fase of ['apr', 'env', 'desconhecida', 'pre'] as const) {
        const r = motivosDoPedidoAmazon({
          decisao: { ...base, avisos },
          fase,
          estadoFinal: ESTADO_PEDIDO.pago,
          agendamentoEncerrado: false,
        });
        expect(r.levantar, `${avisos.join('+')} ${fase}`).toEqual(avisos);
        for (const m of avisos) expect(r.resolver, `${m} ${fase}`).not.toContain(m);
      }
    }
    // The list holds all TEN motivos of the tipo (none left to a later PR): the two
    // Easy Ship scheduling motivos joined it in step 15 (PR 15-b), with the enum.
    expect([...MOTIVOS_PEDIDO_DO_IMPORTADOR_AMAZON].sort()).toEqual(
      [...motivoPedidoAmazonSchema.options].sort(),
    );
  });

  it('divergencia-itens is NOT resolved while the import kept the stored estado (the block stands)', () => {
    expect(
      motivosDoPedidoAmazon({
        decisao: { ...base, motivoEstado: 'manter' },
        fase: 'apr',
        estadoFinal: ESTADO_PEDIDO.error,
        agendamentoEncerrado: false,
      }).resolver,
    ).not.toContain('divergencia-itens');
    expect(
      motivosDoPedidoAmazon({
        decisao: { ...base, motivoEstado: 'sem-mudanca' },
        fase: 'apr',
        estadoFinal: ESTADO_PEDIDO.pago,
        agendamentoEncerrado: false,
      }).resolver,
    ).toContain('divergencia-itens');
  });

  it('★ PR 5-f: divergencia-itens resolves ONLY when the lines agree (or are congelado) — an estado the import WROTE, a sem-mudanca and every phase resolve nothing without it; NEAR-MISS: the same with the lines agreeing resolves', () => {
    for (const motivoEstado of [null, 'sem-mudanca', 'regressivo', 'terminal'] as const) {
      for (const fase of ['apr', 'env', 'cancelado', 'pre', 'desconhecida'] as const) {
        for (const estadoFinal of [ESTADO_PEDIDO.pago, ESTADO_PEDIDO.cancelado, null]) {
          const rotulo = `${String(motivoEstado)} ${fase} ${String(estadoFinal)}`;
          const semConferir = motivosDoPedidoAmazon({
            decisao: { ...base, motivoEstado, itensConferem: false },
            fase,
            estadoFinal,
            agendamentoEncerrado: false,
          });
          expect(semConferir.resolver, rotulo).not.toContain('divergencia-itens');
          // Never raised by the resolver either: only the decision raises it.
          expect(semConferir.levantar, rotulo).toEqual([]);
          const conferindo = motivosDoPedidoAmazon({
            decisao: { ...base, motivoEstado, itensConferem: true },
            fase,
            estadoFinal,
            agendamentoEncerrado: false,
          });
          expect(conferindo.resolver, rotulo).toContain('divergencia-itens');
        }
      }
    }
    // The other motivos are not touched by the lines' verdict.
    const r = motivosDoPedidoAmazon({
      decisao: { ...base, itensConferem: false },
      fase: 'env',
      estadoFinal: ESTADO_PEDIDO.pago,
      // SHIPPED: scheduling has ended, so the two scheduling motivos resolve too.
      agendamentoEncerrado: true,
    });
    expect(r.resolver).toEqual(
      MOTIVOS_PEDIDO_DO_IMPORTADOR_AMAZON.filter((m) => m !== 'divergencia-itens'),
    );
  });

  it.each<[string, Parameters<typeof motivosDoPedidoAmazon>[0], boolean]>([
    [
      'Amazon CANCELLED',
      {
        decisao: base,
        fase: 'cancelado',
        estadoFinal: ESTADO_PEDIDO.cancelado,
        agendamentoEncerrado: true,
      },
      true,
    ],
    [
      'Amazon SHIPPED',
      {
        decisao: base,
        fase: 'env',
        estadoFinal: ESTADO_PEDIDO.cancelado,
        agendamentoEncerrado: true,
      },
      true,
    ],
    [
      'the pedido no longer terminal',
      { decisao: base, fase: 'apr', estadoFinal: ESTADO_PEDIDO.pago, agendamentoEncerrado: false },
      true,
    ],
    [
      'still to ship, still cancelled',
      {
        decisao: base,
        fase: 'apr',
        estadoFinal: ESTADO_PEDIDO.cancelado,
        agendamentoEncerrado: false,
      },
      false,
    ],
    [
      'PENDING, still cancelled',
      {
        decisao: base,
        fase: 'pre',
        estadoFinal: ESTADO_PEDIDO.estornadoIntegralmente,
        agendamentoEncerrado: false,
      },
      false,
    ],
    [
      'an unknown status, still cancelled',
      {
        decisao: base,
        fase: 'desconhecida',
        estadoFinal: ESTADO_PEDIDO.cancelado,
        agendamentoEncerrado: false,
      },
      false,
    ],
  ])('cancelado-so-no-erp — %s ⇒ resolved: %s', (_c, entrada, resolve) => {
    expect(motivosDoPedidoAmazon(entrada).resolver.includes('cancelado-so-no-erp')).toBe(resolve);
  });

  it('★ step 15: the two scheduling motivos resolve ONLY when scheduling has ended — whatever the phase, the estado or the lines; NEAR-MISS: not ended ⇒ neither is resolved (no getAll key)', () => {
    const agendamento = ['dimensoes-ausentes', 'agendamento-recusado'] as const;
    expect([...MOTIVOS_AGENDAMENTO_PEDIDO_AMAZON].sort()).toEqual([...agendamento].sort());
    for (const fase of ['apr', 'env', 'cancelado', 'pre', 'desconhecida'] as const) {
      for (const estadoFinal of [ESTADO_PEDIDO.pago, ESTADO_PEDIDO.cancelado, null]) {
        for (const itensConferem of [true, false]) {
          const rotulo = `${fase} ${String(estadoFinal)} ${String(itensConferem)}`;
          const entrada = { decisao: { ...base, itensConferem }, fase, estadoFinal };
          const encerrado = motivosDoPedidoAmazon({ ...entrada, agendamentoEncerrado: true });
          const aberto = motivosDoPedidoAmazon({ ...entrada, agendamentoEncerrado: false });
          for (const m of agendamento) {
            expect(encerrado.resolver, `${m} ${rotulo}`).toContain(m);
            expect(aberto.resolver, `${m} ${rotulo}`).not.toContain(m);
            expect(encerrado.levantar, `${m} ${rotulo}`).not.toContain(m);
            expect(aberto.levantar, `${m} ${rotulo}`).not.toContain(m);
          }
          // Every other motivo's verdict ignores the flag.
          expect(aberto.resolver, rotulo).toEqual(
            encerrado.resolver.filter((m) => !MOTIVOS_AGENDAMENTO_PEDIDO_AMAZON.has(m)),
          );
        }
      }
    }
  });

  it('★ step 15: an import NEVER raises a scheduling motivo — even a decision that listed one (the task is their one producer)', () => {
    for (const agendamentoEncerrado of [true, false]) {
      const r = motivosDoPedidoAmazon({
        decisao: {
          ...base,
          avisos: ['dimensoes-ausentes', 'agendamento-recusado', 'status-desconhecido'],
        },
        fase: 'apr',
        estadoFinal: ESTADO_PEDIDO.pago,
        agendamentoEncerrado,
      });
      // NEAR-MISS: the other derived motivo still rises.
      expect(r.levantar).toEqual(['status-desconhecido']);
    }
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

/* ------------------------------------ PR 6 ------------------------------------ */

describe('★ PR 6 — the pagamento rides the import', () => {
  const PAGAMENTO = `${CAMINHO}/pagamentos/${PEDIDO_ID}`;

  it('an approved import creates the pagamento in the SAME batch as the pedido; a PENDING one creates none', async () => {
    const pendente = montar();
    await pendente.importar(pedido({ status: 'PENDING' }));
    expect(pendente.h.db.ler(PAGAMENTO)).toBeUndefined();
    const ex = montar();
    await ex.importar(pedido({ status: 'UNSHIPPED', extra: comprador() }));
    const lote = ex.h.db.escritas.filter((e) => e.lote !== undefined);
    expect(lote.map((e) => [e.verbo, e.caminho, e.lote])).toEqual([
      ['create', CAMINHO, 1],
      ['create', PAGAMENTO, 1],
    ]);
    expect(ex.h.db.ler(PAGAMENTO)).toMatchObject({
      id: ORDER_ID_TESTE,
      status_pagamento: 4,
      forma_de_pagamento: 3,
      valor: 20,
    });
  });

  it('★ the payment incidentes are filed after the commit; a refused acquirer is ONE count line with no value', async () => {
    const ex = montar();
    const recusado = '12.345.678';
    await ex.importar(
      pedido({
        status: 'UNSHIPPED',
        extra: comprador(),
        pagamento: [
          execucaoAmazon('Rewards', '15.00', { acquirerId: recusado }),
          execucaoAmazon('CreditCard', '5.00', { acquirerId: recusado }),
        ],
      }),
    );
    expect(incidente(ex, 'amz-forma-pagamento-desconhecida')).toMatchObject({
      subtipo: 'forma-pagamento-desconhecida',
    });
    expect(incidente(ex, 'amz-pagamento-dividido')).toMatchObject({
      subtipo: 'pagamento-dividido',
    });
    // The 99 leg is the larger one: no card block, so no CNPJ was even evaluated.
    expect(linhasPedido(ex).filter((l) => l.codigo === 'cnpj-instituicao-recusado')).toEqual([]);
    const cartao = montar();
    await cartao.importar(
      pedido({
        status: 'UNSHIPPED',
        extra: comprador(),
        pagamento: [execucaoAmazon('CreditCard', '20.00', { acquirerId: recusado })],
      }),
    );
    const linhas = linhasPedido(cartao).filter((l) => l.codigo === 'cnpj-instituicao-recusado');
    expect(linhas).toHaveLength(1);
    expect(JSON.stringify(cartao.h.log.linhas)).not.toContain(recusado);
    expect(JSON.stringify(cartao.h.log.linhas)).not.toContain('12345678');
  });

  it('★ the aviso clock is the commit’s LATEST writeTime: a carrier-first batch (pedido unchanged, its pagamento re-created) re-clocks the row past the previous import’s', async () => {
    const ex = montar();
    const comR = pedido({
      status: 'UNSHIPPED',
      extra: comprador(),
      linhas: [linhaAmazon('L1', { qtd: 2, preco: '10.00', solicitacao: true })],
    });
    await ex.importar(comR);
    const antes = avisoPedido(ex, MOTIVO_PEDIDO_AMAZON.cancelamentoSolicitado);
    expect(antes?.resolvidoEm).toBeNull();
    expect(antes?.relogioEvento).toBe(relogioDoDocumentoUs(ex.h.db.carimboDe(CAMINHO) as never));
    // The pagamento disappears; the same order again re-creates it beside a pedido carrier.
    ex.h.db.apagar(PAGAMENTO);
    const carimboPedido = ex.h.db.carimboDe(CAMINHO);
    const r = await ex.importar(comR);
    expect(r).toMatchObject({ kind: 'importado' });
    const lote = ex.h.db.escritas.filter((e) => e.lote === 2);
    expect(lote.map((e) => [e.verbo, e.caminho])).toEqual([
      ['update', CAMINHO],
      ['create', PAGAMENTO],
    ]);
    // The carrier moved nothing: the pedido kept its stamp.
    expect(ex.h.db.carimboDe(CAMINHO)?.isEqual(carimboPedido)).toBe(true);
    const depoisDaCarga = avisoPedido(ex, MOTIVO_PEDIDO_AMAZON.cancelamentoSolicitado);
    // `results[0]` would have repeated the first import's clock (an EQUAL one, dropped).
    expect(depoisDaCarga?.relogioEvento).toBe(
      relogioDoDocumentoUs(ex.h.db.carimboDe(PAGAMENTO) as never),
    );
    expect(depoisDaCarga?.relogioEvento).toBeGreaterThan(antes?.relogioEvento as number);
  });
});

/* --------------------------- PR 7: the freight, end to end --------------------------- */

describe('★ PR 7 — Easy Ship packages through the import', () => {
  /** The approved buyer, with the order's invoice status beside the BUYER registration. */
  function comNota(invoiceStatus: string): Record<string, unknown> {
    const c = comprador();
    return {
      ...c,
      tax: { ...(c.tax as Record<string, unknown>), taxInvoicing: { invoiceStatus } },
    };
  }
  const frete = (ex: Execucao) => ex.h.db.ler(CAMINHO)?.freteInicial as Record<string, unknown>;

  it('LABEL_CANCELLED ⇒ freight despachoNegado + the coleta-cancelada aviso; the reschedule at an EQUAL clock RESOLVES the aviso while the ladder keeps the failure', async () => {
    const ex = montar();
    const extra = comNota('ACCEPTED');
    await ex.importar(
      pedido({
        status: 'UNSHIPPED',
        extra,
        pacotesBrutos: [pacoteAmazon('PKG-1', 'LABEL_CANCELLED')],
      }),
    );
    expect(frete(ex).estado).toBe('despachoNegado');
    expect(avisoPedido(ex, MOTIVO_PEDIDO_AMAZON.coletaCancelada)).toMatchObject({
      resolvidoEm: null,
      severidade: 'atencao',
    });
    await ex.importar(
      pedido({
        status: 'UNSHIPPED',
        extra,
        pacotesBrutos: [pacoteAmazon('PKG-1', 'PENDING_PICK_UP')],
      }),
    );
    expect(avisoPedido(ex, MOTIVO_PEDIDO_AMAZON.coletaCancelada)?.resolvidoEm).not.toBeNull();
    // An equal clock never resurrects: the stored failure stands until a newer read.
    expect(frete(ex).estado).toBe('despachoNegado');
    await ex.importar(
      pedido({
        status: 'UNSHIPPED',
        atualizadoEm: depois(60),
        extra,
        pacotesBrutos: [pacoteAmazon('PKG-1', 'PENDING_PICK_UP')],
      }),
    );
    expect(frete(ex).estado).toBe('aguardandoPostagem');
    expect(linhasPedido(ex).map((l) => l.codigo)).toContain('frete-ressuscitado');
  });

  it('★ NEAR-MISS: coleta-cancelada stays OPEN while a package is still LABEL_CANCELLED (another package moving does not resolve it); the order CANCELLED resolves it', async () => {
    const ex = montar();
    const extra = comNota('ACCEPTED');
    const cancelada = pacoteAmazon('PKG-1', 'LABEL_CANCELLED');
    await ex.importar(pedido({ status: 'UNSHIPPED', extra, pacotesBrutos: [cancelada] }));
    await ex.importar(
      pedido({
        status: 'UNSHIPPED',
        atualizadoEm: depois(30),
        extra,
        pacotesBrutos: [cancelada, pacoteAmazon('PKG-2', 'PENDING_PICK_UP')],
      }),
    );
    expect(avisoPedido(ex, MOTIVO_PEDIDO_AMAZON.coletaCancelada)?.resolvidoEm).toBeNull();
    await ex.importar(
      pedido({ status: 'CANCELLED', atualizadoEm: depois(60), extra, pacotesBrutos: [cancelada] }),
    );
    expect(avisoPedido(ex, MOTIVO_PEDIDO_AMAZON.coletaCancelada)?.resolvidoEm).not.toBeNull();
  });

  it('★ an unknown token ⇒ pacote-status-desconhecido + ONE count line with counts and closed codes only (never the token, never a tracking number); every token known and keyed resolves it', async () => {
    const ex = montar();
    const extra = comNota('ACCEPTED');
    await ex.importar(
      pedido({
        status: 'UNSHIPPED',
        extra,
        pacotesBrutos: [
          pacoteAmazon('PKG-1', 'TOKEN_NOVO_X', { rastreio: 'TRK-SECRETO-1' }),
          pacoteAmazon('PKG-2', 'PENDING_PICK_UP', { status: 'PENDING' }),
        ],
      }),
    );
    // The fold is BLOCKED: the seed stays (the known package does not answer for its sibling).
    expect(frete(ex).estado).toBe('iniciado');
    expect(avisoPedido(ex, MOTIVO_PEDIDO_AMAZON.pacoteStatusDesconhecido)).toMatchObject({
      resolvidoEm: null,
    });
    const linha = linhasPedido(ex).filter((l) => l.codigo === 'pacote-nao-mapeado');
    expect(linha).toHaveLength(1);
    expect(linha[0]).toMatchObject({
      pedido: ORDER_ID_TESTE,
      pacotes: 2,
      pacotesNaoMapeados: 1,
      pacotesSemChave: 0,
      statusPacotes: 'IN_TRANSIT,PENDING',
    });
    // This import's own lines (the `pedido` event). The getOrder CALL line's
    // excerpt is step 2b's redactor's, which shows Amazon-made ids by grammar.
    expect(JSON.stringify(linhasPedido(ex))).not.toMatch(/TOKEN_NOVO_X|TRK-SECRETO/);
    // A non-freight event line carries no package campos.
    expect(
      linhasPedido(ex).filter((l) => l.codigo !== 'pacote-nao-mapeado' && 'pacotes' in l),
    ).toEqual([]);

    await ex.importar(
      pedido({
        status: 'UNSHIPPED',
        atualizadoEm: depois(60),
        extra,
        pacotesBrutos: [
          pacoteAmazon('PKG-1', 'PENDING_PICK_UP', { rastreio: 'TRK-SECRETO-1' }),
          pacoteAmazon('PKG-2', 'PENDING_PICK_UP', { status: 'PENDING' }),
        ],
      }),
    );
    expect(
      avisoPedido(ex, MOTIVO_PEDIDO_AMAZON.pacoteStatusDesconhecido)?.resolvidoEm,
    ).not.toBeNull();
    expect(frete(ex)).toMatchObject({ estado: 'aguardandoPostagem', codRastreio: 'TRK-SECRETO-1' });
  });

  it('★ the package fold is read BEFORE the CANCELLED decision: a pickup Amazon reports in the cancelling read keeps the estado, the pagamento and files cancelado-apos-envio', async () => {
    const ex = montar();
    const extra = comNota('ACCEPTED');
    await ex.importar(
      pedido({
        status: 'UNSHIPPED',
        extra,
        pacotesBrutos: [pacoteAmazon('PKG-1', 'PENDING_PICK_UP')],
      }),
    );
    expect(frete(ex).estado).toBe('aguardandoPostagem');
    await ex.importar(
      pedido({
        status: 'CANCELLED',
        atualizadoEm: depois(60),
        extra,
        pacotesBrutos: [pacoteAmazon('PKG-1', 'PICKED_UP')],
      }),
    );
    expect(ex.h.db.ler(CAMINHO)?.estado).toBe('pago');
    expect(frete(ex).estado).toBe('postado');
    expect(ex.h.db.ler(`${CAMINHO}/pagamentos/${PEDIDO_ID}`)?.status_pagamento).toBe(4);
    expect(incidente(ex, 'amz-cancelado-apos-envio')).toBeDefined();
  });

  it('★ a CANCELLED read still carrying an unknown token keeps pacote-status-desconhecido OPEN, and its picked-up sibling keeps the estado (goods out from EVERY package)', async () => {
    const ex = montar();
    const extra = comNota('ACCEPTED');
    // Its closed status PENDING: the picked-up sibling alone says the goods left.
    const desconhecido = pacoteAmazon('PKG-2', 'TOKEN_NOVO_X', { status: 'PENDING' });
    await ex.importar(
      pedido({
        status: 'UNSHIPPED',
        extra,
        pacotesBrutos: [pacoteAmazon('PKG-1', 'PENDING_PICK_UP'), desconhecido],
      }),
    );
    expect(avisoPedido(ex, MOTIVO_PEDIDO_AMAZON.pacoteStatusDesconhecido)?.resolvidoEm).toBeNull();
    await ex.importar(
      pedido({
        status: 'CANCELLED',
        atualizadoEm: depois(60),
        extra,
        pacotesBrutos: [pacoteAmazon('PKG-1', 'PICKED_UP'), desconhecido],
      }),
    );
    expect(avisoPedido(ex, MOTIVO_PEDIDO_AMAZON.pacoteStatusDesconhecido)?.resolvidoEm).toBeNull();
    expect(ex.h.db.ler(CAMINHO)?.estado).toBe('pago');
    expect(incidente(ex, 'amz-cancelado-apos-envio')).toBeDefined();
    // The blocked fold moved nothing: the seed stays (never cancelado).
    expect(frete(ex).estado).toBe('iniciado');
  });

  it('★ (PR 5-f) a CANCELLED read whose package has NO detailedStatus but which Amazon reports IN_TRANSIT keeps the estado, the pagamento and files cancelado-apos-envio — the freight stays where it was; NEAR-MISS: the same package at PENDING is released', async () => {
    for (const [status, fica] of [
      ['IN_TRANSIT', true],
      ['PENDING', false],
    ] as const) {
      const ex = montar();
      const extra = comNota('ACCEPTED');
      await ex.importar(
        pedido({
          status: 'UNSHIPPED',
          extra,
          pacotesBrutos: [pacoteAmazon('PKG-1', 'PENDING_PICK_UP', { status: 'PENDING' })],
        }),
      );
      expect(frete(ex).estado, status).toBe('aguardandoPostagem');
      await ex.importar(
        pedido({
          status: 'CANCELLED',
          atualizadoEm: depois(60),
          extra,
          pacotesBrutos: [pacoteAmazon('PKG-1', undefined, { status })],
        }),
      );
      const pagamentoGuardado = ex.h.db.ler(`${CAMINHO}/pagamentos/${PEDIDO_ID}`);
      expect(
        avisoPedido(ex, MOTIVO_PEDIDO_AMAZON.pacoteStatusDesconhecido)?.resolvidoEm,
        status,
      ).toBeNull();
      if (fica) {
        expect(ex.h.db.ler(CAMINHO)?.estado, status).toBe('pago');
        expect(pagamentoGuardado?.status_pagamento, status).toBe(4);
        expect(incidente(ex, 'amz-cancelado-apos-envio'), status).toBeDefined();
        expect(frete(ex).estado, status).toBe('aguardandoPostagem');
      } else {
        expect(ex.h.db.ler(CAMINHO)?.estado, status).toBe('estornadoIntegralmente');
        expect(pagamentoGuardado?.status_pagamento, status).toBe(8);
        expect(incidente(ex, 'amz-cancelado-apos-envio'), status).toBeUndefined();
        expect(frete(ex).estado, status).toBe('cancelado');
      }
    }
  });
});

/* ------------------- step 15 (PR 15-b): the two scheduling motivos ------------------- */

describe('★ step 15 (PR 15-b) — the import RESOLVES the two scheduling motivos once scheduling has ended, and never raises them', () => {
  const AGENDAMENTO = [
    MOTIVO_PEDIDO_AMAZON.dimensoesAusentes,
    MOTIVO_PEDIDO_AMAZON.agendamentoRecusado,
  ] as const;
  const caminhosAgendamento = AGENDAMENTO.map((m) =>
    caminhoAviso(chavePedidoPrecisaAtencao(CONTA_IMPORTADOR, ORDER_ID_TESTE, m)),
  );

  /** An approved order (the buyer, its invoice status merged into the same `tax`) with one package. */
  function comPacote(
    c: Record<string, unknown>,
    detalhe: string,
    opcoes: { status?: string; atualizadoEm?: string; invoiceStatus?: string } = {},
  ): Record<string, unknown> {
    return pedido({
      status: opcoes.status ?? 'UNSHIPPED',
      atualizadoEm: opcoes.atualizadoEm,
      pacotesBrutos: [pacoteAmazon('PKG-1', detalhe, { status: 'PENDING' })],
      extra: {
        ...c,
        tax: {
          ...(c.tax as Record<string, unknown>),
          taxInvoicing: { invoiceStatus: opcoes.invoiceStatus ?? 'ACCEPTED' },
        },
      },
    });
  }

  /** The scheduling task's raise of both rows, clocked by the first commit. */
  async function levantarAgendamento(ex: Execucao): Promise<void> {
    const relogio = ex.h.db.escritasEm(CAMINHO)[0]?.writeTime;
    expect(relogio).toBeDefined();
    await sincronizarAvisosDoPedidoAmazon(
      asDb(ex.h.db),
      { increment, nowMs: AGORA_MS, logger: ex.h.log.logger },
      {
        integracaoId: CONTA_IMPORTADOR,
        orderId: ORDER_ID_TESTE,
        pedidoId: PEDIDO_ID,
        levantar: [...AGENDAMENTO],
        resolver: [],
        relogio: relogio!,
      },
    );
    for (const m of AGENDAMENTO) expect(avisoPedido(ex, m)?.resolvidoEm, m).toBeNull();
  }

  it('★ PENDING_PICK_UP resolves both open rows; NEAR-MISS: a newer PENDING_SCHEDULE + ACCEPTED leaves them OPEN and reads neither key', async () => {
    const ex = montar();
    const c = comprador();
    await ex.importar(comPacote(c, 'PENDING_SCHEDULE'));
    await levantarAgendamento(ex);

    const leiturasAntes = ex.h.db.leituras.length;
    const r = await ex.importar(comPacote(c, 'PENDING_SCHEDULE', { atualizadoEm: depois(60) }));
    expect(r.kind).toBe('importado');
    for (const m of AGENDAMENTO) expect(avisoPedido(ex, m)?.resolvidoEm, m).toBeNull();
    // Neither key joined the per-pedido sync's getAll: no extra read on an order still to schedule.
    const lidas = ex.h.db.leituras.slice(leiturasAntes);
    for (const caminho of caminhosAgendamento) expect(lidas).not.toContain(caminho);
    // Anti-vacuity: that sync did read the other motivos' keys.
    expect(lidas.filter((l) => l.startsWith('avisos/')).length).toBeGreaterThan(0);

    const leiturasAgendado = ex.h.db.leituras.length;
    await ex.importar(comPacote(c, 'PENDING_PICK_UP', { atualizadoEm: depois(120) }));
    expect(ex.h.db.ler(CAMINHO)?.freteInicial).toMatchObject({ estado: 'aguardandoPostagem' });
    for (const m of AGENDAMENTO) expect(avisoPedido(ex, m)?.resolvidoEm, m).not.toBeNull();
    // Scheduled or later: both keys join the getAll (+2 reads).
    const lidasAgendado = ex.h.db.leituras.slice(leiturasAgendado);
    for (const caminho of caminhosAgendamento) expect(lidasAgendado).toContain(caminho);
  });

  it('★ CANCELLED resolves both open rows', async () => {
    const ex = montar();
    const c = comprador();
    await ex.importar(comPacote(c, 'PENDING_SCHEDULE'));
    await levantarAgendamento(ex);
    await ex.importar(pedido({ status: 'CANCELLED', atualizadoEm: depois(60), extra: c }));
    for (const m of AGENDAMENTO) expect(avisoPedido(ex, m)?.resolvidoEm, m).not.toBeNull();
  });

  it('★ LABEL_CANCELLED (a schedule existed) resolves both; SHIPPED with the package picked up does too', async () => {
    const cancelada = montar();
    const c = comprador();
    await cancelada.importar(comPacote(c, 'PENDING_SCHEDULE'));
    await levantarAgendamento(cancelada);
    await cancelada.importar(comPacote(c, 'LABEL_CANCELLED', { atualizadoEm: depois(60) }));
    for (const m of AGENDAMENTO) {
      expect(avisoPedido(cancelada, m)?.resolvidoEm, m).not.toBeNull();
    }

    const enviado = montar();
    await enviado.importar(comPacote(c, 'PENDING_SCHEDULE'));
    await levantarAgendamento(enviado);
    await enviado.importar(
      comPacote(c, 'PICKED_UP', { status: 'SHIPPED', atualizadoEm: depois(60) }),
    );
    for (const m of AGENDAMENTO) expect(avisoPedido(enviado, m)?.resolvidoEm, m).not.toBeNull();
  });

  it('★ no import ever RAISES either: to schedule, scheduled, cancelled pickup, shipped, cancelled, pending — no row written', async () => {
    const leituras: readonly Record<string, unknown>[] = [
      comPacote(comprador(), 'PENDING_SCHEDULE'),
      comPacote(comprador(), 'PENDING_SCHEDULE', { invoiceStatus: 'PROCESSING' }),
      comPacote(comprador(), 'PENDING_PICK_UP'),
      comPacote(comprador(), 'LABEL_CANCELLED'),
      comPacote(comprador(), 'PICKED_UP', { status: 'SHIPPED' }),
      pedido({ status: 'UNSHIPPED', extra: comprador() }),
      pedido({ status: 'PENDING' }),
    ];
    for (const [i, corpo] of leituras.entries()) {
      const ex = montar();
      await ex.importar(corpo);
      for (const caminho of caminhosAgendamento) {
        expect(ex.h.db.ler(caminho), `${String(i)} ${caminho}`).toBeUndefined();
      }
    }
  });
});

describe('★ PR 5-f — a D17 block over goods already out, through the import', () => {
  /** The approved buyer, with the order's invoice status beside the BUYER registration. */
  function comNota(invoiceStatus: string): Record<string, unknown> {
    const c = comprador();
    return {
      ...c,
      tax: { ...(c.tax as Record<string, unknown>), taxInvoicing: { invoiceStatus } },
    };
  }
  const DUAS = [
    linhaAmazon('L1', { qtd: 2, preco: '10.00' }),
    linhaAmazon('L2', { qtd: 1, preco: '5.00' }),
  ];
  const L2_CANCELADA = [
    DUAS[0] ?? {},
    linhaAmazon('L2', { qtd: 0, preco: '5.00', execucao: true }),
  ];
  const frete = (ex: Execucao) => ex.h.db.ler(CAMINHO)?.freteInicial as Record<string, unknown>;
  const pagamentoGuardado = (ex: Execucao) => ex.h.db.ler(`${CAMINHO}/pagamentos/${PEDIDO_ID}`);

  /** Imported pago with its pagamento, then `pacote` reported for PKG-1 (scheduled, freight aguardandoPostagem). */
  async function agendado(ex: Execucao, extra: Record<string, unknown>): Promise<void> {
    await ex.importar(
      pedido({
        status: 'UNSHIPPED',
        linhas: DUAS,
        extra,
        pacotesBrutos: [pacoteAmazon('PKG-1', 'PENDING_PICK_UP')],
      }),
    );
    expect(ex.h.db.ler(CAMINHO)?.estado).toBe('pago');
    expect(frete(ex).estado).toBe('aguardandoPostagem');
  }

  it('★ L2 cancelled while PKG-1 is PICKED_UP ⇒ the pedido stays pago (no stock reversal), the crítico aviso and the cancelamento-parcial line still come, the lines and the pagamento untouched; the next read keeps all of it', async () => {
    const ex = montar();
    const extra = comNota('ACCEPTED');
    await agendado(ex, extra);
    const antes = ex.h.db.ler(CAMINHO) ?? {};
    const pagamentoAntes = pagamentoGuardado(ex);
    expect(pagamentoAntes?.status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);

    for (const [segundos, nome] of [
      [60, 'the blocking read'],
      [120, 'the next read'],
    ] as const) {
      const r = await ex.importar(
        pedido({
          status: 'PARTIALLY_SHIPPED',
          linhas: L2_CANCELADA,
          atualizadoEm: depois(segundos),
          extra,
          pacotesBrutos: [pacoteAmazon('PKG-1', 'PICKED_UP')],
        }),
      );
      expect(r, nome).toEqual({
        kind: 'importado',
        detalhe: expect.objectContaining({
          itens: 'divergencia-itens-aprovado',
          linhasDivergentes: 1,
        }),
      });
      const doc = ex.h.db.ler(CAMINHO) ?? {};
      expect(doc.estado, nome).toBe('pago');
      expect(doc.error ?? null, nome).toBeNull();
      expect(doc.itens, nome).toEqual(antes.itens);
      expect(frete(ex).estado, nome).toBe('postado');
      expect(pagamentoGuardado(ex), nome).toEqual(pagamentoAntes);
      expect(avisoPedido(ex, MOTIVO_PEDIDO_AMAZON.divergenciaItens), nome).toMatchObject({
        severidade: 'critico',
        resolvidoEm: null,
      });
    }
    expect(linhasPedido(ex).filter((l) => l.codigo === 'cancelamento-parcial')).toHaveLength(2);
  });

  it('★ NEAR-MISS: the same cancelled line while nothing is scheduled (freight aguardandoNFe) ⇒ our error — the reservation released, as the owner decided', async () => {
    const ex = montar();
    const extra = comNota('NOT_FOUND');
    await ex.importar(pedido({ status: 'UNSHIPPED', linhas: DUAS, extra }));
    expect(frete(ex).estado).toBe('aguardandoNFe');
    await ex.importar(
      pedido({
        status: 'PARTIALLY_SHIPPED',
        linhas: L2_CANCELADA,
        atualizadoEm: depois(60),
        extra,
      }),
    );
    expect(ex.h.db.ler(CAMINHO)).toMatchObject({
      estado: 'error',
      error: '[amazon] linha cancelada na Amazon em pedido a enviar: L2',
    });
    expect(avisoPedido(ex, MOTIVO_PEDIDO_AMAZON.divergenciaItens)?.resolvidoEm).toBeNull();
    expect(linhasPedido(ex).map((l) => l.codigo)).toContain('cancelamento-parcial');
  });
});

/* ------------- PR 5-f: the block's aviso and the missing pagamento ------------- */

describe('★ PR 5-f — divergencia-itens resolves only on lines that agree, and an approved pedido never sits without a pagamento in silence', () => {
  const INTEIRAS = [
    linhaAmazon('L1', { qtd: 2, preco: '10.00' }),
    linhaAmazon('L2', { qtd: 1, preco: '5.00' }),
  ];
  /** L2 cancelled on Amazon (an executed line cancellation that stays on the line). */
  const L2_CANCELADA = [
    linhaAmazon('L1', { qtd: 2, preco: '10.00' }),
    linhaAmazon('L2', { qtd: 0, preco: '5.00', execucao: true }),
  ];
  const PAGAMENTO = `${CAMINHO}/pagamentos/${PEDIDO_ID}`;
  const divergencia = (ex: Execucao) => avisoPedido(ex, MOTIVO_PEDIDO_AMAZON.divergenciaItens);

  /** An operator's fix on the pedido form: L2 dropped, the edit latch stamped. */
  function corrigir(ex: Execucao): void {
    const doc = ex.h.db.ler(CAMINHO) ?? {};
    const itens = doc.itens as Record<string, Record<string, unknown>[]>;
    ex.h.db.seed(CAMINHO, {
      ...doc,
      hasUserInteraction: true,
      itens: Object.fromEntries(
        Object.entries(itens).map(([chave, linhas]) => [
          chave,
          linhas.filter((l) => l.mktplaceId !== 'L2'),
        ]),
      ),
    });
  }

  /** `primeiro` read, then the UNSHIPPED read with L2 cancelled: our error, the crítico aviso open. */
  async function bloqueado(
    ex: Execucao,
    primeiro: 'PENDING' | 'UNSHIPPED',
    extra: Record<string, unknown>,
  ): Promise<void> {
    await ex.importar(pedido({ status: primeiro, linhas: INTEIRAS, extra }));
    await ex.importar(
      pedido({ status: 'UNSHIPPED', linhas: L2_CANCELADA, atualizadoEm: depois(60), extra }),
    );
    expect(ex.h.db.ler(CAMINHO)).toMatchObject({
      estado: 'error',
      error: '[amazon] linha cancelada na Amazon em pedido a enviar: L2',
    });
    expect(divergencia(ex)).toMatchObject({ severidade: 'critico', resolvidoEm: null });
  }

  const enviado = (ex: Execucao, extra: Record<string, unknown>, linhas = L2_CANCELADA) =>
    ex.importar(pedido({ status: 'SHIPPED', linhas, atualizadoEm: depois(120), extra }));

  it('★ (b) the block, then Amazon SHIPS the order with the execution still on L2 ⇒ pago and our text cleared (the goods are out), but divergencia-itens STAYS OPEN — the lines were never judged; possivel-reembolso filed, the stored lines and the pagamento untouched', async () => {
    const ex = montar();
    const extra = comprador();
    await bloqueado(ex, 'UNSHIPPED', extra);
    const antes = ex.h.db.ler(CAMINHO) ?? {};
    const pagamentoAntes = ex.h.db.ler(PAGAMENTO);
    expect(pagamentoAntes?.status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    const r = await enviado(ex, extra);
    expect(r).toEqual({
      kind: 'importado',
      detalhe: expect.objectContaining({ itens: 'itens-preservados-reversao' }),
    });
    const doc = ex.h.db.ler(CAMINHO) ?? {};
    expect(doc).toMatchObject({ estado: 'pago', error: null });
    expect(doc.itens).toEqual(antes.itens);
    expect(divergencia(ex)).toMatchObject({ severidade: 'critico', resolvidoEm: null });
    expect(incidente(ex, 'amz-possivel-reembolso')).toBeDefined();
    expect(incidente(ex, 'amz-pagamento-divergente')).toBeUndefined();
    expect(ex.h.db.ler(PAGAMENTO)).toEqual(pagamentoAntes);
  });

  it('★ NEAR-MISS: the same SHIPPED read after an operator fixed the lines (congelado) RESOLVES it; so does an UNSHIPPED read whose lines agree again with the stored ones', async () => {
    const congelado = montar();
    const extra = comprador();
    await bloqueado(congelado, 'UNSHIPPED', extra);
    corrigir(congelado);
    await enviado(congelado, extra);
    expect(congelado.h.db.ler(CAMINHO)).toMatchObject({ estado: 'pago', error: null });
    expect(divergencia(congelado)?.resolvidoEm).not.toBeNull();

    const deAcordo = montar();
    await bloqueado(deAcordo, 'UNSHIPPED', extra);
    const r = await deAcordo.importar(
      pedido({ status: 'UNSHIPPED', linhas: INTEIRAS, atualizadoEm: depois(120), extra }),
    );
    expect(r).toEqual({
      kind: 'importado',
      detalhe: expect.objectContaining({ itens: 'mantidas' }),
    });
    expect(deAcordo.h.db.ler(CAMINHO)).toMatchObject({ estado: 'pago', error: null });
    expect(divergencia(deAcordo)?.resolvidoEm).not.toBeNull();
  });

  it('★ (a) PENDING first (no pagamento), the block, an operator’s fix, and a first read after it that is already SHIPPED with the execution still on L2 ⇒ pago with NO pagamento document, and the pagamento-divergente incidente says so — the aviso resolved (congelado)', async () => {
    const ex = montar();
    const extra = comprador();
    await bloqueado(ex, 'PENDING', extra);
    expect(ex.h.db.ler(PAGAMENTO)).toBeUndefined();
    corrigir(ex);
    const r = await enviado(ex, extra);
    expect(r).toEqual({
      kind: 'importado',
      detalhe: expect.objectContaining({ itens: 'congeladas' }),
    });
    expect(ex.h.db.ler(CAMINHO)).toMatchObject({ estado: 'pago', error: null });
    expect(ex.h.db.ler(PAGAMENTO)).toBeUndefined();
    const filed = incidente(ex, 'amz-pagamento-divergente');
    expect(filed).toMatchObject({ subtipo: 'pagamento-divergente', resolucao: null });
    expect(String(filed?.motivoDoIncidente)).toContain(
      'possível devolução, reembolso ou item cancelado',
    );
    expect(divergencia(ex)?.resolvidoEm).not.toBeNull();
    // A later SHIPPED read: still none created, the incidente not re-dated.
    const primeiro = incidente(ex, 'amz-pagamento-divergente');
    await ex.importar(
      pedido({ status: 'SHIPPED', linhas: L2_CANCELADA, atualizadoEm: depois(180), extra }),
    );
    expect(ex.h.db.ler(PAGAMENTO)).toBeUndefined();
    expect(incidente(ex, 'amz-pagamento-divergente')).toEqual(primeiro);
  });

  it('★ NEAR-MISS: the same fix with an UNSHIPPED first read after it (not a reversal) ⇒ the pagamento IS created at aprovado for the operator’s lines, nothing filed', async () => {
    const ex = montar();
    const extra = comprador();
    await bloqueado(ex, 'PENDING', extra);
    corrigir(ex);
    await ex.importar(
      pedido({ status: 'UNSHIPPED', linhas: L2_CANCELADA, atualizadoEm: depois(120), extra }),
    );
    expect(ex.h.db.ler(CAMINHO)).toMatchObject({ estado: 'pago', error: null });
    expect(ex.h.db.ler(PAGAMENTO)).toMatchObject({
      status_pagamento: STATUS_PAGAMENTO.aprovado,
      valor: 20,
    });
    expect(incidente(ex, 'amz-pagamento-divergente')).toBeUndefined();
  });
});

/* ------- PR 5-f: a migrated fulfillment residue under a read without fulfilledBy ------- */

describe('★ PR 5-f — a migrated fulfillment residue under a CANCELLED read WITHOUT fulfilledBy, through the import', () => {
  /** The approved buyer, with the order's invoice status beside the BUYER registration. */
  function comNota(invoiceStatus: string): Record<string, unknown> {
    const c = comprador();
    return {
      ...c,
      tax: { ...(c.tax as Record<string, unknown>), taxInvoicing: { invoiceStatus } },
    };
  }
  const DUAS = [
    linhaAmazon('L1', { qtd: 2, preco: '10.00' }),
    linhaAmazon('L2', { qtd: 1, preco: '5.00' }),
  ];
  const frete = (ex: Execucao) => ex.h.db.ler(CAMINHO)?.freteInicial as Record<string, unknown>;
  const pagamentoGuardado = (ex: Execucao) => ex.h.db.ler(`${CAMINHO}/pagamentos/${PEDIDO_ID}`);

  /**
   * Imported `pago` with its pagamento, then re-seeded in the SHAPE of a migrated
   * MFN pedido: no marketplace block of this importer's, its freight block at
   * `fulfillment` (the legacy residue: the package at the carrier's facility).
   */
  async function migrado(ex: Execucao, extra: Record<string, unknown>): Promise<void> {
    await ex.importar(pedido({ status: 'UNSHIPPED', linhas: DUAS, extra }));
    const doc = ex.h.db.ler(CAMINHO) ?? {};
    const semMarketplace: Record<string, unknown> = { ...doc };
    delete semMarketplace.marketplace;
    ex.h.db.seed(CAMINHO, {
      ...semMarketplace,
      freteInicial: { ...(doc.freteInicial as Record<string, unknown>), estado: 'fulfillment' },
    });
    expect(ex.h.db.ler(CAMINHO)?.estado).toBe(ESTADO_PEDIDO.pago);
    expect(pagamentoGuardado(ex)?.status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
  }

  it('★ the probe end to end: CANCELLED without fulfilledBy ⇒ pago KEPT, the pagamento still aprovado, amz-cancelado-apos-envio filed, the freight still fulfillment; the C1 flip: the same doc under an AFN CANCELLED read ⇒ estornadoIntegralmente, the pagamento estornado, no incidente, the freight still fulfillment (as today)', async () => {
    for (const [por, fica] of [
      [null, true],
      ['AMAZON', false],
    ] as const) {
      const nome = String(por);
      const ex = montar();
      const extra = comNota('ACCEPTED');
      await migrado(ex, extra);
      await ex.importar(
        pedido({ por, status: 'CANCELLED', linhas: DUAS, atualizadoEm: depois(60), extra }),
      );
      const doc = ex.h.db.ler(CAMINHO) ?? {};
      expect(frete(ex).estado, nome).toBe('fulfillment');
      if (fica) {
        expect(doc.estado, nome).toBe(ESTADO_PEDIDO.pago);
        expect(pagamentoGuardado(ex)?.status_pagamento, nome).toBe(STATUS_PAGAMENTO.aprovado);
        expect(incidente(ex, 'amz-cancelado-apos-envio'), nome).toBeDefined();
      } else {
        expect(doc.estado, nome).toBe(ESTADO_PEDIDO.estornadoIntegralmente);
        expect(pagamentoGuardado(ex)?.status_pagamento, nome).toBe(STATUS_PAGAMENTO.estornado);
        expect(incidente(ex, 'amz-cancelado-apos-envio'), nome).toBeUndefined();
      }
    }
  });

  it('★ NEAR-MISS, the old behaviour kept: our AFN seed (created at our AFN error, freight fulfillment, no pagamento) under the same CANCELLED read without fulfilledBy ⇒ cancelado, no incidente', async () => {
    const ex = montar();
    const extra = comNota('ACCEPTED');
    await ex.importar(pedido({ por: 'AMAZON', status: 'UNSHIPPED', linhas: DUAS, extra }));
    expect(ex.h.db.ler(CAMINHO)).toMatchObject({
      estado: ESTADO_PEDIDO.error,
      error: '[amazon] pedido atendido pela Amazon',
    });
    expect(frete(ex).estado).toBe('fulfillment');
    expect(pagamentoGuardado(ex)).toBeUndefined();
    await ex.importar(
      pedido({ por: null, status: 'CANCELLED', linhas: DUAS, atualizadoEm: depois(60), extra }),
    );
    expect(ex.h.db.ler(CAMINHO)?.estado).toBe(ESTADO_PEDIDO.cancelado);
    expect(incidente(ex, 'amz-cancelado-apos-envio')).toBeUndefined();
    expect(frete(ex).estado).toBe('fulfillment');
  });
});

/* --------------- PR 5-f: what the order money cannot state, end to end --------------- */

describe('★ PR 5-f — a money shape the pagamento check cannot see ⇒ a pedido incidente + a count line', () => {
  /** L1 charges SHIPPING 8 with a DISCOUNT 3 whose shipping part Amazon did not itemise. */
  const linhasSemDetalhe = (detalhes?: readonly unknown[]) => [
    linhaAmazon('L1', {
      qtd: 2,
      preco: '10.00',
      quebras: [
        { type: 'SHIPPING', subtotal: brl('8.00') },
        {
          type: 'DISCOUNT',
          subtotal: brl('3.00'),
          ...(detalhes === undefined ? {} : { detailedBreakdowns: detalhes }),
        },
      ],
    }),
  ];
  const linhasDoCodigo = (ex: Execucao, codigo: string) =>
    ex.h.log.linhas.filter((l) => l.meta?.evento === 'pedido' && l.meta.codigo === codigo);

  it('★ the silent case (the buyer paid exactly what the lines, freight and discount state): `amz-desconto-nao-detalhado`, non-blocking, ONE WARNING count line; a redelivery creates nothing new', async () => {
    const ex = montar();
    const corpo = pedido({ status: 'UNSHIPPED', linhas: linhasSemDetalhe(), extra: comprador() });
    await ex.importar(corpo);
    const doc = ex.h.db.ler(CAMINHO) ?? {};
    // The money is what it was: the whole discount on the goods, the freight gross.
    expect(doc).toMatchObject({ estado: 'pago', descontoTotal: 3 });
    expect(doc.freteInicial).toMatchObject({ valorCobrado: 8 });
    expect(incidente(ex, 'amz-desconto-nao-detalhado')).toMatchObject({
      origem: ORIGEM_INCIDENTE.outros,
      tipo: TIPO_INCIDENTE.outros,
      subtipo: 'desconto-nao-detalhado',
      externalId: null,
      resolucao: null,
    });
    const texto = String(incidente(ex, 'amz-desconto-nao-detalhado')?.motivoDoIncidente);
    expect(texto).toContain(ORDER_ID_TESTE);
    expect(texto).toContain('antes de emitir a NF-e');
    // The payment check agreed: no other money incidente speaks for it.
    expect(incidente(ex, 'amz-pagamento-divergente')).toBeUndefined();
    expect(incidente(ex, 'amz-imposto-destacado')).toBeUndefined();
    const linhas = linhasDoCodigo(ex, 'desconto-nao-detalhado');
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.nivel).toBe('warn');
    expect(linhas[0]?.meta).toMatchObject({
      pedido: ORDER_ID_TESTE,
      conta: CONTA_IMPORTADOR,
      linhasDescontoNaoDetalhado: 1,
      quebrasImposto: 0,
    });
    // Counts only: never an amount.
    expect(JSON.stringify(linhas[0]?.meta)).not.toMatch(/8\.00|3\.00|:(8|3|17)[,}]|Compradora/);
    // Only a money event line carries the money counts.
    expect(
      linhasPedido(ex).filter(
        (l) => l.codigo !== 'desconto-nao-detalhado' && 'linhasDescontoNaoDetalhado' in l,
      ),
    ).toEqual([]);

    const criacoes = () =>
      escritasEm(ex, `${CAMINHO}/incidentes/amz-desconto-nao-detalhado`).filter(
        (e) => e.verbo === 'create',
      ).length;
    expect(criacoes()).toBe(1);
    const primeiro = incidente(ex, 'amz-desconto-nao-detalhado');
    await ex.importar(corpo);
    // Created once (tier 0, ALREADY_EXISTS swallowed, never re-dated); the count line is per read.
    expect(criacoes()).toBe(1);
    expect(incidente(ex, 'amz-desconto-nao-detalhado')).toEqual(primeiro);
    expect(linhasDoCodigo(ex, 'desconto-nao-detalhado')).toHaveLength(2);
  });

  it('NEAR-MISS: the same amounts with the shipping part itemised ⇒ no incidente, no line', async () => {
    const ex = montar();
    await ex.importar(
      pedido({
        status: 'UNSHIPPED',
        linhas: linhasSemDetalhe([{ subtype: 'SHIPPING', value: brl('3.00') }]),
        extra: comprador(),
      }),
    );
    expect(ex.h.db.ler(CAMINHO)).toMatchObject({ estado: 'pago', descontoTotal: 0 });
    expect(incidente(ex, 'amz-desconto-nao-detalhado')).toBeUndefined();
    expect(linhasDoCodigo(ex, 'desconto-nao-detalhado')).toEqual([]);
  });

  it('NEAR-MISS: a PENDING read files nothing; the UNSHIPPED re-read of the same shape files it', async () => {
    const ex = montar();
    await ex.importar(pedido({ status: 'PENDING', linhas: linhasSemDetalhe() }));
    expect(incidente(ex, 'amz-desconto-nao-detalhado')).toBeUndefined();
    expect(linhasDoCodigo(ex, 'desconto-nao-detalhado')).toEqual([]);
    await ex.importar(
      pedido({
        status: 'UNSHIPPED',
        atualizadoEm: depois(60),
        linhas: linhasSemDetalhe(),
        extra: comprador(),
      }),
    );
    expect(incidente(ex, 'amz-desconto-nao-detalhado')?.subtipo).toBe('desconto-nao-detalhado');
  });

  it('★ a TAX row that is not 0 ⇒ `amz-imposto-destacado` + its count line; TAX exactly 0 ⇒ nothing (NEAR-MISS)', async () => {
    const comImposto = (valor: string) =>
      pedido({
        status: 'UNSHIPPED',
        linhas: [
          linhaAmazon('L1', {
            qtd: 2,
            preco: '10.00',
            quebras: [{ type: 'TAX', subtotal: brl(valor) }],
          }),
        ],
        extra: comprador(),
      });
    const ex = montar();
    await ex.importar(comImposto('2.00'));
    expect(incidente(ex, 'amz-imposto-destacado')).toMatchObject({
      tipo: TIPO_INCIDENTE.outros,
      subtipo: 'imposto-destacado',
    });
    expect(linhasDoCodigo(ex, 'imposto-destacado')[0]?.meta).toMatchObject({
      linhasDescontoNaoDetalhado: 0,
      quebrasImposto: 1,
    });

    const zero = montar();
    await zero.importar(comImposto('0.00'));
    expect(incidente(zero, 'amz-imposto-destacado')).toBeUndefined();
    expect(linhasDoCodigo(zero, 'imposto-destacado')).toEqual([]);
  });
});

/* -------- PR 5-f: an order created PENDING without fulfilledBy, through the import -------- */

describe('★ PR 5-f — fulfilledBy ausente na criação: a PENDING order created WITHOUT fulfilledBy, through the import (the defensive default: a real PENDING read carries MERCHANT, capture C1b)', () => {
  const DUAS = [
    linhaAmazon('L1', { qtd: 2, preco: '10.00' }),
    linhaAmazon('L2', { qtd: 1, preco: '5.00' }),
  ];
  /** An approved read's lines: L1 re-counted and re-priced (a mirror takes them, a lock does not). */
  const OUTRAS = [
    linhaAmazon('L1', { qtd: 3, preco: '12.00' }),
    linhaAmazon('L2', { qtd: 1, preco: '5.00' }),
  ];
  const PAGAMENTO = `${CAMINHO}/pagamentos/${PEDIDO_ID}`;
  const logistica = (ex: Execucao) => avisoPedido(ex, MOTIVO_PEDIDO_AMAZON.logisticaDesconhecida);
  const divergencia = (ex: Execucao) => avisoPedido(ex, MOTIVO_PEDIDO_AMAZON.divergenciaItens);

  /** The stored lines as `[mktplaceId, quantidade, precoDeVenda]`, by id. */
  function linhas(ex: Execucao): unknown[][] {
    const itens = (ex.h.db.ler(CAMINHO)?.itens ?? {}) as Record<string, Record<string, unknown>[]>;
    return Object.values(itens)
      .flat()
      .map((l) => [l.mktplaceId, l.quantidade, l.precoDeVenda])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  }

  /**
   * What the stock sync converges to for the stored pedido under an operação that
   * moves stock AND tracks the reservation: the shared desired-state predicate
   * (`efeitoEstoquePedido`), fed the two estados it reads beside the operação.
   */
  function estoque(ex: Execucao) {
    const doc = ex.h.db.ler(CAMINHO) ?? {};
    const frete = estadoFreteSchema.safeParse(
      (doc.freteInicial as Record<string, unknown> | undefined)?.estado,
    );
    return efeitoEstoquePedido({
      estado: estadoPedidoSchema.parse(doc.estado),
      estadoFrete: frete.success ? frete.data : null,
      ehSaida: doc.ehSaida === true,
      movimentaEstoque: true,
      movimentaIndisponivelEstoque: true,
      jaMovimentado: false,
    });
  }

  /** The create every case starts from: `status` with `fulfillment.fulfilledBy` ABSENT. */
  async function criadoSemPor(ex: Execucao, status: string): Promise<void> {
    conta(ex, { operacaoOuterRef: 'documents/operacao/op-1' });
    intFrete(ex);
    const r = await ex.importar(pedido({ status, por: null, linhas: DUAS }));
    expect(r, status).toMatchObject({ kind: 'importado', detalhe: { acao: 'criado' } });
    expect(ex.h.db.ler(CAMINHO), status).toMatchObject({
      estado: ESTADO_PEDIDO.error,
      error: TEXTO_ERRO_AMAZON.logisticaDesconhecida,
      marketplace: { status, fulfilledBy: null },
      freteInicial: { estado: 'iniciado' },
    });
    // No pagamento before approval, and `error` holds no stock: nothing is reserved
    // while the order waits — today's cost (plan §3 decision 13 wants a reservation).
    expect(ex.h.db.ler(PAGAMENTO), status).toBeUndefined();
    expect(estoque(ex), status).toEqual(EFEITO_ESTOQUE_NENHUM);
    expect(logistica(ex), status).toMatchObject({
      severidade: 'critico',
      resolvidoEm: null,
      ocorrencias: 1,
    });
  }

  it('★ the lifecycle: created at our error + the crítico logistica-desconhecida, nothing reserved; the UNSHIPPED+MERCHANT read is the APPROVAL moment ⇒ pago, our text cleared, the lines MIRRORED (row 9, never locked), the pagamento aprovado, the reservation applied, the aviso RESOLVED — PENDING and PENDING_AVAILABILITY alike', async () => {
    for (const status of ['PENDING', 'PENDING_AVAILABILITY']) {
      const ex = montar();
      await criadoSemPor(ex, status);
      const r = await ex.importar(
        pedido({
          status: 'UNSHIPPED',
          linhas: OUTRAS,
          atualizadoEm: depois(60),
          extra: comprador(),
        }),
      );
      expect(r, status).toEqual({
        kind: 'importado',
        detalhe: expect.objectContaining({ acao: 'atualizado', itens: 'espelhadas' }),
      });
      expect(ex.h.db.ler(CAMINHO), status).toMatchObject({
        estado: ESTADO_PEDIDO.pago,
        error: null,
        marketplace: { status: 'UNSHIPPED', fulfilledBy: 'MERCHANT' },
      });
      expect(linhas(ex), status).toEqual([
        ['L1', 3, 12],
        ['L2', 1, 5],
      ]);
      expect(ex.h.db.ler(PAGAMENTO), status).toMatchObject({
        status_pagamento: STATUS_PAGAMENTO.aprovado,
        valor: 41,
      });
      expect(estoque(ex), status).toEqual({ reservar: true, remover: false, adicionar: false });
      expect(logistica(ex)?.resolvidoEm, status).not.toBeNull();
      // Mirrored, never judged: no block, so no divergence row was ever raised.
      expect(divergencia(ex), status).toBeUndefined();
    }
  });

  it('★ NEAR-MISS: the approval moment is the FIRST approved read, with or without fulfilledBy — after an UNSHIPPED read WITHOUT it (mirrored, our error kept), the same UNSHIPPED+MERCHANT read with other lines is LOCKED: a block, the lines kept, no pagamento, nothing reserved', async () => {
    const ex = montar();
    await criadoSemPor(ex, 'PENDING');
    const primeira = await ex.importar(
      pedido({
        status: 'UNSHIPPED',
        por: null,
        linhas: DUAS,
        atualizadoEm: depois(30),
        extra: comprador(),
      }),
    );
    expect(primeira).toEqual({
      kind: 'importado',
      detalhe: expect.objectContaining({ itens: 'espelhadas' }),
    });
    expect(ex.h.db.ler(CAMINHO)).toMatchObject({
      estado: ESTADO_PEDIDO.error,
      error: TEXTO_ERRO_AMAZON.logisticaDesconhecida,
      marketplace: { status: 'UNSHIPPED', fulfilledBy: null },
    });
    const r = await ex.importar(
      pedido({ status: 'UNSHIPPED', linhas: OUTRAS, atualizadoEm: depois(60), extra: comprador() }),
    );
    expect(r).toEqual({
      kind: 'importado',
      detalhe: expect.objectContaining({ itens: 'divergencia-itens-aprovado' }),
    });
    const doc = ex.h.db.ler(CAMINHO) ?? {};
    expect(doc.estado).toBe(ESTADO_PEDIDO.error);
    expect(String(doc.error)).toMatch(/^\[amazon\] itens divergentes/);
    expect(linhas(ex)).toEqual([
      ['L1', 2, 10],
      ['L2', 1, 5],
    ]);
    expect(ex.h.db.ler(PAGAMENTO)).toBeUndefined();
    expect(estoque(ex)).toEqual(EFEITO_ESTOQUE_NENHUM);
    // The logistics are known now; the block is what holds the pedido.
    expect(logistica(ex)?.resolvidoEm).not.toBeNull();
    expect(divergencia(ex)).toMatchObject({ severidade: 'critico', resolvidoEm: null });
  });

  it('★ fulfilledBy absent on EVERY read (today’s behaviour, pinned until the capture): PENDING → UNSHIPPED → SHIPPED keeps our error, no pagamento, nothing reserved, the crítico aviso OPEN; the lines are mirrored at the first approved read, then kept', async () => {
    for (const status of ['PENDING', 'PENDING_AVAILABILITY']) {
      const ex = montar();
      await criadoSemPor(ex, status);
      for (const [i, [seguinte, itens]] of (
        [
          ['UNSHIPPED', 'espelhadas'],
          ['SHIPPED', 'mantidas'],
        ] as const
      ).entries()) {
        const nome = `${status} → ${seguinte}`;
        const r = await ex.importar(
          pedido({
            status: seguinte,
            por: null,
            linhas: OUTRAS,
            atualizadoEm: depois(60 * (i + 1)),
            extra: comprador(),
          }),
        );
        expect(r, nome).toEqual({
          kind: 'importado',
          detalhe: expect.objectContaining({ acao: 'atualizado', itens }),
        });
        expect(ex.h.db.ler(CAMINHO), nome).toMatchObject({
          estado: ESTADO_PEDIDO.error,
          error: TEXTO_ERRO_AMAZON.logisticaDesconhecida,
          marketplace: { status: seguinte, fulfilledBy: null },
        });
        expect(linhas(ex), nome).toEqual([
          ['L1', 3, 12],
          ['L2', 1, 5],
        ]);
        expect(ex.h.db.ler(PAGAMENTO), nome).toBeUndefined();
        expect(estoque(ex), nome).toEqual(EFEITO_ESTOQUE_NENHUM);
        expect(logistica(ex), nome).toMatchObject({
          severidade: 'critico',
          resolvidoEm: null,
          ocorrencias: i + 2,
        });
      }
    }
  });
});

/* ------------- step 14 (14-c): the NF-e transitions of the import ------------- */

describe('★ step 14 (14-c) — the import’s two NF-e TRANSITIONS', () => {
  /** The approved buyer, with the order's invoice status beside the BUYER registration. */
  function comNota(invoiceStatus: string): Record<string, unknown> {
    const c = comprador();
    return {
      ...c,
      tax: { ...(c.tax as Record<string, unknown>), taxInvoicing: { invoiceStatus } },
    };
  }
  const CHAVE_NFE = chaveAvisoNfeAmazon(CONTA_IMPORTADOR, PEDIDO_ID);
  const avisoNfe = (ex: Execucao) => ex.h.db.ler(caminhoAviso(CHAVE_NFE));
  const frete = (ex: Execucao) => ex.h.db.ler(CAMINHO)?.freteInicial as Record<string, unknown>;
  /** A synthetic approved SALE proc (tpAmb 1); no party, no access key. */
  const PROC =
    '<nfeProc><NFe><infNFe><ide><tpAmb>1</tpAmb><tpNF>1</tpNF><finNFe>1</finNFe></ide>' +
    '</infNFe></NFe></nfeProc>';
  /** The NF-e stamp, as the task leaves it. */
  function carimbar(ex: Execucao) {
    const doc = ex.h.db.ler(CAMINHO) ?? {};
    ex.h.db.seed(CAMINHO, {
      ...doc,
      freteInicial: { ...(doc.freteInicial as Record<string, unknown>), estado: 'error' },
    });
  }
  /** What one import read or queried of the NF-e side: the subcollection and the NF-e row. */
  function tocouNfe(ex: Execucao, leiturasAntes: number, consultasAntes: number) {
    return {
      leituras: ex.h.db.leituras
        .slice(leiturasAntes)
        .filter((c) => c.includes('/nfev4') || c.endsWith(CHAVE_NFE)),
      consultas: ex.h.db.consultas.slice(consultasAntes).filter((c) => c.colecao.includes('nfev4')),
    };
  }

  it('★ INTO a cancelled sale ⇒ the clocked pedido-cancelado resolve even with NO row (a resolved tombstone, clocked by the batch writeTime); a stale task raise is then DROPPED', async () => {
    const ex = montar();
    await ex.importar(pedido({ status: 'UNSHIPPED', extra: comprador() }));
    expect(avisoNfe(ex)).toBeUndefined();
    const escritasAntes = ex.h.db.escritas.length;
    await ex.importar(
      pedido({ status: 'CANCELLED', atualizadoEm: depois(60), extra: comprador() }),
    );
    // A PAID order: the CANCELLED predicate's target is estornadoIntegralmente.
    expect(ex.h.db.ler(CAMINHO)?.estado).toBe('estornadoIntegralmente');
    const lote = ex.h.db.escritas.slice(escritasAntes).find((e) => e.lote !== undefined);
    const tumulo = avisoNfe(ex);
    expect(tumulo).toMatchObject({
      tipo: TIPO_AVISO.nfeUploadRejeitado,
      resolucaoMotivo: 'pedido-cancelado',
      relogioEvento: relogioDoDocumentoUs(lote?.writeTime ?? { seconds: 0, nanoseconds: 0 }),
    });
    expect(tumulo?.resolvidoEm).not.toBeNull();
    // A task that read the pedido BEFORE the import raises after it: dropped.
    const r = await avisarNfeAmazon(
      asDb(ex.h.db),
      { increment, nowMs: AGORA_MS },
      {
        integracaoId: CONTA_IMPORTADOR,
        pedidoId: PEDIDO_ID,
        numero: ORDER_ID_TESTE,
        motivo: 'nfe-recusada',
        relogio: { seconds: 0, nanoseconds: 0 },
      },
    );
    expect(r).toBe('ignorado');
    expect(avisoNfe(ex)?.resolvidoEm).not.toBeNull();
  });

  it('★ INTO a cancelled sale with an AUTHORIZED sale nfev4 ⇒ amz-nfe-pedido-cancelado, ONCE (the next cancelled import is no transition and reads no nfev4)', async () => {
    const ex = montar();
    await ex.importar(pedido({ status: 'UNSHIPPED', extra: comprador() }));
    ex.h.db.seed(`${CAMINHO}/nfev4/s1`, { estado: 'a', xml_nfe_proc: PROC });
    await ex.importar(
      pedido({ status: 'CANCELLED', atualizadoEm: depois(60), extra: comprador() }),
    );
    expect(incidente(ex, ID_INCIDENTE_NFE_PEDIDO_CANCELADO_AMAZON)).toMatchObject({
      subtipo: ID_INCIDENTE_NFE_PEDIDO_CANCELADO_AMAZON,
      origem: ORIGEM_INCIDENTE.outros,
      tipo: TIPO_INCIDENTE.outros,
    });
    expect(
      ex.h.db.escritasEm(`${CAMINHO}/incidentes/${ID_INCIDENTE_NFE_PEDIDO_CANCELADO_AMAZON}`),
    ).toHaveLength(1);
    const leituras = ex.h.db.leituras.length;
    const consultas = ex.h.db.consultas.length;
    await ex.importar(
      pedido({ status: 'CANCELLED', atualizadoEm: depois(120), extra: comprador() }),
    );
    expect(tocouNfe(ex, leituras, consultas)).toEqual({ leituras: [], consultas: [] });
    expect(
      ex.h.db.escritasEm(`${CAMINHO}/incidentes/${ID_INCIDENTE_NFE_PEDIDO_CANCELADO_AMAZON}`),
    ).toHaveLength(1);
  });

  it('NEAR-MISS: INTO a cancelled sale with only a CANCELLED or a homologação nfev4 ⇒ no incidente (the listing ran, ONCE)', async () => {
    const ex = montar();
    await ex.importar(pedido({ status: 'UNSHIPPED', extra: comprador() }));
    ex.h.db.seed(`${CAMINHO}/nfev4/s1`, { estado: 'c', xml_nfe_proc: PROC });
    ex.h.db.seed(`${CAMINHO}/nfev4/s9`, {
      estado: 'a',
      xml_nfe_proc: PROC.replace('<tpAmb>1</tpAmb>', '<tpAmb>2</tpAmb>'),
    });
    const consultas = ex.h.db.consultas.length;
    await ex.importar(
      pedido({ status: 'CANCELLED', atualizadoEm: depois(60), extra: comprador() }),
    );
    expect(incidente(ex, ID_INCIDENTE_NFE_PEDIDO_CANCELADO_AMAZON)).toBeUndefined();
    expect(
      ex.h.db.consultas.slice(consultas).filter((c) => c.colecao === `${CAMINHO}/nfev4`),
    ).toHaveLength(1);
  });

  it('★ the next import of the UNCHANGED order after the REAL stamp ⇒ sem-mudanca, ZERO writes (the nested order clock was carried)', async () => {
    const ex = montar();
    const corpo = pedido({ status: 'UNSHIPPED', extra: comNota('NOT_FOUND') });
    await ex.importar(corpo);
    const antes = frete(ex);
    expect(antes.estado).toBe('aguardandoNFe');
    expect(
      await carimbarFreteNfeAmazon(asDb(ex.h.db), PEDIDO_ID, AGORA_MS * 1000 + 1_000_000),
    ).toBe('carimbado');
    expect(frete(ex)).toMatchObject({
      estado: 'error',
      ultimaModificacao: antes.ultimaModificacao,
    });
    const escritas = ex.h.db.escritas.length;
    expect(await ex.importar(corpo)).toMatchObject({ kind: 'sem-mudanca' });
    expect(ex.h.db.escritas.slice(escritas).filter((e) => e.caminho === CAMINHO)).toEqual([]);
    expect(frete(ex).estado).toBe('error');
  });

  it('★ a PENDING_PICK_UP import OVERWRITES the NF-e stamp and resolves frete-despachado (clocked by the batch writeTime)', async () => {
    const ex = montar();
    await ex.importar(pedido({ status: 'UNSHIPPED', extra: comNota('NOT_FOUND') }));
    expect(frete(ex).estado).toBe('aguardandoNFe');
    carimbar(ex);
    const escritasAntes = ex.h.db.escritas.length;
    await ex.importar(
      pedido({
        status: 'UNSHIPPED',
        atualizadoEm: depois(60),
        extra: comNota('ACCEPTED'),
        pacotesBrutos: [pacoteAmazon('PKG-1', 'PENDING_PICK_UP')],
      }),
    );
    expect(frete(ex).estado).toBe('aguardandoPostagem');
    const lote = ex.h.db.escritas.slice(escritasAntes).find((e) => e.lote !== undefined);
    expect(avisoNfe(ex)).toMatchObject({
      resolucaoMotivo: 'frete-despachado',
      relogioEvento: relogioDoDocumentoUs(lote?.writeTime ?? { seconds: 0, nanoseconds: 0 }),
    });
    expect(avisoNfe(ex)?.resolvidoEm).not.toBeNull();
  });

  it('★ NEAR-MISS (mutation 12): a PENDING_SCHEDULE + ACCEPTED import KEEPS the stamp — the order-level ACCEPTED never clears it — and touches no NF-e row', async () => {
    const ex = montar();
    await ex.importar(pedido({ status: 'UNSHIPPED', extra: comNota('NOT_FOUND') }));
    carimbar(ex);
    const leituras = ex.h.db.leituras.length;
    const consultas = ex.h.db.consultas.length;
    await ex.importar(
      pedido({
        status: 'UNSHIPPED',
        atualizadoEm: depois(60),
        extra: comNota('ACCEPTED'),
        pacotesBrutos: [pacoteAmazon('PKG-1', 'PENDING_SCHEDULE')],
      }),
    );
    expect(frete(ex).estado).toBe('error');
    expect(tocouNfe(ex, leituras, consultas)).toEqual({ leituras: [], consultas: [] });
    expect(avisoNfe(ex)).toBeUndefined();
  });

  it('★ (mutation 13) an import that is NOT one of the two transitions reads no nfev4 and no nfeUploadRejeitado row — a create, an update, a redelivery, a later rung', async () => {
    const ex = montar();
    ex.h.db.seed(`${CAMINHO}/nfev4/s1`, { estado: 'a', xml_nfe_proc: PROC });
    const corpos = [
      pedido({ status: 'UNSHIPPED', extra: comNota('NOT_FOUND') }),
      pedido({ status: 'UNSHIPPED', atualizadoEm: depois(60), extra: comNota('ACCEPTED') }),
      pedido({ status: 'UNSHIPPED', atualizadoEm: depois(60), extra: comNota('ACCEPTED') }),
      pedido({
        status: 'SHIPPED',
        atualizadoEm: depois(120),
        extra: comNota('ACCEPTED'),
        pacotesBrutos: [pacoteAmazon('PKG-1', 'PICKED_UP')],
      }),
      pedido({
        status: 'SHIPPED',
        atualizadoEm: depois(180),
        extra: comNota('ACCEPTED'),
        pacotesBrutos: [pacoteAmazon('PKG-1', 'DELIVERED')],
      }),
    ];
    const tocou: ReturnType<typeof tocouNfe>[] = [];
    for (const [i, corpo] of corpos.entries()) {
      const leituras = ex.h.db.leituras.length;
      const consultas = ex.h.db.consultas.length;
      await ex.importar(corpo);
      // The 4th import moves the freight INTO the removal set: the one transition here.
      if (i !== 3) tocou.push(tocouNfe(ex, leituras, consultas));
    }
    expect(tocou).toEqual(Array.from({ length: 4 }, () => ({ leituras: [], consultas: [] })));
    // ÂNCORA: the 4th really was the transition, and still read no nfev4 (a frete one).
    expect(avisoNfe(ex)?.resolucaoMotivo).toBe('frete-despachado');
    expect(ex.h.db.leituras.filter((c) => c.includes('/nfev4'))).toEqual([]);
    expect(ex.h.db.consultas.filter((c) => c.colecao.includes('nfev4'))).toEqual([]);
  });

  it('the pure reader: an update INTO a cancelled sale (either estado) / INTO the removal set; NEAR-MISS a create, a sem-mudanca, a write that stays', () => {
    const base = {
      tipo: 'gravado',
      leitura: {} as never,
      writeTime: null,
      portador: false,
      portadorPagamento: false,
      tentativas: 1,
    } as const;
    const decisao = (estadoEscrito: string | null) => ({ estadoEscrito }) as never;
    const atualizar = (estadoEscrito: string | null, patch: Record<string, unknown>) =>
      ({ tipo: 'atualizar', patch, grupos: [], decisao: decisao(estadoEscrito) }) as never;
    const t = (g: Record<string, unknown>) =>
      transicoesNfeDoPedidoAmazon({ ...base, ...g } as never);
    const pago = { estado: 'pago', freteInicial: { estado: 'error' } };
    for (const terminal of ['cancelado', 'estornadoIntegralmente']) {
      expect(t({ armazenado: pago, escrita: atualizar(terminal, {}) }), terminal).toEqual({
        vendaCancelada: true,
        freteDespachado: false,
      });
    }
    expect(
      t({
        armazenado: pago,
        escrita: atualizar(null, { freteInicial: { estado: 'aguardandoPostagem' } }),
      }),
    ).toEqual({ vendaCancelada: false, freteDespachado: true });
    // NEAR-MISSES: from one terminal to the other is no transition INTO the pair.
    expect(
      t({ armazenado: { estado: 'cancelado' }, escrita: atualizar('estornadoIntegralmente', {}) }),
    ).toEqual({ vendaCancelada: false, freteDespachado: false });
    expect(
      t({
        armazenado: { estado: 'pago', freteInicial: { estado: 'postado' } },
        escrita: atualizar(null, { freteInicial: { estado: 'entregue' } }),
      }),
    ).toEqual({ vendaCancelada: false, freteDespachado: false });
    expect(
      t({
        armazenado: null,
        escrita: { tipo: 'criar', corpo: {}, decisao: decisao('cancelado') } as never,
      }),
    ).toEqual({ vendaCancelada: false, freteDespachado: false });
    expect(
      t({ tipo: 'sem-mudanca', armazenado: pago, escrita: atualizar('cancelado', {}) }),
    ).toEqual({ vendaCancelada: false, freteDespachado: false });
    expect(
      t({
        armazenado: pago,
        escrita: atualizar(null, { freteInicial: { estado: 'aguardandoAgendamento' } }),
      }),
    ).toEqual({ vendaCancelada: false, freteDespachado: false });
    expect(t({ armazenado: pago, escrita: atualizar('pago', {}) })).toEqual({
      vendaCancelada: false,
      freteDespachado: false,
    });
  });

  /* -- a REDELIVERY recovers 8b: the attempt that wrote the transition died after its commit -- */

  const ID_INC = ID_INCIDENTE_NFE_PEDIDO_CANCELADO_AMAZON;

  it('★ the cancel transition loses its nfev4 LISTING after the commit ⇒ the delivery throws; its retry (tentativa 1) answers sem-mudanca and STILL files the incidente — while a FIRST attempt of the same cancelled order reads no nfev4', async () => {
    const ex = montar();
    await ex.importar(pedido({ status: 'UNSHIPPED', extra: comprador() }));
    ex.h.db.seed(`${CAMINHO}/nfev4/s1`, { estado: 'a', xml_nfe_proc: PROC });
    const cancelado = pedido({ status: 'CANCELLED', atualizadoEm: depois(60), extra: comprador() });
    ex.h.db.falharConsulta(`${CAMINHO}/nfev4`, grpc(14, 'UNAVAILABLE'));
    await expect(ex.importar(cancelado)).rejects.toMatchObject({ code: 14 });
    ex.h.db.falharConsulta(`${CAMINHO}/nfev4`, null);
    expect(ex.h.db.ler(CAMINHO)?.estado).toBe('estornadoIntegralmente');
    expect(incidente(ex, ID_INC)).toBeUndefined();
    // NEAR-MISS (decision 8's hot path): a NEW delivery's first attempt is no transition.
    const leituras = ex.h.db.leituras.length;
    const consultas = ex.h.db.consultas.length;
    expect(await ex.importar(cancelado)).toMatchObject({ kind: 'sem-mudanca' });
    expect(tocouNfe(ex, leituras, consultas)).toEqual({ leituras: [], consultas: [] });
    expect(incidente(ex, ID_INC)).toBeUndefined();
    // The queue's retry of the failed delivery: 8b from the conditions the pedido holds.
    expect(await ex.importar(cancelado, { tentativa: 1 })).toMatchObject({ kind: 'sem-mudanca' });
    expect(incidente(ex, ID_INC)).toMatchObject({ subtipo: ID_INC });
    expect(avisoNfe(ex)).toMatchObject({ resolucaoMotivo: 'pedido-cancelado' });
    expect(avisoNfe(ex)?.resolvidoEm).not.toBeNull();
    // Idempotent: a second retry files nothing new.
    await ex.importar(cancelado, { tentativa: 2 });
    expect(ex.h.db.escritasEm(`${CAMINHO}/incidentes/${ID_INC}`)).toHaveLength(1);
  });

  it('★ the cancel transition loses its TOMBSTONE write after the commit ⇒ a sweep re-drive (tentativa null) writes the clocked resolve and files the incidente; a stale task raise is then dropped', async () => {
    const ex = montar();
    await ex.importar(pedido({ status: 'UNSHIPPED', extra: comprador() }));
    ex.h.db.seed(`${CAMINHO}/nfev4/s1`, { estado: 'a', xml_nfe_proc: PROC });
    const cancelado = pedido({ status: 'CANCELLED', atualizadoEm: depois(60), extra: comprador() });
    ex.h.db.falharEscrita(caminhoAviso(CHAVE_NFE), grpc(14, 'UNAVAILABLE'));
    await expect(ex.importar(cancelado)).rejects.toMatchObject({ code: 14 });
    ex.h.db.falharEscrita(caminhoAviso(CHAVE_NFE), null);
    expect(avisoNfe(ex)).toBeUndefined();
    expect(await ex.importar(cancelado, { tentativa: null })).toMatchObject({
      kind: 'sem-mudanca',
    });
    const tumulo = avisoNfe(ex);
    expect(tumulo).toMatchObject({ resolucaoMotivo: 'pedido-cancelado' });
    expect(tumulo?.resolvidoEm).not.toBeNull();
    expect(incidente(ex, ID_INC)).toMatchObject({ subtipo: ID_INC });
    const r = await avisarNfeAmazon(
      asDb(ex.h.db),
      { increment, nowMs: AGORA_MS },
      {
        integracaoId: CONTA_IMPORTADOR,
        pedidoId: PEDIDO_ID,
        numero: ORDER_ID_TESTE,
        motivo: 'nfe-recusada',
        relogio: { seconds: 0, nanoseconds: 0 },
      },
    );
    expect(r).toBe('ignorado');
  });

  it('★ the freight transition loses its frete-despachado resolve after the commit ⇒ the retry resolves it from the stored goods-out estado', async () => {
    const ex = montar();
    await ex.importar(pedido({ status: 'UNSHIPPED', extra: comNota('NOT_FOUND') }));
    carimbar(ex);
    ex.h.db.seed(caminhoAviso(CHAVE_NFE), {
      tipo: TIPO_AVISO.nfeUploadRejeitado,
      conta: CONTA_IMPORTADOR,
      entidade: PEDIDO_ID,
      severidade: 'atencao',
      canal: 'amazon',
      params: { pedido: ORDER_ID_TESTE, erro: 'x' },
      motivo: 'nfe-recusada',
      urlInterna: { rota: '/pedidos/x', campo: null },
      relogioEvento: 1,
      criadoEm: 1,
      atualizadoEm: 1,
      ocorrencias: 1,
      resolvidoEm: null,
      resolucaoMotivo: null,
    });
    const coleta = pedido({
      status: 'UNSHIPPED',
      atualizadoEm: depois(60),
      extra: comNota('ACCEPTED'),
      pacotesBrutos: [pacoteAmazon('PKG-1', 'PENDING_PICK_UP')],
    });
    ex.h.db.falharEscrita(caminhoAviso(CHAVE_NFE), grpc(14, 'UNAVAILABLE'));
    await expect(ex.importar(coleta)).rejects.toMatchObject({ code: 14 });
    ex.h.db.falharEscrita(caminhoAviso(CHAVE_NFE), null);
    expect(frete(ex).estado).toBe('aguardandoPostagem');
    expect(avisoNfe(ex)?.resolvidoEm).toBeNull();
    expect(await ex.importar(coleta, { tentativa: 1 })).toMatchObject({ kind: 'sem-mudanca' });
    expect(avisoNfe(ex)).toMatchObject({ resolucaoMotivo: 'frete-despachado' });
    expect(avisoNfe(ex)?.resolvidoEm).not.toBeNull();
  });

  it('NEAR-MISS: a retry of an order that is neither a cancelled sale nor goods-out reads no nfev4 and no NF-e row', async () => {
    const ex = montar();
    ex.h.db.seed(`${CAMINHO}/nfev4/s1`, { estado: 'a', xml_nfe_proc: PROC });
    const corpo = pedido({ status: 'UNSHIPPED', extra: comNota('NOT_FOUND') });
    await ex.importar(corpo);
    const leituras = ex.h.db.leituras.length;
    const consultas = ex.h.db.consultas.length;
    expect(await ex.importar(corpo, { tentativa: 3 })).toMatchObject({ kind: 'sem-mudanca' });
    expect(tocouNfe(ex, leituras, consultas)).toEqual({ leituras: [], consultas: [] });
  });

  it('the pure CONDITIONS reader: what the pedido is LEFT holding — the write where one was made, the stored value otherwise; never a create', () => {
    const base = {
      leitura: {} as never,
      writeTime: null,
      portador: false,
      portadorPagamento: false,
      tentativas: 1,
    } as const;
    const decisao = (estadoEscrito: string | null) => ({ estadoEscrito }) as never;
    const nenhuma = { tipo: 'nenhuma', decisao: decisao(null) } as never;
    const atualizar = (estadoEscrito: string | null, patch: Record<string, unknown>) =>
      ({ tipo: 'atualizar', patch, grupos: [], decisao: decisao(estadoEscrito) }) as never;
    const c = (g: Record<string, unknown>) =>
      condicoesNfeDoPedidoAmazon({ ...base, ...g } as never);
    for (const estado of ['cancelado', 'estornadoIntegralmente']) {
      expect(
        c({
          tipo: 'sem-mudanca',
          armazenado: { estado, freteInicial: { estado: 'aguardandoPostagem' } },
          escrita: nenhuma,
        }),
        estado,
      ).toEqual({ vendaCancelada: true, freteDespachado: true });
    }
    // NEAR-MISSES: a live sale whose goods are in; a written goods-in estado over a stored goods-out one.
    expect(
      c({
        tipo: 'sem-mudanca',
        armazenado: { estado: 'pago', freteInicial: { estado: 'aguardandoNFe' } },
        escrita: nenhuma,
      }),
    ).toEqual({ vendaCancelada: false, freteDespachado: false });
    expect(
      c({
        tipo: 'gravado',
        armazenado: { estado: 'pago', freteInicial: { estado: 'aguardandoPostagem' } },
        escrita: atualizar(null, { freteInicial: { estado: 'error' } }),
      }),
    ).toEqual({ vendaCancelada: false, freteDespachado: false });
    expect(
      c({
        tipo: 'gravado',
        armazenado: null,
        escrita: { tipo: 'criar', corpo: {}, decisao: decisao('cancelado') } as never,
      }),
    ).toEqual({ vendaCancelada: false, freteDespachado: false });
  });
});

/* ------------------------- step 15 (PR 15-c): E2 and the cancel seed ------------------------- */

/** A Delivery-by-Amazon order (MERCHANT + DELIVERY_BY_AMAZON), its invoice status beside the buyer. */
function pedidoDba(
  detalhe: string | null,
  opcoes: {
    status?: string;
    atualizadoEm?: string;
    invoiceStatus?: string;
    linhas?: readonly Record<string, unknown>[];
  } = {},
): Record<string, unknown> {
  const c = comprador();
  return pedido({
    status: opcoes.status ?? 'UNSHIPPED',
    programs: ['DELIVERY_BY_AMAZON'],
    atualizadoEm: opcoes.atualizadoEm,
    linhas: opcoes.linhas,
    pacotesBrutos:
      detalhe === null ? undefined : [pacoteAmazon('PKG-1', detalhe, { status: 'PENDING' })],
    extra: {
      ...c,
      tax: {
        ...(c.tax as Record<string, unknown>),
        taxInvoicing: { invoiceStatus: opcoes.invoiceStatus ?? 'ACCEPTED' },
      },
    },
  });
}

/** E2's task name for the import read at `watermarkUs`. */
const nomeE2 = (watermarkUs = ATUALIZADO_US) =>
  idDaTarefaDeAgendamentoAmazon({
    origem: ORIGEM_AGENDAMENTO_AMAZON.importacao,
    pedidoId: PEDIDO_ID,
    watermarkUs,
  });

const linhasDoAgendamento = (ex: Execucao) =>
  ex.h.log.linhas.filter((l) => l.meta?.evento === 'agendamento');

describe('★ step 15 (PR 15-c) — E2: the import enqueues the scheduling entry on a read whose decision is agendar', () => {
  it('★ PENDING_SCHEDULE + ACCEPTED ⇒ ONE enqueue: origem importacao, NO delay, named sha256("agendamento:importacao:" + pedidoId + ":" + watermarkUs) — and 8c makes ZERO Firestore operations', async () => {
    const ex = montar();
    let noEnfileiramento = -1;
    ex.h.agendamentos.aoEnfileirar = () => {
      noEnfileiramento = ex.h.db.operacoes;
    };
    const leituras = ex.h.db.leituras.length;
    const consultas = ex.h.db.consultas.length;
    expect(await ex.importar(pedidoDba('PENDING_SCHEDULE'))).toMatchObject({ kind: 'importado' });

    expect(ex.h.agendamentos.enfileiradas).toEqual([
      {
        tarefa: {
          pedidoId: PEDIDO_ID,
          contaId: CONTA_IMPORTADOR,
          orderId: ORDER_ID_TESTE,
          origem: 'importacao',
          espera: 0,
          pausas: 0,
        },
        id: nomeE2(),
        atrasoS: 0,
      },
    ]);
    // The ENQUEUE is the last thing the import does: not one Firestore operation after it…
    expect(noEnfileiramento).toBe(ex.h.db.operacoes);
    // …and E2 reads no nfev4 (the task's NF-e gate judges the documents).
    expect(ex.h.db.leituras.slice(leituras).filter((c) => c.includes('/nfev4'))).toEqual([]);
    expect(ex.h.db.consultas.slice(consultas).filter((c) => c.colecao.includes('nfev4'))).toEqual(
      [],
    );
    // A successful enqueue writes no line of its own.
    expect(linhasDoAgendamento(ex)).toEqual([]);

    // …nor one BEFORE it: the twin import of the same order whose read does not
    // schedule (the order-level invoice status still PROCESSING) never reaches
    // 8c, and reads, queries and writes EXACTLY the same documents outside
    // `avisos/` (the two reads' per-pedido motivos legitimately differ there).
    // A cold conta cache for the twin too, as each test starts with.
    __resetAllReadCaches();
    const gemea = montar();
    await gemea.importar(pedidoDba('PENDING_SCHEDULE', { invoiceStatus: 'PROCESSING' }));
    expect(gemea.h.agendamentos.tentativas).toEqual([]);
    const foraDeAvisos = (db: typeof ex.h.db) => ({
      leituras: db.leituras.filter((p) => !p.startsWith('avisos/')),
      consultas: db.consultas.map((c) => c.colecao),
      escritas: db.escritas.map((w) => w.caminho).filter((p) => !p.startsWith('avisos/')),
    });
    expect(foraDeAvisos(ex.h.db)).toEqual(foraDeAvisos(gemea.h.db));
    expect(foraDeAvisos(ex.h.db).leituras).toContain(CAMINHO);
  });

  it('★ the SAME read again (sem-mudanca, a redelivery) enqueues too — under the SAME name, so it dedupes (ONE INFO line); a NEWER read lands under its own', async () => {
    const ex = montar();
    const corpo = pedidoDba('PENDING_SCHEDULE');
    await ex.importar(corpo);
    expect(await ex.importar(corpo, { tentativa: 1 })).toMatchObject({ kind: 'sem-mudanca' });
    expect(ex.h.agendamentos.tentativas.map((t) => t.id)).toEqual([nomeE2(), nomeE2()]);
    expect(ex.h.agendamentos.enfileiradas).toHaveLength(1);
    expect(linhasDoAgendamento(ex)).toEqual([
      expect.objectContaining({
        nivel: 'info',
        meta: expect.objectContaining({
          motivo: 'ja-enfileirada',
          origem: 'importacao',
          // The line belongs to the import that observed: its attempt, handed on.
          tentativa: 1,
        }) as unknown,
      }),
    ]);

    await ex.importar(pedidoDba('PENDING_SCHEDULE', { atualizadoEm: depois(60) }));
    expect(ex.h.agendamentos.enfileiradas.map((t) => t.id)).toEqual([
      nomeE2(),
      nomeE2(ATUALIZADO_US + 60_000_000),
    ]);
  });

  it('★ ★ (mutation 3) THE TOMBSTONE CASE: the queue holds an E1 task’s name for about an hour after it RAN, whatever that task concluded (its waits exhausted, the valve off) — the E2 import within that hour still creates a NEW task under its OWN name', async () => {
    const ex = montar();
    // The E1 entry went through the SAME queue, which keeps the name it was given.
    await enfileirarAgendamentoDoAceiteAmazon(
      { contaId: CONTA_IMPORTADOR, pedidoId: PEDIDO_ID, nfeId: 's1', orderId: ORDER_ID_TESTE },
      {
        agendamento: ex.h.agendamentos.produtor,
        logger: ex.h.log.logger,
        idTarefa: 'tarefa-nfe-1',
        ultimaTentativa: false,
      },
    );
    const nomeE1 = idDaTarefaDeAgendamentoAmazon({
      origem: ORIGEM_AGENDAMENTO_AMAZON.aceiteNfe,
      idTarefaNfe: 'tarefa-nfe-1',
    });
    expect(ex.h.agendamentos.nomes.has(nomeE1)).toBe(true);

    await ex.importar(pedidoDba('PENDING_SCHEDULE'));
    expect(ex.h.agendamentos.enfileiradas.map((t) => [t.id, t.tarefa.origem])).toEqual([
      [nomeE1, 'aceite-nfe'],
      [nomeE2(), 'importacao'],
    ]);
    expect(linhasDoAgendamento(ex)).toEqual([]);
  });

  it.each<[string, Record<string, unknown>]>([
    [
      'PENDING_SCHEDULE + PROCESSING',
      pedidoDba('PENDING_SCHEDULE', { invoiceStatus: 'PROCESSING' }),
    ],
    [
      'PENDING_SCHEDULE + NOT_REQUIRED (only ACCEPTED schedules)',
      pedidoDba('PENDING_SCHEDULE', { invoiceStatus: 'NOT_REQUIRED' }),
    ],
    ['PENDING_PICK_UP (already scheduled)', pedidoDba('PENDING_PICK_UP')],
    [
      'an open cancellation request',
      pedidoDba('PENDING_SCHEDULE', {
        linhas: [linhaAmazon('L1', { qtd: 2, preco: '10.00', solicitacao: true })],
      }),
    ],
    [
      'not Delivery by Amazon (the same order without the program)',
      pedido({
        status: 'UNSHIPPED',
        pacotesBrutos: [pacoteAmazon('PKG-1', 'PENDING_SCHEDULE', { status: 'PENDING' })],
        invoiceStatus: 'ACCEPTED',
      }),
    ],
  ])('★ NEAR-MISS: %s enqueues NOTHING', async (_c, corpo) => {
    const ex = montar();
    await ex.importar(corpo);
    expect(ex.h.agendamentos.tentativas).toEqual([]);
    expect(ex.h.agendamentos.construcoes).toBe(0);
  });

  it('★ NEAR-MISS: CANCELLED (ACCEPTED survives a cancellation) enqueues nothing', async () => {
    const ex = montar();
    await ex.importar(pedidoDba('PENDING_SCHEDULE', { invoiceStatus: 'PROCESSING' }));
    await ex.importar(
      pedidoDba('PENDING_SCHEDULE', { status: 'CANCELLED', atualizadoEm: depois(60) }),
    );
    expect(ex.h.db.ler(CAMINHO)?.estado).toBe('estornadoIntegralmente');
    expect(ex.h.agendamentos.tentativas).toEqual([]);
  });

  it('★ obsoleto enqueues nothing (an older read than the pedido holds writes nothing at all)', async () => {
    const ex = montar();
    await ex.importar(pedidoDba('PENDING_SCHEDULE', { atualizadoEm: depois(60) }));
    expect(ex.h.agendamentos.tentativas).toHaveLength(1);
    expect(await ex.importar(pedidoDba('PENDING_SCHEDULE'))).toEqual({ kind: 'obsoleto' });
    expect(ex.h.agendamentos.tentativas).toHaveLength(1);
  });

  it('★ obsoleto found by the BATCH (a newer import committed between this read and its batch) enqueues nothing either — that newer import ran its own 8c', async () => {
    // Control: the same schedulable read, with no newer writer, DOES enqueue.
    const controle = montar();
    await controle.importar(pedidoDba('PENDING_SCHEDULE', { invoiceStatus: 'PROCESSING' }));
    await controle.importar(pedidoDba('PENDING_SCHEDULE', { atualizadoEm: depois(60) }));
    expect(controle.h.agendamentos.tentativas).toHaveLength(1);

    const ex = montar();
    await ex.importar(pedidoDba('PENDING_SCHEDULE', { invoiceStatus: 'PROCESSING' }));
    expect(ex.h.agendamentos.tentativas).toEqual([]);
    // Another importer commits a NEWER Amazon read right before this batch.
    ex.h.db.antesDaProximaEscrita(CAMINHO, () => {
      const atual = ex.h.db.ler(CAMINHO) ?? {};
      ex.h.db.seed(CAMINHO, { ...atual, lastMarketplaceUpdate: ATUALIZADO_US + 600_000_000 });
    });
    expect(await ex.importar(pedidoDba('PENDING_SCHEDULE', { atualizadoEm: depois(60) }))).toEqual({
      kind: 'obsoleto',
    });
    expect(ex.h.agendamentos.tentativas).toEqual([]);
    expect(ex.h.agendamentos.construcoes).toBe(0);
  });

  it('★ the tasks valve closed ⇒ ONE WARNING and the import result unchanged (importado, the pedido written)', async () => {
    const ex = montar();
    ex.h.agendamentos.desligado = true;
    expect(await ex.importar(pedidoDba('PENDING_SCHEDULE'))).toMatchObject({ kind: 'importado' });
    expect(ex.h.db.ler(CAMINHO)?.freteInicial).toMatchObject({ estado: 'aguardandoAgendamento' });
    expect(linhasDoAgendamento(ex)).toEqual([
      expect.objectContaining({
        nivel: 'warn',
        meta: expect.objectContaining({
          motivo: 'agendamento-nao-enfileirado',
          erro: 'AmazonAgendamentoTarefasDesligadasError',
        }) as unknown,
      }),
    ]);
  });

  it('★ a TRANSIENT THROWS out of the post-commit step (the import’s own retry); the retry does not re-write the batch and enqueues under the SAME name', async () => {
    const ex = montar();
    const corpo = pedidoDba('PENDING_SCHEDULE');
    ex.h.agendamentos.falha = () => falhaDoFunctions('unknown-error', 503);
    await expect(ex.importar(corpo)).rejects.toBeInstanceOf(AmazonTarefasTransitoriasError);
    // The batch HAD committed: the throw came after it.
    expect(ex.h.db.ler(CAMINHO)?.freteInicial).toMatchObject({ estado: 'aguardandoAgendamento' });
    const escritasDoPedido = ex.h.db.escritasEm(CAMINHO).length;

    ex.h.agendamentos.falha = null;
    expect(await ex.importar(corpo, { tentativa: 1 })).toMatchObject({ kind: 'sem-mudanca' });
    expect(ex.h.db.escritasEm(CAMINHO)).toHaveLength(escritasDoPedido);
    expect(ex.h.agendamentos.tentativas.map((t) => t.id)).toEqual([nomeE2(), nomeE2()]);
    expect(ex.h.agendamentos.enfileiradas.map((t) => t.id)).toEqual([nomeE2()]);
  });

  it('★ (mutation 11) THE STAMP CASE: the stored freight `error` kept (gate 5), the order-level ACCEPTED ⇒ E2 enqueues — keyed on the READ, never on a freight transition', async () => {
    const ex = montar();
    await ex.importar(pedidoDba(null, { invoiceStatus: 'NOT_FOUND' }));
    expect(ex.h.agendamentos.tentativas).toEqual([]);
    const doc = ex.h.db.ler(CAMINHO) ?? {};
    ex.h.db.seed(CAMINHO, {
      ...doc,
      freteInicial: { ...(doc.freteInicial as Record<string, unknown>), estado: 'error' },
    });
    await ex.importar(pedidoDba('PENDING_SCHEDULE', { atualizadoEm: depois(60) }));
    // No freight transition: the stamp stands…
    expect((ex.h.db.ler(CAMINHO)?.freteInicial as Record<string, unknown>).estado).toBe('error');
    // …and the read still schedules.
    expect(ex.h.agendamentos.enfileiradas.map((t) => t.id)).toEqual([
      nomeE2(ATUALIZADO_US + 60_000_000),
    ]);
  });

  it('★ the PARTIAL-ACCEPTANCE case (step-15 plan §3 decision 27): step 14 ended nfe-parcialmente-aceita (an open nfeUploadRejeitado row, one aprovada note) and the order reads PENDING_SCHEDULE + ACCEPTED ⇒ E2 enqueues', async () => {
    const ex = montar();
    await ex.importar(pedidoDba(null, { invoiceStatus: 'PROCESSING' }));
    ex.h.db.seed(`${CAMINHO}/nfev4/s1`, {
      estado: 'a',
      xml_nfe_proc:
        '<nfeProc><NFe><infNFe><ide><tpAmb>1</tpAmb><tpNF>1</tpNF><finNFe>1</finNFe></ide>' +
        '</infNFe></NFe></nfeProc>',
    });
    expect(
      await avisarNfeAmazon(
        asDb(ex.h.db),
        { increment, nowMs: AGORA_MS },
        {
          integracaoId: CONTA_IMPORTADOR,
          pedidoId: PEDIDO_ID,
          numero: ORDER_ID_TESTE,
          motivo: 'nfe-parcialmente-aceita',
          relogio: { seconds: 1, nanoseconds: 0 },
        },
      ),
    ).not.toBe('ignorado');
    await ex.importar(pedidoDba('PENDING_SCHEDULE', { atualizadoEm: depois(60) }));
    expect(ex.h.agendamentos.enfileiradas.map((t) => t.id)).toEqual([
      nomeE2(ATUALIZADO_US + 60_000_000),
    ]);
    // The step-14 row is not the import's to touch here.
    expect(
      ex.h.db.ler(caminhoAviso(chaveAvisoNfeAmazon(CONTA_IMPORTADOR, PEDIDO_ID)))?.resolvidoEm,
    ).toBeNull();
  });
});

describe('★ step 15 (PR 15-c) — the cancel SEED: a cancelled sale seeds a resolved row of BOTH scheduling motivos', () => {
  const AGENDAMENTO = [
    MOTIVO_PEDIDO_AMAZON.dimensoesAusentes,
    MOTIVO_PEDIDO_AMAZON.agendamentoRecusado,
  ] as const;
  const caminhoDo = (m: (typeof AGENDAMENTO)[number]) =>
    caminhoAviso(chavePedidoPrecisaAtencao(CONTA_IMPORTADOR, ORDER_ID_TESTE, m));

  /**
   * The scheduling task's raise of `motivo` (`agendamento/processarAgendamento.ts`'s
   * `sincronizar`), clocked by its older A3 read; the real task runs the same race end
   * to end in `processarAgendamento.test.ts`.
   */
  function levantarDaTarefa(
    ex: Execucao,
    motivo: (typeof AGENDAMENTO)[number],
    relogio: { readonly seconds: number; readonly nanoseconds: number },
  ) {
    return sincronizarAvisosDoPedidoAmazon(
      asDb(ex.h.db),
      { increment, nowMs: AGORA_MS, logger: ex.h.log.logger },
      {
        integracaoId: CONTA_IMPORTADOR,
        orderId: ORDER_ID_TESTE,
        pedidoId: PEDIDO_ID,
        levantar: [motivo],
        resolver: [],
        relogio,
      },
    );
  }

  /** The cancellation read of a DBA order. */
  const cancelamento = (segundos = 60) =>
    pedidoDba(null, {
      status: 'CANCELLED',
      atualizadoEm: depois(segundos),
      invoiceStatus: 'ACCEPTED',
    });

  it.each<[string, () => Record<string, unknown>, string]>([
    ['a PENDING order cancelled ⇒ cancelado', () => pedido({ status: 'PENDING' }), 'cancelado'],
    [
      'a PAID order cancelled ⇒ estornadoIntegralmente',
      () => pedidoDba('PENDING_SCHEDULE', { invoiceStatus: 'PROCESSING' }),
      'estornadoIntegralmente',
    ],
  ])(
    '★ (mutation 12) %s: the transition SEEDS a RESOLVED row for BOTH motivos when none exists — two aviso documents, clocked by the batch writeTime, never open',
    async (_c, antes, estado) => {
      const ex = montar();
      await ex.importar(antes());
      for (const m of AGENDAMENTO) expect(ex.h.db.ler(caminhoDo(m)), m).toBeUndefined();
      const escritasAntes = ex.h.db.escritas.length;
      await ex.importar(cancelamento());
      expect(ex.h.db.ler(CAMINHO)?.estado).toBe(estado);
      const lote = ex.h.db.escritas.slice(escritasAntes).find((e) => e.lote !== undefined);
      expect(lote).toBeDefined();
      for (const m of AGENDAMENTO) {
        const escritas = ex.h.db.escritas
          .slice(escritasAntes)
          .filter((e) => e.caminho === caminhoDo(m));
        expect(
          escritas.map((e) => e.verbo),
          m,
        ).toEqual(['create']);
        expect(ex.h.db.ler(caminhoDo(m)), m).toMatchObject({
          tipo: TIPO_AVISO.amazonPedidoPrecisaAtencao,
          motivo: m,
          severidade: 'critico',
          resolucaoMotivo: 'condicao-encerrada',
          relogioEvento: relogioDoDocumentoUs(lote?.writeTime ?? { seconds: 0, nanoseconds: 0 }),
        });
        expect(ex.h.db.ler(caminhoDo(m))?.resolvidoEm, m).not.toBeNull();
      }
    },
  );

  it('★ ★ THE RACE (step-15 plan §2.1): the task’s A3 read, then a CANCELLED import commits, then the task’s refusal raise clocked by the OLDER A3 read ⇒ ignorado, no open row; NEAR-MISS: without the seed (an absent row) the same raise opens a critico row', async () => {
    const ex = montar();
    await ex.importar(pedidoDba('PENDING_SCHEDULE'));
    // The task's A3 pedido read: older than the cancellation's commit.
    const a3 = ex.h.db.escritasEm(CAMINHO)[0]?.writeTime;
    expect(a3).toBeDefined();
    await ex.importar(cancelamento());
    // Amazon answered the bulk InvalidOrderState: the task raises agendamento-recusado.
    expect(await levantarDaTarefa(ex, MOTIVO_PEDIDO_AMAZON.agendamentoRecusado, a3!)).toMatchObject(
      { levantados: 0 },
    );
    for (const m of AGENDAMENTO) expect(ex.h.db.ler(caminhoDo(m))?.resolvidoEm, m).not.toBeNull();

    // NEAR-MISS: the same race where the cancel import left no row (an only-existing-row resolve).
    const semSemente = montar();
    await semSemente.importar(pedidoDba('PENDING_SCHEDULE'));
    const a3b = semSemente.h.db.escritasEm(CAMINHO)[0]?.writeTime;
    await semSemente.importar(cancelamento());
    for (const m of AGENDAMENTO) semSemente.h.db.apagar(caminhoDo(m));
    expect(
      await levantarDaTarefa(semSemente, MOTIVO_PEDIDO_AMAZON.agendamentoRecusado, a3b!),
    ).toMatchObject({ levantados: 1 });
    expect(semSemente.h.db.ler(caminhoDo(MOTIVO_PEDIDO_AMAZON.agendamentoRecusado))).toMatchObject({
      severidade: 'critico',
      resolvidoEm: null,
    });
  });

  it('★ a REDELIVERY on a pedido already cancelled seeds too (8b’s conditions rule): the first attempt lost the seed after its commit, the retry writes it', async () => {
    const ex = montar();
    await ex.importar(pedidoDba('PENDING_SCHEDULE', { invoiceStatus: 'PROCESSING' }));
    const alvo = caminhoDo(MOTIVO_PEDIDO_AMAZON.dimensoesAusentes);
    ex.h.db.falharEscrita(alvo, grpc(14, 'UNAVAILABLE'));
    await expect(ex.importar(cancelamento())).rejects.toMatchObject({ code: 14 });
    ex.h.db.falharEscrita(alvo, null);
    expect(ex.h.db.ler(alvo)).toBeUndefined();
    expect(ex.h.db.ler(CAMINHO)?.estado).toBe('estornadoIntegralmente');

    expect(await ex.importar(cancelamento(), { tentativa: 1 })).toMatchObject({
      kind: 'sem-mudanca',
    });
    for (const m of AGENDAMENTO) {
      expect(ex.h.db.ler(caminhoDo(m)), m).toMatchObject({ resolucaoMotivo: 'condicao-encerrada' });
      expect(ex.h.db.ler(caminhoDo(m))?.resolvidoEm, m).not.toBeNull();
    }
  });

  it('NEAR-MISS (the hot path): a FIRST attempt over a pedido ALREADY cancelled is no transition — it seeds nothing', async () => {
    const ex = montar();
    await ex.importar(pedidoDba('PENDING_SCHEDULE', { invoiceStatus: 'PROCESSING' }));
    ex.h.db.seed(CAMINHO, { ...(ex.h.db.ler(CAMINHO) ?? {}), estado: 'cancelado' });
    await ex.importar(
      pedidoDba('PENDING_SCHEDULE', { atualizadoEm: depois(60), invoiceStatus: 'PROCESSING' }),
    );
    for (const m of AGENDAMENTO) expect(ex.h.db.ler(caminhoDo(m)), m).toBeUndefined();
  });

  it('★ NEAR-MISS (where the seed STOPS): the goods-out transition is no cancelled sale, so it seeds neither motivo', async () => {
    const ex = montar();
    await ex.importar(pedidoDba('PENDING_SCHEDULE'));
    await ex.importar(pedidoDba('PENDING_PICK_UP', { atualizadoEm: depois(60) }));
    for (const m of AGENDAMENTO) expect(ex.h.db.ler(caminhoDo(m)), m).toBeUndefined();
  });

  it('★ no import ever RAISES either motivo: E2 reads, the cancel seed and a re-import leave no OPEN scheduling row', async () => {
    const ex = montar();
    const leituras = [
      pedidoDba('PENDING_SCHEDULE'),
      pedidoDba('PENDING_SCHEDULE', { atualizadoEm: depois(30) }),
      cancelamento(60),
      cancelamento(90),
    ];
    for (const corpo of leituras) {
      await ex.importar(corpo);
      for (const m of AGENDAMENTO) {
        const linha = ex.h.db.ler(caminhoDo(m));
        if (linha !== undefined) expect(linha.resolvidoEm, m).not.toBeNull();
      }
    }
    // Anti-vacuity: the cancellation did seed both.
    for (const m of AGENDAMENTO) expect(ex.h.db.ler(caminhoDo(m)), m).toBeDefined();
  });
});
