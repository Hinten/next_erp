/**
 * Captures C5 (the order detail, `GET /v1/pedido/{numero}/`) and the owner's
 * situação-history captures (`GET /v1/situacao_historico/search/`), read
 * through the order import's OWN wire schemas (master-plan step 5, PR 5-a):
 * `liPedidoSchema`, and the history page as `listarHistoricoSituacaoLi` decodes
 * it.
 *
 * The package's schema tests run on an invented copy of the captured shape;
 * this file is what keeps the schemas confirmed against the real corpus:
 *
 *  - every capture parses, and each one answers the numero it was asked for
 *    (the detail by its path, every history row by the `numero` filter);
 *  - an empty string `''` put at ANY leaf of a captured body (one leaf at a
 *    time, every key at every depth, undeclared ones included) is refused only
 *    on the required set, at its own path, and every other leaf reads it as
 *    `null` or keeps it as `''`. So a leaf added to the schema with an idiom
 *    that refuses the provider's "nothing" fails here by construction, as long
 *    as a capture carries it.
 *
 * And, since PR 5-b, every committed capture mapped END TO END through the
 * import's pure mappers (`pedidos/*Mapeamento.ts`, `estadoPedidoLi.ts`,
 * `orderIdsLi.ts`): the estado verdict (the cancelled order against its own
 * history, the shipped history against a synthetic detail of its numero), the
 * ids, the lines and their money, the buyer and the address, the freight
 * routing from a raw `mapa`, and the payments — plus the payment-method
 * catalogues and the 404. Nothing here depends on `itens[].produto`, which the
 * sanitized captures fake. The totals cross-check is `totaisPedido.test.ts`.
 *
 * ⚠️ Every assertion is a boolean, a count or a set of KEY paths, labelled with
 * the fixture name, so a failure never prints a body value (the
 * `wireCorpus.test.ts` convention), and a Zod error is never printed: it can
 * quote the value it refused. An ERP-side value this import computes (an
 * estado, a forma, a status code) may be compared directly. Fixtures are read
 * only through the corpus loader.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { roundReais } from '@delfrance/core/money';
import {
  CAMINHO_HISTORICO_SITUACAO_LI,
  LiNotFoundError,
  buscarPedidoLi,
  criarClienteLeituraLi,
  liEnvelopeSchema,
  liPedidoSchema,
  liSituacaoHistoricoLinhaSchema,
  type PedidoLi,
  type SituacaoHistoricoLinhaLi,
} from '@delfrance/integrations-loja-integrada';
import {
  ESTADO_FRETE,
  ESTADO_PEDIDO,
  FORMA_PAGAMENTO,
  INTEGRACAO_FRETE,
  MODALIDADE_FRETE,
  STATUS_PAGAMENTO,
  chaveFormaEnvioLi,
  montarEntradaDoMapaLi,
  pagamentoSchema,
  pedidoSchema,
} from '@delfrance/schemas';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  DIRETORIO_WIRE_LI,
  type EnvelopeFixtureLi,
  lerFixtureLi,
  listarArquivosDoCorpusLi,
} from '../fixtures/wireCorpus';
import { classificarFalhaLi } from '../notificacoes/notificacao';
import { FakeDb, asDb, increment } from '../testing/fakeDb';
import { clienteDoPedidoLi, enderecoDoPedidoLi } from './clienteMapeamento';
import { dataLiParaMicros, lerDataLi } from './dataLi';
import {
  LACUNA_HISTORICO_LI,
  MODO_HISTORICO_LI,
  lerHistoricoLi,
  type LeituraHistoricoLi,
  type ModoHistoricoLi,
} from './estadoPedidoLi';
import { decidirMapaLi, mapearFreteLi, rotearFreteLi } from './freteMapeamento';
import { idLiDoProdutoPai, mapearItensLi, referenciasDeProdutoLi } from './itensMapeamento';
import { idPedidoLi } from './orderIdsLi';
import {
  formaPagamentoLi,
  mapearPagamentosLi,
  montarEscritaPagamentoLi,
} from './pagamentoMapeamento';
import { mapearPedidoLi, montarEscritaPedidoLi } from './pedidoMapeamento';

/** Every order-detail capture in the corpus (the 404 one is not a body). */
const PEDIDOS = [
  'pedido-aguardando.json',
  'pedido-boleto.json',
  'pedido-cancelado.json',
  'pedido-cartao.json',
  'pedido-pix.json',
] as const;

/** Every situação-history capture in the corpus. */
const HISTORICOS = ['historico-pedido-cancelado.json', 'historico-pedido-enviado.json'] as const;

