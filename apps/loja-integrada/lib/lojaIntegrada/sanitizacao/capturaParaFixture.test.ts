import { describe, expect, it } from 'vitest';

import { FALSO_LI, LIMITE_ANALISE_BYTES, redigirCorpo } from '../core/redacao';
import { criarListaDeNomes } from '../fixtures/piiScan';
import { type EnvelopeFixtureLi, lerFixtureLi } from '../fixtures/wireCorpus';
import {
  PII_FALSA,
  exemplosDaEspecificacao,
  gerarCnpj,
  gerarCpf,
} from '../testing/especificacaoPii';
import {
  CHAVE_DE_TESTE_HEX,
  OUTRA_CHAVE_DE_TESTE_HEX,
  chaveDeTeste,
  colisaoDePseudonimo,
} from '../testing/chaveDeFixtures';
import {
  type ResultadoDaCapturaLi,
  capturaParaFixture,
  contarInteirosInseguros,
} from './capturaParaFixture';
import type { ChaveDeFixturesLi } from './pseudonimo';

/* Synthetic captures and a TEST pseudonym key only: PII inline, CPFs generated at run time. */
const CPF = gerarCpf('529982247');
const CNPJ = gerarCnpj('112223330001');
const LISTA = criarListaDeNomes(['Loja Exemplo']);
const CHAVE = chaveDeTeste();
const b = (t: string) => new TextEncoder().encode(t);
const MTIME = Date.UTC(2026, 9, 7, 23, 30); // 2026-10-07 23:30 UTC
/** The pseudonym of `id` under the TEST key (or another one). */
const f = (id: number, chave: ChaveDeFixturesLi = CHAVE) => chave.pseudonimo(String(id));

/** One pair through the sanitizer, under the TEST key unless another key (or none) is given. */
function capturaCom(
  chave: ChaveDeFixturesLi | null,
  linha1: string,
  corpo: unknown,
  ...extra: string[]
): ResultadoDaCapturaLi {
  return capturaParaFixture(
    {
      sidecar: b([linha1, 'credencial: personal-token', ...extra].join('\n')),
      corpo: typeof corpo === 'string' ? b(corpo) : b(JSON.stringify(corpo)),
      corpoModificadoEmMs: MTIME,
    },
    LISTA,
    chave,
  );
}

