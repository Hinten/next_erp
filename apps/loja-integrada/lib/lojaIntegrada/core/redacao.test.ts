import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { URL_BASE_LI } from '@delfrance/integrations-loja-integrada';
import { z } from 'zod';

import {
  type ExemploEspecificacaoLi,
  PII_FALSA,
  exemplosDaEspecificacao,
  gerarCnpj,
  gerarCpf,
} from '../testing/especificacaoPii';
import {
  CHAVES_FALSAS_CATALOGO_LI,
  CHAVES_NEGADAS_LI,
  FALSO_LI,
  LIMITE_ANALISE_BYTES,
  ORIGEM_LI,
  PLACEHOLDERS_FIXTURE_LI,
  PREFIXOS_FALSOS_CATALOGO_LI,
  PREFIXOS_NEGADOS_LI,
  PROFUNDIDADE_MAXIMA_PERCURSO,
  REDIGIDO,
  SUBARVORES_NEGADAS_LI,
  TABELAS_LI,
  type TabelaRedacaoLi,
  bytesUtf8,
  classificarCaminho,
  cortarUtf8,
  mascararTexto,
  profundidadeJson,
  recursoDoCaminho,
  redigirCaminhoEQuery,
  redigirCorpo,
  regrasDaFolhaLi,
  tabelaDoCaminho,
  textoDoCaminho,
} from './redacao';

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

/** Generated at run time: valid check digits, never committed (`especificacaoPii.ts`). */
const CPF = gerarCpf('123456789');
const CPF_INVALIDO = `${CPF.slice(0, 10)}${String((Number(CPF[10]) + 1) % 10)}`;
const CNPJ = gerarCnpj('112223330001');
const CNPJ_LETRA = gerarCnpj('12ABC34501DE');
const CNPJ_LETRA_INVALIDO = `${CNPJ_LETRA.slice(0, 13)}${String((Number(CNPJ_LETRA[13]) + 1) % 10)}`;
const PII = { cpf: CPF };

function log(caminho: string, status: number | null, corpo: string | null) {
  return redigirCorpo({ caminho, status, corpo }, 'log');
}

/** The `log` excerpt of a JSON body, parsed back (the walk emits JSON). */
function logJson(caminho: string, status: number, corpo: unknown): unknown {
  const r = log(caminho, status, JSON.stringify(corpo));
  expect(r.forma).toBe('json');
  return JSON.parse(r.trecho ?? 'null') as unknown;
}

function fixture(caminho: string, status: number | null, corpo: string | null) {
  return redigirCorpo({ caminho, status, corpo }, 'fixture');
}

/** The `fixture` body of a JSON body; fails the test on a refusal. */
function fixtureJson(caminho: string, status: number, corpo: unknown): unknown {
  const r = fixture(caminho, status, JSON.stringify(corpo));
  if (!r.ok) throw new Error(`fixture refused: ${r.motivo}`);
  return r.corpo;
}

/** The value at a dotted path (`itens.0.sku`). */
function em(v: unknown, caminho: string): unknown {
  let atual = v;
  for (const k of caminho.split('.')) {
    if (atual === null || typeof atual !== 'object') return undefined;
    atual = Object.entries(atual).find(([chave]) => chave === k)?.[1];
  }
  return atual;
}

/** Every primitive replaced by its JSON type, keys and lengths kept. */
function forma(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(forma);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, f]) => [k, forma(f)]));
  }
  return v === null ? 'null' : typeof v;
}

/* -------------------------------------------------------------------------- */
/*                       The committed leaf inventory                          */
/* -------------------------------------------------------------------------- */

const inventarioSchema = z.object({
  gerador: z.literal('li-doc.mjs folhas'),
  especificacao: z.object({
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    ultimaModificacao: z.string().min(1),
  }),
  operacoes: z.array(
    z.object({
      metodo: z.literal('GET'),
      caminho: z.string().startsWith('/v1/'),
      folhas: z.array(
        z.tuple([
          z.string(),
          z.array(z.enum(['string', 'integer', 'number', 'boolean', 'null', 'array', 'object'])),
          z.array(z.enum(['schema', 'exemplo'])),
        ]),
      ),
    }),
  ),
});

const INVENTARIO = inventarioSchema.parse(
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../testing/especificacaoFolhas.json', import.meta.url)),
      'utf8',
    ),
  ),
);

const PRIMITIVOS = new Set(['string', 'integer', 'number', 'boolean', 'null']);

/** A concrete request path for a documented one: `{x_id}` → `1`, `/v1/{produto_preco}` → its name. */
function concreto(caminhoDoc: string): string {
  return caminhoDoc.replace('{produto_preco}', 'produto_preco').replace(/\{[a-z_]+\}/g, '1');
}

const OPERACOES_DO_PLANO = [
  'GET /v1/pedido/{pedido_id}',
  'GET /v1/pedido/search',
  'GET /v1/situacao_historico/search',
  'GET /v1/situacao',
  'GET /v1/pagamento',
  'GET /v1/pagamento/{pagamento_id}',
  'GET /v1/envio',
  'GET /v1/envio/{envio_id}',
  'GET /v1/produto/{produto_id}',
  'GET /v1/produto_estoque/{produto_id}',
  'GET /v1/produto_preco/{produto_id}',
];

