/**
 * ONE copy of every fold (review 3a, Q4-1; reconcile R-d/R-e): the wire tokens
 * the label and arrange decision folds appear in CODE in
 * `etiqueta/faseEtiqueta.ts` and nowhere else in the Shopee app — save the
 * NAMED exemptions below, each with the reason it is not a copy.
 *
 * ## Why a raw-text pin
 *
 * A faithful second copy is behaviourally identical, so no behaviour test can
 * see it: review 3a's mutant M-Q4a put a local `[90011, 90012, 90026]` in the
 * aviso resolver and all 72 of its tests stayed green. The drift only shows on
 * the day the ONE copy changes — announcement 1573 moves a channel, Shopee
 * respells a flag — and the stale copy keeps opening and closing avisos (or
 * uploading NF-e) on the old answer: the #1369 failure the root CLAUDE.md
 * names. The executor's own pin (`executarEtiqueta.test.ts`) reads two files;
 * this one reads them all.
 *
 * ## The needles
 *
 * - `invoice_pending` — the invoice fold (`observacaoDoPacoteShopee`).
 * - `fulfilled_by_shopee` — the FBS fold (`ehPedidoFbsShopee`), which step 14's
 *   NF-e gate imports instead of keeping its own since review 3a (Q4-2).
 * - `is_shipment_arranged` — the arranged read (`observacaoDoPacoteShopee`).
 *   The bare word, not only `.is_shipment_arranged`: a destructure or a bracket
 *   read is a read too.
 * - `90011` / `90012` / `90026` — the announcement-1573 channel tuples.
 *
 * ## The universe
 *
 * Every `.ts` / `.tsx` under `apps/shopee/{lib,app,functions/src,scripts}`,
 * minus `*.test.ts` (which covers `*.tasks.test.ts`), read from disk — a
 * SUPERSET of `lib/**`: a route, a script or the functions codebase (where a
 * sweep's schedule lives) would otherwise sit outside. Comments are dropped by
 * the TypeScript parser's own comment ranges, so strings, templates and regex
 * literals stay CODE: a pin on code must not red on a docblock that names the
 * field, and a hand-rolled stripper reads the `//` of a URL string as a
 * comment and hides the rest of the line.
 *
 * ## Exceptions are EXACT (the `disciplinaDaPasta` mechanics)
 *
 * The home must match EVERY needle — a home that stops matching means the fold
 * moved, and the pin would hold vacuously — and an exemption that stops
 * matching points at nothing and fails too. Adding an exemption is a review
 * decision, pinned below; PR 3b's sweep joins THIS pin rather than a second
 * one.
 *
 * ⚠️ This file is a `*.test.ts`, so it sits outside its own universe (and the
 * folder discipline's) and may spell every needle.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** `apps/shopee/` — every path below is relative to it, `/` as the separator. */
const RAIZ_DO_APP = new URL('../../../', import.meta.url);

/** The roots of the universe. */
const RAIZES: readonly string[] = ['lib/', 'app/', 'functions/src/', 'scripts/'];

/** The one file allowed to hold every needle. */
const CASA = 'lib/shopee/etiqueta/faseEtiqueta.ts';

/** One wire token whose fold has ONE home. */
interface Agulha {
  readonly id: string;
  /** Matched per LINE of comment-free code. Never with the `g` flag. */
  readonly padrao: RegExp;
  /** Besides {@link CASA}: the files that MUST match, each with why it is not a copy. */
  readonly isencoes: Readonly<Record<string, string>>;
}

const AGULHAS: readonly Agulha[] = [
  { id: 'invoice_pending', padrao: /invoice_pending/, isencoes: {} },
  { id: 'fulfilled_by_shopee', padrao: /fulfilled_by_shopee/, isencoes: {} },
  {
    id: 'is_shipment_arranged',
    padrao: /is_shipment_arranged/,
    isencoes: {
      'lib/shopee/pedidos/rastrearPedidoCli.ts':
        'the rehearsal DISPLAYS the raw flag verbatim (`isShipmentArranged`, its package row) beside the predicted phase — it decides nothing',
    },
  },
  { id: 'os canais do anúncio 1573', padrao: /\b900(?:11|12|26)\b/, isencoes: {} },
];