const captura = (linha1: string, corpo: unknown, ...extra: string[]) =>
  capturaCom(CHAVE, linha1, corpo, ...extra);

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
        email: 'cliente.real@exemplo.invalid',
        cpf: CPF,
        telefone_celular: '(00) 91234-5678',
      },
      endereco_entrega: { endereco: 'Rua Exemplo', numero: '10', cep: '00000-001' },
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
    for (const valor of [CPF, 'Fulano Real', 'cliente.real', '91234-5678', 'Rua Exemplo']) {
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
  it('a produto detail keeps its keep-list (ids as their pseudonyms) and fakes names, descriptions, URLs, image paths and cost', () => {
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
      id: f(7),
      sku: 'CAM-001',
      ncm: '61091000',
      preco_cheio: '59.90',
      ativo: true,
      nome: FALSO_LI.texto,
      descricao_completa: FALSO_LI.texto,
      url: FALSO_LI.url,
      preco_custo: FALSO_LI.texto,
      imagem_principal: { caminho: FALSO_LI.texto, principal: true, id: f(9) },
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
        detalhes: { ativo: false },
      }),
    );
    expect(env.resposta.corpo).toEqual({
      error: FALSO_LI.texto,
      codigo: '533',
      detalhes: { ativo: false },
    });
    expect(JSON.stringify(env)).not.toContain('SENTINELA');
    // A number the error walk keeps (below 1e7) may be an echoed catalogue id, and
    // a pseudonym cannot live in an error body: the pair is refused, never written.
    expect(
      achados(captura('GET /v1/categoria/?limit=1 401', { detalhes: { tentativa: 2 } })),
    ).toEqual(['resposta.corpo.detalhes.tentativa :: numero-em-erro-do-catalogo']);
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
      CHAVE,
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
    expect(r.resumo?.linhaOmitidaPor).toEqual(['nome-de-loja']);
  });

  it('a request line that trips a personal-data pattern is omitted from the summary too', () => {
    // `numero` passes its predicate (up to 12 digits), so the redactor keeps the value.
    const r = captura(`GET /v1/pedido/search/?numero=${CPF} 200`, { objects: [] });
    expect(achados(r)).toEqual(['requisicao.query.*.* :: cpf']);
    expect(r.resumo?.linhaRequisicao).toBeNull();
    expect(r.resumo?.linhaOmitidaPor).toEqual(['cpf']);
    expect(JSON.stringify(r.resumo)).not.toContain(CPF);
    // Near-miss: an ordinary numero is printed.
    const limpo = captura('GET /v1/pedido/search/?numero=1234 200', { objects: [] });
    expect(limpo.resumo?.linhaRequisicao).toBe('GET /v1/pedido/search/?numero=1234');
    expect(limpo.resumo?.linhaOmitidaPor).toEqual([]);
  });

  it('a CPF or a CNPJ as a path segment is refused, and the line is omitted', () => {
    for (const [segmento, tipo] of [
      [CPF, 'cpf'],
      [CNPJ, 'cnpj'],
    ] as const) {
      const r = captura(`GET /v1/cliente/${segmento} 200`, {});
      expect(achados(r), tipo).toEqual([`requisicao.caminho :: ${tipo}`]);
      expect(r.resumo?.linhaRequisicao, tipo).toBeNull();
      expect(JSON.stringify(r), tipo).not.toContain(segmento);
    }
  });

  it('a CPF in `meta.next` is refused', () => {
    const r = captura('GET /v1/pedido/search/ 200', {
      meta: { next: `/api/v1/pedido/${CPF}/?limit=20` },
      objects: [],
    });
    expect(achados(r)).toEqual(['resposta.corpo.meta.next :: cpf']);
  });

  it('a percent-encoded listed name in a kept query value or in `meta.next` is refused', () => {
    const r = captura('GET /v1/produto/?sku=LOJA%2FEXEMPLO-01 200', {
      meta: { next: '/api/v1/produto/?sku=LOJA%2FEXEMPLO-01&offset=20' },
      objects: [],
    });
    expect(achados(r)).toEqual([
      'requisicao.query.*.* :: nome-de-loja',
      'resposta.corpo.meta.next :: nome-de-loja',
    ]);
    expect(r.resumo?.linhaRequisicao).toBeNull();
    // Control: the same SKU without a listed name is kept and printed.
    const limpo = captura('GET /v1/produto/?sku=CAM%2F001-01 200', { objects: [] });
    expect(achados(limpo)).toEqual([]);
    expect(limpo.resumo?.linhaRequisicao).toBe('GET /v1/produto/?sku=CAM%2F001-01');
  });

  it('a UTF-16 body with no BOM (NUL bytes) is refused as utf16, not read as text', () => {
    const r = capturaParaFixture(
      {
        sidecar: b('GET /v1/situacao/ 200\ncredencial: personal-token\n'),
        corpo: new Uint8Array(Buffer.from('{"objects":[{"codigo":"x"}]}', 'utf16le')),
        corpoModificadoEmMs: MTIME,
      },
      LISTA,
      CHAVE,
    );
    expect(achados(r)).toEqual(['.json :: utf16']);
  });
});

