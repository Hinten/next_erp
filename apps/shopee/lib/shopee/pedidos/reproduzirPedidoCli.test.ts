/**
 * The pure half of `reproduzir:pedido`, in six parts:
 *
 *  - §1 the parser, near-misses included (`--viaCep`, the buyer-mode flags);
 *  - §2 the checkout guard — POSIX and Windows vectors, the sibling-prefix
 *    near-miss, a worktree's `.git` FILE;
 *  - §3 the network guard and its look-alike hosts;
 *  - §4 the residue scan: each class found, and the near-misses that must not be;
 *  - §5 THE PROPERTY: over a clear-buyer BR replay (the real engine on `FakeDb`),
 *    neither the rendered report nor the summary JSON nor any printed log line
 *    carries a buyer value — and a deliberately leaking line IS caught;
 *  - §6 the error describer, and §7 the source pins (`scripts/` is outside
 *    vitest's include, so the script is pinned on its SOURCE).
 */
import nodePath from 'node:path';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError, z } from 'zod';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  SHOPEE_ERROR_KIND,
  SHOPEE_ORDER_DETAIL_OPTIONAL_FIELDS,
  ShopeeApiError,
  ShopeeNetworkError,
  ShopeeSchemaError,
} from '@delfrance/integrations-shopee';

import {
  FIXTURE_ESCROW_DETAIL_QTY2_SG,
  FIXTURE_ORDER_DETAIL_QTY2_SG,
  WIRE_DIR,
} from '../fixtures/wireCorpus';
import { makeEnderecoId, type EnderecoImportFields } from '@delfrance/data/admin/enderecos';
import { gerarCnpj, pontuarCpf } from '../testing/documentos';
import { FakeDb, asDb } from '../testing/fakeDb';
import {
  ATRASO_DA_SEGUNDA_PASSADA_MS,
  linhasDeSemente,
  reproduzirPedidoShopee,
  type ResultadoReproducao,
} from './reproduzirPedido';
import {
  ArgumentoInvalidoError,
  ArquivoRecusadoError,
  CapturaInvalidaError,
  ChamadaNaoCapturadaError,
  ENDERECO_ID_REDIGIDO,
  ORDER_SN_REDIGIDO,
  camposOpcionaisAusentes,
  chavesDoEdt,
  conferenciaNfeDosDocumentos,
  descreverErroReproducao,
  documentosParaSaida,
  encontrarResiduos,
  exigirArquivoExistente,
  exigirForaDeCheckout,
  exigirSaidaNova,
  hostParaRelatorio,
  hostPermitidoNaReproducao,
  linhaConferenciaNfe,
  montarSaidaDaReproducao,
  parseArgsReproduzirPedido,
  renderReproducao,
  resumoDaReproducao,
  resumoDoDocumento,
  urlDaRequisicao,
  valoresSensiveisDaCaptura,
  viaCepDesligado,
  type ValorSensivel,
} from './reproduzirPedidoCli';

/* -------------------------------------------------------------------------- */
/*                                  vectors                                    */
/* -------------------------------------------------------------------------- */

/** The repo's one sanctioned fake CPF (`comprador.ts`). */
const CPF_FALSO = '12345678909';
const NOME = 'Fulana Exemplo da Silva';
const TELEFONE = '11988887777';
const CEP = '01001000';
const LOGRADOURO = 'Rua das Acacias Exemplo, 742, Jardim Exemplo';
const APELIDO = 'compradora.exemplo';
const ID_COMPRADOR = 734512908;
const RECADO = 'Deixar com o porteiro Beltrano Exemplo';

interface Envelope {
  readonly error: string;
  readonly message: string;
  readonly response: Record<string, unknown>;
}

function lerWire(nome: string): Envelope {
  return JSON.parse(readFileSync(nodePath.join(WIRE_DIR, nome), 'utf8')) as Envelope;
}

const DETALHE_SG = lerWire(FIXTURE_ORDER_DETAIL_QTY2_SG);
const ESCROW_SG = lerWire(FIXTURE_ESCROW_DETAIL_QTY2_SG);
const LINHA_SG = (DETALHE_SG.response.order_list as Record<string, unknown>[])[0]!;
const ORDER_SN = LINHA_SG.order_sn as string;

function linhaBR(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...structuredClone(LINHA_SG),
    region: 'BR',
    currency: 'BRL',
    buyer_cpf_id: CPF_FALSO,
    buyer_username: APELIDO,
    buyer_user_id: ID_COMPRADOR,
    message_to_seller: RECADO,
    note: '',
    note_update_time: 0,
    return_request_due_date: 0,
    recipient_address: {
      name: NOME,
      phone: TELEFONE,
      town: '',
      district: 'Jardim Exemplo',
      city: 'Cidade Exemplo',
      state: 'SP',
      region: 'BR',
      zipcode: CEP,
      full_address: LOGRADOURO,
    },
    ...patch,
  };
}

async function reproduzir(
  linha = linhaBR(),
  over: { readonly outras?: Record<string, unknown>[]; readonly orderSn?: string } = {},
): Promise<ResultadoReproducao> {
  const db = new FakeDb();
  for (const [caminho, dados] of linhasDeSemente()) db.seed(caminho, { ...dados });
  return reproduzirPedidoShopee(asDb(db), {
    detalheTexto: JSON.stringify({
      error: '',
      message: '',
      response: { order_list: [...(over.outras ?? []), linha] },
    }),
    escrowTexto: JSON.stringify({
      ...ESCROW_SG,
      response: { ...ESCROW_SG.response, order_sn: linha.order_sn, buyer_user_name: APELIDO },
    }),
    orderSn: over.orderSn ?? null,
    nowMs: 1_789_000_000_000,
    viaCep: viaCepDesligado(),
  });
}

/** The clear vector with a `state` no UF table maps — the ViaCEP stub's case. */
function linhaBRUfDesconhecida(): Record<string, unknown> {
  const base = linhaBR();
  return linhaBR({
    recipient_address: {
      ...(base.recipient_address as Record<string, unknown>),
      state: 'Estado Desconhecido',
    },
  });
}

beforeEach(() => __resetAllReadCaches());
afterEach(() => {
  __resetAllReadCaches();
  vi.restoreAllMocks();
});

/* ========================================================================== */
/*  1 · the parser                                                            */
/* ========================================================================== */