/**
 * The history rows across {@link HISTORICOS}: the observed count, so a row that
 * disappears fails here instead of silently shrinking what the sweep covers.
 */
const MINIMO_DE_LINHAS_DE_HISTORICO = 5;

/**
 * Where `''` must still be refused in an order body, with a list entry written
 * `*`: the required set, and an entry of a list (an object, never "nothing").
 */
const ESTRITOS_PEDIDO = new Set([
  'numero',
  'situacao',
  'itens',
  'itens.*',
  'envios',
  'envios.*',
  'pagamentos',
  'pagamentos.*',
]);

/** Where `''` must still be refused in a history row: its required set. */
const ESTRITOS_LINHA = new Set(['id', 'numero', 'situacao']);

/** The history page exactly as the listing decodes it (`paginarLi`). */
const paginaDoHistorico = liEnvelopeSchema(liSituacaoHistoricoLinhaSchema);

/** The body's rows as they are on disk, before any schema touched them. */
const corpoBruto = z.object({ objects: z.array(z.unknown()) }).passthrough();

type Caminho = readonly (string | number)[];

/** A capture, through the corpus loader. */
function captura(nome: string): EnvelopeFixtureLi {
  if (!listarArquivosDoCorpusLi().includes(nome)) {
    throw new Error(`${nome}: missing from the corpus`);
  }
  const leitura = lerFixtureLi(readFileSync(join(DIRETORIO_WIRE_LI, nome), 'utf8'));
  // ⚠️ Never print a failed reading: its `nao-json` arm carries the raw text.
  if (!leitura.ok) throw new Error(`${nome}: not a valid fixture envelope`);
  return leitura.data;
}

/** Every key path of a JSON value: each object key and each list index, at every depth. */
function caminhosDoCorpo(v: unknown, prefixo: Caminho = []): Caminho[] {
  const filhos: [string | number, unknown][] = Array.isArray(v)
    ? v.map((x, i) => [i, x])
    : v !== null && typeof v === 'object'
      ? Object.entries(v)
      : [];
  return filhos.flatMap(([chave, x]) => {
    const caminho = [...prefixo, chave];
    return [caminho, ...caminhosDoCorpo(x, caminho)];
  });
}

/** `corpo` with its leaf at `caminho` set to `valor`, as a deep copy. */
function comFolha(corpo: unknown, caminho: Caminho, valor: unknown): unknown {
  const copia = structuredClone(corpo);
  let alvo = copia as Record<string | number, unknown>;
  for (const seg of caminho.slice(0, -1)) alvo = alvo[seg] as Record<string | number, unknown>;
  alvo[caminho[caminho.length - 1]!] = valor;
  return copia;
}

function folha(corpo: unknown, caminho: Caminho): unknown {
  let v = corpo;
  for (const seg of caminho) v = (v as Record<string | number, unknown>)[seg];
  return v;
}

/** A path with every list index written `*`, so one set covers every entry. */
const nomeDe = (caminho: Caminho): string =>
  caminho.map((s) => (typeof s === 'number' ? '*' : s)).join('.');

/**
 * Puts `''` at every key path of `corpo`, one at a time, and parses. Returns
 * the paths refused (indices as `*`) and every path that broke the contract: a
 * refusal must name only that path, and a parse must read the leaf as `null`
 * (folded) or keep it as `''` (text).
 */
function varrerVazios(schema: z.ZodType, corpo: unknown) {
  const recusados = new Set<string>();
  const problemas = new Set<string>();
  for (const caminho of caminhosDoCorpo(corpo)) {
    const r = schema.safeParse(comFolha(corpo, caminho, ''));
    if (!r.success) {
      recusados.add(nomeDe(caminho));
      const onde = r.error.issues.map((i) => i.path.join('.'));
      if (onde.length !== 1 || onde[0] !== caminho.join('.')) {
        problemas.add(`${nomeDe(caminho)}: refused elsewhere`);
      }
      continue;
    }
    const lido = folha(r.data, caminho);
    if (lido !== null && lido !== '')
      problemas.add(`${nomeDe(caminho)}: read as neither null nor ''`);
  }
  return { recusados, problemas };
}

/** The `numero` a capture's request asked for, from its path or its filter. */
function numeroPedido(e: EnvelopeFixtureLi): string | undefined {
  const doCaminho = /^\/v1\/pedido\/([1-9][0-9]*)\/$/.exec(e.requisicao.caminho)?.[1];
  return doCaminho ?? e.requisicao.query.find(([k]) => k === 'numero')?.[1];
}

