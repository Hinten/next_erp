import { describe, expect, it } from 'vitest';

import { FALSO_LI, LIMITE_ANALISE_BYTES, redigirCorpo } from '../core/redacao';
import { criarListaDeNomes } from '../fixtures/piiScan';
import { type EnvelopeFixtureLi, lerFixtureLi } from '../fixtures/wireCorpus';
import { PII_FALSA, exemplosDaEspecificacao, gerarCpf } from '../testing/especificacaoPii';
import {
  type ResultadoDaCapturaLi,
  capturaParaFixture,
  contarInteirosInseguros,
} from './capturaParaFixture';

/* Synthetic captures only: PII inline, CPFs generated at run time. */
const CPF = gerarCpf('529982247');
const LISTA = criarListaDeNomes(['Loja Exemplo']);
const b = (t: string) => new TextEncoder().encode(t);
const MTIME = Date.UTC(2026, 9, 7, 23, 30); // 2026-10-07 23:30 UTC

function captura(linha1: string, corpo: unknown, ...extra: string[]): ResultadoDaCapturaLi {
  return capturaParaFixture(
    {
      sidecar: b([linha1, 'credencial: personal-token', ...extra].join('\n')),
      corpo: typeof corpo === 'string' ? b(corpo) : b(JSON.stringify(corpo)),
      corpoModificadoEmMs: MTIME,
    },
    LISTA,
  );
}

function envelope(r: ResultadoDaCapturaLi): EnvelopeFixtureLi {
  if (!r.ok) throw new Error(`refused: ${r.achados.map((a) => `${a.onde} ${a.tipo}`).join('; ')}`);
  return r.envelope;
}

function achados(r: ResultadoDaCapturaLi): string[] {
  return r.ok ? [] : r.achados.map((a) => `${a.onde} :: ${a.tipo}`);
}

/** The value at a dotted path (`objects.0.itens.0.sku`). */
function em(v: unknown, caminho: string): unknown {
  let atual = v;
  for (const k of caminho.split('.')) {
    if (atual === null || typeof atual !== 'object') return undefined;
    atual = Object.entries(atual).find(([chave]) => chave === k)?.[1];
  }
  return atual;
}

const PEDIDO_BUSCA = {
  meta: {
    limit: 20,
    offset: 0,
    total_count: 45,
    next: '/api/v1/pedido/search/?limit=20&offset=20&since_atualizado=2026-09-25T00%3A00%3A00',
    previous: null,
  },
  objects: [
    {
      numero: 1234,
      id_externo: 'MP-99',
      id_anymarket: 555,
      data_criacao: '2026-09-25T10:00:00.123456',
      valor_total: '129.80',
      situacao: { id: 4, codigo: 'pedido_pago', nome: 'Pedido Pago', aprovado: true },
      cliente: {
        nome: 'Fulano Real',
        email: 'fulano.real@provedor.com.br',
        cpf: CPF,
        telefone_celular: '(21) 98765-4321',
      },
      endereco_entrega: { endereco: 'Rua das Flores', numero: '10', cep: '20000-000' },
      itens: [
        { sku: 'CAM-001-P', quantidade: '2.000', preco_venda: '59.90', preco_custo: 20, nome: 'X' },
        { sku: 'CAM-001-M', quantidade: '1.000', preco_venda: '59.90', preco_custo: '20.00' },
      ],
      envios: [{ objeto: 'BR123456789XX', valor: '10.00', prazo: 7 }],
    },
  ],
};