describe('spec coverage — against the committed leaf inventory', () => {
  const ops = INVENTARIO.operacoes;

  it('reads the inventory (anti-vacuity): every planned operation, hundreds of leaves', () => {
    const nomes = ops.map((o) => `${o.metodo} ${o.caminho}`);
    expect(nomes).toEqual(expect.arrayContaining(OPERACOES_DO_PLANO));
    expect(ops.flatMap((o) => o.folhas).length).toBeGreaterThan(400);
  });

  it('every terminal leaf is classified EXACTLY once: allowed, denied or redacted on purpose', () => {
    const problemas: string[] = [];
    for (const op of ops) {
      const caminhos = op.folhas.map(([c]) => c);
      for (const [folha] of op.folhas) {
        if (caminhos.some((c) => c.startsWith(`${folha}.`))) continue; // a container
        const regras = regrasDaFolhaLi(concreto(op.caminho), folha);
        if (regras.length !== 1) {
          problemas.push(`${op.caminho} ${folha}: ${regras.map((r) => r.tipo).join('+') || '∅'}`);
        }
      }
    }
    expect(problemas).toEqual([]);
  });

  it('every keep-list entry has a predicate and resolves to a primitive leaf (schema or example)', () => {
    const manutencao: readonly TabelaRedacaoLi[] = [
      TABELAS_LI.situacao,
      TABELAS_LI.envio,
      TABELAS_LI.pagamento,
      TABELAS_LI.produto,
      TABELAS_LI.produtoImagem,
      TABELAS_LI.produtoEstoque,
      TABELAS_LI.produtoPreco,
      TABELAS_LI.categoria,
      TABELAS_LI.marca,
      TABELAS_LI.grade,
    ];
    const naoResolvidas: string[] = [];
    for (const t of manutencao) {
      const folhas = ops
        .filter((o) => tabelaDoCaminho(concreto(o.caminho)) === t)
        .flatMap((o) => o.folhas)
        .filter(([, tipos]) => tipos.some((tipo) => PRIMITIVOS.has(tipo)))
        .map(([c]) => c);
      expect(folhas.length, t.nome).toBeGreaterThan(0);
      for (const [entrada, predicado] of t.permitidas) {
        expect(predicado, `${t.nome} ${entrada}`).toBeTruthy();
        const relativa = entrada.startsWith('objects.*.') ? entrada.slice(10) : entrada;
        if (!folhas.includes(relativa) && !folhas.includes(`objects.*.${relativa}`)) {
          naoResolvidas.push(`${t.nome} ${entrada}`);
        }
      }
    }
    expect(naoResolvidas).toEqual([]);
  });

  it('every valor*, preco* and quantidade* leaf of an estrutural operation is allow-listed', () => {
    const fora: string[] = [];
    let vistos = 0;
    for (const op of ops) {
      const caminho = concreto(op.caminho);
      if (classificarCaminho(caminho) !== 'estrutural') continue;
      for (const [folha] of op.folhas) {
        const ultima = folha.split('.').pop() ?? '';
        if (!/^(valor|preco|quantidade)/.test(ultima)) continue;
        vistos += 1;
        if (tabelaDoCaminho(caminho)?.permitidas.get(folha) === undefined) {
          fora.push(`${op.caminho} ${folha}`);
        }
      }
    }
    expect(vistos).toBeGreaterThan(15);
    expect(fora).toEqual([]);
  });

  it('no always-denied key sits on an allow-listed path of an estrutural table', () => {
    const negada = (k: string) =>
      SUBARVORES_NEGADAS_LI.has(k) ||
      CHAVES_NEGADAS_LI.has(k) ||
      PREFIXOS_NEGADOS_LI.some((p) => k.startsWith(p));
    const estruturais = [
      TABELAS_LI.pedido,
      TABELAS_LI.pedidoBusca,
      TABELAS_LI.historico,
      TABELAS_LI.situacaoPedido,
      TABELAS_LI.pedidoEnvio,
      TABELAS_LI.generica,
    ];
    const conflitos = estruturais.flatMap((t) =>
      [...t.permitidas.keys()].filter((p) => p.split('.').some(negada)),
    );
    expect(conflitos).toEqual([]);
  });

  it("every transcribed example's leaves are leaves of the inventory", () => {
    const folhasDe = (v: unknown, caminho: string, saida: string[]) => {
      const juntar = (k: string) => (caminho === '' ? k : `${caminho}.${k}`);
      if (Array.isArray(v)) {
        if (v.length === 0) saida.push(caminho);
        for (const item of v) folhasDe(item, juntar('*'), saida);
      } else if (v !== null && typeof v === 'object') {
        for (const [k, f] of Object.entries(v)) folhasDe(f, juntar(k), saida);
      } else saida.push(caminho);
      return saida;
    };
    const fora: string[] = [];
    for (const ex of exemplosDaEspecificacao(PII)) {
      const op = ops.find((o) => `${o.metodo} ${o.caminho}` === ex.operacao);
      expect(op, ex.operacao).toBeDefined();
      const doInventario = new Set(op?.folhas.map(([c]) => c));
      for (const f of folhasDe(ex.corpo, '', [])) {
        if (!doInventario.has(f)) fora.push(`${ex.operacao} ${f}`);
      }
    }
    expect(fora).toEqual([]);
  });

  it('the security lists are exactly these (a change is a reviewed edit of this test)', () => {
    expect([...SUBARVORES_NEGADAS_LI].sort()).toEqual(['cliente', 'endereco_entrega', 'enderecos']);
    expect([...CHAVES_NEGADAS_LI].sort()).toEqual(
      [
        'access_key',
        'authorization_code',
        'bairro',
        'banco',
        'bandeira',
        'cep',
        'cidade',
        'cliente_obs',
        'cnpj',
        'codigo_retorno_gateway',
        'complemento',
        'cpf',
        'cupom_desconto',
        'data_nascimento',
        'destinatario',
        'email',
        'identificador_id',
        'ie',
        'mensagem_gateway',
        'nome',
        'notifyUrl',
        'obs',
        'observacao',
        'razao_social',
        'referencia',
        'rg',
        'sexo',
        'token',
        'transacao_id',
        'utm_campaign',
      ].sort(),
    );
    expect([...PREFIXOS_NEGADOS_LI].sort()).toEqual([
      'alterado_por',
      'endereco',
      'telefone',
      'url',
    ]);
    expect([...CHAVES_FALSAS_CATALOGO_LI].sort()).toEqual(
      [
        'apelido',
        'caminho',
        'custo',
        'grande',
        'icone',
        'id_anymarket',
        'imagem',
        'imagem_variacao',
        'media',
        'nome',
        'nome_visivel',
        'pequena',
        'preco_custo',
        'tags',
      ].sort(),
    );
    expect([...PREFIXOS_FALSOS_CATALOGO_LI].sort()).toEqual(['descricao', 'seo', 'url']);
  });
});

/* -------------------------------------------------------------------------- */
/*                        The public document's examples                       */
/* -------------------------------------------------------------------------- */

const exemplos = new Map<string, ExemploEspecificacaoLi>(
  exemplosDaEspecificacao(PII).map((e) => [e.operacao, e]),
);
function exemplo(operacao: string): ExemploEspecificacaoLi {
  const e = exemplos.get(operacao);
  if (e === undefined) throw new Error(`no example for ${operacao}`);
  return e;
}

/** Every fake personal value the examples carry, plus the generated CPF. */
const PII_DOS_EXEMPLOS = [...Object.values(PII_FALSA), CPF];