describe('capture C5: the order-detail captures', () => {
  it('are all in the corpus, and each is the detail GET, answered 200 with a JSON body', () => {
    for (const nome of PEDIDOS) {
      const e = captura(nome);
      expect(e.requisicao.metodo === 'GET', `${nome} metodo`).toBe(true);
      expect(numeroPedido(e) !== undefined, `${nome} caminho`).toBe(true);
      expect(e.resposta.status === 200 && e.resposta.forma === 'json', `${nome} status`).toBe(true);
    }
  });

  it('every body passes `liPedidoSchema`, and answers the numero its path asked for', () => {
    for (const nome of PEDIDOS) {
      const e = captura(nome);
      const r = liPedidoSchema.safeParse(e.resposta.corpo);
      expect(r.success, `${nome} schema`).toBe(true);
      expect(r.success && String(r.data.numero) === numeroPedido(e), `${nome} numero`).toBe(true);
    }
  });

  it("'' at any leaf is refused only on the required set, at its own path; any other leaf reads null or ''", () => {
    for (const nome of PEDIDOS) {
      const { recusados, problemas } = varrerVazios(liPedidoSchema, captura(nome).resposta.corpo);
      expect([...problemas], `${nome} problemas`).toEqual([]);
      expect(recusados, `${nome} recusados`).toEqual(ESTRITOS_PEDIDO);
    }
  });
});

describe('the situação-history captures', () => {
  it('are all in the corpus, and each is the listing GET filtered by numero, answered 200', () => {
    expect(listarArquivosDoCorpusLi().filter((a) => a.startsWith('historico-'))).toEqual([
      ...HISTORICOS,
    ]);
    for (const nome of HISTORICOS) {
      const e = captura(nome);
      expect(e.requisicao.metodo === 'GET', `${nome} metodo`).toBe(true);
      expect(e.requisicao.caminho === CAMINHO_HISTORICO_SITUACAO_LI, `${nome} caminho`).toBe(true);
      expect(numeroPedido(e) !== undefined, `${nome} filtro`).toBe(true);
      expect(e.resposta.status === 200 && e.resposta.forma === 'json', `${nome} status`).toBe(true);
    }
  });

  it('every page passes the listing’s page schema, and every row is about the numero filtered on', () => {
    let linhas = 0;
    for (const nome of HISTORICOS) {
      const e = captura(nome);
      const r = paginaDoHistorico.safeParse(e.resposta.corpo);
      expect(r.success, `${nome} schema`).toBe(true);
      if (!r.success) continue;
      r.data.objects.forEach((linha, i) => {
        expect(String(linha.numero) === numeroPedido(e), `${nome} objects[${String(i)}]`).toBe(
          true,
        );
      });
      linhas += r.data.objects.length;
    }
    expect(linhas).toBeGreaterThanOrEqual(MINIMO_DE_LINHAS_DE_HISTORICO);
  });

  it("'' at any leaf of a row is refused only on `id`, `numero` and `situacao`, at its own path", () => {
    for (const nome of HISTORICOS) {
      const brutas = corpoBruto.safeParse(captura(nome).resposta.corpo);
      if (!brutas.success) throw new Error(`${nome}: no objects array`);
      brutas.data.objects.forEach((bruta, i) => {
        const rotulo = `${nome} objects[${String(i)}]`;
        const { recusados, problemas } = varrerVazios(liSituacaoHistoricoLinhaSchema, bruta);
        expect([...problemas], `${rotulo} problemas`).toEqual([]);
        expect(recusados, `${rotulo} recusados`).toEqual(ESTRITOS_LINHA);
      });
    }
  });
});

/* -------------------------------------------------------------------------- */
/*              PR 5-b: every capture through the pure mappers                 */
/* -------------------------------------------------------------------------- */

const CONTA = 'CONTA1';
const INT_FRETE_LI = 'lojaIntegrada-CONTA1';
const REF_INT_FRETE_LI = 'documents/int_frete/lojaIntegrada-CONTA1';
const AGORA_US = 1_900_000_000_000_000;

/** A detail capture, through the import's own schema. */
function detalhe(nome: string): PedidoLi {
  const r = liPedidoSchema.safeParse(captura(nome).resposta.corpo);
  if (!r.success) throw new Error(`${nome}: does not parse`);
  return r.data;
}

/** A history capture's rows, through the listing's page schema. */
function historico(nome: string): readonly SituacaoHistoricoLinhaLi[] {
  const r = paginaDoHistorico.safeParse(captura(nome).resposta.corpo);
  if (!r.success) throw new Error(`${nome}: does not parse`);
  return r.data.objects;
}

