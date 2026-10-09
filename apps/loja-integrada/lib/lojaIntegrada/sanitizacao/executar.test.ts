import { describe, expect, it } from 'vitest';

import { gerarCpf } from '../testing/especificacaoPii';
import {
  ErroDeUsoSanitizacao,
  type SistemaDeArquivosDaSanitizacao,
  executarSanitizacao,
  lerArgumentos,
} from './executar';

/*
 * An in-memory file system: synthetic captures only. Nothing here touches a disk,
 * let alone a real capture folder.
 */
const PASTA = '/home/fulano/li-capturas';
const CPF = gerarCpf('529982247');
const SENTINELA = 'SENTINELA-5d1e';
const NOMES = 'Loja Exemplo\n';
const MTIME = Date.UTC(2026, 9, 7);
const b = (t: string) => new TextEncoder().encode(t);

interface Disco {
  readonly arquivos?: Readonly<Record<string, string | Uint8Array>>;
  /** Entries that are not regular files (a link, a folder): listed, never readable. */
  readonly naoArquivos?: readonly string[];
  readonly git?: readonly string[];
  readonly fixtures?: Readonly<Record<string, string>>;
  readonly outros?: Readonly<Record<string, string>>;
}

function disco(d: Disco = {}): SistemaDeArquivosDaSanitizacao & { readonly lidos: string[] } {
  const arquivos: Readonly<Record<string, string | Uint8Array>> = {
    'nomes-proibidos.txt': NOMES,
    ...d.arquivos,
  };
  const lidos: string[] = [];
  return {
    lidos,
    pastaReal: (caminho) => (caminho === PASTA || caminho === 'li-capturas' ? PASTA : null),
    existe: (caminho) => (d.git ?? []).includes(caminho),
    listar: (pasta) =>
      pasta === PASTA
        ? [
            ...Object.keys(arquivos).map((nome) => ({ nome, arquivo: true })),
            ...(d.naoArquivos ?? []).map((nome) => ({ nome, arquivo: false })),
          ]
        : [],
    ler: (pasta, nome) => {
      lidos.push(nome);
      const v = arquivos[nome];
      if (pasta !== PASTA || v === undefined) throw new Error('no such file');
      return typeof v === 'string' ? b(v) : v;
    },
    modificadoEmMs: () => MTIME,
    fixtureExistente: (nome) => d.fixtures?.[nome] ?? null,
    lerArquivo: (caminho) => {
      const v = d.outros?.[caminho];
      return v === undefined ? null : b(v);
    },
  };
}

