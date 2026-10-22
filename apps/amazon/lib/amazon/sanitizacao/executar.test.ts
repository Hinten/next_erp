import { describe, expect, it } from 'vitest';

import { gerarCpf, pontuarCpf } from '../testing/documentos';
import { getOrderBr } from '../testing/sandboxBr';
import {
  ErroDeUsoSanitizacao,
  type SistemaDeArquivosDaSanitizacao,
  executarSanitizacao,
  lerArgumentos,
} from './executar';
import { TAMANHO_DO_SAL } from './falsificacao';
import { ARQUIVO_SAL } from './lote';

/*
 * An in-memory file system: synthetic captures only. Nothing here touches a disk,
 * let alone a real capture folder.
 */
const PASTA = '/home/fulano/amazon-capturas';
const CPF = gerarCpf('529982247');
const NOMES = 'Termo Ficticio Zeta\n';
const MTIME = Date.UTC(2026, 9, 19);
const SAL = new Uint8Array(TAMANHO_DO_SAL).fill(4);
const b = (t: string) => new TextEncoder().encode(t);
const GET_ORDER = '/orders/2026-01-01/orders/123-4567890-1234567';

interface Disco {
  readonly arquivos?: Readonly<Record<string, string | Uint8Array>>;
  /** Entries that are not regular files (a link, a folder): listed, never readable. */
  readonly naoArquivos?: readonly string[];
  readonly git?: readonly string[];
  readonly fixtures?: Readonly<Record<string, string>>;
  readonly outros?: Readonly<Record<string, string | Uint8Array>>;
  readonly semSal?: boolean;
}

type Falso = SistemaDeArquivosDaSanitizacao & {
  readonly lidos: string[];
  readonly inicios: string[];
  readonly criados: Map<string, Uint8Array>;
};

function disco(d: Disco = {}): Falso {
  const arquivos: Record<string, string | Uint8Array> = {
    'nomes-proibidos.txt': NOMES,
    ...(d.semSal === true ? {} : { [ARQUIVO_SAL]: SAL }),
    ...d.arquivos,
  };
  const lidos: string[] = [];
  const inicios: string[] = [];
  const criados = new Map<string, Uint8Array>();
  const bytes = (v: string | Uint8Array) => (typeof v === 'string' ? b(v) : v);
  return {
    lidos,
    inicios,
    criados,
    pastaReal: (caminho) => (caminho === PASTA ? PASTA : null),
    existe: (caminho) => (d.git ?? []).includes(caminho),
    listar: (pasta) =>
      pasta === PASTA
        ? [
            ...Object.keys(arquivos).map((nome) => ({ nome, arquivo: true })),
            ...(d.naoArquivos ?? []).map((nome) => ({ nome, arquivo: false })),
          ]
        : [],
    lerInicio: (_pasta, nome, n) => {
      inicios.push(nome);
      const v = arquivos[nome];
      if (v === undefined) throw new Error('no such file');
      return bytes(v).subarray(0, n);
    },
    ler: (pasta, nome) => {
      lidos.push(nome);
      const v = arquivos[nome];
      if (pasta !== PASTA || v === undefined) throw new Error('no such file');
      return bytes(v);
    },
    modificadoEmMs: () => MTIME,
    criarExclusivo: (_pasta, nome, conteudo) => {
      if (nome in arquivos || criados.has(nome)) throw new Error('EEXIST');
      criados.set(nome, conteudo);
      arquivos[nome] = conteudo;
    },
    aleatorio: (n) => new Uint8Array(n).fill(2),
    fixtureExistente: (nome) => d.fixtures?.[nome] ?? null,
    lerArquivo: (caminho) => {
      const v = d.outros?.[caminho];
      return v === undefined ? null : bytes(v);
    },
  };
}

const credencial = 'credencial: token-legado-curl\npapeis: dtc,tax-invoicing\n';
const par = (linha1: string, corpo: unknown) => ({
  txt: `${linha1}\n${credencial}`,
  json: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
});

function pares(p: Readonly<Record<string, { txt: string; json: string }>>) {
  const arquivos: Record<string, string> = {};
  for (const [nome, { txt, json }] of Object.entries(p)) {
    arquivos[`${nome}.txt`] = txt;
    arquivos[`${nome}.json`] = json;
  }
  return arquivos;
}