describe('§1 parseArgsReproduzirPedido', () => {
  it('--detalhe é o único obrigatório; os demais têm padrão', () => {
    expect(parseArgsReproduzirPedido(['--detalhe', '/fora/d.json'])).toEqual({
      kind: 'reproduzir',
      args: { detalhe: '/fora/d.json', escrow: null, orderSn: null, viaCep: false, saida: null },
    });
    expect(() => parseArgsReproduzirPedido([])).toThrow('--detalhe <arquivo> é obrigatório');
  });

  it('todas as flags, com valor separado ou inline', () => {
    expect(
      parseArgsReproduzirPedido([
        '--detalhe=/fora/d.json',
        '--escrow',
        '/fora/e.json',
        '--order-sn=ABC123',
        '--viacep',
        '--saida',
        '/fora/s.json',
      ]),
    ).toEqual({
      kind: 'reproduzir',
      args: {
        detalhe: '/fora/d.json',
        escrow: '/fora/e.json',
        orderSn: 'ABC123',
        viaCep: true,
        saida: '/fora/s.json',
      },
    });
  });

  it('--help vence antes de qualquer validação', () => {
    expect(parseArgsReproduzirPedido(['--bogus', '--help'])).toEqual({ kind: 'ajuda' });
    expect(parseArgsReproduzirPedido(['-h'])).toEqual({ kind: 'ajuda' });
  });

  it('opção desconhecida — e os QUASE-ERROS: --viaCep e as flags do modo comprador de teste', () => {
    for (const flag of ['--viaCep', '--importar-cliente', '--cpf-teste', '--live', '--json']) {
      expect(() => parseArgsReproduzirPedido(['--detalhe', 'd', flag]), flag).toThrow(
        `Opção desconhecida: ${flag}`,
      );
    }
    expect(() => parseArgsReproduzirPedido(['--detalhe', 'd', '--viacep=1'])).toThrow(
      '--viacep não aceita valor',
    );
  });

  it('um valor solto NUNCA é repetido no erro (um CPF digitado sem flag)', () => {
    const err: unknown = (() => {
      try {
        return parseArgsReproduzirPedido(['--detalhe', 'd', pontuarCpf(CPF_FALSO)]);
      } catch (e) {
        if (e instanceof ArgumentoInvalidoError) return e;
        throw e;
      }
    })();
    expect(err).toBeInstanceOf(ArgumentoInvalidoError);
    expect((err as Error).message).not.toContain('123');
  });

  it('duas vezes a mesma flag, flag sem valor e o separador `--` são recusados', () => {
    expect(() => parseArgsReproduzirPedido(['--detalhe', 'a', '--detalhe', 'b'])).toThrow(
      'informado duas vezes',
    );
    expect(() => parseArgsReproduzirPedido(['--detalhe'])).toThrow('--detalhe exige um valor');
    expect(() => parseArgsReproduzirPedido(['--detalhe', '--viacep'])).toThrow('exige um valor');
    expect(() => parseArgsReproduzirPedido(['--', '--detalhe', 'd'])).toThrow('Separador');
  });
});

/* ========================================================================== */
/*  2 · the checkout guard                                                    */
/* ========================================================================== */

describe('§2 exigirForaDeCheckout', () => {
  const posix = (existentes: string[]) => ({
    existe: (p: string) => existentes.includes(p),
    caminhos: nodePath.posix,
  });
  /** NTFS answers a probe case-INsensitively; the double does the same. */
  const windows = (existentes: string[]) => {
    const conjunto = new Set(existentes.map((p) => p.toLowerCase()));
    return { existe: (p: string) => conjunto.has(p.toLowerCase()), caminhos: nodePath.win32 };
  };

  it('POSIX: dentro de um clone (.git pasta) ou de um workspace (pnpm-workspace.yaml) ⇒ recusa nomeando papel e raiz', () => {
    const fs = posix(['/home/u/next_erp/.git', '/home/u/outro/pnpm-workspace.yaml']);
    expect(() => exigirForaDeCheckout('--detalhe', '/home/u/next_erp/capturas/d.json', fs)).toThrow(
      /--detalhe aponta para dentro de um checkout \(\/home\/u\/next_erp\)/,
    );
    expect(() => exigirForaDeCheckout('--saida', '/home/u/outro/a/b/s.json', fs)).toThrow(
      /--saida .*\(\/home\/u\/outro\)/,
    );
  });

  it('POSIX: o QUASE-ERRO do prefixo — next_erp-capturas não está dentro de next_erp', () => {
    const fs = posix(['/home/u/next_erp/.git']);
    expect(exigirForaDeCheckout('--detalhe', '/home/u/next_erp-capturas/d.json', fs)).toBe(
      '/home/u/next_erp-capturas/d.json',
    );
  });

  it('um worktree tem um ARQUIVO .git — é a mesma entrada, e recusa igual', () => {
    const fs = posix(['/home/u/next_erp/.claude/worktrees/w/.git']);
    expect(() =>
      exigirForaDeCheckout('--escrow', '/home/u/next_erp/.claude/worktrees/w/x/e.json', fs),
    ).toThrow(ArquivoRecusadoError);
  });

  it('o próprio caminho pode ser a raiz (um --saida apontado para a pasta do repo)', () => {
    const fs = posix(['/home/u/next_erp/.git']);
    expect(() => exigirForaDeCheckout('--saida', '/home/u/next_erp', fs)).toThrow(
      ArquivoRecusadoError,
    );
  });

  it('Windows: letra de drive em outra caixa e separador final não escapam', () => {
    const fs = windows(['C:\\Users\\x\\next_erp\\.claude\\worktrees\\w\\.git']);
    expect(() =>
      exigirForaDeCheckout(
        '--detalhe',
        'c:\\users\\X\\next_erp\\.claude\\worktrees\\w\\cap\\d.json',
        fs,
      ),
    ).toThrow(ArquivoRecusadoError);
    const fs2 = windows(['C:\\Users\\x\\next_erp\\pnpm-workspace.yaml']);
    expect(() =>
      exigirForaDeCheckout('--saida', 'C:\\Users\\x\\next_erp\\capturas\\', fs2),
    ).toThrow(ArquivoRecusadoError);
    expect(() =>
      exigirForaDeCheckout('--saida', 'C:/Users/x/next_erp/capturas/s.json', fs2),
    ).toThrow(ArquivoRecusadoError);
  });

  it('Windows: o QUASE-ERRO do prefixo, e uma pasta de capturas fora de tudo', () => {
    const fs = windows(['C:\\x\\next_erp\\.git']);
    expect(exigirForaDeCheckout('--detalhe', 'C:\\x\\next_erp-capturas\\d.json', fs)).toBe(
      'C:\\x\\next_erp-capturas\\d.json',
    );
    expect(exigirForaDeCheckout('--detalhe', 'D:\\capturas\\shopee\\d.json', fs)).toBe(
      'D:\\capturas\\shopee\\d.json',
    );
  });

  it('um caminho RELATIVO é recusado (o pnpm roda o script em apps/shopee), nos dois sistemas', () => {
    for (const relativo of ['capturas/d.json', './d.json', '../../../fora/d.json']) {
      expect(() => exigirForaDeCheckout('--detalhe', relativo, posix([])), relativo).toThrow(
        /--detalhe precisa de um caminho ABSOLUTO/,
      );
    }
    // `C:d.json` is DRIVE-relative on Windows — relative to that drive's cwd.
    for (const relativo of ['capturas\\d.json', '..\\d.json', 'C:d.json']) {
      expect(() => exigirForaDeCheckout('--saida', relativo, windows([])), relativo).toThrow(
        /--saida precisa de um caminho ABSOLUTO/,
      );
    }
  });

  it('um LINK de fora para DENTRO de um checkout é recusado — o caminho real também é varrido', () => {
    const marcado = '/home/u/next_erp/.git';
    // `/fora/link` is a junction to `/home/u/next_erp/apps/shopee`.
    const realpath = (c: string): string =>
      c.startsWith('/fora/link') ? c.replace('/fora/link', '/home/u/next_erp/apps/shopee') : c;
    const fs = {
      existe: (c: string) => [marcado, '/fora', '/fora/link', '/'].includes(c),
      realpath,
      caminhos: nodePath.posix,
    };
    // A --saida file that does not exist yet, under the link: its tail is kept.
    expect(() => exigirForaDeCheckout('--saida', '/fora/link/s.json', fs)).toThrow(
      /--saida aponta para dentro de um checkout \(\/home\/u\/next_erp\), através de um link/,
    );
    // Without the realpath probe the same path passes — which is what it fixes.
    expect(
      exigirForaDeCheckout('--saida', '/fora/link/s.json', { ...fs, realpath: undefined }),
    ).toBe('/fora/link/s.json');
    // A link that resolves OUTSIDE every checkout is fine.
    expect(exigirForaDeCheckout('--saida', '/fora/outra/s.json', fs)).toBe('/fora/outra/s.json');
  });

  it('Windows: uma junção para dentro do worktree (letra em outra caixa) é recusada', () => {
    const fs = {
      ...windows(['C:\\x\\next_erp\\.claude\\worktrees\\w\\.git', 'D:\\', 'D:\\j']),
      realpath: (c: string) =>
        c.toLowerCase() === 'd:\\j' ? 'c:\\X\\next_erp\\.claude\\worktrees\\w\\sub' : c,
    };
    expect(() => exigirForaDeCheckout('--detalhe', 'D:\\j\\d.json', fs)).toThrow(
      ArquivoRecusadoError,
    );
  });

  it('o arquivo que falta e o --saida que já existe — só o PAPEL é nomeado', () => {
    expect(() => exigirArquivoExistente('--detalhe', '/fora/260910X.json', () => false)).toThrow(
      '--detalhe: arquivo não encontrado.',
    );
    expect(() => exigirSaidaNova('/fora/s.json', () => true)).toThrow('nunca sobrescreve');
    expect(() => exigirSaidaNova('/fora/s.json', () => false)).not.toThrow();
  });
});