function lido(leitura: LeituraHistoricoLi, rotulo: string) {
  if (!leitura.ok) throw new Error(`${rotulo}: the history was refused`);
  return leitura;
}

/**
 * One capture, mapped end to end the way the importer composes the mappers: no
 * produto resolves, the conta's freight doc exists with an EMPTY `mapa` (so the
 * method is unmapped), and the conta is configured FOB — so CIF on an order
 * with freight is the override, and the conta's own FOB shows on one without.
 */
function importar(
  nome: string,
  linhas: readonly SituacaoHistoricoLinhaLi[] = [],
  modo: ModoHistoricoLi = MODO_HISTORICO_LI.degradado,
) {
  const pedido = detalhe(nome);
  const watermarkUs = dataLiParaMicros(pedido.data_modificacao);
  if (watermarkUs === null) throw new Error(`${nome}: unreadable stamp`);
  const h = lido(
    lerHistoricoLi({ numero: pedido.numero, codigoDetalhe: pedido.situacao.codigo, linhas, modo }),
    nome,
  );
  const itens = mapearItensLi({
    itens: pedido.itens,
    valorSubtotal: pedido.valor_subtotal,
    resolucoes: new Map(),
    nowUs: AGORA_US,
  });
  if (!itens.ok) throw new Error(`${nome}: lines refused`);
  const formaEnvio = pedido.envios[0]?.forma_envio;
  const decisaoMapa = decidirMapaLi({
    intFreteLiId: INT_FRETE_LI,
    registro: { resultado: 'registrada', mapa: [], lidoEmUs: null },
    formaEnvio,
  });
  const roteamento = rotearFreteLi({
    intFreteLiId: INT_FRETE_LI,
    decisao: decisaoMapa,
    alvo: null,
  });
  const dataAprovacaoUs = h.dataAprovacao.derivavel ? h.dataAprovacao.us : null;
  const frete = mapearFreteLi({
    pedido,
    modalidadeConta: MODALIDADE_FRETE.fob,
    roteamento,
    horarioDeCorteConta: null,
    dataAprovacaoUs,
    enderecoFiscalOuterRef: null,
  });
  const mapeado = mapearPedidoLi({
    contaId: CONTA,
    operacaoOuterRef: null,
    pedido,
    watermarkUs,
    capturado: h.capturado,
    itens: itens.itens,
    descontoExtra: itens.descontoExtra,
    frete,
    clientePedidoOuterRef: null,
    enderecoFiscalOuterRef: null,
  });
  const escrita = montarEscritaPedidoLi(null, mapeado, AGORA_US);
  if (escrita.tipo !== 'criar') throw new Error(`${nome}: expected a create`);
  const pagamentos = mapearPagamentosLi({
    contaId: CONTA,
    pedido,
    statusPagamento: escrita.decisao.statusPagamento,
    dataAprovacao: h.dataAprovacao,
    dataCancelamento: h.dataCancelamento,
    watermarkUs,
  });
  if (!pagamentos.ok) throw new Error(`${nome}: payments refused`);
  const corposPagamento = pagamentos.pagamentos.map((p) => {
    const e = montarEscritaPagamentoLi(null, p, AGORA_US);
    if (e.tipo !== 'criar') throw new Error(`${nome}: expected a payment create`);
    return e.corpo;
  });
  return {
    pedido,
    h,
    itens,
    decisaoMapa,
    roteamento,
    frete,
    mapeado,
    escrita,
    pagamentos,
    corposPagamento,
  };
}