const LIMPO = par(`GET ${GET_ORDER} 200`, getOrderBr());
const comSku = (sku: string) => {
  const corpo = getOrderBr();
  const itens = corpo.order.orderItems as { product: Record<string, unknown> }[];
  if (itens[0] !== undefined) itens[0].product.sellerSku = sku;
  return par(`GET ${GET_ORDER} 200`, corpo);
};
const rodar = (argv: readonly string[], d: SistemaDeArquivosDaSanitizacao) =>
  executarSanitizacao(argv, d);

describe('★ all or nothing', () => {
  it('one bad pair among 5: zero files written, exit 1, every finding listed', () => {
    const d = disco({
      arquivos: pares({ a: LIMPO, b: LIMPO, c: comSku(CPF), d: LIMPO, e: LIMPO }),
    });
    const r = rodar(['--entrada', PASTA], d);
    expect(r.codigo).toBe(1);
    expect(r.escritas).toEqual([]);
    expect(r.saida).toContain('REFUSED, no fixture was written. Each line');
    expect(r.saida).toContain('  c resposta.corpo.order.orderItems.*.product.sellerSku :: cpf\n');
    expect(r.saida).not.toContain(CPF);
  });

  it('a clean run writes every pair as `JSON.stringify(v, null, 2) + "\\n"`', () => {
    const r = rodar(['--entrada', PASTA], disco({ arquivos: pares({ 'c1-pedido': LIMPO }) }));
    expect(r.codigo).toBe(0);
    expect(r.escritas.map((e) => e.nome)).toEqual(['c1-pedido']);
    const texto = r.escritas[0]?.texto ?? '';
    expect(texto).toBe(`${JSON.stringify(JSON.parse(texto), null, 2)}\n`);
    expect(r.saida).toContain('c1-pedido -> written');
  });
});

describe('★ collisions', () => {
  it('an existing differing fixture without --sobrescrever is refused; with it, written', () => {
    const d = disco({ arquivos: pares({ a: LIMPO }), fixtures: { a: '{}\n' } });
    const r = rodar(['--entrada', PASTA], d);
    expect(r).toMatchObject({ codigo: 1, escritas: [] });
    expect(r.saida).toContain('a __wire__ :: fixture-existente-diferente');
    expect(rodar(['--entrada', PASTA, '--sobrescrever'], d).escritas.map((e) => e.nome)).toEqual([
      'a',
    ]);
  });

  it('identical bytes are a no-op', () => {
    const primeiro = rodar(['--entrada', PASTA], disco({ arquivos: pares({ a: LIMPO }) }));
    const texto = primeiro.escritas[0]?.texto ?? '';
    const r = rodar(
      ['--entrada', PASTA],
      disco({ arquivos: pares({ a: LIMPO }), fixtures: { a: texto } }),
    );
    expect(r).toMatchObject({ codigo: 0, escritas: [] });
    expect(r.saida).toContain('a -> unchanged');
  });
});