/* ========================================================================== */
/*  3 · the network guard                                                     */
/* ========================================================================== */

describe('§3 hostPermitidoNaReproducao', () => {
  const VIACEP = 'https://viacep.com.br/ws/01001000/json/';

  it('só o ViaCEP, só com --viacep', () => {
    expect(hostPermitidoNaReproducao(VIACEP, true)).toBe(true);
    expect(hostPermitidoNaReproducao(VIACEP, false)).toBe(false);
  });

  it('QUASE-ERROS: host parecido, http, porta, userinfo nos dois sentidos, URL ilegível', () => {
    for (const url of [
      'https://viacep.com.br.evil.test/ws/01001000/json/',
      'https://evilviacep.com.br/ws/',
      'http://viacep.com.br/ws/01001000/json/',
      'https://viacep.com.br:8443/ws/',
      'https://viacep.com.br@evil.test/ws/',
      'https://evil.test@viacep.com.br/ws/',
      'https://u:p@viacep.com.br/ws/',
      'https://openplatform.shopee.com.br/api/v2/order/get_order_detail',
      'https://firestore.googleapis.com/v1/projects',
      'não é url',
    ]) {
      expect(hostPermitidoNaReproducao(url, true), url).toBe(false);
    }
  });

  it('o relatório de uma chamada bloqueada leva o HOST, nunca a URL (que pode carregar um token)', () => {
    expect(hostParaRelatorio('https://exemplo.test/p?access_token=abc')).toBe('exemplo.test');
    expect(hostParaRelatorio('lixo')).toBe('(url ilegível)');
    expect(urlDaRequisicao(new URL(VIACEP))).toBe(VIACEP);
    expect(urlDaRequisicao(new Request(VIACEP))).toBe(VIACEP);
  });
});

/* ========================================================================== */
/*  4 · the residue scan                                                      */
/* ========================================================================== */