/* -------------------------------------------------------------------------- */
/*                               the machinery                                 */
/* -------------------------------------------------------------------------- */

const PRIMEIRO_JSDOC = ts.SyntaxKind.FirstJSDocNode;
const ULTIMO_JSDOC = ts.SyntaxKind.LastJSDocNode;

/**
 * The CODE of a source: every comment the TypeScript parser sees — line,
 * block and JSDoc — blanked to spaces, line breaks kept, so a finding keeps
 * `git grep -n`'s line number. Strings, templates and regex literals are
 * tokens of their own and stay.
 *
 * The comments are the leading and trailing comment ranges at every token
 * boundary of the parse tree. JSDoc nodes are not walked: their boundaries
 * fall INSIDE a comment, where a `//` in a URL would read as a comment running
 * past the `*\/` that closes it.
 */
function semComentarios(arquivo: string, texto: string): string {
  const fonte = ts.createSourceFile(
    arquivo,
    texto,
    ts.ScriptTarget.Latest,
    false,
    arquivo.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const faixas: ts.CommentRange[] = [];
  const visitadas = new Set<number>();
  const coletar = (pos: number): void => {
    if (visitadas.has(pos)) return;
    visitadas.add(pos);
    faixas.push(...(ts.getLeadingCommentRanges(texto, pos) ?? []));
    faixas.push(...(ts.getTrailingCommentRanges(texto, pos) ?? []));
  };
  const visitar = (no: ts.Node): void => {
    if (no.kind >= PRIMEIRO_JSDOC && no.kind <= ULTIMO_JSDOC) return;
    coletar(no.getFullStart());
    coletar(no.getEnd());
    for (const filho of no.getChildren(fonte)) visitar(filho);
  };
  visitar(fonte);
  // UTF-16 units, the parser's own offsets (`[...texto]` would split on code points).
  const unidades = texto.split('');
  for (const { pos, end } of faixas) {
    for (let i = pos; i < end; i += 1) {
      if (unidades[i] !== '\n' && unidades[i] !== '\r') unidades[i] = ' ';
    }
  }
  return unidades.join('');
}

/** Every `.ts` / `.tsx` under the roots, minus `*.test.ts`, keyed by path relative to the app. */
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
  for (const raiz of RAIZES) ler(new URL(raiz, RAIZ_DO_APP), raiz);
  return fontes;
}

/** One finding, in `git grep -n`'s shape. */
interface Achado {
  readonly arquivo: string;
  readonly linha: number;
}

/**
 * {@link semComentarios}, split into lines, parsed ONCE per (file, text): the
 * universe is ~220 files and every check below re-reads all of them, a copy
 * differing from the real universe in one file only.
 */
const LINHAS_DE_CODIGO = new Map<string, readonly string[]>();

function linhasDeCodigo(arquivo: string, texto: string): readonly string[] {
  const chave = `${arquivo}\u0000${texto}`;
  let linhas = LINHAS_DE_CODIGO.get(chave);
  if (linhas === undefined) {
    linhas = semComentarios(arquivo, texto).split(/\r?\n/);
    LINHAS_DE_CODIGO.set(chave, linhas);
  }
  return linhas;
}

/** Where the needle matches in CODE — the sources come in as a parameter, so a copy can be fed. */
function achadosDa(agulha: Agulha, fontes: ReadonlyMap<string, string>): Achado[] {
  const achados: Achado[] = [];
  for (const [arquivo, texto] of fontes) {
    linhasDeCodigo(arquivo, texto).forEach((linha, i) => {
      if (agulha.padrao.test(linha)) achados.push({ arquivo, linha: i + 1 });
    });
  }
  return achados;
}