describe('PR 5-b: the estado verdict on the captures', () => {
  it('pedido-cancelado + its own history: 2 rows, chain intact, no creation row ⇒ not captured ⇒ cancelado / cancelado', () => {
    const linhas = historico('historico-pedido-cancelado.json');
    const pedido = detalhe('pedido-cancelado.json');
    expect(
      linhas.every((l) => l.numero === pedido.numero),
      'same numero',
    ).toBe(true);
    expect(linhas.length === 2, 'two rows').toBe(true);
    expect(
      linhas.some((l) => l.situacao_anterior == null),
      'a creation row',
    ).toBe(false);

    // STRICT mode accepts it: no hole.
    const r = importar('pedido-cancelado.json', linhas, MODO_HISTORICO_LI.estrito);
    expect(r.h.lacunas).toEqual([]);
    expect(r.h.corte.length === 2, 'cut of two rows').toBe(true);
    expect(r.h.capturado).toBe(false);
    expect(r.escrita.decisao.estado).toBe(ESTADO_PEDIDO.cancelado);
    expect(r.escrita.decisao.statusPagamento.criacao).toBe(STATUS_PAGAMENTO.cancelado);
    // The cancellation date is objects[1].data, through the one conversion.
    const esperado = dataLiParaMicros(linhas[1]?.data);
    expect(r.h.dataCancelamento.derivavel, 'derivable').toBe(true);
    expect(
      r.h.dataCancelamento.derivavel && r.h.dataCancelamento.us === esperado,
      'objects[1].data',
    ).toBe(true);
    expect(r.h.dataAprovacao.derivavel && r.h.dataAprovacao.us === null, 'no approval date').toBe(
      true,
    );
    expect(r.corposPagamento[0]?.status_pagamento).toBe(STATUS_PAGAMENTO.cancelado);
    expect(r.corposPagamento[0]?.dataCancelamento === esperado, 'payment dataCancelamento').toBe(
      true,
    );
  });

  it('historico-pedido-enviado + a SYNTHETIC codigo-11 detail of its numero: captured, approval = the first paid row', () => {
    const linhas = historico('historico-pedido-enviado.json');
    const numero = linhas[0]!.numero;
    const h = lido(
      lerHistoricoLi({
        numero,
        codigoDetalhe: 'pedido_enviado',
        linhas,
        modo: MODO_HISTORICO_LI.estrito,
      }),
      'enviado',
    );
    expect(h.lacunas).toEqual([]);
    expect(h.capturado).toBe(true);
    expect(h.corte.length === 3, 'cut of three rows').toBe(true);
    const primeiroPago = linhas.find((l) => l.situacao.codigo === 'pedido_pago');
    expect(primeiroPago !== undefined, 'a paid row').toBe(true);
    expect(
      h.dataAprovacao.derivavel && h.dataAprovacao.us === dataLiParaMicros(primeiroPago?.data),
      'approval',
    ).toBe(true);
    // No reversal codigo: no cancellation date.
    expect(
      h.dataCancelamento.derivavel && h.dataCancelamento.us === null,
      'no cancellation date',
    ).toBe(true);
  });

  it('⚠️ the same history against a detail still at pedido_pago is cut THERE (the shipped row is newer than it)', () => {
    const linhas = historico('historico-pedido-enviado.json');
    const h = lido(
      lerHistoricoLi({
        numero: linhas[0]!.numero,
        codigoDetalhe: 'pedido_pago',
        linhas,
        modo: MODO_HISTORICO_LI.estrito,
      }),
      'pago',
    );
    expect(h.corte.length === 2, 'cut of two rows').toBe(true);
    expect(h.capturado).toBe(true);
  });

  it('⚠️ the details with no history capture: strict refuses (the codigo is absent), degraded decides from the codigo', () => {
    const aguardando = detalhe('pedido-aguardando.json');
    expect(
      lerHistoricoLi({
        numero: aguardando.numero,
        codigoDetalhe: aguardando.situacao.codigo,
        linhas: [],
        modo: MODO_HISTORICO_LI.estrito,
      }),
    ).toEqual({ ok: false, lacunas: [LACUNA_HISTORICO_LI.codigoAusente] });

    const esperado: Record<string, string> = {
      'pedido-aguardando.json': ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
      'pedido-boleto.json': ESTADO_PEDIDO.pago,
      'pedido-cartao.json': ESTADO_PEDIDO.pago,
      'pedido-pix.json': ESTADO_PEDIDO.pago,
    };
    for (const [nome, estado] of Object.entries(esperado)) {
      const r = importar(nome);
      expect(r.escrita.decisao.estado, nome).toBe(estado);
      // A paid order with no history: captured, its approval date not derivable.
      if (estado === ESTADO_PEDIDO.pago)
        expect(r.h.dataAprovacao.derivavel === false, `${nome} approval`).toBe(true);
    }
  });
});