describe('§4 a varredura de resíduo', () => {
  const s = (campo: string, valor: string): ValorSensivel => ({ campo, valor });

  it('coleta os valores do comprador por CAMPO — e pula os curtos e as máscaras puras', () => {
    const sensiveis = valoresSensiveisDaCaptura(
      linhaBR({
        invoice_data: {
          number: '000123',
          access_key: '3'.repeat(44),
          total_value: 1500,
          status: 'valid',
        },
        payment_info: [
          { payment_processor_register: gerarCnpj('112223330001'), transaction_id: 'AUT98765' },
        ],
      }),
      { buyer_user_name: APELIDO, order_income: { tax_registration_code: '' } },
    );
    const campos = sensiveis.map((v) => v.campo);
    expect(campos).toEqual(
      expect.arrayContaining([
        'recipient_address.name',
        'recipient_address.phone',
        'recipient_address.zipcode',
        'recipient_address.full_address',
        'recipient_address.district',
        'recipient_address.city',
        'invoice_data.number',
        'invoice_data.access_key',
        'buyer_cpf_id',
        'buyer_username',
        'buyer_user_id',
        'message_to_seller',
        'payment_info.0.payment_processor_register',
        'payment_info.0.transaction_id',
        'escrow.buyer_user_name',
      ]),
    );
    // Short ('SP', 'BR', ''), money and the status token are not collected.
    expect(campos).not.toContain('recipient_address.state');
    expect(campos).not.toContain('recipient_address.region');
    expect(campos).not.toContain('invoice_data.total_value');
    expect(campos).not.toContain('invoice_data.status');
    expect(campos).not.toContain('escrow.order_income.tax_registration_code');

    const mascarado = valoresSensiveisDaCaptura(
      linhaBR({ buyer_cpf_id: '***********', buyer_user_id: 0 }),
      null,
    );
    expect(mascarado.map((v) => v.campo)).not.toContain('buyer_cpf_id');
    expect(mascarado.map((v) => v.campo)).not.toContain('buyer_user_id');
  });

  it('acha cada classe: CPF formatado, telefone com separadores, CEP com hífen, nome sem acento', () => {
    const sensiveis = [
      s('buyer_cpf_id', CPF_FALSO),
      s('recipient_address.phone', TELEFONE),
      s('recipient_address.zipcode', CEP),
      s('recipient_address.name', 'José Ávila Conceição'),
    ];
    expect(encontrarResiduos(`doc: ${pontuarCpf(CPF_FALSO)} (11 dígitos)`, sensiveis)).toEqual([
      'buyer_cpf_id',
    ]);
    expect(encontrarResiduos('tel (11) 98888-7777.', sensiveis)).toEqual([
      'recipient_address.phone',
    ]);
    expect(encontrarResiduos('cep=01001-000', sensiveis)).toEqual(['recipient_address.zipcode']);
    expect(encontrarResiduos('Nome: JOSE AVILA  CONCEICAO', sensiveis)).toEqual([
      'recipient_address.name',
    ]);
    // Glued to a word is still the value.
    expect(encontrarResiduos(`cpf${CPF_FALSO}x`, sensiveis)).toEqual(['buyer_cpf_id']);
  });

  it('um valor CAPTURADO já formatado é achado pelos dígitos, em qualquer pontuação — e o quase-erro não', () => {
    const telefone = s('recipient_address.phone', '(11) 98888-7777');
    const doc = s('buyer_cpf_id', pontuarCpf(CPF_FALSO));
    expect(encontrarResiduos(`tel ${TELEFONE}`, [telefone])).toEqual(['recipient_address.phone']);
    expect(encontrarResiduos('tel 11 98888 7777', [telefone])).toEqual(['recipient_address.phone']);
    expect(encontrarResiduos(`doc ${CPF_FALSO}`, [doc])).toEqual(['buyer_cpf_id']);
    // Near-misses: one digit off, and the same digits as part of a longer number.
    expect(encontrarResiduos('tel (11) 98888-7778', [telefone])).toEqual([]);
    expect(encontrarResiduos(`n ${TELEFONE}5`, [telefone])).toEqual([]);
  });

  it('a chave de acesso na forma `NFe<44 dígitos>` (o Id do XML) é achada — o branqueamento de hex não a come', () => {
    const chave = `35${'2'.repeat(42)}`;
    const sensivel = [s('invoice_data.access_key', chave)];
    expect(encontrarResiduos(`chave NFe${chave}`, sensivel)).toEqual(['invoice_data.access_key']);
    expect(encontrarResiduos(`chave ${chave}`, sensivel)).toEqual(['invoice_data.access_key']);
    // …while a WHOLE hex id still blanks the short value inside it.
    const id = s('buyer_user_id', '12345');
    expect(encontrarResiduos(`pedidos/ab12345cd${'e0'.repeat(28)}`, [id])).toEqual([]);
  });

  it('QUASE-ERRO: um valor curto dentro de um carimbo µs ou de um id sha256 NÃO é resíduo', () => {
    const id = s('buyer_user_id', '12345');
    const hex = `ab12345cd${'e0'.repeat(28)}`;
    expect(hex.length).toBeGreaterThanOrEqual(32);
    expect(
      encontrarResiduos('statusEm ... 1789000123450000 (2026-09-10T00:00:00.000Z)', [id]),
    ).toEqual([]);
    expect(encontrarResiduos(`pedidoId ................ ${hex}`, [id])).toEqual([]);
    // …and the same digits standing alone ARE.
    expect(encontrarResiduos('usuario 12345 ', [id])).toEqual(['buyer_user_id']);
  });

  it('QUASE-ERRO: um bairro dentro de outra palavra não é resíduo; como palavra, é', () => {
    const bairro = s('recipient_address.district', 'Centro');
    expect(encontrarResiduos('a falha concentrou-se ali', [bairro])).toEqual([]);
    expect(encontrarResiduos('bairro: Centro.', [bairro])).toEqual(['recipient_address.district']);
  });
});

/* ========================================================================== */
/*  5 · THE PROPERTY                                                          */
/* ========================================================================== */

/** Every leaf key path of the summary this module owns — the allow-list, spelled out. */
const CHAVES_DO_RESUMO = [
  'captura.regiao',
  'captura.orderStatus',
  'captura.moeda',
  'captura.orderSnPrefixo',
  'captura.orderSnComprimento',
  'captura.linhasDeItem',
  'captura.escrow',
  'captura.camposOpcionaisAusentes',
  'captura.chavesDoEdt',
  'captura.capturaIncompleta',
  'chamadas.detalheServidas',
  'chamadas.escrowServidas',
  'chamadas.escrowRecusadas',
  'chamadas.inesperadas',
  'conferenciaNfe.totalDaNota',
  'conferenciaNfe.somaPagamentos',
  'conferenciaNfe.confere',
  'primeira.acao',
  'primeira.detail',
  'primeira.orderStatus',
  'primeira.acaoPagamentos',
  'primeira.pagamentosGravados',
  'primeira.acaoFrete',
  'primeira.itensSemProduto',
  'comprador.captura.estado',
  'comprador.captura.camposRecusados',
  'comprador.captura.camposRecusadosDeEndereco',
  'comprador.documento.situacao',
  'comprador.documento.comprimento',
  'comprador.documento.digitosVerificadoresValidos',
  'comprador.documento.tipo',
  'comprador.nome',
  'cliente.vinculado',
  'cliente.id',
  'cliente.criado',
  'cliente.camposPreenchidos',
  'endereco.construtor',
  'endereco.portoesRecusados',
  'endereco.digitosDoCep',
  'endereco.vinculado',
  'endereco.uf',
  'endereco.pais',
  'endereco.codigoMunicipioPreenchido',
  'endereco.camposPreenchidos',
  'endereco.fallbacks',
  'incidentes',
  'viaCep.modo',
  'viaCep.consultas',
  'segunda.acao',
  'segunda.detail',
  'segunda.orderStatus',
  'segunda.acaoPagamentos',
  'segunda.pagamentosGravados',
  'segunda.acaoFrete',
  'segunda.itensSemProduto',
  'segunda.documentosAlterados',
  'segunda.clientesAntes',
  'segunda.clientesDepois',
  'logsGravados',
];