describe('capturaParaFixture — catalogue ids are pseudonymized', () => {
  const CATEGORIAS = {
    meta: {
      limit: 50,
      offset: 50,
      total_count: 67,
      previous: '/api/v1/categoria?limit=50&offset=0',
      next: null,
    },
    objects: [
      { id: 4101, categoria_pai: null, nome: 'Camisetas', resource_uri: '/v1/categoria/4101' },
      {
        id: 4102,
        categoria_pai: '/v1/categoria/4101',
        nome: 'Regatas',
        resource_uri: '/v1/categoria/4102',
      },
    ],
  };
  const LINHA_CATEGORIAS = 'GET /v1/categoria/?limit=50&offset=50 200';
  const GRADE = {
    id: 6062,
    nome: 'Tamanho',
    resource_uri: '/api/v1/grades/6062',
    variacoes: [
      { grade: '/api/v1/grades/6062', id: 31, resource_uri: '/api/v1/grade/6062/variacao/31' },
    ],
  };

  it('EQUAL: a grade id in the request path, the body, its URI and every option URI is one pseudonym', () => {
    const r = captura('GET /v1/grades/6062/ 200', GRADE);
    const env = envelope(r);
    const g = String(f(6062));
    expect(env.requisicao.caminho).toBe(`/v1/grades/${g}/`);
    expect(env.resposta.corpo).toEqual({
      id: f(6062),
      nome: FALSO_LI.texto,
      resource_uri: `/api/v1/grades/${g}`,
      variacoes: [
        {
          grade: `/api/v1/grades/${g}`,
          id: f(31),
          resource_uri: `/api/v1/grade/${g}/variacao/${String(f(31))}`,
        },
      ],
    });
    // The dry run prints the line the fixture holds.
    expect(r.resumo?.linhaRequisicao).toBe(`GET /v1/grades/${g}/`);
    expect(JSON.stringify(env)).not.toMatch(/\b(?:6062|31)\b/);
  });

  it('EQUAL: a category row and the categoria_pai naming it share one pseudonym', () => {
    const corpo = envelope(captura(LINHA_CATEGORIAS, CATEGORIAS)).resposta.corpo;
    expect(em(corpo, 'objects.0.id')).toBe(f(4101));
    expect(em(corpo, 'objects.0.resource_uri')).toBe(`/v1/categoria/${String(f(4101))}`);
    expect(em(corpo, 'objects.1.categoria_pai')).toBe(`/v1/categoria/${String(f(4101))}`);
  });

  it('EQUAL: the same key and the same capture give identical bytes', () => {
    const a = captura(LINHA_CATEGORIAS, CATEGORIAS);
    const b2 = captura(LINHA_CATEGORIAS, CATEGORIAS);
    expect(a.ok && b2.ok && a.texto === b2.texto).toBe(true);
  });

  it('NEAR-MISS: another key gives other ids', () => {
    const outra = chaveDeTeste(OUTRA_CHAVE_DE_TESTE_HEX);
    const corpo = envelope(capturaCom(outra, LINHA_CATEGORIAS, CATEGORIAS)).resposta.corpo;
    expect(em(corpo, 'objects.0.id')).toBe(f(4101, outra));
    expect(em(corpo, 'objects.0.id')).not.toBe(f(4101));
  });

  it('NEAR-MISS: meta numbers, meta.next/previous and the query values stay as captured', () => {
    const env = envelope(captura(LINHA_CATEGORIAS, CATEGORIAS));
    expect(em(env.resposta.corpo, 'meta')).toEqual(CATEGORIAS.meta);
    expect(env.requisicao.query).toEqual([
      ['limit', '50'],
      ['offset', '50'],
    ]);
  });

  it('the leaf table reads `pseudonimizado` for the mapped leaves, and no finding is raised for them', () => {
    const r = captura(LINHA_CATEGORIAS, CATEGORIAS);
    expect(achados(r)).toEqual([]);
    expect(r.resumo?.folhas).toEqual(
      expect.arrayContaining([
        { caminho: 'objects.*.id', tipo: 'number', tratamento: 'pseudonimizado', contagem: 2 },
        {
          caminho: 'objects.*.resource_uri',
          tipo: 'string',
          tratamento: 'pseudonimizado',
          contagem: 2,
        },
        {
          caminho: 'objects.*.categoria_pai',
          tipo: 'string',
          tratamento: 'pseudonimizado',
          contagem: 1,
        },
        { caminho: 'meta.total_count', tipo: 'number', tratamento: 'mantido', contagem: 1 },
      ]),
    );
  });

  it('NEAR-MISS: an allow-listed catalogue value the profile had to fake is still a finding', () => {
    const r = captura('GET /v1/produto/?limit=1 200', { objects: [{ id: 7, sku: CPF }] });
    expect(achados(r)).toEqual(['resposta.corpo.objects.*.sku :: cpf']);
  });

  it('NEAR-MISS: a configuracao-class id stays real', () => {
    const env = envelope(
      captura('GET /v1/situacao/ 200', { objects: [{ id: 2, codigo: 'pedido_pago' }] }),
    );
    expect(em(env.resposta.corpo, 'objects.0.id')).toBe(2);
  });

  it('NEAR-MISS: a configuracao or estrutural pair is byte-identical with the key, without it, or under another', () => {
    for (const [linha, corpo] of [
      ['GET /v1/situacao/ 200', { objects: [{ id: 2, codigo: 'pedido_pago' }] }],
      ['GET /v1/pedido/search/ 200', PEDIDO_BUSCA],
      ['GET /v1/pedido/1234 200', { numero: 1234, id: 99 }],
    ] as const) {
      const textos = [CHAVE, null, chaveDeTeste(OUTRA_CHAVE_DE_TESTE_HEX)].map((chave) => {
        const r = capturaCom(chave, linha, corpo);
        return r.ok ? r.texto : 'refused';
      });
      expect(new Set(textos).size, linha).toBe(1);
      expect(textos[0], linha).not.toBe('refused');
    }
  });

  it('no key: a catalogue pair is refused, naming the remedy kind', () => {
    const r = capturaCom(null, LINHA_CATEGORIAS, CATEGORIAS);
    expect(achados(r)).toEqual(['.chave-fixtures :: sem-chave-de-fixtures']);
  });

  it('a collision (two ids, one pseudonym) refuses the pair', () => {
    const [a, b2] = colisaoDePseudonimo();
    const r = captura('GET /v1/marca/ 200', {
      objects: [
        { id: a, resource_uri: `/api/v1/marca/${String(a)}` },
        { id: b2, resource_uri: `/api/v1/marca/${String(b2)}` },
      ],
    });
    expect(achados(r)).toEqual(['pseudonimos :: colisao-de-pseudonimo']);
  });

  it('a clean pair reports the pseudonyms it used (pseudonym -> real), in memory only', () => {
    const r = captura('GET /v1/grades/6062/ 200', GRADE);
    if (!r.ok) throw new Error('refused');
    expect([...r.pseudonimos.entries()].sort()).toEqual(
      [
        [f(6062), '6062'],
        [f(31), '31'],
      ].sort(),
    );
  });

  it('SENTINEL: the key never appears in a result, clean or refused', () => {
    for (const r of [
      captura(LINHA_CATEGORIAS, CATEGORIAS),
      captura('GET /v1/produto/?limit=1 200', { objects: [{ id: 7, sku: CPF }] }),
    ]) {
      expect(JSON.stringify(r)).not.toContain(CHAVE_DE_TESTE_HEX);
      expect(JSON.stringify(r)).not.toContain('7e57');
    }
  });
});