describe('the examples — no personal value survives, and the structure does', () => {
  it.each(exemplosDaEspecificacao(PII).map((e) => [e.operacao, e] as const))(
    '%s: no fake personal value in either profile',
    (_op, ex) => {
      const corpo = JSON.stringify(ex.corpo);
      const noLog = log(ex.caminho, 200, corpo).trecho ?? '';
      const r = fixture(ex.caminho, 200, corpo);
      expect(r.ok).toBe(true);
      const noFixture = JSON.stringify(r.ok ? r.corpo : null);
      for (const pii of PII_DOS_EXEMPLOS) {
        expect(noLog).not.toContain(pii);
        // `00000-000` is also the fixture's own CEP placeholder.
        if (!PLACEHOLDERS_FIXTURE_LI.has(pii)) expect(noFixture).not.toContain(pii);
      }
    },
  );

  it('GET /v1/pedido/{pedido_id} — log', () => {
    const ex = exemplo('GET /v1/pedido/{pedido_id}');
    const saida = logJson(ex.caminho, 200, ex.corpo);
    // Non-vacuity: these allow-listed values come out unchanged.
    for (const [caminho, valor] of [
      ['numero', 165],
      ['valor_total', '32.48'],
      ['data_criacao', '2022-10-31T12:28:05.704751'],
      ['situacao.codigo', 'pedido_cancelado'],
      ['itens.0.sku', 'casaco-azul-tam-m666'],
      ['itens.0.quantidade', '1.00'],
      ['envios.0.forma_envio.code', 'PAC'],
      ['pagamentos.0.forma_pagamento.codigo', 'pagsegurov2'],
      ['pagamentos.0.parcelamento.valor_parcela', 32.48],
    ] as const) {
      expect(em(saida, caminho), caminho).toBe(valor);
    }
    expect(saida).toMatchInlineSnapshot(`
      {
        "cliente": {
          "cnpj": null,
          "cpf": "<redacted>",
          "data_nascimento": null,
          "email": "<redacted>",
          "id": "<redacted>",
          "nome": "<redacted>",
          "razao_social": null,
          "resource_uri": "<redacted>",
          "sexo": "",
          "telefone_celular": "<redacted>",
          "telefone_principal": null,
        },
        "cliente_obs": null,
        "cupom_desconto": null,
        "data_criacao": "2022-10-31T12:28:05.704751",
        "data_expiracao": "2022-11-06T12:28:05.782308",
        "data_modificacao": "2022-10-31T12:28:12.653648",
        "endereco_entrega": {
          "bairro": "<redacted>",
          "cep": "<redacted>",
          "cidade": "<redacted>",
          "cnpj": null,
          "complemento": null,
          "cpf": "<redacted>",
          "endereco": "<redacted>",
          "estado": "<redacted>",
          "id": "<redacted>",
          "ie": "<redacted>",
          "nome": "<redacted>",
          "numero": "<redacted>",
          "pais": "<redacted>",
          "razao_social": null,
          "referencia": null,
          "rg": null,
          "tipo": "<redacted>",
        },
        "envios": [
          {
            "data_criacao": "2022-10-31T12:28:05.722569",
            "data_modificacao": "2022-10-31T12:28:05.722584",
            "forma_envio": {
              "code": "PAC",
              "id": 141909,
              "nome": "<redacted>",
              "tipo": "<redacted>",
            },
            "id": 69291055,
            "objeto": null,
            "prazo": 7,
            "valor": "21.38",
          },
        ],
        "id_anymarket": null,
        "id_externo": null,
        "itens": [
          {
            "altura": 2,
            "disponibilidade": 0,
            "id": 156487061,
            "largura": 12,
            "linha": 1,
            "nome": "<redacted>",
            "pedido": "/api/v1/pedido/165",
            "peso": "0.450",
            "preco_cheio": "12.00",
            "preco_custo": null,
            "preco_promocional": "11.10",
            "preco_subtotal": "11.10",
            "preco_venda": "11.10",
            "produto": {
              "id_externo": 88568855,
              "resource_uri": "<redacted>",
            },
            "produto_pai": "/api/v1/produto/182904918",
            "profundidade": 6,
            "quantidade": "1.00",
            "sku": "casaco-azul-tam-m666",
            "tipo": "atributo_opcao",
          },
        ],
        "numero": 165,
        "pagamentos": [
          {
            "authorization_code": null,
            "banco": null,
            "bandeira": "<redacted>",
            "codigo_retorno_gateway": null,
            "forma_pagamento": {
              "codigo": "pagsegurov2",
              "configuracoes": {
                "ativo": "<redacted>",
                "disponivel": "<redacted>",
              },
              "id": 24,
              "imagem": "<redacted>",
              "nome": "<redacted>",
              "resource_uri": "<redacted>",
            },
            "id": 69291176,
            "identificador_id": null,
            "mensagem_gateway": null,
            "pagamento_tipo": "creditCard",
            "parcelamento": {
              "numero_parcelas": 1,
              "valor_parcela": 32.48,
            },
            "transacao_id": null,
            "valor": "32.48",
            "valor_pago": "32.48",
          },
        ],
        "peso_real": "0.450",
        "resource_uri": "/api/v1/pedido/165",
        "situacao": {
          "aprovado": false,
          "cancelado": true,
          "codigo": "pedido_cancelado",
          "final": true,
          "id": 8,
          "nome": "<redacted>",
          "notificar_comprador": true,
          "padrao": false,
          "resource_uri": "/api/v1/situacao/8",
        },
        "utm_campaign": null,
        "valor_desconto": "0.00",
        "valor_envio": "21.38",
        "valor_subtotal": "11.10",
        "valor_total": "32.48",
      }
    `);
  });

  it('GET /v1/pedido/search — log', () => {
    const ex = exemplo('GET /v1/pedido/search');
    const saida = logJson(ex.caminho, 200, ex.corpo);
    expect(em(saida, 'objects.0.numero')).toBe(164);
    expect(em(saida, 'objects.0.valor_total')).toBe('106.38');
    expect(em(saida, 'meta.total_count')).toBe(2);
    expect(em(saida, 'objects.0.cliente')).toBe(REDIGIDO);
    expect(saida).toMatchInlineSnapshot(`
      {
        "meta": {
          "limit": 15,
          "next": null,
          "offset": 0,
          "previous": null,
          "total_count": 2,
        },
        "objects": [
          {
            "cliente": "<redacted>",
            "data_criacao": "2022-10-31T12:17:51.633657",
            "data_expiracao": "2022-11-06T12:17:51.733114",
            "data_modificacao": "2022-10-31T12:17:58.949670",
            "id_anymarket": null,
            "id_externo": null,
            "numero": 164,
            "peso_real": "0.170",
            "resource_uri": "/api/v1/pedido/164",
            "situacao": {
              "aprovado": false,
              "cancelado": true,
              "codigo": "pedido_cancelado",
              "final": true,
              "id": 8,
              "nome": "<redacted>",
              "notificar_comprador": true,
              "padrao": false,
              "resource_uri": "/api/v1/situacao/8",
            },
            "utm_campaign": null,
            "valor_desconto": "0.00",
            "valor_envio": "21.38",
            "valor_subtotal": "85.00",
            "valor_total": "106.38",
          },
        ],
      }
    `);
  });

  it('GET /v1/situacao_historico/search — log', () => {
    const ex = exemplo('GET /v1/situacao_historico/search');
    const saida = logJson(ex.caminho, 200, ex.corpo);
    expect(em(saida, 'objects.0.situacao_anterior.codigo')).toBe('pedido_efetuado');
    expect(em(saida, 'objects.0.data')).toBe('2022-10-31T12:28:12.673363');
    expect(saida).toMatchInlineSnapshot(`
      {
        "meta": {
          "limit": 20,
          "next": null,
          "offset": 0,
          "previous": null,
          "total_count": 2,
        },
        "objects": [
          {
            "alterado_por": "<redacted>",
            "alterado_por_nome": "<redacted>",
            "data": "2022-10-31T12:28:12.673363",
            "id": 207232816,
            "numero": 165,
            "obs": null,
            "resource_uri": "/api/v1/situacao_historico/207232816",
            "situacao": {
              "aprovado": false,
              "cancelado": true,
              "codigo": "pedido_cancelado",
              "final": true,
              "id": 8,
              "nome": "<redacted>",
              "notificar_comprador": true,
              "padrao": false,
              "resource_uri": "/api/v1/situacao/8",
            },
            "situacao_anterior": {
              "aprovado": false,
              "cancelado": false,
              "codigo": "pedido_efetuado",
              "final": false,
              "id": 9,
              "nome": "<redacted>",
              "notificar_comprador": false,
              "padrao": true,
              "resource_uri": "/api/v1/situacao/9",
            },
          },
        ],
      }
    `);
  });

  it.each([
    'GET /v1/situacao',
    'GET /v1/pagamento',
    'GET /v1/pagamento/{pagamento_id}',
    'GET /v1/envio',
    'GET /v1/envio/{envio_id}',
  ])('%s — log keeps codes, flags and labels; drops the image', (op) => {
    const ex = exemplo(op);
    const saida = logJson(ex.caminho, 200, ex.corpo);
    const linha = em(saida, 'objects.0') ?? saida;
    expect(em(linha, 'codigo')).toEqual(expect.any(String));
    expect(em(linha, 'nome')).not.toBe(REDIGIDO);
    expect(em(linha, 'id')).toEqual(expect.any(Number));
    // `/v1/situacao` rows have no image; the others answer null or a URL.
    expect([undefined, null, REDIGIDO]).toContain(em(linha, 'imagem'));
  });

  it('GET /v1/pagamento/{pagamento_id}, GET /v1/envio — log snapshots', () => {
    const saidas = ['GET /v1/pagamento/{pagamento_id}', 'GET /v1/envio'].map((op) =>
      logJson(exemplo(op).caminho, 200, exemplo(op).corpo),
    );
    expect(saidas).toMatchInlineSnapshot(`
      [
        {
          "codigo": "boleto",
          "configuracoes": {
            "ativo": false,
            "disponivel": false,
          },
          "id": 8,
          "imagem": "<redacted>",
          "nome": "Boleto Bancário",
          "resource_uri": "/api/v1/pagamento/8",
        },
        {
          "meta": {
            "limit": 20,
            "next": null,
            "offset": 0,
            "previous": null,
            "total_count": 12,
          },
          "objects": [
            {
              "codigo": "enviali",
              "configuracoes": {
                "ativo": true,
                "disponivel": true,
              },
              "id": 141909,
              "imagem": null,
              "nome": "Enviali",
              "resource_uri": "/api/v1/envio/141909",
              "tipo": "enviali",
            },
            {
              "codigo": "sedex",
              "configuracoes": {
                "ativo": true,
                "disponivel": true,
              },
              "id": 1,
              "imagem": "<redacted>",
              "nome": "SEDEX",
              "resource_uri": "/api/v1/envio/1",
              "tipo": "correios_api",
            },
          ],
        },
      ]
    `);
  });

  it('GET /v1/situacao, GET /v1/pagamento, GET /v1/envio/{envio_id} — log snapshots', () => {
    const saidas = ['GET /v1/situacao', 'GET /v1/pagamento', 'GET /v1/envio/{envio_id}'].map((op) =>
      logJson(exemplo(op).caminho, 200, exemplo(op).corpo),
    );
    expect(saidas).toMatchInlineSnapshot(`
      [
        {
          "meta": {
            "limit": 20,
            "next": null,
            "offset": 0,
            "previous": null,
            "total_count": 15,
          },
          "objects": [
            {
              "aprovado": false,
              "cancelado": false,
              "codigo": "aguardando_pagamento",
              "final": false,
              "id": 2,
              "nome": "Aguardando pagamento",
              "notificar_comprador": true,
              "padrao": false,
              "resource_uri": "/api/v1/situacao/2",
            },
            {
              "aprovado": true,
              "cancelado": false,
              "codigo": "em_producao",
              "final": false,
              "id": 17,
              "nome": "Em produção",
              "notificar_comprador": true,
              "padrao": false,
              "resource_uri": "/api/v1/situacao/17",
            },
          ],
        },
        {
          "meta": {
            "limit": 20,
            "next": "/api/v1/pagamento?limit=20&offset=20",
            "offset": 0,
            "previous": null,
            "total_count": 27,
          },
          "objects": [
            {
              "codigo": "wcboleto",
              "configuracoes": {
                "ativo": false,
                "disponivel": true,
              },
              "id": 30,
              "imagem": "<redacted>",
              "nome": "Boleto Bancário",
              "resource_uri": "/api/v1/pagamento/30",
            },
            {
              "codigo": "deposito",
              "configuracoes": {
                "ativo": false,
                "disponivel": false,
              },
              "id": 7,
              "imagem": "<redacted>",
              "nome": "Depósito Bancário",
              "resource_uri": "/api/v1/pagamento/7",
            },
          ],
        },
        {
          "codigo": "mercadoenvios_normal",
          "configuracoes": {
            "ativo": false,
            "disponivel": false,
          },
          "id": 30133,
          "imagem": null,
          "nome": "MercadoEnvios Normal",
          "resource_uri": "/api/v1/envio/30133",
          "tipo": "mercadoenvios_api",
        },
      ]
    `);
  });

  it.each([
    'GET /v1/produto/{produto_id}',
    'GET /v1/produto_estoque/{produto_id}',
    'GET /v1/produto_preco/{produto_id}',
  ])('%s — the log keeps a catalogue body whole, behind the regex layer', (op) => {
    const ex = exemplo(op);
    const r = log(ex.caminho, 200, JSON.stringify(ex.corpo));
    expect(r.politica).toBe('catalogo');
    expect(r.trecho).toBe(JSON.stringify(ex.corpo));
    expect(r.mascarados).toBe(0);
  });

  it('GET /v1/produto/{produto_id} — fixture keep-list', () => {
    const ex = exemplo('GET /v1/produto/{produto_id}');
    const saida = fixtureJson(ex.caminho, 200, ex.corpo);
    for (const [caminho, valor] of [
      ['id', 238281213],
      ['sku', '16167'],
      ['peso', '0.500'],
      ['preco_cheio', 100],
      ['estoque_situacao_sem_estoque', -1],
      ['imagens.0.imagem_id', 154961348],
      ['imagem_principal.mime', 'image/jpeg'],
      ['marca', '/api/v1/marca/20507618'],
    ] as const) {
      expect(em(saida, caminho), caminho).toBe(valor);
    }
    for (const caminho of ['nome', 'apelido', 'imagens.0.caminho', 'imagens.0.grande', 'seo']) {
      expect(em(saida, caminho), caminho).toBe(FALSO_LI.texto);
    }
    expect(em(saida, 'url')).toBe(FALSO_LI.url);
    expect(saida).toMatchInlineSnapshot(`
      {
        "altura": 15,
        "apelido": "REDACTED",
        "ativo": true,
        "bloqueado": false,
        "categorias": [
          "/api/v1/categoria/23171713",
        ],
        "data_criacao": "2023-10-23T16:06:03.257071",
        "data_modificacao": "2025-03-17T10:27:10.571236",
        "descricao_completa": "",
        "destaque": false,
        "estoque_gerenciado": true,
        "estoque_quantidade": 15,
        "estoque_situacao_em_estoque": 0,
        "estoque_situacao_sem_estoque": -1,
        "grades": [],
        "gtin": "",
        "id": 238281213,
        "id_externo": null,
        "imagem_principal": {
          "caminho": "REDACTED",
          "grande": "REDACTED",
          "icone": "REDACTED",
          "id": 143127013,
          "id_anymarket": null,
          "imagem_id": 154961348,
          "media": "REDACTED",
          "mime": "image/jpeg",
          "pequena": "REDACTED",
          "posicao": "0",
          "principal": true,
          "produto": "/api/v1/produto/238281213",
          "resource_uri": "/api/v1/produto_imagem/143127013",
        },
        "imagens": [
          {
            "caminho": "REDACTED",
            "grande": "REDACTED",
            "icone": "REDACTED",
            "id": 143127013,
            "id_anymarket": null,
            "imagem_id": 154961348,
            "media": "REDACTED",
            "mime": "image/jpeg",
            "pequena": "REDACTED",
            "posicao": "0",
            "principal": true,
            "produto": "/api/v1/produto/238281213",
            "resource_uri": "/api/v1/produto_imagem/143127013",
          },
          {
            "caminho": "REDACTED",
            "grande": "REDACTED",
            "icone": "REDACTED",
            "id": 138518698,
            "id_anymarket": null,
            "imagem_id": 150044515,
            "media": "REDACTED",
            "mime": null,
            "pequena": "REDACTED",
            "posicao": null,
            "principal": false,
            "produto": "/api/v1/produto/238281213",
            "resource_uri": "/api/v1/produto_imagem/138518698",
          },
        ],
        "largura": 15,
        "marca": "/api/v1/marca/20507618",
        "mpn": "",
        "ncm": "",
        "nome": "REDACTED",
        "pai": null,
        "peso": "0.500",
        "preco_cheio": 100,
        "preco_custo": null,
        "preco_promocional": null,
        "preco_sob_consulta": false,
        "profundidade": 15,
        "removido": false,
        "resource_uri": "/api/v1/produto/238281213",
        "seo": "REDACTED",
        "sku": "16167",
        "tags": [],
        "tipo": "normal",
        "url": "https://redacted.invalid/",
        "url_video_youtube": "",
        "usado": false,
        "variacoes": [],
      }
    `);
  });

  it('GET /v1/produto_estoque/{produto_id} and GET /v1/produto_preco/{produto_id} — fixture', () => {
    const estoque = exemplo('GET /v1/produto_estoque/{produto_id}');
    const preco = exemplo('GET /v1/produto_preco/{produto_id}');
    const saidas = [
      fixtureJson(estoque.caminho, 200, estoque.corpo),
      fixtureJson(preco.caminho, 200, preco.corpo),
    ];
    expect(em(saidas[0], 'quantidade_reservada')).toBe(0);
    expect(em(saidas[1], 'promocional')).toBe('22.83');
    expect(em(saidas[1], 'custo')).toBe(FALSO_LI.texto);
    expect(saidas).toMatchInlineSnapshot(`
      [
        {
          "gerenciado": true,
          "id": 109877209,
          "produto": "/api/v1/produto/174389010",
          "quantidade": 10,
          "quantidade_disponivel": 10,
          "quantidade_reservada": 0,
          "resource_uri": "/api/v1/produto_estoque/174389010",
          "situacao_em_estoque": 0,
          "situacao_sem_estoque": -1,
        },
        {
          "cheio": "32.83",
          "custo": "REDACTED",
          "id": 109870055,
          "produto": "/api/v1/produto/174389010",
          "promocional": "22.83",
          "resource_uri": "/api/v1/produto_preco/174389010",
          "sob_consulta": false,
        },
      ]
    `);
  });
});