describe('§5 a propriedade: nada impresso carrega um valor do comprador', () => {
  /** Every buyer value of the vector, in every spelling a renderer could produce. */
  const VALORES_CRUS = [
    CPF_FALSO,
    pontuarCpf(CPF_FALSO),
    NOME,
    NOME.toUpperCase(),
    TELEFONE,
    CEP,
    '01001-000',
    LOGRADOURO,
    APELIDO,
    String(ID_COMPRADOR),
    RECADO,
  ];
  /**
   * The vector's WORDS, one by one — the whole-value scan cannot see a partial
   * leak (a first name alone), so the property checks the pieces too.
   */
  const PALAVRAS_DO_COMPRADOR = [
    'Fulana',
    'Silva',
    'Exemplo',
    'Acacias',
    'Jardim',
    'Beltrano',
    'porteiro',
    'compradora',
  ];

  it('o relatório inteiro, o resumo em JSON e as linhas de log impressas: nenhum resíduo', async () => {
    const r = await reproduzir();
    const saida = montarSaidaDaReproducao(r, { viaCepLigado: false, hostsBloqueados: [] });
    const resumo = JSON.stringify(resumoDaReproducao(r, { viaCepLigado: false }));
    const sensiveis = valoresSensiveisDaCaptura(r.linhaBruta, r.escrowBruto);

    // ÂNCORAS: the report really rendered, really about a captured buyer.
    expect(saida.recusado).toBe(false);
    expect(saida.stdout.join('\n')).toContain('capturaComprador ........ capturado');
    expect(saida.stdout.join('\n')).toContain('## Endereço');
    expect(saida.stdout.join('\n')).toMatch(/## Endereço[\s\S]*vinculado \.+ sim/);
    expect(sensiveis.length).toBeGreaterThanOrEqual(8);

    for (const texto of [saida.stdout.join('\n'), saida.stderr.join('\n'), resumo]) {
      expect(encontrarResiduos(texto, sensiveis)).toEqual([]);
      for (const valor of VALORES_CRUS) expect(texto).not.toContain(valor);
      for (const palavra of PALAVRAS_DO_COMPRADOR) {
        expect(texto.toLowerCase(), palavra).not.toContain(palavra.toLowerCase());
      }
    }
  });

  it('o id do endereço (sha1 do endereço do comprador) NUNCA sai — nem no relatório, nem no stderr', async () => {
    const r = await reproduzir();
    const id = r.leitura.endereco!.id;
    // ÂNCORA: the id IS the legacy hash of the stored address — one guess confirms it.
    expect(id).toMatch(/^[0-9a-f]{40}$/);
    expect(makeEnderecoId(r.leitura.endereco!.dados as unknown as EnderecoImportFields)).toBe(id);

    // A log line naming it (a path, a bare id) is redacted too.
    const comLog: ResultadoReproducao = {
      ...r,
      logs: [...r.logs, `[info] endereço ${id} em clientes/auto-1/enderecos/${id}`],
    };
    const saida = montarSaidaDaReproducao(comLog, { viaCepLigado: false, hostsBloqueados: [] });
    const tudo = [...saida.stdout, ...saida.stderr].join('\n');
    expect(saida.recusado).toBe(false);
    expect(tudo).not.toContain(id);
    expect(tudo).not.toContain(id.slice(0, 12));
    // ÂNCORA: the refs ARE printed — set, with the id replaced.
    expect(tudo).toContain(
      `enderecoFiscalOuterRef .. documents/clientes/auto-1/enderecos/${ENDERECO_ID_REDIGIDO}`,
    );
    expect(tudo).toContain(
      `[info] endereço ${ENDERECO_ID_REDIGIDO} em clientes/auto-1/enderecos/${ENDERECO_ID_REDIGIDO}`,
    );
    expect(resumoDaReproducao(r, { viaCepLigado: false }).endereco).not.toHaveProperty('id');
  });

  it('o resumo do endereço e do cliente: os VEREDITOS do construtor, contados por nome', async () => {
    const r = await reproduzir();
    const resumo = resumoDaReproducao(r, { viaCepLigado: false });
    expect(resumo.endereco).toEqual({
      construtor: 'ok',
      portoesRecusados: [],
      digitosDoCep: 8,
      vinculado: true,
      uf: 'SP',
      pais: null,
      codigoMunicipioPreenchido: false,
      camposPreenchidos: expect.arrayContaining([
        'bairro',
        'cep',
        'cidade',
        'estado',
        'logradouro',
      ]) as unknown,
      fallbacks: ['numero=S/N'],
    });
    expect(resumo.cliente).toMatchObject({ vinculado: true, criado: true });
    expect(resumo.cliente.camposPreenchidos).toEqual(expect.arrayContaining(['cpf_cnpj', 'nome']));
    expect(resumo.comprador.captura).toEqual({
      estado: 'capturado',
      camposRecusados: [],
      camposRecusadosDeEndereco: [],
    });
    expect(resumo.viaCep).toEqual({ modo: 'stub', consultas: 0 });
  });

  it('UF que não mapeia + o STUB: uf-desconhecida, AC, UMA consulta — e o relatório diz que é o stub', async () => {
    const r = await reproduzir(linhaBRUfDesconhecida());
    const resumo = resumoDaReproducao(r, { viaCepLigado: false });
    expect(resumo.endereco).toMatchObject({
      construtor: 'uf-desconhecida',
      uf: 'AC',
      vinculado: true,
    });
    expect(resumo.viaCep).toEqual({ modo: 'stub', consultas: 1 });
    // Derived from the stored diary — the mapper's own extra list is never stored.
    expect(resumo.comprador.captura.camposRecusadosDeEndereco).toEqual([
      'endereco:uf-desconhecida',
    ]);
    const texto = renderReproducao(resumo).join('\n');
    expect(texto).toContain('dos quais de endereço . endereco:uf-desconhecida');
    expect(texto).toContain('O STUB respondeu "não sei"');
    expect(texto).toContain('Rode de novo com --viacep');
    expect(texto).toMatch(/UF gravada \.+ AC {3}⚠️ fallback do construtor/);

    // The same capture with the REAL ViaCEP mode, and a run that never asked: no caveat.
    expect(
      renderReproducao(resumoDaReproducao(r, { viaCepLigado: true })).join('\n'),
    ).not.toContain('O STUB respondeu');
    expect(
      renderReproducao(resumoDaReproducao(await reproduzir(), { viaCepLigado: false })).join('\n'),
    ).not.toContain('O STUB respondeu');
  });

  it('um CEP inutilizável: construtor sem-cep, nenhum endereço vinculado', async () => {
    const base = linhaBR();
    const r = await reproduzir(
      linhaBR({
        recipient_address: {
          ...(base.recipient_address as Record<string, unknown>),
          zipcode: '0100',
        },
      }),
    );
    const resumo = resumoDaReproducao(r, { viaCepLigado: false });
    expect(resumo.endereco).toMatchObject({
      construtor: 'sem-cep',
      digitosDoCep: 4,
      vinculado: false,
      uf: null,
    });
    expect(resumo.comprador.captura.camposRecusadosDeEndereco).toEqual(['endereco:sem-cep']);
  });

  it('uma captura de várias orders: a varredura usa a linha ESCOLHIDA — o vazamento do seu comprador é suprimido', async () => {
    const OUTRA_SN = '991231AAAAAAAA';
    const cnpj = gerarCnpj('112223330001');
    const r = await reproduzir(linhaBR({ order_sn: OUTRA_SN, buyer_cpf_id: cnpj }), {
      outras: [linhaBR()],
      orderSn: OUTRA_SN,
    });
    expect(r.linhaBruta.order_sn).toBe(OUTRA_SN);
    const vazando: ResultadoReproducao = { ...r, logs: [...r.logs, `[warn] doc ${cnpj}`] };
    const saida = montarSaidaDaReproducao(vazando, { viaCepLigado: false, hostsBloqueados: [] });
    expect(saida.recusado).toBe(false);
    expect(saida.stderr.join('\n')).not.toContain(cnpj);
    expect(saida.stderr.at(-1)).toContain('1 linha(s) de log suprimida(s)');
    expect(saida.stdout.join('\n')).toContain('14 dígitos, DV válidos, PJ (CNPJ)');
  });

  it('as CHAVES do resumo são uma lista fechada — um campo novo não entra sem passar por aqui', async () => {
    const r = await reproduzir();
    const resumo = resumoDaReproducao(r, { viaCepLigado: false });
    // `pedido` / `pagamentos` are `importar:pedido`'s allow-lists, pinned there.
    const { pedido: _p, pagamentos: _g, ...nosso } = resumo;
    const chaves = (v: unknown, prefixo: string): string[] => {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return [prefixo];
      return Object.entries(v).flatMap(([k, x]) =>
        chaves(x, prefixo === '' ? k : `${prefixo}.${k}`),
      );
    };
    expect(chaves(nosso, '').sort()).toEqual([...CHAVES_DO_RESUMO].sort());
  });

  it('o order_sn sai redigido em toda linha — só o prefixo e o comprimento ficam', async () => {
    const r = await reproduzir();
    const saida = montarSaidaDaReproducao(r, { viaCepLigado: false, hostsBloqueados: [] });
    const tudo = [...saida.stdout, ...saida.stderr].join('\n');
    expect(tudo).not.toContain(ORDER_SN);
    expect(tudo).toContain(`${ORDER_SN.slice(0, 6)}… (${String(ORDER_SN.length)} caracteres)`);
    // ÂNCORA: the pedido summary's `numero` WOULD have carried it.
    expect(tudo).toContain(`numero (order_sn) ....... ${ORDER_SN_REDIGIDO}`);
  });

  it('uma linha de log que vaza é SUPRIMIDA e contada pelo nome do campo', async () => {
    const r = await reproduzir();
    const vazando: ResultadoReproducao = {
      ...r,
      logs: [...r.logs, `[warn] algo { doc: '${pontuarCpf(CPF_FALSO)}' }`],
    };
    const saida = montarSaidaDaReproducao(vazando, { viaCepLigado: false, hostsBloqueados: [] });
    expect(saida.recusado).toBe(false);
    expect(saida.stderr.join('\n')).not.toContain(pontuarCpf(CPF_FALSO));
    expect(saida.stderr.at(-1)).toContain('1 linha(s) de log suprimida(s)');
    expect(saida.stderr.at(-1)).toContain('buyer_cpf_id');
  });

  it('um relatório que vazaria é RETIDO inteiro — stdout vazio, recusa nomeando o campo', async () => {
    const r = await reproduzir();
    // The cliente id is printed verbatim; make it the buyer's document.
    const vazando: ResultadoReproducao = {
      ...r,
      leitura: { ...r.leitura, cliente: { ...r.leitura.cliente!, id: CPF_FALSO } },
    };
    const saida = montarSaidaDaReproducao(vazando, { viaCepLigado: false, hostsBloqueados: [] });
    expect(saida.recusado).toBe(true);
    expect(saida.stdout).toEqual([]);
    expect(saida.stderr.join('\n')).toContain('Relatório RETIDO');
    expect(saida.stderr.join('\n')).toContain('buyer_cpf_id');
    expect(saida.stderr.join('\n')).not.toContain(CPF_FALSO);
  });

  it('a UF só sai quando é do conjunto fechado; o resto vira «(inválida)»', async () => {
    const r = await reproduzir();
    const comUf = (estado: unknown): string | null =>
      resumoDaReproducao(
        {
          ...r,
          leitura: {
            ...r.leitura,
            endereco: { ...r.leitura.endereco!, dados: { ...r.leitura.endereco!.dados, estado } },
          },
        },
        { viaCepLigado: false },
      ).endereco.uf;
    expect(comUf('SP')).toBe('SP');
    expect(comUf('São Paulo')).toBe('(inválida)');
    expect(comUf('sp')).toBe('(inválida)');
    expect(comUf(null)).toBeNull();
  });

  it('o --saida é o ÚNICO lugar com valores: os documentos relidos, inteiros', async () => {
    const r = await reproduzir();
    const json = documentosParaSaida(r);
    expect(json).toContain(CPF_FALSO);
    expect(json).toContain(NOME);
    expect(json).toContain('CONTÉM DADOS REAIS DO COMPRADOR');
  });

  it('o resumo do documento: classes e comprimento, nunca os dígitos', () => {
    expect(resumoDoDocumento(CPF_FALSO)).toEqual({
      situacao: 'utilizavel',
      comprimento: 11,
      digitosVerificadoresValidos: true,
      tipo: 'PF',
    });
    expect(resumoDoDocumento('12345678900')).toMatchObject({
      situacao: 'invalido',
      comprimento: 11,
      digitosVerificadoresValidos: false,
    });
    expect(resumoDoDocumento('***********')).toMatchObject({ situacao: 'mascarado' });
    expect(resumoDoDocumento(null)).toMatchObject({ situacao: 'ausente', comprimento: null });
    expect(resumoDoDocumento('1234567')).toMatchObject({ comprimento: 'outro' });
  });

  it('a captura feita SEM os campos opcionais do importador grita', async () => {
    const linha = linhaBR();
    expect(camposOpcionaisAusentes(linha)).toEqual([]);
    const { recipient_address: _r, buyer_cpf_id: _c, edt_from: _f, edt_to: _t, ...pobre } = linha;
    expect(camposOpcionaisAusentes(pobre)).toEqual(['recipient_address', 'buyer_cpf_id', 'edt']);
    // `edt` is answered by ANY of its three candidate keys — `edt` itself included.
    expect(camposOpcionaisAusentes({ ...pobre, edt_to: 0 })).not.toContain('edt');
    expect(camposOpcionaisAusentes({ ...pobre, edt: { de: 1 } })).not.toContain('edt');

    const r = await reproduzir();
    const completa = renderReproducao(resumoDaReproducao(r, { viaCepLigado: false }));
    expect(completa.join('\n')).not.toContain('A CAPTURA FOI FEITA SEM');
    const incompleta = renderReproducao(
      resumoDaReproducao({ ...r, linhaBruta: pobre }, { viaCepLigado: false }),
    );
    expect(incompleta.join('\n')).toContain('A CAPTURA FOI FEITA SEM O response_optional_fields');
  });

  it.each(['recipient_address', 'buyer_cpf_id', 'item_list'])(
    'cada campo essencial SOZINHO ausente já grita: %s',
    async (campo) => {
      const r = await reproduzir();
      const { [campo]: _fora, ...sem } = r.linhaBruta;
      expect(camposOpcionaisAusentes(sem)).toEqual([campo]);
      const texto = renderReproducao(
        resumoDaReproducao({ ...r, linhaBruta: sem }, { viaCepLigado: false }),
      ).join('\n');
      expect(texto).toContain('A CAPTURA FOI FEITA SEM O response_optional_fields');
    },
  );

  it('quais chaves do edt vieram — só os NOMES, para assentar o registro', async () => {
    const r = await reproduzir();
    expect(chavesDoEdt(r.linhaBruta)).toEqual(['edt_from', 'edt_to']);
    expect(chavesDoEdt({ edt: 7 })).toEqual(['edt']);
    expect(chavesDoEdt({})).toEqual([]);
    const texto = renderReproducao(resumoDaReproducao(r, { viaCepLigado: false })).join('\n');
    expect(texto).toContain('edt — chaves que vieram . edt_from, edt_to');
  });

  it('a 2ª passada é rotulada pelo relógio em que roda', async () => {
    const r = await reproduzir();
    const texto = renderReproducao(resumoDaReproducao(r, { viaCepLigado: false })).join('\n');
    expect(ATRASO_DA_SEGUNDA_PASSADA_MS).toBe(5 * 60_000);
    expect(texto).toContain('## 2ª passada — a mesma captura de novo, 5 min depois');
  });
});

/* ========================================================================== */
/*  6 · the error describer                                                   */
/* ========================================================================== */

describe('§6 descreverErroReproducao', () => {
  it('ShopeeSchemaError: só os CAMINHOS dos campos, nunca a mensagem', () => {
    const err = new ShopeeSchemaError(`valor ${CPF_FALSO} inválido`, {
      campos: ['response.order_list.0.item_list'],
      httpStatus: 200,
      path: '/api/v2/order/get_order_detail',
    });
    const texto = descreverErroReproducao(err).join('\n');
    expect(texto).toContain('response.order_list.0.item_list');
    expect(texto).not.toContain(CPF_FALSO);
  });

  it('ZodError: caminhos e códigos, nunca a mensagem (que pode citar o valor)', () => {
    const resultado = z.object({ cpf: z.literal('x') }).safeParse({ cpf: CPF_FALSO });
    expect(resultado.success).toBe(false);
    const texto = descreverErroReproducao(resultado.error!).join('\n');
    expect(resultado.error).toBeInstanceOf(ZodError);
    expect(texto).toContain('cpf (');
    expect(texto).not.toContain(CPF_FALSO);
  });

  it('ShopeeApiError: code e path, sem a prosa da Shopee', () => {
    const err = new ShopeeApiError(`order ${CPF_FALSO}`, {
      code: 'error_auth',
      kind: SHOPEE_ERROR_KIND.other,
      httpStatus: 403,
      path: '/api/v2/payment/get_escrow_detail',
    });
    const texto = descreverErroReproducao(err).join('\n');
    expect(texto).toContain('code=error_auth');
    expect(texto).not.toContain(CPF_FALSO);
  });

  it('as nossas classes pela mensagem; a falha de rede de um caminho não capturado diz qual', () => {
    expect(descreverErroReproducao(new CapturaInvalidaError('xyz'))).toEqual(['❌ xyz']);
    expect(descreverErroReproducao(new ArgumentoInvalidoError('abc'))[0]).toBe('❌ abc');
    const rede = new ShopeeNetworkError(
      'Falha de rede ao contatar a Shopee em /api/v2/x.',
      new ChamadaNaoCapturadaError('/api/v2/x'),
    );
    expect(descreverErroReproducao(rede).join('\n')).toContain('o importador pediu /api/v2/x');
  });

  it('qualquer outra coisa: só o NOME da classe', () => {
    expect(descreverErroReproducao(new RangeError(`r ${CPF_FALSO}`))).toEqual([
      '❌ erro inesperado: RangeError',
    ]);
    expect(descreverErroReproducao(CPF_FALSO)).toEqual(['❌ erro inesperado: string']);
  });
});

/* ========================================================================== */
/*  7 · the source pins                                                       */
/* ========================================================================== */

/** `apps/shopee/`. */
const RAIZ_DO_APP = new URL('../../../', import.meta.url);

const MOTOR = 'lib/shopee/pedidos/reproduzirPedido.ts';
const CLI = 'lib/shopee/pedidos/reproduzirPedidoCli.ts';
const SCRIPT = 'scripts/reproduzir-pedido.ts';

function fonte(arquivo: string): string {
  return readFileSync(new URL(arquivo, RAIZ_DO_APP), 'utf8');
}

/** Every non-test `.ts`/`.tsx` under the app's code roots, keyed by app-relative path. */
function fontesDoApp(): Map<string, string> {
  const fontes = new Map<string, string>();
  const ler = (dir: URL, prefixo: string): void => {
    for (const nome of readdirSync(dir)) {
      const url = new URL(nome, dir);
      if (statSync(url).isDirectory()) {
        if (nome !== 'node_modules') ler(new URL(`${nome}/`, dir), `${prefixo}${nome}/`);
        continue;
      }
      if (!/\.tsx?$/.test(nome) || nome.endsWith('.test.ts')) continue;
      fontes.set(`${prefixo}${nome}`, readFileSync(url, 'utf8'));
    }
  };
  for (const raiz of ['lib/', 'app/', 'functions/src/', 'scripts/']) {
    ler(new URL(raiz, RAIZ_DO_APP), raiz);
  }
  return fontes;
}

/**
 * The two identifiers no new file may spell — assembled from pieces, so THIS
 * file never spells them either (the transaction inventory and the simulation
 * guard both grep raw text).
 */
const OPCAO_DE_SIMULACAO = new RegExp(`\\b${['simulacao', 'Comprador'].join('')}\\b`);
const API_DE_TRANSACAO = new RegExp(`\\b${['run', 'Transaction'].join('')}\\b`);

describe('§7 as fontes', () => {
  it('os cinco arquivos novos: sem a opção de simulação, sem o admin, sem o nome da API de transação', () => {
    const TESTES = [
      'lib/shopee/pedidos/reproduzirPedido.test.ts',
      'lib/shopee/pedidos/reproduzirPedidoCli.test.ts',
    ];
    for (const arquivo of [MOTOR, CLI, SCRIPT, ...TESTES]) {
      const texto = fonte(arquivo);
      expect(texto.length, arquivo).toBeGreaterThan(1000);
      expect(texto, arquivo).not.toMatch(OPCAO_DE_SIMULACAO);
      expect(texto, arquivo).not.toMatch(API_DE_TRANSACAO);
    }
    for (const arquivo of [MOTOR, CLI, SCRIPT]) {
      const texto = fonte(arquivo);
      expect(texto, arquivo).not.toContain('lib/firebase/admin');
      expect(texto, arquivo).not.toContain('getAdminFirestore');
      expect(texto, arquivo).not.toContain(CPF_FALSO);
    }
    // ÂNCORA: the assembled patterns DO match the identifiers they stand for.
    expect(`x.${['run', 'Transaction'].join('')}(`).toMatch(API_DE_TRANSACAO);
    expect(`{ ${['simulacao', 'Comprador'].join('')}: 1 }`).toMatch(OPCAO_DE_SIMULACAO);
  });

  it('as duas metades em lib/ não leem o ambiente nem um relógio', () => {
    for (const arquivo of [MOTOR, CLI]) {
      expect(fonte(arquivo), arquivo).not.toContain('process.env');
      expect(fonte(arquivo), arquivo).not.toContain('Date.now(');
    }
  });

  it('o script é o ÚNICO importador não-teste de testing/fakeDb', () => {
    const importa = /(?:from\s+|import\()\s*['"][^'"]*testing\/fakeDb['"]/;
    const importadores = [...fontesDoApp()]
      .filter(([, texto]) => importa.test(texto))
      .map(([arquivo]) => arquivo);
    expect(importadores).toEqual([SCRIPT]);
  });

  it('o package.json roda o script SEM dotenv — ele não precisa de ambiente nenhum', () => {
    const pacote = JSON.parse(fonte('package.json')) as { scripts: Record<string, string> };
    expect(pacote.scripts['reproduzir:pedido']).toBe('tsx scripts/reproduzir-pedido.ts');
  });

  it('o script: guarda de rede ANTES de carregar o motor e o banco; --saida com `wx`; argv lido uma vez', () => {
    const texto = fonte(SCRIPT);
    const guarda = texto.indexOf('globalThis.fetch = ');
    expect(guarda).toBeGreaterThan(-1);
    expect(texto.indexOf("await import('../lib/shopee/testing/fakeDb')")).toBeGreaterThan(guarda);
    expect(texto.indexOf("await import('../lib/shopee/pedidos/reproduzirPedido')")).toBeGreaterThan(
      guarda,
    );
    expect(texto).toContain("flag: 'wx'");
    // The checkout probe: `existsSync` answers for a worktree's `.git` FILE and a
    // clone's folder alike (the lib's double cannot tell them apart, so the
    // script's probe is pinned here), and the real location is walked too.
    expect(texto).toContain(
      'const fs = { existe: existsSync, realpath: (c: string) => realpathSync.native(c) };',
    );
    expect(
      texto.match(/exigirForaDeCheckout\('--(?:detalhe|escrow|saida)', args\.\w+, fs\)/g),
    ).toHaveLength(3);
    expect(texto.match(/\bprocess\.argv\b/g)).toHaveLength(1);
    // The report reaches stdout only through the scanned output: `log` is
    // declared once and called twice — the usage, and the scanned report.
    expect(texto).toMatch(/for \(const linha of relatorio\.stdout\) log\(linha\);/);
    expect(texto).toContain('log(USO_REPRODUZIR_PEDIDO);');
    expect(texto.match(/(?<![.\w])log\(/g)).toHaveLength(3);
  });

  it('o README traz a lista de response_optional_fields LITERAL, igual à constante', () => {
    expect(fonte('scripts/README.md')).toContain(SHOPEE_ORDER_DETAIL_OPTIONAL_FIELDS);
  });
});

/* -------------------------------------------------------------------------- */
/*                 the NF-e check — Σ vPag = vNF, amounts only                 */
/* -------------------------------------------------------------------------- */

describe('a conferência da NF-e no relatório — Σ pagamentos contra o vNF dos documentos GRAVADOS', () => {
  it('a reprodução de um pedido pago: a linha sai, com os dois valores e o veredito', async () => {
    const r = await reproduzir();
    const resumo = resumoDaReproducao(r, { viaCepLigado: false });
    // ÂNCORA: a pagamento really was stored, so the check is not vacuous.
    expect(r.leitura.pagamentos.length).toBeGreaterThan(0);
    expect(resumo.conferenciaNfe.confere).toBe(true);
    expect(resumo.conferenciaNfe.totalDaNota).toBe(resumo.conferenciaNfe.somaPagamentos);
    const texto = renderReproducao(resumo).join('\n');
    expect(texto).toContain(linhaConferenciaNfe(resumo.conferenciaNfe));
    expect(texto).toMatch(
      /NF-e .+ vNF \(Σ itens − desconto \+ frete se CIF\) .+ · Σ pagamentos .+ · confere/,
    );
  });

  const linha = { precoDeVenda: 53.87, descontoUnitario: 2.64, quantidade: 1 };
  const pedidoFob = {
    itens: { NONE: [linha] },
    descontoTotal: 0,
    freteInicial: { modalidade: '1', valorCobrado: 4 },
  };

  it('DIVERGE quando Σ pagante não é o vNF — e o frete FOB fica FORA do vNF', () => {
    const c = conferenciaNfeDosDocumentos(pedidoFob, [
      { dados: { valor: 55.23, status_pagamento: 4 } },
    ]);
    expect(c).toEqual({ totalDaNota: 51.23, somaPagamentos: 55.23, confere: false });
    expect(linhaConferenciaNfe(c)).toContain('DIVERGE');
    const ok = conferenciaNfeDosDocumentos(pedidoFob, [
      { dados: { valor: 51.23, status_pagamento: 4 } },
    ]);
    expect(ok.confere).toBe(true);
  });

  it('⚠️ NEAR-MISS: um pagamento estornado não entra na soma (a regra de isPagamentoPagante)', () => {
    const c = conferenciaNfeDosDocumentos(pedidoFob, [
      { dados: { valor: 51.23, status_pagamento: 4 } },
      { dados: { valor: 51.23, status_pagamento: 8 } },
    ]);
    expect(c.somaPagamentos).toBe(51.23);
    expect(c.confere).toBe(true);
  });

  it('sem pedido, ou com uma linha gravada ilegível, o veredito é — (nunca uma soma parcial)', () => {
    expect(conferenciaNfeDosDocumentos(null, []).confere).toBeNull();
    const ilegivel = conferenciaNfeDosDocumentos({ itens: { NONE: [{ precoDeVenda: 'x' }] } }, []);
    expect(ilegivel.totalDaNota).toBeNull();
    expect(linhaConferenciaNfe(ilegivel)).toContain('linha gravada ilegível');
  });
});