/** The verdict: matches OUTSIDE the home and the exemptions, and the allowed files that did not match. */
function violacoesDa(
  agulha: Agulha,
  fontes: ReadonlyMap<string, string>,
): { readonly copias: string[]; readonly mortos: string[] } {
  const permitidos = [CASA, ...Object.keys(agulha.isencoes)];
  const achados = achadosDa(agulha, fontes);
  const casaram = new Set(achados.map((a) => a.arquivo));
  return {
    copias: achados
      .filter((a) => !permitidos.includes(a.arquivo))
      .map((a) => `${a.arquivo}:${String(a.linha)}`),
    mortos: permitidos.filter((arquivo) => !casaram.has(arquivo)),
  };
}

/** The real universe, read once. */
const FONTES = fontesDoApp();

/** The real universe with ONE file's text replaced — a COPY; nothing on disk changes. */
function comArquivo(arquivo: string, texto: string): Map<string, string> {
  expect(FONTES.has(arquivo), arquivo).toBe(true);
  return new Map([...FONTES, [arquivo, texto]]);
}

/** The real text of a file of the universe. */
function fonteReal(arquivo: string): string {
  const texto = FONTES.get(arquivo);
  if (texto === undefined) throw new RangeError(`${arquivo} fora do universo`);
  return texto;
}

/** The needle of an id — fails loudly if it disappears. */
function agulha(id: string): Agulha {
  const achada = AGULHAS.find((a) => a.id === id);
  if (achada === undefined) throw new RangeError(`agulha ${id} inexistente`);
  return achada;
}

/* -------------------------------------------------------------------------- */
/*                                  the pin                                    */
/* -------------------------------------------------------------------------- */

describe('o universo: o app inteiro, lido do disco', () => {
  it('as quatro raízes foram lidas, os testes ficaram fora, e os arquivos que importam estão nele', () => {
    // Without this anchor an empty universe would pass every needle below.
    expect(FONTES.size).toBeGreaterThanOrEqual(200);
    for (const raiz of RAIZES) {
      expect(
        [...FONTES.keys()].some((n) => n.startsWith(raiz)),
        raiz,
      ).toBe(true);
    }
    for (const arquivo of [
      CASA,
      'lib/shopee/etiqueta/executarEtiqueta.ts',
      'lib/shopee/pedidos/arranjoAutomatico.ts',
      'lib/shopee/avisos/despachoAutomatico.ts',
      'lib/shopee/nfe/notaNaShopee.ts',
      'lib/shopee/pedidos/rastrearPedidoCli.ts',
      'app/api/marketplace/shopee/etiqueta/route.ts',
      'functions/src/processNotification.ts',
      'scripts/etiqueta.ts',
    ]) {
      expect(FONTES.has(arquivo), arquivo).toBe(true);
    }
    expect([...FONTES.keys()].filter((n) => n.endsWith('.test.ts'))).toEqual([]);
  });

  it('as agulhas são as QUATRO, sem `g`, e as isenções fixadas — mudar uma é decisão de revisão', () => {
    expect(AGULHAS.map((a) => a.id)).toEqual([
      'invoice_pending',
      'fulfilled_by_shopee',
      'is_shipment_arranged',
      'os canais do anúncio 1573',
    ]);
    for (const a of AGULHAS) {
      // The `g` flag would make `test` remember the last position and skip lines.
      expect(a.padrao.global, a.id).toBe(false);
      for (const [arquivo, motivo] of Object.entries(a.isencoes)) {
        expect(FONTES.has(arquivo), `${a.id}: ${arquivo}`).toBe(true);
        expect(motivo.length, `${a.id}: ${arquivo} precisa de um porquê`).toBeGreaterThan(20);
      }
    }
    expect(
      AGULHAS.filter((a) => Object.keys(a.isencoes).length > 0).map(
        (a) => `${a.id}: ${Object.keys(a.isencoes).join(',')}`,
      ),
    ).toEqual(['is_shipment_arranged: lib/shopee/pedidos/rastrearPedidoCli.ts']);
  });

  it('o CÓDIGO da casa: a dobra fica, o docblock sai', () => {
    const codigo = semComentarios(CASA, fonteReal(CASA));
    expect(codigo).toContain('invoice_pending?.status');
    expect(codigo).toContain('[90011, 90012, 90026]');
    // The docblock line that NAMES the fold is gone…
    expect(fonteReal(CASA)).toContain('The invoice fold lives HERE and only here');
    expect(codigo).not.toContain('The invoice fold lives HERE and only here');
    // …and every line survived: line numbers are `git grep -n`'s.
    expect(codigo.split('\n')).toHaveLength(fonteReal(CASA).split('\n').length);
  });
});