describe('★ run-wide refusals', () => {
  it.each<[string, { arquivos?: Record<string, string>; naoArquivos?: string[] }]>([
    ['a .har file', { arquivos: { 'sessao.har': '{}' } }],
    ['a .har link', { naoArquivos: ['sessao.har'] }],
    ['a .har folder', { naoArquivos: ['capturas.HAR'] }],
    ['.env.local', { arquivos: { '.env.local': 'X=1' } }],
  ])('%s refuses the run before anything is read whole', (_caso, extra) => {
    const d = disco({
      arquivos: { ...pares({ a: LIMPO }), ...extra.arquivos },
      naoArquivos: extra.naoArquivos,
    });
    const r = rodar(['--entrada', PASTA], d);
    expect(r).toMatchObject({ codigo: 1, escritas: [] });
    expect(d.lidos.filter((n) => n.endsWith('.json'))).toEqual([]);
  });

  it.each([
    ['PK', [0x50, 0x4b, 0x03, 0x04, 0x0a, 0x00], 'binario-zip'],
    ['^XA', [0x5e, 0x58, 0x41, 0x0a], 'binario-zpl'],
    ['%PDF-', [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31], 'binario-pdf'],
    ['gzip', [0x1f, 0x8b, 0x08, 0x00], 'binario-gzip'],
  ])(
    '%s magic in ANY file (even notas.txt) refuses the run; the file is never read whole',
    (_caso, magia, tipo) => {
      const d = disco({ arquivos: { ...pares({ a: LIMPO }), 'notas.txt': new Uint8Array(magia) } });
      const r = rodar(['--entrada', PASTA], d);
      expect(r).toMatchObject({ codigo: 1, escritas: [] });
      expect(r.saida).toContain(`pasta notas.txt :: ${tipo}`);
      expect(d.inicios).toContain('notas.txt');
      expect(d.lidos).not.toContain('notas.txt');
    },
  );

  it('a binary named like a capture is refused too, never parsed', () => {
    const d = disco({
      arquivos: { 'a.txt': LIMPO.txt, 'a.json': new Uint8Array([0x50, 0x4b, 0x03, 0x04]) },
    });
    expect(rodar(['--entrada', PASTA], d).saida).toContain('pasta a.json :: binario-zip');
    expect(d.lidos).not.toContain('a.json');
  });

  it('★ a folder inside a checkout is refused; a sibling is accepted', () => {
    expect(() =>
      rodar(
        ['--entrada', PASTA],
        disco({ arquivos: pares({ a: LIMPO }), git: ['/home/fulano/.git'] }),
      ),
    ).toThrow(ErroDeUsoSanitizacao);
    expect(
      rodar(
        ['--entrada', PASTA],
        disco({ arquivos: pares({ a: LIMPO }), git: ['/home/outro/.git'] }),
      ).codigo,
    ).toBe(0);
  });
});

describe('★ the salt', () => {
  it('a run with captures but no salt creates it, exclusively, once', () => {
    const d = disco({ arquivos: pares({ a: LIMPO }), semSal: true });
    const seco = rodar(['--entrada', PASTA, '--dry-run'], d);
    expect(seco.codigo).toBe(0);
    expect(d.criados.get(ARQUIVO_SAL)).toHaveLength(TAMANHO_DO_SAL);
    // The output says the salt was created: never "nothing was written".
    expect(seco.saida).toContain(
      `dry run: clean, no fixture was written (the salt ${ARQUIVO_SAL} was created beside the captures).`,
    );
    // The second run reads it: the fakes are the same.
    expect(rodar(['--entrada', PASTA], d).escritas).toEqual(
      rodar(['--entrada', PASTA], d).escritas,
    );
    expect(d.criados.size).toBe(1);
  });

  it('a refused run that created the salt says so; one that read it does not', () => {
    const recusado = (semSal: boolean) =>
      rodar(
        ['--entrada', PASTA],
        disco({ arquivos: { ...pares({ a: LIMPO }), 'orfao.json': '{}' }, semSal }),
      );
    const criou = recusado(true);
    expect(criou.codigo).toBe(1);
    expect(criou.saida).toContain(
      `REFUSED, no fixture was written (the salt ${ARQUIVO_SAL} was created beside the captures).`,
    );
    expect(recusado(false).saida).not.toContain('the salt');
  });

  it('a short salt, or a salt that is not a regular file, refuses the run', () => {
    expect(() =>
      rodar(
        ['--entrada', PASTA],
        disco({ arquivos: { ...pares({ a: LIMPO }), [ARQUIVO_SAL]: new Uint8Array(8) } }),
      ),
    ).toThrow(ErroDeUsoSanitizacao);
    expect(() =>
      rodar(
        ['--entrada', PASTA],
        disco({ arquivos: pares({ a: LIMPO }), semSal: true, naoArquivos: [ARQUIVO_SAL] }),
      ),
    ).toThrow(ErroDeUsoSanitizacao);
  });

  it('the salt keys every fake: another salt, other bytes', () => {
    const um = rodar(['--entrada', PASTA], disco({ arquivos: pares({ a: LIMPO }) }));
    const outro = rodar(
      ['--entrada', PASTA],
      disco({
        arquivos: { ...pares({ a: LIMPO }), [ARQUIVO_SAL]: new Uint8Array(TAMANHO_DO_SAL).fill(8) },
      }),
    );
    expect(um.escritas[0]?.texto).not.toBe(outro.escritas[0]?.texto);
  });
});