describe('PR 5-b: ids, lines, buyer and address on all 5 captures', () => {
  it('the pedido id is the numero’s digest; numero is stored as text; the stamps are canonical', () => {
    const ids = new Set<string>();
    for (const nome of PEDIDOS) {
      const { pedido, mapeado } = importar(nome);
      expect(mapeado.pedidoId === idPedidoLi(CONTA, pedido.numero), `${nome} id`).toBe(true);
      expect(mapeado.preencherUmaVez.numero === String(pedido.numero), `${nome} numero`).toBe(true);
      expect(lerDataLi(pedido.data_modificacao) === pedido.data_modificacao, `${nome} stamp`).toBe(
        true,
      );
      ids.add(mapeado.pedidoId);
    }
    expect(ids.size).toBe(PEDIDOS.length);
  });

  it('the valor_total identity: total = subtotal + freight − discount (to the centavo)', () => {
    for (const nome of PEDIDOS) {
      const p = detalhe(nome);
      const calculado = roundReais(
        (p.valor_subtotal ?? 0) + (p.valor_envio ?? 0) - (p.valor_desconto ?? 0),
      );
      expect(calculado === roundReais(p.valor_total ?? Number.NaN), nome).toBe(true);
    }
  });

  it('every line: descontoUnitario 0, the 4-dp price kept as is, no cost (faked) and no refusal, SKU text at full length', () => {
    let linhas = 0;
    for (const nome of PEDIDOS) {
      const { pedido, itens } = importar(nome);
      const refs = referenciasDeProdutoLi(pedido.itens);
      expect(refs.length === pedido.itens.length, `${nome} one reference per line`).toBe(true);
      expect(itens.residuo === 0, `${nome} residual`).toBe(true);
      expect(itens.semProduto.length === pedido.itens.length, `${nome} unmatched`).toBe(true);
      itens.itens.forEach((l, i) => {
        const w = pedido.itens[i]!;
        const rotulo = `${nome} itens[${String(i)}]`;
        expect(l.descontoUnitario === 0, `${rotulo} descontoUnitario`).toBe(true);
        expect(l.precoDeVenda === w.preco_venda, `${rotulo} precoDeVenda`).toBe(true);
        expect(l.custo === null, `${rotulo} custo`).toBe(true);
        expect(
          typeof l.sku === 'string' && l.sku === w.sku && l.sku.length >= 14,
          `${rotulo} sku`,
        ).toBe(true);
        expect(l.ensureUniqueId === String(w.id), `${rotulo} key`).toBe(true);
        // `produto_pai` is a KEPT resource path — the only real evidence of the
        // produto path shape — so the parent reference must read from it.
        expect(idLiDoProdutoPai(w.produto_pai) !== null, `${rotulo} produto_pai`).toBe(true);
        expect(refs[i]?.idLiPai != null, `${rotulo} idLiPai`).toBe(true);
      });
      linhas += itens.itens.length;
    }
    expect(linhas).toBe(6);
    // pedido-boleto carries two lines.
    expect(importar('pedido-boleto.json').itens.itens.length === 2, 'boleto lines').toBe(true);
  });

  it('no captured buyer has a strong identity, and every address takes uf-desconhecida', () => {
    for (const nome of PEDIDOS) {
      const p = detalhe(nome);
      const c = clienteDoPedidoLi(p.cliente);
      expect(c.identidadeForte, `${nome} identity`).toBe(false);
      expect(c.campos.cpf_cnpj === null, `${nome} document`).toBe(true);
      expect(enderecoDoPedidoLi(p.endereco_entrega).kind, `${nome} endereço`).toBe(
        'uf-desconhecida',
      );
    }
  });

  it('every create body parses (pedido and payments) and names the order’s numero', () => {
    for (const nome of PEDIDOS) {
      const r = importar(nome);
      expect(pedidoSchema.safeParse(r.escrita.corpo).success, `${nome} pedido`).toBe(true);
      for (const corpo of r.corposPagamento) {
        expect(pagamentoSchema.safeParse(corpo).success, `${nome} pagamento`).toBe(true);
      }
    }
  });
});