describe('UMA cópia: cada agulha casa no código só na casa e nas isenções nomeadas', () => {
  it.each(AGULHAS.map((a) => [a.id, a] as const))('%s', (_id, a) => {
    const { copias, mortos } = violacoesDa(a, FONTES);
    expect(copias, `${a.id}: uma segunda cópia — importe de faseEtiqueta.ts`).toEqual([]);
    expect(mortos, `${a.id}: casa ou isenção que não casa mais — tire-a`).toEqual([]);
  });
});

describe('o pin MORDE — sobre uma CÓPIA do universo, nada muda no disco', () => {
  it('M-Q4a: a lista de canais copiada no resolvedor de avisos é achada (near-miss: num comentário, não)', () => {
    const arquivo = 'lib/shopee/avisos/despachoAutomatico.ts';
    const real = fonteReal(arquivo);
    const copiado = `${real}\nconst CANAIS_LOCAIS = [90011, 90012, 90026] as const;\n`;
    const linha = copiado.split(/\r?\n/).length - 1;
    expect(violacoesDa(agulha('os canais do anúncio 1573'), comArquivo(arquivo, copiado))).toEqual({
      copias: [`${arquivo}:${String(linha)}`],
      mortos: [],
    });
    const comentado = `${real}\n// const CANAIS_LOCAIS = [90011, 90012, 90026] as const;\n`;
    expect(
      violacoesDa(agulha('os canais do anúncio 1573'), comArquivo(arquivo, comentado)).copias,
    ).toEqual([]);
  });

  it('o prazo de 1 hora copiado como um predicado local também (90011 / 90012 soltos)', () => {
    const arquivo = 'lib/shopee/avisos/despachoAutomatico.ts';
    const copiado = `${fonteReal(arquivo)}\nconst comPrazo = (c: number): boolean => c === 90011 || c === 90012;\n`;
    expect(
      violacoesDa(agulha('os canais do anúncio 1573'), comArquivo(arquivo, copiado)).copias,
    ).toHaveLength(1);
  });

  it('a dobra da NF-e inlinada no gancho é achada', () => {
    const arquivo = 'lib/shopee/pedidos/arranjoAutomatico.ts';
    const copiado = `${fonteReal(arquivo)}\nexport const pendente = (row: { invoice_pending?: { status?: string } }): boolean =>\n  row.invoice_pending?.status?.trim().toLowerCase() === 'pending';\n`;
    expect(
      violacoesDa(agulha('invoice_pending'), comArquivo(arquivo, copiado)).copias,
    ).toHaveLength(2);
  });

  it('o FBS de volta no portão da NF-e (a cópia que Q4-2 tirou) é achado', () => {
    const arquivo = 'lib/shopee/nfe/notaNaShopee.ts';
    const copiado = `${fonteReal(arquivo)}\nconst FULFILLMENT_SHOPEE = 'fulfilled_by_shopee';\n`;
    expect(violacoesDa(agulha('fulfilled_by_shopee'), comArquivo(arquivo, copiado)).copias).toEqual(
      [`${arquivo}:${String(copiado.split(/\r?\n/).length - 1)}`],
    );
  });

  it('a leitura do arranjo por desestruturação é achada — a palavra, não só `.is_shipment_arranged`', () => {
    const arquivo = 'lib/shopee/avisos/despachoAutomatico.ts';
    const copiado = `${fonteReal(arquivo)}\nexport const lido = ({ is_shipment_arranged }: { is_shipment_arranged: boolean }): boolean => is_shipment_arranged;\n`;
    expect(
      violacoesDa(agulha('is_shipment_arranged'), comArquivo(arquivo, copiado)).copias,
    ).toHaveLength(1);
  });

  it('a casa que perde a dobra é uma casa MORTA; a isenção que perde a leitura também', () => {
    const semDobra = fonteReal(CASA).replace(/invoice_pending/g, 'campo_qualquer');
    expect(violacoesDa(agulha('invoice_pending'), comArquivo(CASA, semDobra))).toEqual({
      copias: [],
      mortos: [CASA],
    });
    const cli = 'lib/shopee/pedidos/rastrearPedidoCli.ts';
    const semLeitura = fonteReal(cli).replace(/is_shipment_arranged/g, 'outro_campo');
    expect(violacoesDa(agulha('is_shipment_arranged'), comArquivo(cli, semLeitura))).toEqual({
      copias: [],
      mortos: [cli],
    });
  });

  it('a isenção cobre só o SEU arquivo e só a SUA agulha', () => {
    const cli = 'lib/shopee/pedidos/rastrearPedidoCli.ts';
    const copiado = `${fonteReal(cli)}\nconst CANAL = 90026;\n`;
    expect(
      violacoesDa(agulha('os canais do anúncio 1573'), comArquivo(cli, copiado)).copias,
    ).toHaveLength(1);
  });
});