/* -------------------------------------------------------------------------- */
/*                         Unknown personal data                               */
/* -------------------------------------------------------------------------- */

const CORPO_PII_DESCONHECIDA = {
  numero: 165,
  destinatario: {
    nome: PII_FALSA.nome,
    cpf: CPF,
    endereco: { logradouro: PII_FALSA.logradouro, cep: PII_FALSA.cep },
  },
  obs: `ligar ${PII_FALSA.telefone}`,
  itens: [{ sku: 'sku-1', personalizacao: { endereco: PII_FALSA.logradouro } }],
  [PII_FALSA.email]: 'x',
  campo_novo: PII_FALSA.nome,
};

describe('a body carrying personal data in places no table knows', () => {
  it('log: every value is <redacted>; the denied subtree keeps its keys; the e-mail KEY is masked', () => {
    const saida = logJson('/v1/pedido/165', 200, CORPO_PII_DESCONHECIDA);
    expect(saida).toEqual({
      numero: 165,
      destinatario: {
        nome: REDIGIDO,
        cpf: REDIGIDO,
        endereco: { logradouro: REDIGIDO, cep: REDIGIDO },
      },
      obs: REDIGIDO,
      itens: [{ sku: 'sku-1', personalizacao: { endereco: REDIGIDO } }],
      '<redacted:email>': REDIGIDO,
      campo_novo: REDIGIDO,
    });
  });

  it('fixture: every value is a fake of its type; the e-mail key is renamed', () => {
    const saida = fixtureJson('/v1/pedido/165', 200, CORPO_PII_DESCONHECIDA);
    expect(saida).toEqual({
      numero: 165,
      destinatario: {
        nome: FALSO_LI.texto,
        cpf: FALSO_LI.cpf,
        endereco: { logradouro: FALSO_LI.texto, cep: FALSO_LI.cep },
      },
      obs: FALSO_LI.texto,
      itens: [{ sku: 'sku-1', personalizacao: { endereco: FALSO_LI.texto } }],
      chave_redigida_5: FALSO_LI.texto,
      campo_novo: FALSO_LI.texto,
    });
  });

  it('the same text on a CATALOGUE path is span-masked in the log, counted', () => {
    const r = log('/v1/produto/1', 200, JSON.stringify(CORPO_PII_DESCONHECIDA));
    expect(r.mascarados).toBeGreaterThanOrEqual(4);
    for (const pii of [CPF, PII_FALSA.cep, PII_FALSA.telefone, PII_FALSA.email]) {
      expect(r.trecho).not.toContain(pii);
    }
    expect(r.trecho).toContain('<redacted:cpf>');
    expect(r.trecho).toContain('<redacted:email>');
  });
});