describe('capturaParaFixture — catalogue ids outside the body rows', () => {
  const IMAGENS = {
    meta: {
      limit: 1,
      offset: 0,
      total_count: 2,
      next: '/api/v1/produto_imagem/?limit=1&offset=1&produto=5555',
      previous: null,
    },
    objects: [
      {
        id: 1,
        imagem_id: 4444444,
        produto: '/api/v1/produto/5555',
        resource_uri: '/api/v1/produto_imagem/1',
      },
    ],
  };
  const LINHA_IMAGENS = 'GET /v1/produto_imagem/?produto=5555&limit=1 200';

  it("EQUAL: a `produto=` query value, meta.next's and the rows' produto URI share one pseudonym", () => {
    const r = captura(LINHA_IMAGENS, IMAGENS);
    const env = envelope(r);
    const p = String(f(5555));
    expect(env.requisicao.query).toEqual([
      ['produto', p],
      ['limit', '1'],
    ]);
    expect(em(env.resposta.corpo, 'meta.next')).toBe(
      `/api/v1/produto_imagem/?limit=1&offset=1&produto=${p}`,
    );
    expect(em(env.resposta.corpo, 'objects.0.produto')).toBe(`/api/v1/produto/${p}`);
    expect(em(env.resposta.corpo, 'objects.0.imagem_id')).toBe(f(4444444));
    expect(r.resumo?.linhaRequisicao).toBe(`GET /v1/produto_imagem/?produto=${p}&limit=1`);
    expect(JSON.stringify(env)).not.toMatch(/\b(?:5555|4444444)\b/);
    expect(r.resumo?.folhas).toEqual(
      expect.arrayContaining([
        { caminho: 'meta.next', tipo: 'string', tratamento: 'pseudonimizado', contagem: 1 },
        {
          caminho: 'objects.*.imagem_id',
          tipo: 'number',
          tratamento: 'pseudonimizado',
          contagem: 1,
        },
      ]),
    );
  });

  it('no key: the refused pair prints its request line with every id position blanked', () => {
    for (const [linha, esperada] of [
      ['GET /v1/grades/7777/ 200', 'GET /v1/grades/<id>/'],
      [LINHA_IMAGENS, 'GET /v1/produto_imagem/?produto=<id>&limit=1'],
    ] as const) {
      const r = capturaCom(null, linha, IMAGENS);
      expect(achados(r)).toEqual(['.chave-fixtures :: sem-chave-de-fixtures']);
      expect(r.resumo?.linhaRequisicao).toBe(esperada);
      expect(JSON.stringify(r)).not.toMatch(/\b(?:7777|5555)\b/);
    }
  });

  it('a catalogue error body that keeps a number is refused: it may echo a resource id', () => {
    expect(achados(captura('GET /v1/grades/7777/ 404', { error: '404', id: 7777 }))).toEqual([
      'resposta.corpo.id :: numero-em-erro-do-catalogo',
    ]);
    expect(achados(captura('GET /v1/categoria/9191/ 404', { error: { categoria: 9191 } }))).toEqual(
      ['resposta.corpo.error.categoria :: numero-em-erro-do-catalogo'],
    );
  });

  it('NEAR-MISS: a catalogue error body whose only number is its status is written, unmapped', () => {
    const env = envelope(captura('GET /v1/grades/7777/ 404', { status: 404, sucesso: false }));
    expect(env.requisicao.caminho).toBe(`/v1/grades/${String(f(7777))}/`);
    expect(env.resposta.corpo).toEqual({ status: 404, sucesso: false });
    // The 401 shape of the corpus: a code string equal to the status.
    expect(achados(captura('GET /v1/categoria/?limit=1 401', { Code: '401' }))).toEqual([]);
  });

  it('NEAR-MISS: a number the error walk FAKED (1e7 or more) is no finding: the fake carries nothing', () => {
    const env = envelope(captura('GET /v1/categoria/9/ 404', { referencia: 123_456_789 }));
    expect(env.resposta.corpo).toEqual({ referencia: 0 });
  });

  it('a catalogue error body that is a bare number is refused at the body itself', () => {
    expect(achados(captura('GET /v1/categoria/9191/ 404', '9191'))).toEqual([
      // The leaf table names the root `<raiz>`.
      'resposta.corpo.<raiz> :: numero-em-erro-do-catalogo',
    ]);
  });

  it('a single collision (one second id on a taken pseudonym) refuses the pair', () => {
    const [a, b2] = colisaoDePseudonimo();
    expect(achados(captura('GET /v1/marca/ 200', { objects: [{ id: a }, { id: b2 }] }))).toEqual([
      'pseudonimos :: colisao-de-pseudonimo',
    ]);
  });

  it('NEAR-MISS: an estrutural error body keeps its numbers, as before', () => {
    expect(achados(captura('GET /v1/pedido/5/ 404', { id: 5 }))).toEqual([]);
  });

  it('a catalogue resource on a path the catalogue class does not admit is refused', () => {
    for (const linha of [
      'GET /v1/grades/7777/variacoes/ 200',
      'GET /v1/produto/7/fotos/ 200',
      'GET /v1/categoria/7/filhas/ 200',
    ]) {
      expect(achados(captura(linha, { objects: [{ id: 31 }] })), linha).toEqual([
        '.txt:1 :: catalogo-fora-da-classe',
      ]);
    }
    // Near-miss: an estrutural path of another resource is converted as before.
    expect(achados(captura('GET /v1/pedido/5/ 200', { numero: 5 }))).toEqual([]);
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