describe('semComentarios — o que é comentário e o que é código', () => {
  /** Whether the line `alvo` (1-based) of `texto`'s CODE names `invoice_pending`. */
  function nomeiaNoCodigo(texto: string, alvo = 1): boolean {
    const linha = semComentarios('sintetico.ts', texto).split(/\r?\n/)[alvo - 1] ?? '';
    return /invoice_pending/.test(linha);
  }

  it.each([
    ['uma leitura', 'const x = row.invoice_pending;'],
    ['depois de uma string com `//`', "const u = 'https://x/y'; const x = row.invoice_pending;"],
    [
      'depois de um regex com aspas e barras',
      'const r = /["\'\\/]/; const x = row.invoice_pending;',
    ],
    ['dentro de um template', 'const t = `a // ${row.invoice_pending} b`;'],
    ['numa string — o valor da dobra É código', "const campo = 'invoice_pending';"],
    ['depois de um bloco fechado na mesma linha', '/* nota */ const x = row.invoice_pending;'],
  ])('PAR — %s: casa', (_rotulo, texto) => {
    expect(nomeiaNoCodigo(texto)).toBe(true);
  });

  it.each([
    ['um comentário de linha', '// row.invoice_pending'],
    ['um comentário no fim da linha', 'const x = 1; // row.invoice_pending'],
    ['um bloco', '/* row.invoice_pending */ const x = 1;'],
    ['um JSDoc com URL', '/** see https://x and `row.invoice_pending` */ const x = 1;'],
  ])('QUASE-MISS — %s: não casa', (_rotulo, texto) => {
    expect(nomeiaNoCodigo(texto)).toBe(false);
  });

  it('um JSDoc de várias linhas some inteiro, e o número da linha é o do `git grep -n` (LF e CRLF)', () => {
    for (const quebra of ['\n', '\r\n']) {
      const texto = ['/**', ' * row.invoice_pending', ' */', 'const x = row.invoice_pending;'].join(
        quebra,
      );
      expect(nomeiaNoCodigo(texto, 2), JSON.stringify(quebra)).toBe(false);
      expect(nomeiaNoCodigo(texto, 4), JSON.stringify(quebra)).toBe(true);
      expect(achadosDa(agulha('invoice_pending'), new Map([['s.ts', texto]]))).toEqual([
        { arquivo: 's.ts', linha: 4 },
      ]);
    }
  });

  it('o canal casa como NÚMERO inteiro — near-miss: 900110, 9001 e 90013 não', () => {
    const canais = agulha('os canais do anúncio 1573');
    for (const linha of ['f(90011)', 'x === 90012', '[90026]']) {
      expect(achadosDa(canais, new Map([['s.ts', linha]])), linha).toHaveLength(1);
    }
    for (const linha of ['f(900110)', 'x === 9001', '[90013]', 'const id = 190026;']) {
      expect(achadosDa(canais, new Map([['s.ts', linha]])), linha).toEqual([]);
    }
  });
});