describe('capturaParaFixture — a 2xx pedido search', () => {
  const r = captura(
    'GET https://api.awsli.com.br/v1/pedido/search/?limit=50&since_atualizado=2026-09-25T00%3A00%3A00 200',
    PEDIDO_BUSCA,
  );
  const env = envelope(r);
  const corpo = env.resposta.corpo;

  it('keeps SKUs, numeros, dates, quantities and prices (non-vacuity: each named value unchanged)', () => {
    expect(em(corpo, 'objects.0.numero')).toBe(1234);
    expect(em(corpo, 'objects.0.itens.0.sku')).toBe('CAM-001-P');
    expect(em(corpo, 'objects.0.itens.1.sku')).toBe('CAM-001-M');
    expect(em(corpo, 'objects.0.itens.0.quantidade')).toBe('2.000');
    expect(em(corpo, 'objects.0.itens.0.preco_venda')).toBe('59.90');
    expect(em(corpo, 'objects.0.valor_total')).toBe('129.80');
    expect(em(corpo, 'objects.0.data_criacao')).toBe('2026-09-25T10:00:00.123456');
    expect(em(corpo, 'objects.0.situacao.codigo')).toBe('pedido_pago');
    expect(em(corpo, 'meta.total_count')).toBe(45);
  });

  it('fakes every customer field and keeps the shape', () => {
    expect(em(corpo, 'objects.0.cliente')).toEqual({
      nome: FALSO_LI.texto,
      email: FALSO_LI.email,
      cpf: FALSO_LI.cpf,
      telefone_celular: FALSO_LI.telefone,
    });
    expect(em(corpo, 'objects.0.endereco_entrega')).toEqual({
      endereco: FALSO_LI.texto,
      numero: FALSO_LI.texto,
      cep: FALSO_LI.cep,
    });
    const texto = JSON.stringify(env);
    for (const valor of [CPF, 'Fulano Real', 'fulano.real', '98765-4321', 'Rua das Flores']) {
      expect(texto).not.toContain(valor);
    }
  });

  it('fakes the tracking code, the external ids and the cost (Q3)', () => {
    expect(em(corpo, 'objects.0.envios.0.objeto')).toBe(FALSO_LI.rastreio);
    expect(em(corpo, 'objects.0.id_externo')).toBe(FALSO_LI.texto);
    expect(em(corpo, 'objects.0.id_anymarket')).toBe(0);
    expect(em(corpo, 'objects.0.itens.0.preco_custo')).toBe(0);
    expect(em(corpo, 'objects.0.itens.1.preco_custo')).toBe(FALSO_LI.texto);
  });

  it('`meta.next` goes through the path and query redactor and keeps `%3A`', () => {
    expect(em(corpo, 'meta.next')).toBe(
      '/api/v1/pedido/search/?limit=20&offset=20&since_atualizado=2026-09-25T00%3A00%3A00',
    );
  });

  it('the request line: redacted path, raw query pairs in order, and the envelope fields', () => {
    expect(env.requisicao).toEqual({
      metodo: 'GET',
      caminho: '/v1/pedido/search/',
      query: [
        ['limit', '50'],
        ['since_atualizado', '2026-09-25T00%3A00%3A00'],
      ],
    });
    expect(env.resposta.status).toBe(200);
    expect(env.resposta.politica).toBe('estrutural');
    expect(env.resposta.forma).toBe('json');
    expect(env.credencial).toBe('personal-token');
    expect(Object.keys(env).sort()).toEqual([
      'capturadoEm',
      'credencial',
      'perfil',
      'requisicao',
      'resposta',
      'versao',
    ]);
  });

  it('the fixture text is the envelope, serialised the one way, and reads back', () => {
    if (!r.ok) throw new Error('refused');
    expect(r.texto).toBe(`${JSON.stringify(env, null, 2)}\n`);
    expect(lerFixtureLi(r.texto).ok).toBe(true);
  });

  it('idempotence: sanitizing the envelope body again gives byte-identical output', () => {
    const deNovo = redigirCorpo(
      { caminho: '/v1/pedido/search/', status: 200, corpo: JSON.stringify(corpo) },
      'fixture',
    );
    expect(deNovo.ok && JSON.stringify(deNovo.corpo)).toBe(JSON.stringify(corpo));
  });
});