describe('the dry run', () => {
  it('a clean dry run: zero writes, exit 0, the request line and the leaf table', () => {
    const r = rodar(['--entrada', PASTA, '--dry-run'], disco({ arquivos: pares({ a: LIMPO }) }));
    expect(r).toMatchObject({ codigo: 0, escritas: [] });
    expect(r.saida).toMatch(/request: GET \/orders\/2026-01-01\/orders\/000-0000000-\d{7}\n/);
    expect(r.saida).toContain(
      'credential token-legado-curl, roles dtc,tax-invoicing, status 200, form json',
    );
    expect(r.saida).toContain('order.orderItems.*.product.sellerSku : string → falsificado (1)');
    expect(r.saida).toContain('dry run: clean, no fixture was written.\n');
  });

  it('★ never prints a raw request line that holds a CPF', () => {
    const d = disco({
      arquivos: pares({
        a: par(`GET /orders/2026-01-01/orders/${CPF} 200`, getOrderBr()),
        b: par(`GET /orders/2026-01-01/orders?createdAfter=${pontuarCpf(CPF)} 200`, { orders: [] }),
      }),
    });
    const r = rodar(['--entrada', PASTA, '--dry-run'], d);
    expect(r.saida).not.toContain(CPF);
    expect(r.saida).not.toContain(pontuarCpf(CPF));
    expect(r.saida).toContain('request: GET /orders/2026-01-01/orders/<seg>\n');
  });

  it('a request line that trips a listed term prints `<omitted…>` instead', () => {
    const d = disco({
      arquivos: pares({
        a: par('GET /orders/2026-01-01/orders?termoficticiozeta=1 200', { orders: [] }),
      }),
    });
    const r = rodar(['--entrada', PASTA, '--dry-run'], d);
    expect(r.saida).toContain('request: <omitted: it trips nome-de-loja>');
    expect(r.saida.toLowerCase()).not.toContain('termoficticiozeta');
  });

  it('★ a pair whose NAME holds a listed term prints as par-<n> and refuses the run', () => {
    const d = disco({ arquivos: pares({ 'termo-ficticio-zeta': LIMPO, 'c1-pedido-cpf': LIMPO }) });
    const r = rodar(['--entrada', PASTA], d);
    expect(r).toMatchObject({ codigo: 1, escritas: [] });
    expect(r.saida).toContain('  par-2 nome :: nome-de-loja\n');
    expect(r.saida.toLowerCase()).not.toContain('ficticio');
  });
});

describe('★ a capture name becomes a PUBLIC file name', () => {
  // An order id (the natural name for C1 (9)/(10)), a bare and a hyphenated phone, a CEP, a CPF.
  const NOMES_COM_DADOS = [
    'c1-123-4567890-1234567',
    'c1-11987654321',
    'c1-11-98765-4321',
    'c1-01234567',
    `c1-${CPF}`,
  ];

  it.each([false, true])(
    'a name holding an id, a phone, a CEP or a document is outside the grammar: refused, never printed (dry run %s)',
    (seco) => {
      const d = disco({
        arquivos: pares(
          Object.fromEntries([...NOMES_COM_DADOS, 'c1-pedido-cpf'].map((n) => [n, LIMPO])),
        ),
      });
      const r = rodar(['--entrada', PASTA, ...(seco ? ['--dry-run'] : [])], d);
      expect(r).toMatchObject({ codigo: 1, escritas: [] });
      expect(r.saida).toContain(
        `  pasta ${String(NOMES_COM_DADOS.length * 2)} file(s) :: nome-fora-da-gramatica\n`,
      );
      for (const nome of NOMES_COM_DADOS) expect(r.saida).not.toContain(nome.slice(3));
      // Near-miss: a name that describes the request is printed as is.
      if (seco) expect(r.saida).toContain('[c1-pedido-cpf]\n');
    },
  );

  it('near-miss: short digit groups are a request description, not data', () => {
    const r = rodar(
      ['--entrada', PASTA],
      disco({ arquivos: pares({ 'c1-9-10-pedido': LIMPO, 'c2-12345': LIMPO }) }),
    );
    expect(r.codigo).toBe(0);
    expect(r.escritas.map((e) => e.nome)).toEqual(['c1-9-10-pedido', 'c2-12345']);
  });

  it('a refused folder entry whose name holds an order id or a digit run prints as entrada-<n>', () => {
    const d = disco({
      arquivos: {
        ...pares({ a: LIMPO }),
        '702-1234567-1234567.har': '{}',
        'fulana-11987654321.json': new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
        'notas.txt': new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
      },
    });
    const r = rodar(['--entrada', PASTA], d);
    expect(r.saida).toContain('  pasta entrada-1 :: har\n');
    expect(r.saida).toContain('  pasta entrada-2 :: binario-zip\n');
    expect(r.saida).toContain('  pasta notas.txt :: binario-pdf\n');
    expect(r.saida).not.toContain('1234567');
    expect(r.saida).not.toContain('11987654321');
  });
});