describe('PR 5-b: freight on the captures', () => {
  it('modalidade: CIF on the 4 orders with freight (overriding the FOB conta); the conta’s FOB on the one without', () => {
    for (const nome of PEDIDOS) {
      const r = importar(nome);
      const comFrete = (r.pedido.valor_envio ?? 0) > 0;
      expect(r.frete?.base.modalidade, nome).toBe(
        comFrete ? MODALIDADE_FRETE.cif : MODALIDADE_FRETE.fob,
      );
      expect(r.frete?.modalidadeSobrescrita, nome).toBe(comFrete);
    }
    expect(PEDIDOS.filter((n) => (detalhe(n).valor_envio ?? 0) > 0)).toHaveLength(4);
    expect((detalhe('pedido-cancelado.json').valor_envio ?? 0) > 0).toBe(false);
  });

  it('the freight estado: aguardando ⇒ iniciado (no deadline); boleto ⇒ despachoAutorizado, no code; pix ⇒ aguardandoPostagem', () => {
    const aguardando = importar('pedido-aguardando.json').escrita.corpo.freteInicial as Record<
      string,
      unknown
    >;
    expect(aguardando.estado).toBe(ESTADO_FRETE.iniciado);
    expect(aguardando.prazoDespacho).toBeNull();
    const boleto = importar('pedido-boleto.json').escrita.corpo.freteInicial as Record<
      string,
      unknown
    >;
    expect(boleto.estado).toBe(ESTADO_FRETE.despachoAutorizado);
    expect(boleto.codRastreio === null, 'boleto code').toBe(true);
    const pix = importar('pedido-pix.json').escrita.corpo.freteInicial as Record<string, unknown>;
    expect(pix.codRastreio !== null, 'pix code').toBe(true);
    expect(pix.estado).toBe(ESTADO_FRETE.aguardandoPostagem);
  });

  it('every capture routes UNMAPPED to the conta’s LI doc from an empty mapa; integração null', () => {
    for (const nome of PEDIDOS) {
      const r = importar(nome);
      expect(r.decisaoMapa.tipo, nome).toBe('nao-mapeado');
      expect(r.roteamento.integracaoFreteOuterRef).toBe(REF_INT_FRETE_LI);
      expect(r.frete?.base.externalOptionIntegracao, nome).toBeNull();
      expect(
        r.frete?.base.externalId === String(r.pedido.envios[0]?.id),
        `${nome} externalId`,
      ).toBe(true);
    }
  });

  it('a raw mapa row built from a capture’s own method, mapped to an active Melhor Envio target ⇒ that target', () => {
    for (const nome of PEDIDOS) {
      const forma = detalhe(nome).envios[0]?.forma_envio;
      const linha = montarEntradaDoMapaLi({ forma, numero: 1 });
      expect(linha !== null, `${nome} row`).toBe(true);
      const mapa = [{ ...linha, integracaoUid: 'me-1', targetData: { id: 2 } }];
      const decisao = decidirMapaLi({
        intFreteLiId: INT_FRETE_LI,
        registro: { resultado: 'ja-presente', mapa, lidoEmUs: null },
        formaEnvio: forma,
      });
      expect(decisao.tipo, nome).toBe('mapeado');
      const r = rotearFreteLi({
        intFreteLiId: INT_FRETE_LI,
        decisao,
        alvo: { existe: true, dados: { tipo: INTEGRACAO_FRETE.melhorEnvios, ativo: true } },
      });
      expect(r.integracaoFreteOuterRef, nome).toBe('documents/int_frete/me-1');
      expect(r.externalOptionId, nome).toBe('2');
    }
  });

  it('three carrier codes under ONE forma_envio.id ⇒ three keys; the pickup method (tipo null) has a key', () => {
    const porId = new Map<string, Set<string>>();
    for (const nome of PEDIDOS) {
      const forma = detalhe(nome).envios[0]?.forma_envio;
      const chave = chaveFormaEnvioLi(forma);
      expect(chave !== null, `${nome} key`).toBe(true);
      const id = String(forma?.id);
      (porId.get(id) ?? porId.set(id, new Set()).get(id)!).add(chave!);
      if (forma?.tipo === null) expect(chave !== null, `${nome} pickup key`).toBe(true);
    }
    const maior = Math.max(...[...porId.values()].map((s) => s.size));
    expect(maior).toBe(3);
    expect(PEDIDOS.some((n) => detalhe(n).envios[0]?.forma_envio?.tipo === null)).toBe(true);
  });
});