/* -------------------------------------------------------------------------- */
/*                               Error bodies                                  */
/* -------------------------------------------------------------------------- */

describe('error bodies', () => {
  it('a 400 on /v1/pedido/1 echoing a name, an address and CPFs logs none of them', () => {
    const corpo = {
      erro: `cliente ${PII_FALSA.nome} invalido`,
      nome: PII_FALSA.nome,
      endereco: PII_FALSA.logradouro,
      documento: Number(CPF),
      x_doc: CPF,
      codigo: 'campo_invalido',
      pedido: 123456,
    };
    const r = log('/v1/pedido/1', 400, JSON.stringify(corpo));
    for (const pii of [PII_FALSA.nome, PII_FALSA.logradouro, CPF, 'Fulano']) {
      expect(r.trecho).not.toContain(pii);
    }
    expect(JSON.parse(r.trecho ?? '')).toEqual({
      erro: REDIGIDO,
      nome: REDIGIDO,
      endereco: REDIGIDO,
      documento: REDIGIDO,
      x_doc: REDIGIDO,
      codigo: 'campo_invalido',
      pedido: 123456,
    });
  });

  it('near-miss: a code-shaped string with a 10-digit run, a punctuated CPF, and a long number are dropped', () => {
    const r = log(
      '/v1/pedido/1',
      422,
      JSON.stringify({
        a: 'ref_1234567890',
        b: `${CPF.slice(0, 3)}.${CPF.slice(3, 6)}.${CPF.slice(6, 9)}-${CPF.slice(9)}`,
        c: 1e9,
        d: 999_999_999,
        e: true,
        f: null,
      }),
    );
    expect(JSON.parse(r.trecho ?? '')).toEqual({
      a: REDIGIDO,
      b: REDIGIDO,
      c: REDIGIDO,
      d: 999_999_999,
      e: true,
      f: null,
    });
  });

  it('a 2xx estrutural body that is not JSON (it could be a cut pedido): no excerpt', () => {
    for (const corpo of [
      `<html>${PII_FALSA.nome}</html>`,
      `{"cliente": {"nome": "${PII_FALSA.nome}"`,
    ]) {
      const r = log('/v1/pedido/1', 200, corpo);
      expect(r).toMatchObject({ politica: 'estrutural', forma: 'texto', trecho: null });
    }
  });

  it('an estrutural non-JSON error body: byte count and form only', () => {
    const r = log('/v1/pedido/1', 500, `<html>${PII_FALSA.nome}</html>`);
    expect(r).toMatchObject({ politica: 'estrutural', forma: 'texto', trecho: null });
    expect(r.bytes).toBeGreaterThan(0);
  });

  it('a 4xx on /webhooks/v1/pedido echoing a secret gets no excerpt, ever', () => {
    const segredo = 'SEGREDO-SENTINELA-webhook';
    for (const status of [200, 400, 401, 500]) {
      const r = log('/webhooks/v1/pedido', status, JSON.stringify({ token: segredo }));
      expect(r).toMatchObject({ politica: 'webhook', trecho: null, forma: 'nao-analisado' });
      expect(JSON.stringify(r)).not.toContain(segredo);
    }
  });

  it('a 401 on /v1/categoria/ keeps its text in the log, masked', () => {
    const r = log(
      '/v1/categoria/',
      401,
      JSON.stringify({ detail: `Token inválido para ${PII_FALSA.email}` }),
    );
    expect(r.politica).toBe('catalogo');
    expect(r.trecho).toBe('{"detail":"Token inválido para <redacted:email>"}');
    expect(r.mascarados).toBe(1);
  });

  it('fixture: a catalogue 400 echoing a product name keeps no string but "codigo": "533"', () => {
    const corpo = {
      codigo: '533',
      mensagem: 'Produto Exemplo Azul já existe',
      nome: 'Produto Exemplo Azul',
      detalhes: [{ campo: 'sku', valor: 'Produto Exemplo Azul' }],
      limite: 100,
    };
    const saida = fixtureJson('/v1/produto/1', 400, corpo);
    expect(saida).toEqual({
      codigo: '533',
      mensagem: FALSO_LI.texto,
      nome: FALSO_LI.texto,
      detalhes: [{ campo: FALSO_LI.texto, valor: FALSO_LI.texto }],
      limite: 100,
    });
    expect(JSON.stringify(saida)).not.toContain('Produto');
  });

  it('fixture: error digits — short kept, long faked', () => {
    expect(fixtureJson('/v1/pedido/1', 400, { pedido: 123456 })).toEqual({ pedido: 123456 });
    expect(fixtureJson('/v1/pedido/1', 400, { x: Number(CPF) })).toEqual({ x: 0 });
    expect(fixtureJson('/v1/pedido/1', 400, { x: CPF })).toEqual({ x: FALSO_LI.texto });
  });

  it('fixture: a non-2xx body that is not JSON (or is empty) keeps no body', () => {
    for (const [caminho, corpo] of [
      ['/v1/categoria/', '<html>401</html>'],
      ['/v1/pedido/1', '<html>400</html>'],
      ['/v1/pedido/1', ''],
    ] as const) {
      const r = fixture(caminho, 400, corpo);
      expect(r).toMatchObject({ ok: true, corpo: null });
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                           Path → policy, path → line                        */
/* -------------------------------------------------------------------------- */

describe('classificarCaminho', () => {
  it.each([
    ['/v1/situacao', 'configuracao'],
    ['/v1/situacao/', 'configuracao'],
    ['/v1/pagamento/3', 'configuracao'],
    ['/v1/envio/', 'configuracao'],
    ['/v1/envio/141909', 'configuracao'],
    ['/v1/produto/1', 'catalogo'],
    ['/v1/produto/', 'catalogo'],
    ['/v1/produto/1/alias', 'catalogo'],
    ['/v1/produto_estoque/1', 'catalogo'],
    ['/v1/produto_preco/set/1;2;3', 'catalogo'],
    ['/v1/produto_preco/', 'catalogo'],
    ['/v1/produto_imagem/1/grade_variacao/2', 'catalogo'],
    ['/v1/categoria/', 'catalogo'],
    ['/v1/marca/7', 'catalogo'],
    ['/v1/grades/8945', 'catalogo'],
    ['/v1/grade/8945/variacao', 'catalogo'],
    ['/webhooks/v1/pedido', 'webhook'],
    ['/v1/situacao/pedido/1', 'estrutural'],
    ['/v1/situacao/1', 'estrutural'],
    ['/v1/produtox/1', 'estrutural'],
    ['/v1/produto/abc', 'estrutural'],
    ['/v1/pagamento/3/x', 'estrutural'],
    ['/v1/pedido/165', 'estrutural'],
    ['/v1/pedido/search/', 'estrutural'],
    ['/v1/cliente/1', 'estrutural'],
    ['/api/v1/produto/1', 'estrutural'],
    ['', 'estrutural'],
  ])('%s → %s', (caminho, politica) => {
    expect(classificarCaminho(caminho)).toBe(politica);
  });

  it('picks the estrutural table by shape; an unknown path falls back to the generic one', () => {
    expect(tabelaDoCaminho('/v1/pedido/165')).toBe(TABELAS_LI.pedido);
    expect(tabelaDoCaminho('/v1/pedido/search/')).toBe(TABELAS_LI.pedidoBusca);
    expect(tabelaDoCaminho('/v1/situacao_historico/search')).toBe(TABELAS_LI.historico);
    expect(tabelaDoCaminho('/v1/situacao/pedido/1')).toBe(TABELAS_LI.situacaoPedido);
    expect(tabelaDoCaminho('/v1/pedido_envio/9')).toBe(TABELAS_LI.pedidoEnvio);
    expect(tabelaDoCaminho('/v1/pedido_nf/9')).toBe(TABELAS_LI.generica);
    expect(tabelaDoCaminho('/webhooks/v1/pedido')).toBeNull();
  });

  it('recursoDoCaminho names the resource, never an id or a value', () => {
    expect(recursoDoCaminho('/v1/produto_estoque/1')).toBe('produto_estoque');
    expect(recursoDoCaminho('/webhooks/v1/pedido')).toBe('pedido');
    expect(recursoDoCaminho('/v1/Fulano/1')).toBeNull();
    expect(recursoDoCaminho('/x')).toBeNull();
  });
});

describe('redigirCaminhoEQuery', () => {
  const t = (entrada: Parameters<typeof redigirCaminhoEQuery>[0]) =>
    textoDoCaminho(redigirCaminhoEQuery(entrada));

  it.each([
    [
      '/api/v1/pedido/search/?limit=20&offset=20&since_atualizado=2026-09-25T00%3A00%3A00',
      '/api/v1/pedido/search/?limit=20&offset=20&since_atualizado=2026-09-25T00%3A00%3A00',
    ],
    [
      '/api/v1/pedido/search/?since_atualizado=2026-09-25T00:00:00',
      '/api/v1/pedido/search/?since_atualizado=2026-09-25T00:00:00',
    ],
    ['/v1/pedido/search?limit=abc', '/v1/pedido/search?limit=<redacted>'],
    [
      '/v1/cliente/search?cliente_email=fulano%40exemplo.invalid',
      '/v1/cliente/search?cliente_email=<redacted>',
    ],
    ['/v1/x?email=a', '/v1/x?email=<redacted>'],
    ['/v1/x?chave%20api=1', '/v1/x?<chave>=<redacted>'],
    ['/v1/x?1x=1', '/v1/x?<chave>=<redacted>'],
    ['/v1/pedido/fulano@exemplo.invalid', '/v1/pedido/<redacted>'],
    ['/v1/produto_preco/set/1;2;3', '/v1/produto_preco/set/1;2;3'],
    ['/v1/x/', '/v1/x/'],
    ['/v1/x', '/v1/x'],
    ['/v1/produto?limit=1&limit=2&ativo=true', '/v1/produto?limit=1&limit=2&ativo=true'],
    ['/v1/produto?ativo=sim&removido=0', '/v1/produto?ativo=<redacted>&removido=0'],
    ['/v1/produto?sku=abc-1', '/v1/produto?sku=abc-1'],
    ['/v1/produto?sku=a+b', '/v1/produto?sku=<redacted>'],
    ['/v1/produto?id_externo=123', '/v1/produto?id_externo=123'],
    ['https://api.awsli.com.br/v1/x/?limit=1', 'https://api.awsli.com.br/v1/x/?limit=1'],
    ['https://outro.example/v1/x', '<origem>/v1/x'],
    ['/v1/x#fragmento', '/v1/x'],
    ['/v1/x?', '/v1/x'],
    ['/v1/x?&&limit=1&', '/v1/x?limit=1'],
    ['/v1/x?limit', '/v1/x?limit=<redacted>'],
  ])('%s → %s', (entrada, saida) => {
    expect(t(entrada)).toBe(saida);
  });

  it('a CPF-shaped sku is refused and counted', () => {
    const r = redigirCaminhoEQuery(`/v1/produto?sku=${CPF}`);
    expect(textoDoCaminho(r)).toBe('/v1/produto?sku=<redacted>');
    expect(r.mascarados).toBe(1);
  });

  it("the client's DECODED pairs: tested and emitted as given", () => {
    expect(
      t({
        caminho: '/v1/pedido/search/',
        query: [
          ['since_atualizado', '2026-09-25T00:00:00'],
          ['limit', '50'],
          ['email', PII_FALSA.email],
        ],
      }),
    ).toBe('/v1/pedido/search/?since_atualizado=2026-09-25T00:00:00&limit=50&email=<redacted>');
  });

  it('re-redaction changes nothing (fixtures re-run it)', () => {
    for (const bruto of [
      '/v1/pedido/fulano@exemplo.invalid?email=x&chave%20api=1&limit=abc&limit=2',
      'https://outro.example/v1/x?sku=a+b',
    ]) {
      const uma = t(bruto);
      expect(t(uma)).toBe(uma);
    }
  });

  it('the local origin is the package origin', () => {
    expect(ORIGEM_LI).toBe(URL_BASE_LI);
  });
});

/* -------------------------------------------------------------------------- */
/*                              The regex layer                                */
/* -------------------------------------------------------------------------- */

describe('mascararTexto', () => {
  const m = (texto: string, digitos = true) => mascararTexto(texto, { digitos });
  const cpfPontuado = `${CPF.slice(0, 3)}.${CPF.slice(3, 6)}.${CPF.slice(6, 9)}-${CPF.slice(9)}`;
  const cnpjPontuado = `${CNPJ.slice(0, 2)}.${CNPJ.slice(2, 5)}.${CNPJ.slice(5, 8)}/${CNPJ.slice(8, 12)}-${CNPJ.slice(12)}`;

  it.each([
    [`escreva para ${PII_FALSA.email}.`, 'escreva para <redacted:email>.'],
    [`cpf ${cpfPontuado}`, 'cpf <redacted:cpf>'],
    [`cnpj ${cnpjPontuado}`, 'cnpj <redacted:cnpj>'],
    ['tel (11) 91234-5678', 'tel <redacted:telefone>'],
    ['tel +55 (11) 91234-5678', 'tel <redacted:telefone>'],
    ['tel 1234-5678', 'tel <redacted:telefone>'],
    ['cep 12345-678', 'cep <redacted:cep>'],
    ['cep 12.345-678', 'cep <redacted:cep>'],
    [`doc ${CPF}`, 'doc <redacted:cpf>'],
    [`doc ${CNPJ}`, 'doc <redacted:cnpj>'],
    [`doc ${CNPJ_LETRA}`, 'doc <redacted:cnpj>'],
  ])('%s → %s', (entrada, saida) => {
    expect(m(entrada).texto).toBe(saida);
    expect(m(entrada).mascarados).toBe(1);
  });

  it.each([
    ['an 8-digit id', 'id 12345678'],
    ['a bare 8-digit CEP (looks like an id)', 'cep 01001000'],
    ['a bare 10-digit phone (looks like an id)', 'tel 1191234567'],
    ['an 11-digit run with invalid check digits', `n ${CPF_INVALIDO}`],
    ['a letter-bearing 14-char run with invalid check digits', `n ${CNPJ_LETRA_INVALIDO}`],
    ['a 12-digit run', 'n 123456789012'],
    ['a resource uri', '/api/v1/pedido/165'],
    ['a date', '2022-10-31T12:28:05.704751'],
    ['an @ that is no e-mail', 'a @ b, x@y, @fulano'],
  ])('near-miss: %s is not masked', (_caso, texto) => {
    expect(m(texto)).toEqual({ texto, mascarados: 0 });
  });

  it('without the digit check, a bare CPF stays (the 2xx walk exempts LI ids)', () => {
    expect(m(`doc ${CPF}`, false).texto).toBe(`doc ${CPF}`);
  });

  it('is linear: a 1 MB run with no @ and no digits is fast', () => {
    const inicio = performance.now();
    m(`${'a.'.repeat(500_000)}@`);
    m('1'.repeat(1_000_000));
    expect(performance.now() - inicio).toBeLessThan(2000);
  });
});

/* -------------------------------------------------------------------------- */
/*                        The 2xx walk, near-miss pairs                         */
/* -------------------------------------------------------------------------- */

describe('the estrutural 2xx walk — near-miss pairs', () => {
  const pedido = (extra: Record<string, unknown>) => logJson('/v1/pedido/165', 200, extra);

  it('path policy: root numero kept, endereco_entrega.numero redacted with its key kept', () => {
    expect(pedido({ numero: 165, endereco_entrega: { numero: '12' } })).toEqual({
      numero: 165,
      endereco_entrega: { numero: REDIGIDO },
    });
  });

  it('dates: data_criacao kept, data_nascimento redacted', () => {
    expect(pedido({ data_criacao: '2022-10-31T12:28:05', data_nascimento: '1990-01-01' })).toEqual({
      data_criacao: '2022-10-31T12:28:05',
      data_nascimento: REDIGIDO,
    });
  });

  it('predicate: a code-shaped situacao.codigo kept, an e-mail there redacted', () => {
    expect(pedido({ situacao: { codigo: 'pedido_pago' } })).toEqual({
      situacao: { codigo: 'pedido_pago' },
    });
    expect(pedido({ situacao: { codigo: PII_FALSA.email } })).toEqual({
      situacao: { codigo: REDIGIDO },
    });
  });

  it('second layer: a kept 8-digit id and uri stay; a CEP-shaped token is masked', () => {
    expect(
      pedido({
        numero: 12345678,
        resource_uri: '/api/v1/pedido/165',
        situacao: { codigo: '12345-678' },
      }),
    ).toEqual({
      numero: 12345678,
      resource_uri: '/api/v1/pedido/165',
      situacao: { codigo: '<redacted:cep>' },
    });
  });

  it('bare digits: a valid-check 11-digit inteiro is KEPT; in free text or an objeto it is masked', () => {
    expect(pedido({ numero: CPF, situacao: { id: Number(CPF) } })).toEqual({
      numero: CPF,
      situacao: { id: Number(CPF) },
    });
    expect(pedido({ envios: [{ objeto: CPF }] })).toEqual({
      envios: [{ objeto: '<redacted:cpf>' }],
    });
    expect(pedido({ itens: [{ sku: `x-${CPF}` }] })).toEqual({
      itens: [{ sku: 'x-<redacted:cpf>' }],
    });
    expect(pedido({ itens: [{ sku: `x-${CPF_INVALIDO}` }] })).toEqual({
      itens: [{ sku: `x-${CPF_INVALIDO}` }],
    });
  });

  it('rastreio: a Correios-shaped objeto is kept in the log, an e-mail there redacted', () => {
    expect(pedido({ envios: [{ objeto: 'BR123456789BR' }] })).toEqual({
      envios: [{ objeto: 'BR123456789BR' }],
    });
    expect(pedido({ envios: [{ objeto: PII_FALSA.email }] })).toEqual({
      envios: [{ objeto: REDIGIDO }],
    });
  });

  it('a denied subtree is walked leaf by leaf, never collapsed', () => {
    expect(
      pedido({ cliente: { id: 1, enderecos: [{ cep: '1' }, { cep: '2' }], ativo: true } }),
    ).toEqual({
      cliente: { id: REDIGIDO, enderecos: [{ cep: REDIGIDO }, { cep: REDIGIDO }], ativo: REDIGIDO },
    });
  });

  it('an object or array where a primitive is listed is redacted, keys kept', () => {
    expect(pedido({ numero: { a: 1 }, valor_total: ['1.00'] })).toEqual({
      numero: { a: REDIGIDO },
      valor_total: [REDIGIDO],
    });
  });

  it('a key spelled like a path never matches a table path', () => {
    expect(pedido({ 'situacao.codigo': 'pedido_pago' })).toEqual({ 'situacao.codigo': REDIGIDO });
  });

  it('null and an empty string are kept as they are', () => {
    expect(pedido({ obs: null, campo: '', cliente: { nome: '' } })).toEqual({
      obs: null,
      campo: '',
      cliente: { nome: '' },
    });
  });

  it('meta.next goes through the path and query redactor, keeping %3A', () => {
    const saida = logJson('/v1/pedido/search/', 200, {
      meta: {
        next: '/api/v1/pedido/search/?limit=20&offset=20&since_atualizado=2026-09-25T00%3A00%3A00&email=x',
        previous: null,
      },
      objects: [],
    });
    expect(saida).toEqual({
      meta: {
        next: '/api/v1/pedido/search/?limit=20&offset=20&since_atualizado=2026-09-25T00%3A00%3A00&email=<redacted>',
        previous: null,
      },
      objects: [],
    });
  });

  it('configuracao: nome kept as a label (log), a non-label redacted, an unknown key redacted', () => {
    expect(
      logJson('/v1/situacao/', 200, {
        objects: [{ codigo: 'pedido_pago', nome: 'Pedido Pago', extra: 'x' }, { nome: { a: 1 } }],
      }),
    ).toEqual({
      objects: [
        { codigo: 'pedido_pago', nome: 'Pedido Pago', extra: REDIGIDO },
        { nome: { a: REDIGIDO } },
      ],
    });
  });

  it('the walker caps depth at 32: deeper structure collapses into one refused leaf', () => {
    let fundo: unknown = 'x';
    for (let i = 0; i < 40; i++) fundo = { a: fundo };
    expect(profundidadeJson(JSON.stringify(fundo))).toBe(40);
    // Literal, not derived from the constant: raising the cap must turn this red.
    expect(PROFUNDIDADE_MAXIMA_PERCURSO).toBe(32);
    for (const saida of [
      logJson('/v1/pedido/165', 200, fundo),
      fixtureJson('/v1/pedido/165', 200, fundo),
      logJson('/v1/pedido/165', 400, fundo),
      fixtureJson('/v1/produto/1', 200, fundo),
    ]) {
      // Levels 0..32 are walked (33 objects); level 33 collapses into one leaf.
      expect(profundidadeJson(JSON.stringify(saida))).toBe(33);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                              The fixture profile                            */
/* -------------------------------------------------------------------------- */

describe('the fixture profile', () => {
  it('is idempotent and preserves every JSON type, over every example and synthetic body', () => {
    const casos: [string, number, unknown][] = [
      ...exemplosDaEspecificacao(PII).map(
        (e) => [e.caminho, 200, e.corpo] as [string, number, unknown],
      ),
      ['/v1/pedido/165', 200, CORPO_PII_DESCONHECIDA],
      ['/v1/pedido/1', 400, { erro: 'x', codigo: '533', n: 12345678901, '1x': [true, null, ''] }],
      ['/v1/produto/1', 200, { sku: { a: 'x' }, 'João Silva': 1, filhos: ['/api/v1/produto/2'] }],
    ];
    for (const [caminho, status, corpo] of casos) {
      const uma = fixtureJson(caminho, status, corpo);
      expect(fixtureJson(caminho, status, uma), caminho).toEqual(uma);
    }
    for (const ex of exemplosDaEspecificacao(PII)) {
      expect(forma(fixtureJson(ex.caminho, 200, ex.corpo)), ex.operacao).toEqual(forma(ex.corpo));
    }
  });

  it('objeto → the tracking placeholder; the log keeps a Correios-shaped one', () => {
    const corpo = { envios: [{ objeto: 'BR123456789BR' }] };
    expect(fixtureJson('/v1/pedido/165', 200, corpo)).toEqual({
      envios: [{ objeto: FALSO_LI.rastreio }],
    });
    expect(fixtureJson('/v1/pedido_envio/9', 200, { objeto: 'BR123456789BR' })).toEqual({
      objeto: FALSO_LI.rastreio,
    });
    expect(logJson('/v1/pedido/165', 200, corpo)).toEqual(corpo);
  });

  it("cost (Q3): the pedido's itens.*.preco_custo is faked; the log keeps it", () => {
    const corpo = { itens: [{ preco_custo: 7.5, preco_venda: '11.10' }] };
    expect(fixtureJson('/v1/pedido/165', 200, corpo)).toEqual({
      itens: [{ preco_custo: 0, preco_venda: '11.10' }],
    });
    expect(logJson('/v1/pedido/165', 200, corpo)).toEqual(corpo);
  });

  it("the pedido's external ids and a configuration label are faked", () => {
    expect(
      fixtureJson('/v1/pedido/165', 200, { id_externo: 'EXT-1', id_anymarket: 99, numero: 165 }),
    ).toEqual({ id_externo: FALSO_LI.texto, id_anymarket: 0, numero: 165 });
    expect(
      fixtureJson('/v1/situacao/', 200, {
        objects: [{ codigo: 'pedido_pago', nome: 'Pedido Pago' }],
      }),
    ).toEqual({ objects: [{ codigo: 'pedido_pago', nome: FALSO_LI.texto }] });
  });

  it('key rule: a conforming key stays; a non-conforming one becomes chave_redigida_<position>', () => {
    expect(
      fixtureJson('/v1/pedido/165', 200, { 'João Silva': 1, nome_cliente: 'x', numero: 1 }),
    ).toEqual({ chave_redigida_1: 0, nome_cliente: FALSO_LI.texto, numero: 1 });
    expect(fixtureJson('/v1/pedido/165', 200, { chave_redigida_2: 1, 'x y': 2 })).toEqual({
      chave_redigida_2: 0,
      chave_redigida_4: 0,
    });
  });

  it('keep-list: a string sku kept, an object in sku faked leaf by leaf', () => {
    expect(fixtureJson('/v1/produto/1', 200, { sku: 'abc-1' })).toEqual({ sku: 'abc-1' });
    expect(fixtureJson('/v1/produto/1', 200, { sku: { a: 'x', b: 2 } })).toEqual({
      sku: { a: FALSO_LI.texto, b: 0 },
    });
  });

  it('a 2xx estrutural body that is not JSON is refused; a webhook is refused', () => {
    expect(fixture('/v1/pedido/1', 200, '<html>')).toMatchObject({
      ok: false,
      motivo: 'estrutural-nao-json',
    });
    expect(fixture('/v1/pedido/1', 200, '')).toMatchObject({
      ok: false,
      motivo: 'estrutural-nao-json',
    });
    expect(fixture('/webhooks/v1/pedido', 200, '{}')).toMatchObject({
      ok: false,
      motivo: 'webhook',
    });
    expect(fixture('/v1/pedido/1', null, null)).toMatchObject({
      ok: false,
      motivo: 'sem-resposta',
    });
  });

  it('every placeholder is in the exported set', () => {
    expect([...PLACEHOLDERS_FIXTURE_LI].sort()).toEqual(Object.values(FALSO_LI).sort());
    expect(PLACEHOLDERS_FIXTURE_LI.size).toBe(8);
  });
});

/* -------------------------------------------------------------------------- */
/*                  Bytes, the cut, the caps, and totality                     */
/* -------------------------------------------------------------------------- */

describe('cortarUtf8', () => {
  it('ç straddling the 2048-byte edge: valid UTF-8, at most 2048 bytes', () => {
    const r = cortarUtf8(`${'a'.repeat(2047)}ç`, 2048);
    expect(r).toEqual({ texto: 'a'.repeat(2047), truncado: true });
    expect(cortarUtf8(`${'a'.repeat(2046)}ç`, 2048)).toEqual({
      texto: `${'a'.repeat(2046)}ç`,
      truncado: false,
    });
  });

  it('a 4-byte character is never split, and a lone surrogate counts 3 bytes', () => {
    const r = cortarUtf8(`${'a'.repeat(2046)}😀`, 2048);
    expect(r.texto).toBe('a'.repeat(2046));
    expect(bytesUtf8('😀')).toBe(4);
    expect(bytesUtf8('\ud800')).toBe(3);
    expect(bytesUtf8('aç€')).toBe(1 + 2 + 3);
  });

  it('mask first, cut second: an e-mail straddling the edge leaves no fragment', () => {
    // Byte 2048 falls inside `exemplo`: cut first, `fulano@exe` would survive.
    const corpo = `${'x'.repeat(2037)} ${PII_FALSA.email} fim`;
    expect(cortarUtf8(corpo, 2048).texto.endsWith('fulano@exe')).toBe(true);
    expect(mascararTexto(cortarUtf8(corpo, 2048).texto, { digitos: true }).texto).toContain(
      'fulano@exe',
    );
    const r = log('/v1/categoria/', 401, corpo);
    const corte = cortarUtf8(r.trecho ?? '', 2048);
    expect(corte.texto).not.toContain('fulano');
    expect(corte.texto).not.toContain('@');
    expect(bytesUtf8(corte.texto)).toBeLessThanOrEqual(2048);
  });
});

describe('caps', () => {
  const pagina = (bytes: number) => {
    const linha = JSON.stringify({ id: 1, sku: 'sku-0001', nome: 'Produto Exemplo', ativo: true });
    const n = Math.ceil(bytes / (linha.length + 1));
    return `{"meta":{"limit":${String(n)}},"objects":[${Array(n).fill(linha).join(',')}]}`;
  };

  it('parse cap by profile: a 1.5 MB page is nao-analisado in log, parsed in fixture', () => {
    const corpo = pagina(1.5 * 1024 * 1024);
    expect(bytesUtf8(corpo)).toBeGreaterThan(LIMITE_ANALISE_BYTES.log);
    expect(log('/v1/produto/', 200, corpo)).toMatchObject({ forma: 'nao-analisado', trecho: null });
    const r = fixture('/v1/produto/', 200, corpo);
    expect(r).toMatchObject({ ok: true, forma: 'json' });
    expect(em(r.ok ? r.corpo : null, 'objects.0.sku')).toBe('sku-0001');
  });

  it('a body over 32 MB is refused by the fixture profile', () => {
    expect(LIMITE_ANALISE_BYTES.fixture).toBe(32 * 1024 * 1024);
    const corpo = `"${'x'.repeat(LIMITE_ANALISE_BYTES.fixture)}"`;
    expect(fixture('/v1/produto/1', 200, corpo)).toMatchObject({
      ok: false,
      motivo: 'nao-analisado',
    });
  });

  it('depth pre-scan: counts outside strings only, and stops past the limit', () => {
    expect(profundidadeJson('{"a":[1,{"b":"[[[{{{"}]}')).toBe(3);
    expect(profundidadeJson('"\\"[["')).toBe(0);
    expect(profundidadeJson('['.repeat(10_000), 256)).toBe(257);
    const fundo = `${'['.repeat(300)}${']'.repeat(300)}`;
    expect(log('/v1/produto/1', 200, fundo)).toMatchObject({ forma: 'nao-analisado' });
    expect(fixture('/v1/produto/1', 200, fundo)).toMatchObject({
      ok: false,
      motivo: 'nao-analisado',
    });
  });
});

describe('totality — never throws', () => {
  const corpos: readonly (string | null)[] = [
    null,
    '',
    'null',
    '"x"',
    '[]',
    '<html><body>Erro</body></html>',
    '{"a": ',
    `${'['.repeat(10_000)}${']'.repeat(10_000)}`,
    `[${Array(500_000).fill('1').join(',')}]`,
    `"${'x'.repeat(2 * 1024 * 1024)}"`,
  ];
  const caminhos = ['/v1/pedido/1', '/v1/situacao/', '/v1/produto/1', '/webhooks/v1/pedido'];
  const statuses = [200, 401, 429, 503, null];

  it('over every body × class × status, in both profiles', () => {
    let n = 0;
    for (const corpo of corpos) {
      for (const caminho of caminhos) {
        for (const status of statuses) {
          expect(() => log(caminho, status, corpo)).not.toThrow();
          expect(() => fixture(caminho, status, corpo)).not.toThrow();
          n += 1;
        }
      }
    }
    expect(n).toBe(corpos.length * caminhos.length * statuses.length);
  });
});