describe('arguments', () => {
  it('parses every flag; usage errors name positions, never values', () => {
    expect(lerArgumentos(['--entrada', PASTA, '--so', 'a', '--dry-run'])).toEqual({
      entrada: PASTA,
      so: ['a'],
      dryRun: true,
      sobrescrever: false,
      verificar: null,
    });
    expect(() => lerArgumentos(['--', '--entrada', PASTA])).toThrow(/stray "--"/);
    expect(() => lerArgumentos(['--entrada', PASTA, 'segredo'])).toThrow(/argument 3/);
    expect(() => lerArgumentos(['--entrada', PASTA, 'segredo'])).not.toThrow(/segredo/);
    expect(() => lerArgumentos([])).toThrow(ErroDeUsoSanitizacao);
    expect(() => lerArgumentos(['--entrada', PASTA, '--verificar', 'x', '--dry-run'])).toThrow(
      ErroDeUsoSanitizacao,
    );
  });
});

describe('--verificar', () => {
  const verificar = (outros: Readonly<Record<string, string | Uint8Array>>) =>
    rodar(['--entrada', PASTA, '--verificar', ...Object.keys(outros)], disco({ outros }));

  it('a clean file passes; a CPF and a listed term are found by line, never printed', () => {
    expect(verificar({ 'doc.md': '# Nada aqui\n000-0000000-1234567\n' })).toMatchObject({
      codigo: 0,
    });
    const r = verificar({ 'doc.md': `linha um\nCPF ${pontuarCpf(CPF)}\nTermo Ficticio Zeta\n` });
    expect(r.codigo).toBe(1);
    expect(r.saida).toContain('doc.md:2 :: cpf');
    expect(r.saida).toContain('doc.md:3 :: nome-de-loja');
    expect(r.saida).not.toContain(pontuarCpf(CPF));
  });

  it('★ a percent-encoded listed term (1, 2 and 3 rounds) is found', () => {
    for (const texto of [
      'termo%20ficticio%20zeta',
      'termo%2520ficticio%2520zeta',
      'termo%252520ficticio%252520zeta',
    ]) {
      expect(verificar({ 'pr.md': `${texto}\n` }).saida, texto).toContain(
        'pr.md:1 :: nome-de-loja',
      );
    }
  });

  it('★ a term split by a hard wrap is found in a 2-line and a 3-line window', () => {
    expect(verificar({ 'pr.md': 'a loja Termo\nFicticio Zeta vende\n' }).saida).toContain(
      'pr.md:1-2 :: nome-de-loja',
    );
    expect(verificar({ 'pr.md': 'a loja Termo\nFicticio\nZeta vende\n' }).saida).toContain(
      'pr.md:1-3 :: nome-de-loja',
    );
    // A list marker on the continuation is dropped.
    expect(verificar({ 'pr.md': '- Termo Ficticio\n- Zeta\n' }).saida).toContain(
      'pr.md:1-2 :: nome-de-loja',
    );
  });

  it('a UTF-16 file is refused whole; a file name that trips prints as arquivo-<n>', () => {
    expect(verificar({ 'u.md': new Uint8Array([0xff, 0xfe, 0x41, 0x00]) }).saida).toContain(
      'u.md :: utf16',
    );
    const nome = `notas-${CPF}.md`;
    const r = verificar({ [nome]: `${pontuarCpf(CPF)}\n` });
    expect(r.saida).toContain('arquivo-1:1 :: cpf');
    expect(r.saida).not.toContain(CPF);
  });
});