describe('PR 5-b: payments on the captures', () => {
  it('pedido-aguardando: forma 15, pendente although valor_pago == valor; no card; 1 parcela from {}; no vencimento', () => {
    const r = importar('pedido-aguardando.json');
    const w = r.pedido.pagamentos[0]!;
    expect(w.valor_pago === w.valor, 'valor_pago is a copy of valor').toBe(true);
    const p = r.corposPagamento[0]!;
    expect(p.forma_de_pagamento).toBe(FORMA_PAGAMENTO.boleto_bancario);
    expect(p.status_pagamento).toBe(STATUS_PAGAMENTO.pendente);
    expect(p.cartao === null, 'no card block').toBe(true);
    expect(p.parcelas).toBe(1);
    expect(p.vencimento).toBeNull();
  });

  it('pedido-boleto: forma 15, aprovado', () => {
    const p = importar('pedido-boleto.json').corposPagamento[0]!;
    expect(p.forma_de_pagamento).toBe(FORMA_PAGAMENTO.boleto_bancario);
    expect(p.status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
  });

  it('pedido-pix: forma 17 with the card block {tpIntegra 2, bandeira null, cAut null}', () => {
    const p = importar('pedido-pix.json').corposPagamento[0]!;
    expect(p.forma_de_pagamento).toBe(FORMA_PAGAMENTO.pix);
    const c = p.cartao as Record<string, unknown> | null;
    expect(
      c !== null && c.tpIntegra === '2' && c.bandeira === null && c.cAut === null,
      'pix card block',
    ).toBe(true);
  });

  it('pedido-cartao: forma 3, several instalments, not à vista, cAut null, bandeira null, no vencimento', () => {
    const r = importar('pedido-cartao.json');
    const p = r.corposPagamento[0]!;
    expect(p.forma_de_pagamento).toBe(FORMA_PAGAMENTO.cartao_credito);
    expect((p.parcelas as number) > 1, 'parcelas > 1').toBe(true);
    expect(p.aVista).toBe(false);
    const c = p.cartao as Record<string, unknown> | null;
    expect(c !== null && c.bandeira === null && c.cAut === null, 'card block').toBe(true);
    expect(p.vencimento).toBeNull();
    // The order's expiry exists and is never the due date.
    expect('data_expiracao' in (captura('pedido-cartao.json').resposta.corpo as object)).toBe(true);
  });

  it('every payment: valor is the wire valor, the doc keyed by the payment id, never null status', () => {
    for (const nome of PEDIDOS) {
      const r = importar(nome);
      expect(
        r.pagamentos.pagamentos.length === r.pedido.pagamentos.length,
        `${nome} every payment`,
      ).toBe(true);
      r.corposPagamento.forEach((p, i) => {
        expect(p.valor === r.pedido.pagamentos[i]!.valor, `${nome} valor`).toBe(true);
        expect(p.status_pagamento !== null, `${nome} status`).toBe(true);
        expect(p.lastProviderUpdate === r.mapeado.watermarkUs, `${nome} clock`).toBe(true);
      });
    }
  });

  it('the payment-method catalogues: every ACTIVE codigo maps to a known forma, except the redirect (pinned at 99)', () => {
    const catalogo = z.object({
      objects: z.array(
        z
          .object({
            codigo: z.string(),
            configuracoes: z.object({ ativo: z.boolean() }).passthrough(),
          })
          .passthrough(),
      ),
    });
    const REDIRECT = 'proxy-mercadopago-v1-redirect';
    let redirectAtivo = false;
    for (const nome of ['pagamento-loja1.json', 'pagamento-loja2.json']) {
      const r = catalogo.safeParse(captura(nome).resposta.corpo);
      if (!r.success) throw new Error(`${nome}: not a catalogue`);
      const ativos = r.data.objects.filter((o) => o.configuracoes.ativo);
      expect(ativos.length > 0, `${nome} active`).toBe(true);
      for (const o of ativos) {
        const forma = formaPagamentoLi({ forma_pagamento: { codigo: o.codigo } }).forma;
        if (o.codigo === REDIRECT) {
          redirectAtivo = true;
          expect(forma, `${nome} ${o.codigo}`).toBe(FORMA_PAGAMENTO.outros);
        } else {
          expect(forma !== FORMA_PAGAMENTO.outros, `${nome} ${o.codigo}`).toBe(true);
        }
      }
    }
    expect(redirectAtivo, 'the redirect pin is exercised').toBe(true);
  });
});

describe('PR 5-b: pedido-inexistente', () => {
  it('the captured 404, served through the real client, is LiNotFoundError ⇒ the pedido-inexistente park', async () => {
    const e = captura('pedido-inexistente.json');
    expect(e.resposta.status).toBe(404);
    const numero = /^\/v1\/pedido\/([1-9][0-9]*)\/$/.exec(e.requisicao.caminho)?.[1];
    expect(numero !== undefined, 'numero').toBe(true);
    const fetch: typeof globalThis.fetch = () =>
      Promise.resolve(
        new Response(e.resposta.forma === 'json' ? JSON.stringify(e.resposta.corpo) : '', {
          status: e.resposta.status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const cliente = criarClienteLeituraLi({
      obterCredencial: () => ({ token: 'token-de-teste', ref: 'conta-de-teste' }),
      fetch,
    });
    let erro: unknown = null;
    try {
      await buscarPedidoLi(cliente, numero!);
    } catch (err) {
      if (!(err instanceof LiNotFoundError)) throw err;
      erro = err;
    }
    expect(erro).toBeInstanceOf(LiNotFoundError);
    const resultado = await classificarFalhaLi(asDb(new FakeDb()), erro, null, {
      agoraMs: () => 0,
      increment,
    });
    expect(resultado).toEqual({ kind: 'pedido-inexistente' });
  });
});