const par = (linha1: string, corpo: unknown) => ({
  txt: `${linha1}\ncredencial: personal-token\n`,
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

const LIMPO = par('GET /v1/situacao/ 200', {
  meta: { limit: 20, offset: 0, total_count: 1, next: null, previous: null },
  objects: [{ id: 2, codigo: 'pedido_pago', nome: SENTINELA }],
});
const COM_CPF_NO_SKU = par('GET /v1/pedido/search/ 200', {
  objects: [{ numero: 987654321, itens: [{ sku: CPF }], cliente: { nome: SENTINELA } }],
});
const COM_NOME_DE_LOJA = par('GET /v1/pedido/1 200', { situacao: { codigo: 'loja_exemplo_x' } });

const rodar = (argv: readonly string[], d: SistemaDeArquivosDaSanitizacao) =>
  executarSanitizacao(argv, d);

describe('executarSanitizacao — all or nothing', () => {
  it('three pairs, two with findings: zero writes, exit 1, every finding listed', () => {
    const d = disco({
      arquivos: pares({ a: LIMPO, b: COM_CPF_NO_SKU, c: COM_NOME_DE_LOJA }),
    });
    const r = rodar(['--entrada', PASTA], d);
    expect(r.codigo).toBe(1);
    expect(r.escritas).toEqual([]);
    expect(r.saida).toContain('REFUSED, nothing was written.');
    expect(r.saida).toContain('  b resposta.corpo.objects.*.itens.*.sku :: cpf\n');
    expect(r.saida).toContain('  c resposta.corpo.situacao.codigo :: nome-de-loja\n');
  });

  it('a clean run writes `<nome>.json` as `JSON.stringify(v, null, 2) + "\\n"`', () => {
    const r = rodar(['--entrada', PASTA], disco({ arquivos: pares({ 'c3-situacao': LIMPO }) }));
    expect(r.codigo).toBe(0);
    expect(r.escritas.map((e) => e.nome)).toEqual(['c3-situacao']);
    const texto = r.escritas[0]?.texto ?? '';
    expect(texto).toBe(`${JSON.stringify(JSON.parse(texto), null, 2)}\n`);
    expect(r.saida).toContain('c3-situacao -> written');
  });

  it('a clean dry run: zero writes, exit 0', () => {
    const r = rodar(['--entrada', PASTA, '--dry-run'], disco({ arquivos: pares({ a: LIMPO }) }));
    expect(r).toMatchObject({ codigo: 0, escritas: [] });
    expect(r.saida).toContain('request: GET /v1/situacao/');
    expect(r.saida).toContain('class configuracao, status 200, form json');
    expect(r.saida).toContain('objects.*.codigo : string → mantido (1)');
    expect(r.saida).toContain('objects.*.nome : string → falsificado (1)');
    expect(r.saida).toContain('dry run: clean, nothing was written.');
  });

  it('a dry run with a finding exits 1', () => {
    const r = rodar(
      ['--entrada', PASTA, '--dry-run'],
      disco({ arquivos: pares({ b: COM_CPF_NO_SKU }) }),
    );
    expect(r).toMatchObject({ codigo: 1, escritas: [] });
  });

  it('a dry run never prints a request line that trips a pattern, only the kind', () => {
    // `numero` passes its predicate, so the redactor keeps the digits; the scanner refuses them.
    const r = rodar(
      ['--entrada', PASTA, '--dry-run'],
      disco({
        arquivos: pares({
          a: par(`GET /v1/pedido/search/?numero=${CPF} 200`, { objects: [] }),
          b: par(`GET /v1/cliente/${CPF} 200`, {}),
          c: par('GET /v1/produto/?sku=LOJA%2FEXEMPLO-01 200', { objects: [] }),
        }),
      }),
    );
    expect(r).toMatchObject({ codigo: 1, escritas: [] });
    expect(r.saida).not.toContain(CPF);
    expect(r.saida.toLowerCase()).not.toContain('exemplo');
    expect(r.saida).toContain('[a]\n  request: <omitted: it trips cpf>\n');
    expect(r.saida).toContain('[b]\n  request: <omitted: it trips cpf>\n');
    expect(r.saida).toContain('[c]\n  request: <omitted: it trips nome-de-loja>\n');
    expect(r.saida).toContain('  a requisicao.query.*.* :: cpf\n');
    expect(r.saida).toContain('  b requisicao.caminho :: cpf\n');
  });

  it('`--so` converts only the named pair', () => {
    const r = rodar(
      ['--entrada', PASTA, '--so', 'a'],
      disco({ arquivos: pares({ a: LIMPO, b: COM_CPF_NO_SKU }) }),
    );
    expect(r.codigo).toBe(0);
    expect(r.escritas.map((e) => e.nome)).toEqual(['a']);
  });
});

describe('executarSanitizacao — collisions', () => {
  const texto = rodar(['--entrada', PASTA], disco({ arquivos: pares({ a: LIMPO }) })).escritas[0]
    ?.texto;

  it('identical bytes are a no-op', () => {
    const r = rodar(
      ['--entrada', PASTA],
      disco({ arquivos: pares({ a: LIMPO }), fixtures: { a: texto ?? '' } }),
    );
    expect(r).toMatchObject({ codigo: 0, escritas: [] });
    expect(r.saida).toContain('a -> unchanged');
  });

  it('different bytes are refused without `--sobrescrever`, and replaced with it', () => {
    const d = () => disco({ arquivos: pares({ a: LIMPO }), fixtures: { a: '{}\n' } });
    const sem = rodar(['--entrada', PASTA], d());
    expect(sem).toMatchObject({ codigo: 1, escritas: [] });
    expect(sem.saida).toContain('a __wire__ :: fixture-existente-diferente');
    const com = rodar(['--entrada', PASTA, '--sobrescrever'], d());
    expect(com.codigo).toBe(0);
    expect(com.escritas.map((e) => e.nome)).toEqual(['a']);
    // The dry run counts the collision against its pair.
    const seco = rodar(['--entrada', PASTA, '--dry-run'], d());
    expect(seco).toMatchObject({ codigo: 1, escritas: [] });
    expect(seco.saida).toContain('[a]\n');
    expect(seco.saida).toContain('  findings: 1\n');
  });
});

describe('executarSanitizacao — the folder', () => {
  it('a HAR file refuses the run before any capture is read', () => {
    const d = disco({ arquivos: { ...pares({ a: LIMPO }), 'sessao.har': '{}' } });
    const r = rodar(['--entrada', PASTA], d);
    expect(r).toMatchObject({ codigo: 1, escritas: [] });
    expect(r.saida).toContain('pasta :: har');
    expect(r.saida).toContain('Authorization header and cookies');
    expect(d.lidos).toEqual([]);
  });

  it('a HAR that is not a regular file (a link, a folder) refuses the run too', () => {
    const d = disco({ arquivos: pares({ a: LIMPO }), naoArquivos: ['sessao.har'] });
    const r = rodar(['--entrada', PASTA, '--dry-run'], d);
    expect(r).toMatchObject({ codigo: 1, escritas: [] });
    expect(r.saida).toContain('pasta :: har');
    expect(d.lidos).toEqual([]);
  });

  it('a capture that is not a regular file is refused by name, never read; other entries are counted', () => {
    const d = disco({
      arquivos: { ...pares({ a: LIMPO }), 'b.txt': LIMPO.txt },
      naoArquivos: ['b.json', 'antigas'],
    });
    const r = rodar(['--entrada', PASTA], d);
    expect(r).toMatchObject({ codigo: 1, escritas: [] });
    expect(r.saida).toContain('  b .json :: nao-e-arquivo\n');
    expect(r.saida).toContain('regular file');
    expect(r.saida).not.toContain('sem-corpo');
    expect(d.lidos).not.toContain('b.json');
    const seco = rodar(
      ['--entrada', PASTA, '--dry-run'],
      disco({
        arquivos: pares({ a: LIMPO }),
        naoArquivos: ['antigas'],
      }),
    );
    expect(seco.codigo).toBe(0);
    expect(seco.saida).toContain('1 pair(s), 1 other file(s) ignored');
  });

  it('an unpaired capture refuses the run, by name', () => {
    const r = rodar(
      ['--entrada', PASTA],
      disco({ arquivos: { ...pares({ a: LIMPO }), 'b.json': '{}' } }),
    );
    expect(r).toMatchObject({ codigo: 1, escritas: [] });
    expect(r.saida).toContain('  b .txt :: sem-sidecar');
  });

  it('a pair named after a document or a listed store is printed as `par-<n>`', () => {
    const r = rodar(
      ['--entrada', PASTA],
      disco({ arquivos: pares({ [CPF]: LIMPO, 'lojaexemplo-1': LIMPO }) }),
    );
    expect(r.codigo).toBe(1);
    expect(r.saida).toContain('par-1 nome :: cpf');
    expect(r.saida).toContain('par-2 nome :: nome-de-loja');
    expect(r.saida).not.toContain(CPF);
    expect(r.saida.toLowerCase()).not.toContain('exemplo');
  });

  it('SENTINEL: the whole output never holds a body value or a listed term', () => {
    const d = () =>
      disco({ arquivos: pares({ a: LIMPO, b: COM_CPF_NO_SKU, c: COM_NOME_DE_LOJA }) });
    const saida = [
      rodar(['--entrada', PASTA], d()).saida,
      rodar(['--entrada', PASTA, '--dry-run'], d()).saida,
    ].join('\n');
    for (const valor of [SENTINELA, CPF, '987654321', 'pedido_pago']) {
      expect(saida).not.toContain(valor);
    }
    expect(saida.toLowerCase()).not.toContain('exemplo');
    // Anti-vacuity: the dry run did print the tables.
    expect(saida).toContain('objects.*.itens.*.sku : string → falsificado (1)');
  });
});

describe('executarSanitizacao — usage errors (exit 2), never echoing an argument', () => {
  /** The run as a thunk: a usage error is a throw, and the script maps it to exit 2. */
  const uso =
    (argv: readonly string[], d = disco({ arquivos: pares({ a: LIMPO }) })) =>
    () =>
      rodar(argv, d);

  it.each([
    ['no --entrada', []],
    ['an unknown flag', ['--entrada', PASTA, `--${SENTINELA}`]],
    ['a stray --', ['--entrada', PASTA, '--', '--dry-run']],
    ['a positional argument', ['--entrada', PASTA, SENTINELA]],
    ['--entrada given twice', ['--entrada', PASTA, '--entrada', PASTA]],
    ['--entrada with no value', ['--entrada']],
    ['a folder that does not exist', ['--entrada', `/tmp/${SENTINELA}`]],
    ['--so naming no pair', ['--entrada', PASTA, '--so', 'zzz']],
    ['--so with an odd name', ['--entrada', PASTA, '--so', SENTINELA]],
    ['--verificar with --dry-run', ['--entrada', PASTA, '--verificar', 'x.md', '--dry-run']],
    ['--verificar with no file', ['--entrada', PASTA, '--verificar']],
    ['--verificar on a missing file', ['--entrada', PASTA, '--verificar', `${SENTINELA}.md`]],
  ])('%s', (_caso, argv) => {
    expect(uso(argv)).toThrow(ErroDeUsoSanitizacao);
    expect(uso(argv)).not.toThrow(SENTINELA);
  });

  it('a folder inside a git checkout (a `.git` directory or a worktree `.git` file up the tree)', () => {
    expect(uso(['--entrada', PASTA], disco({ git: ['/home/fulano/.git'] }))).toThrow(
      /inside a git checkout/,
    );
    expect(uso(['--entrada', PASTA], disco({ git: [`${PASTA}/.git`] }))).toThrow(
      /inside a git checkout/,
    );
  });

  it('a folder with no store-name list, or a list with a short term', () => {
    const semLista = disco({ arquivos: pares({ a: LIMPO }) });
    const listar = semLista.listar;
    expect(
      uso(['--entrada', PASTA], {
        ...semLista,
        listar: (p) => listar(p).filter((e) => e.nome !== 'nomes-proibidos.txt'),
      }),
    ).toThrow(/no nomes-proibidos\.txt/);
    expect(
      uso(
        ['--entrada', PASTA],
        disco({ arquivos: { ...pares({ a: LIMPO }), 'nomes-proibidos.txt': `abc\n` } }),
      ),
    ).toThrow(/line 1/);
  });

  it('zero pairs', () => {
    expect(uso(['--entrada', PASTA], disco())).toThrow(/no complete capture pair/);
  });
});

describe('--verificar', () => {
  it('a doc line holding a listed name or a pattern is `arquivo:linha :: tipo`, never the term or the value', () => {
    const r = rodar(
      ['--entrada', PASTA, '--verificar', 'docs/x.md', 'pr.md'],
      disco({
        outros: {
          'docs/x.md': `linha limpa\na LOJA EXÊMPLO vendeu\nCPF ${CPF}\nfake 000.000.000-00 ok\n`,
          'pr.md': 'nada aqui\n',
        },
      }),
    );
    expect(r.codigo).toBe(1);
    expect(r.saida).toContain('  docs/x.md:2 :: nome-de-loja\n');
    expect(r.saida).toContain('  docs/x.md:3 :: cpf\n');
    expect(r.saida).not.toContain('docs/x.md:4');
    expect(r.saida).not.toContain('pr.md:');
    expect(r.saida.toLowerCase()).not.toContain('exemplo');
    expect(r.saida.toLowerCase()).not.toContain('xêmplo');
    expect(r.saida).not.toContain(CPF);
  });

  it('a clean file exits 0 and reads no capture', () => {
    const d = disco({ arquivos: pares({ a: LIMPO }), outros: { 'a.md': 'tudo certo\n' } });
    const r = rodar(['--entrada', PASTA, '--verificar', 'a.md'], d);
    expect(r).toMatchObject({ codigo: 0, escritas: [] });
    expect(r.saida).toContain('clean.');
    expect(d.lidos).toEqual(['nomes-proibidos.txt']);
  });

  it('a file whose PATH holds a listed name is printed by position', () => {
    const r = rodar(
      ['--entrada', PASTA, '--verificar', 'notas-loja-exemplo.md'],
      disco({ outros: { 'notas-loja-exemplo.md': `CPF ${CPF}\n` } }),
    );
    expect(r.saida).toContain('arquivo-1:1 :: cpf');
    expect(r.saida.toLowerCase()).not.toContain('exemplo');
  });
});

describe('lerArgumentos', () => {
  it('parses every flag', () => {
    expect(
      lerArgumentos(['--entrada', 'p', '--so', 'a', '--so', 'b', '--dry-run', '--sobrescrever']),
    ).toEqual({ entrada: 'p', so: ['a', 'b'], dryRun: true, sobrescrever: true, verificar: null });
    expect(lerArgumentos(['--verificar', 'x.md', 'y.md', '--entrada', 'p'])).toMatchObject({
      verificar: ['x.md', 'y.md'],
    });
  });
});