describe('capturaParaFixture — the catalogue and configuration classes', () => {
  it('a produto detail keeps its keep-list and fakes names, descriptions, URLs, image paths and cost', () => {
    const corpo = envelope(
      captura('GET /v1/produto/7 200', {
        id: 7,
        sku: 'CAM-001',
        ncm: '61091000',
        preco_cheio: '59.90',
        ativo: true,
        nome: 'Camiseta da Loja',
        descricao_completa: '<p>linda</p>',
        url: 'https://loja.example/camiseta',
        preco_custo: '20.00',
        imagem_principal: { caminho: '0000/x.jpg', principal: true, id: 9 },
      }),
    ).resposta.corpo;
    expect(corpo).toEqual({
      id: 7,
      sku: 'CAM-001',
      ncm: '61091000',
      preco_cheio: '59.90',
      ativo: true,
      nome: FALSO_LI.texto,
      descricao_completa: FALSO_LI.texto,
      url: FALSO_LI.url,
      preco_custo: FALSO_LI.texto,
      imagem_principal: { caminho: FALSO_LI.texto, principal: true, id: 9 },
    });
  });

  it('a produto list keeps `meta.limit` and `meta.total_count`', () => {
    const env = envelope(
      captura('GET /v1/produto/?limit=1000 200', {
        meta: { limit: 1000, offset: 0, total_count: 4321, next: null, previous: null },
        objects: [{ id: 1, sku: 'A' }],
      }),
    );
    expect(env.resposta.politica).toBe('catalogo');
    expect(em(env.resposta.corpo, 'meta.limit')).toBe(1000);
    expect(em(env.resposta.corpo, 'meta.total_count')).toBe(4321);
  });

  it('a situação list keeps `codigo` and the flags, and fakes `nome`', () => {
    const env = envelope(
      captura('GET /v1/situacao/ 200', {
        meta: { limit: 20, offset: 0, total_count: 1, next: null, previous: null },
        objects: [{ id: 2, codigo: 'aguardando_pagamento', nome: 'Aguardando', aprovado: false }],
      }),
    );
    expect(env.resposta.politica).toBe('configuracao');
    expect(em(env.resposta.corpo, 'objects.0')).toEqual({
      id: 2,
      codigo: 'aguardando_pagamento',
      nome: FALSO_LI.texto,
      aprovado: false,
    });
  });

  it('every transcribed spec example converts cleanly', () => {
    for (const ex of exemplosDaEspecificacao({ cpf: CPF })) {
      const r = captura(`GET ${ex.caminho} 200`, ex.corpo);
      expect(achados(r), ex.operacao).toEqual([]);
      expect(JSON.stringify(r), ex.operacao).not.toContain(PII_FALSA.email);
    }
  });
});

describe('capturaParaFixture — non-2xx, per class', () => {
  it('a catalogue 401 JSON body keeps keys and short digit strings only', () => {
    const env = envelope(
      captura('GET /v1/categoria/?limit=1 401', {
        error: 'Token SENTINELA invalido',
        codigo: '533',
        detalhes: { tentativa: 2 },
      }),
    );
    expect(env.resposta.corpo).toEqual({
      error: FALSO_LI.texto,
      codigo: '533',
      detalhes: { tentativa: 2 },
    });
    expect(JSON.stringify(env)).not.toContain('SENTINELA');
  });

  it('a catalogue 401 HTML body gives `corpo: null`', () => {
    const env = envelope(captura('GET /v1/categoria/ 401', '<html>SENTINELA</html>'));
    expect(env.resposta).toMatchObject({ forma: 'texto', corpo: null, politica: 'catalogo' });
    expect(env.resposta.bytes).toBe('<html>SENTINELA</html>'.length);
  });

  it('an estrutural 404 JSON body goes through the fixture error walk', () => {
    const env = envelope(
      captura('GET /v1/pedido/99 404', {
        erro: 'Pedido de Fulano Real nao encontrado',
        numero: 99,
      }),
    );
    expect(env.resposta.corpo).toEqual({ erro: FALSO_LI.texto, numero: 99 });
  });

  it('an estrutural 400 HTML body gives `forma: texto`, `corpo: null`', () => {
    expect(envelope(captura('GET /v1/pedido/1 400', '<p>x</p>')).resposta).toMatchObject({
      forma: 'texto',
      corpo: null,
    });
  });
});

describe('capturaParaFixture — refusals', () => {
  it('a webhook path', () => {
    expect(achados(captura('GET /webhooks/v1/pedido 200', {}))).toEqual(['.txt:1 :: webhook']);
  });

  it('an estrutural 2xx body that is not JSON', () => {
    expect(achados(captura('GET /v1/pedido/1 200', '<html>'))).toEqual([
      '.json :: recusado-estrutural-nao-json',
    ]);
  });

  it('a body over the fixture parse cap', () => {
    const r = capturaParaFixture(
      {
        sidecar: b('GET /v1/produto/ 200\ncredencial: personal-token\n'),
        corpo: new Uint8Array(LIMITE_ANALISE_BYTES.fixture + 1),
        corpoModificadoEmMs: MTIME,
      },
      LISTA,
    );
    expect(achados(r)).toEqual(['.json :: corpo-acima-do-limite']);
  });

  it('an unsafe 16-digit literal (only the count is reported)', () => {
    const r = captura('GET /v1/pedido/1 200', '{"numero": 1234567890123456789}');
    expect(achados(r)).toEqual(['.json :: inteiro-alterado-pelo-parse (1)']);
    expect(JSON.stringify(r)).not.toContain('1234567890123456789');
  });

  it('a CPF with valid check digits planted in a kept SKU: path and kind, no value', () => {
    const r = captura('GET /v1/pedido/search/ 200', {
      objects: [{ numero: 1, itens: [{ sku: CPF }] }],
    });
    expect(achados(r)).toEqual(['resposta.corpo.objects.*.itens.*.sku :: cpf']);
    expect(JSON.stringify(r)).not.toContain(CPF);
  });

  it('a listed store name inside `situacao.codigo`: `nome-de-loja`, no term', () => {
    const r = captura('GET /v1/pedido/1 200', { situacao: { codigo: 'loja_exemplo_enviado' } });
    expect(achados(r)).toEqual(['resposta.corpo.situacao.codigo :: nome-de-loja']);
    expect(JSON.stringify(r).toLowerCase()).not.toContain('exemplo');
  });

  it('a request line that holds a listed name is omitted from the summary', () => {
    const r = captura('GET /v1/produto/?sku=LOJAEXEMPLO-1 200', { objects: [] });
    expect(achados(r)).toEqual(['requisicao.query.*.* :: nome-de-loja']);
    expect(r.resumo?.linhaRequisicao).toBeNull();
  });
});

describe('capturaParaFixture — the capture date', () => {
  it('comes from `data:` when given', () => {
    expect(envelope(captura('GET /v1/situacao/ 200', {}, 'data: 2026-09-01')).capturadoEm).toBe(
      '2026-09-01',
    );
  });

  it("otherwise from the body file's modification time, in UTC, with no time of day", () => {
    expect(envelope(captura('GET /v1/situacao/ 200', {})).capturadoEm).toBe('2026-10-07');
  });
});

describe('contarInteirosInseguros', () => {
  it.each([
    ['a safe 15-digit id', '{"id": 123456789012345}', 0],
    ['an exactly representable 19-digit value', '{"id": 1000000000000000000}', 0],
    ['an unsafe one', '{"id": 1234567890123456789}', 1],
    ['a negative unsafe one', '{"id": -1234567890123456789}', 1],
    ['inside an array', '[1, 9007199254740993]', 1],
    ['a root literal', '9007199254740993', 1],
    ['inside a string', '{"id": "1234567890123456789", "x": "a:1234567890123456789,"}', 0],
    ['a fraction', '{"preco": 1234567890123456789.5}', 0],
    ['an exponent', '{"x": 12345678901234567e2}', 0],
  ])('%s', (_caso, texto, esperado) => {
    expect(contarInteirosInseguros(texto)).toBe(esperado);
  });
});
