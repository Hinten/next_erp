/**
 * #2015 — WHO may vouch for a stored `logistic_info`, pinned on the SOURCE.
 *
 * A stored list is re-sent only when THIS app wrote it, and the proof is the
 * stamp `logisticaGravadaEm`, written in the same patch as the list and read
 * through ONE predicate, `logisticaGravadaPeloErpShopee` (`@delfrance/schemas`).
 * The behaviour suites prove what each reader and each writer does TODAY; none
 * of them can see a SECOND way in — a reader that re-derives trust from the raw
 * field (`!= null` accepts a string stamp the predicate refuses), or another
 * writer that stamps a list it did not write (an ENSURE adoption, a draft
 * create). That is the #1369 drift the root CLAUDE.md names: a faithful second
 * copy is green until the day the one copy changes.
 *
 * ## What is pinned (everything over CODE, never a comment)
 *
 * 1. **No raw read.** Outside a test, `logisticaGravadaEm` appears only as the
 *    KEY of an object-literal property — a write. Any other occurrence is a
 *    read (a type member included: only `@delfrance/schemas` declares the
 *    field).
 * 2. **Exactly five writers**, in four files, each beside the list it vouches
 *    for: the stamp's object literal also holds `logistic_info`. So a stamp
 *    moved next to the unconditional `ultimaPublicacao` reds here too — and so
 *    does the draft edit's stamp (#1911 P15) moved out of its list's literal
 *    into the caller's spread.
 * 3. **Where trust reaches `construirLogistica`.** Every `armazenadoConfiavel:`
 *    in code is in `planoPublicacao.ts` (its value reads the projection's
 *    `.logisticaConfiavel`) or in `planoKit.ts` (its value calls the
 *    predicate); `logisticaConfiavel:` is assigned only in `publicarAnuncio.ts`,
 *    to the predicate's call itself. Hoisting either call into a `const` moves
 *    this pin, deliberately: it is the review that says where trust comes from.
 * 4. **One predicate.** `publicarAnuncio.ts` and `planoKit.ts` call it; every
 *    import of the name comes from `@delfrance/schemas`, and nothing in the app
 *    declares one of its own.
 *
 * ## Why the TypeScript parser, and not a line regex
 *
 * The brief's needle, `/\.logisticaGravadaEm\b|\[['"]logisticaGravadaEm['"]\]/`,
 * sees `raw.logisticaGravadaEm` and `raw['logisticaGravadaEm']` but not
 * `const { logisticaGravadaEm } = raw`, `'logisticaGravadaEm' in raw` or
 * `snap.get('logisticaGravadaEm')` — three raw reads — and no key-colon regex
 * can tell the write `{ logisticaGravadaEm: v }` from the destructuring read
 * `({ logisticaGravadaEm: v } = raw)`. On raw TEXT it would also red on the
 * docblocks every writer uses to explain its stamp. The parser sees code only
 * and classifies each occurrence by its PARENT node; the table under
 * "o classificador" pins every form above, the brief's three included.
 * (`etiqueta/umaSoCopia.test.ts` is the precedent for parsing the app.)
 *
 * ⚠️ A shorthand `{ logisticaGravadaEm }` counts as a READ: it needs a local of
 * that name, and the declaration of that local is itself a read of the name.
 * Write the stamp as `logisticaGravadaEm: <ms>` beside the list.
 *
 * ## The universe
 *
 * Every `.ts` / `.tsx` under `apps/shopee/{lib,app,functions/src,scripts}`,
 * minus `*.test.ts` — a superset of `lib/**`: a route, a script or the
 * functions codebase (the mass import's) would otherwise sit outside. The
 * fixtures and the in-memory doubles are non-test files and stay IN.
 * `apps/web` is outside on purpose: a cross-workspace read here would be
 * cached by turbo against a hash that never sees a web-only change.
 *
 * ⚠️ This file is a `*.test.ts`, so it sits outside its own universe and may
 * spell every form it forbids.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** `apps/shopee/` — every path below is relative to it, `/` as the separator. */
const RAIZ_DO_APP = new URL('../../../', import.meta.url);

/** The roots of the universe. */
const RAIZES: readonly string[] = ['lib/', 'app/', 'functions/src/', 'scripts/'];

/** The stamp. */
const CAMPO = 'logisticaGravadaEm';
/** The ONE reading of it (`@delfrance/schemas`, `shopeeLinkLeitura.ts`). */
const PREDICADO = 'logisticaGravadaPeloErpShopee';
/** Where {@link PREDICADO} must be imported from. */
const MODULO_DO_PREDICADO = '@delfrance/schemas';
/** The list the stamp vouches for — its sibling in every write. */
const LISTA = 'logistic_info';

const PUBLICAR = 'lib/shopee/anuncios/publicarAnuncio.ts';
const PLANO_ITEM = 'lib/shopee/anuncios/planoPublicacao.ts';
const PLANO_KIT = 'lib/shopee/kits/planoKit.ts';
const MAPEAMENTO = 'lib/shopee/produtos/mapeamento.ts';
const VINCULOS_KIT = 'lib/shopee/kits/vinculosKit.ts';
const RASCUNHO = 'lib/shopee/anuncios/rascunho.ts';

/**
 * The writers, by file, and how many writes each holds — write-back #1 and #2
 * in `publicarAnuncio.ts`, the import builder, the kit create, and the draft
 * edit (`atualizarRascunhoShopee`'s `escritaDoCampo`, #1911 P15: the list the
 * operator chose, or `null`, stamped in the same literal). A change here is a
 * review decision: the stamp must keep meaning "a list this app produced,
 * Shopee answered, or the operator chose on a draft".
 */
const ESCRITORES: Readonly<Record<string, number>> = {
  [PUBLICAR]: 2,
  [MAPEAMENTO]: 1,
  [VINCULOS_KIT]: 1,
  [RASCUNHO]: 1,
};

/* -------------------------------------------------------------------------- */
/*                               the machinery                                 */
/* -------------------------------------------------------------------------- */

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

function analisarFonte(arquivo: string, texto: string): ts.SourceFile {
  return ts.createSourceFile(
    arquivo,
    texto,
    ts.ScriptTarget.Latest,
    true,
    arquivo.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** `(x)` → `x`, any depth. */
function semParenteses(no: ts.Node): ts.Node {
  let atual = no;
  while (ts.isParenthesizedExpression(atual)) atual = atual.expression;
  return atual;
}

/**
 * Is this object literal the TARGET of a destructuring assignment —
 * `({ a } = x)`, `[{ a }] = xs`, `for ({ a } of xs)` — at any nesting? There
 * its keys READ the right-hand side.
 */
function ehAlvoDeDesestruturacao(objeto: ts.ObjectLiteralExpression): boolean {
  let atual: ts.Node = objeto;
  for (;;) {
    const pai = atual.parent;
    if (ts.isParenthesizedExpression(pai) || ts.isArrayLiteralExpression(pai)) {
      atual = pai;
      continue;
    }
    if (
      (ts.isPropertyAssignment(pai) && pai.initializer === atual) ||
      ts.isSpreadAssignment(pai) ||
      ts.isSpreadElement(pai)
    ) {
      atual = pai.parent;
      continue;
    }
    if (ts.isBinaryExpression(pai)) {
      return pai.operatorToken.kind === ts.SyntaxKind.EqualsToken && pai.left === atual;
    }
    if (ts.isForOfStatement(pai) || ts.isForInStatement(pai)) return pai.initializer === atual;
    return false;
  }
}

/**
 * The object-literal property whose KEY `nome` is — `nome` an identifier, a
 * string literal or a computed `['…']` — or `null` when `nome` is not such a
 * key (or the literal is a destructuring target, where the key reads).
 */
function propriedadeEscritaPor(nome: ts.Node): ts.PropertyAssignment | null {
  const chave = ts.isComputedPropertyName(nome.parent) ? nome.parent : nome;
  const propriedade = chave.parent;
  if (!ts.isPropertyAssignment(propriedade) || propriedade.name !== chave) return null;
  return ehAlvoDeDesestruturacao(propriedade.parent) ? null : propriedade;
}

/** The text an identifier or a plain string names, or `null`. */
function textoDoNome(no: ts.Node): string | null {
  if (ts.isIdentifier(no) || ts.isStringLiteral(no) || ts.isNoSubstitutionTemplateLiteral(no)) {
    return no.text;
  }
  return null;
}

/** The KEY text of a property assignment, when it is a plain name. */
function chaveDe(propriedade: ts.ObjectLiteralElementLike): string | null {
  if (!ts.isPropertyAssignment(propriedade) && !ts.isShorthandPropertyAssignment(propriedade)) {
    return null;
  }
  const nome = propriedade.name;
  if (ts.isComputedPropertyName(nome)) return textoDoNome(nome.expression);
  return textoDoNome(nome);
}

/** Does `no`'s subtree hold a call to {@link PREDICADO}? */
function chamaOPredicado(no: ts.Node): boolean {
  let achou = false;
  const visitar = (n: ts.Node): void => {
    if (achou) return;
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === PREDICADO
    ) {
      achou = true;
      return;
    }
    ts.forEachChild(n, visitar);
  };
  visitar(no);
  return achou;
}

/** Does `no`'s subtree READ the projection's `.logisticaConfiavel`? */
function leAProjecao(no: ts.Node): boolean {
  let achou = false;
  const visitar = (n: ts.Node): void => {
    if (achou) return;
    if (ts.isPropertyAccessExpression(n) && n.name.text === 'logisticaConfiavel') {
      achou = true;
      return;
    }
    ts.forEachChild(n, visitar);
  };
  visitar(no);
  return achou;
}

/** Where the value of a trust property comes from. */
type Origem = 'predicado' | 'projecao' | 'outra';

function origemDe(valor: ts.Expression): Origem {
  if (chamaOPredicado(valor)) return 'predicado';
  return leAProjecao(valor) ? 'projecao' : 'outra';
}

/** Everything this file asserts, over one universe (the real one, or a COPY). */
interface Analise {
  /** `arquivo` → how many writes of the stamp it holds. */
  readonly escritas: Readonly<Record<string, number>>;
  /** Every other occurrence of the name in code, as `arquivo:linha`. */
  readonly leituras: readonly string[];
  /** Writes whose object literal holds no {@link LISTA} beside the stamp, as `arquivo:linha`. */
  readonly escritasSemALista: readonly string[];
  /** The files that call {@link PREDICADO}, sorted. */
  readonly chamadores: readonly string[];
  /** Imports of {@link PREDICADO} from anywhere else, and local declarations of it, as `arquivo:linha`. */
  readonly predicadoForaDeLugar: readonly string[];
  /** `arquivo` → the origin of each `armazenadoConfiavel:` value it passes. */
  readonly confiancaPassada: Readonly<Record<string, readonly Origem[]>>;
  /** `arquivo` → the origin of each `logisticaConfiavel:` value it assigns ('predicado' only when the value IS the call). */
  readonly projecaoAtribuida: Readonly<Record<string, readonly Origem[]>>;
}

function analisar(fontes: ReadonlyMap<string, string>): Analise {
  const escritas: Record<string, number> = {};
  const leituras: string[] = [];
  const escritasSemALista: string[] = [];
  const chamadores = new Set<string>();
  const predicadoForaDeLugar: string[] = [];
  const confiancaPassada: Record<string, Origem[]> = {};
  const projecaoAtribuida: Record<string, Origem[]> = {};

  for (const [arquivo, texto] of fontes) {
    const fonte = analisarFonte(arquivo, texto);
    const onde = (no: ts.Node): string =>
      `${arquivo}:${String(fonte.getLineAndCharacterOfPosition(no.getStart(fonte)).line + 1)}`;

    const visitar = (no: ts.Node): void => {
      // 1–2. The stamp: a write is an object-literal KEY; anything else reads.
      if (textoDoNome(no) === CAMPO) {
        const propriedade = propriedadeEscritaPor(no);
        if (propriedade === null) {
          leituras.push(onde(no));
        } else {
          escritas[arquivo] = (escritas[arquivo] ?? 0) + 1;
          if (!propriedade.parent.properties.some((p) => chaveDe(p) === LISTA)) {
            escritasSemALista.push(onde(no));
          }
        }
      }

      // 3. Where trust reaches `construirLogistica`, and how the projection is set.
      if (ts.isPropertyAssignment(no) && !ehAlvoDeDesestruturacao(no.parent)) {
        const chave = chaveDe(no);
        if (chave === 'armazenadoConfiavel') {
          (confiancaPassada[arquivo] ??= []).push(origemDe(no.initializer));
        }
        if (chave === 'logisticaConfiavel') {
          const valor = semParenteses(no.initializer);
          const ehAChamada =
            ts.isCallExpression(valor) &&
            ts.isIdentifier(valor.expression) &&
            valor.expression.text === PREDICADO;
          (projecaoAtribuida[arquivo] ??= []).push(
            ehAChamada
              ? 'predicado'
              : origemDe(no.initializer) === 'projecao'
                ? 'projecao'
                : 'outra',
          );
        }
      }

      // 4. One predicate: who calls it, where it comes from, and no local twin.
      if (ts.isCallExpression(no) && ts.isIdentifier(no.expression)) {
        if (no.expression.text === PREDICADO) chamadores.add(arquivo);
      }
      if (ts.isImportSpecifier(no)) {
        const importado = (no.propertyName ?? no.name).text;
        const local = no.name.text;
        const declaracao = no.parent.parent.parent;
        const modulo = ts.isStringLiteral(declaracao.moduleSpecifier)
          ? declaracao.moduleSpecifier.text
          : '';
        // From anywhere but the schemas, or ANOTHER export renamed to its name.
        if (
          (importado === PREDICADO && modulo !== MODULO_DO_PREDICADO) ||
          (local === PREDICADO && importado !== PREDICADO)
        ) {
          predicadoForaDeLugar.push(onde(no));
        }
      }
      if (
        (ts.isFunctionDeclaration(no) ||
          ts.isVariableDeclaration(no) ||
          ts.isMethodDeclaration(no)) &&
        no.name !== undefined &&
        textoDoNome(no.name) === PREDICADO
      ) {
        predicadoForaDeLugar.push(onde(no));
      }

      ts.forEachChild(no, visitar);
    };
    visitar(fonte);
  }

  return {
    escritas,
    leituras,
    escritasSemALista,
    chamadores: [...chamadores].sort(),
    predicadoForaDeLugar,
    confiancaPassada,
    projecaoAtribuida,
  };
}

/** The real universe, read once, and its analysis. */
const FONTES = fontesDoApp();
const REAL = analisar(FONTES);

/** The real text of a file of the universe. */
function fonteReal(arquivo: string): string {
  const texto = FONTES.get(arquivo);
  if (texto === undefined) throw new RangeError(`${arquivo} fora do universo`);
  return texto;
}

/**
 * The real universe with ONE file's text edited — a COPY; nothing on disk
 * changes. The edit must APPLY (the `de` text is in the file exactly once), or
 * the mutant would prove nothing.
 */
function comMutante(arquivo: string, de: string, para: string): Analise {
  const real = fonteReal(arquivo);
  expect(real.split(de), `${arquivo}: o trecho do mutante existe uma vez`).toHaveLength(2);
  return analisar(new Map([...FONTES, [arquivo, real.replace(de, para)]]));
}

/** One snippet, alone, as its own universe. */
function deTrecho(trecho: string): Analise {
  return analisar(new Map([['lib/trecho.ts', trecho]]));
}

/* -------------------------------------------------------------------------- */
/*                                   the pin                                   */
/* -------------------------------------------------------------------------- */

describe('o universo: o app inteiro, lido do disco', () => {
  it('as quatro raízes foram lidas, os testes ficaram fora, e os arquivos que importam estão nele', () => {
    // Without this anchor an empty universe would pass every pin below.
    expect(FONTES.size).toBeGreaterThanOrEqual(200);
    for (const raiz of RAIZES) {
      expect(
        [...FONTES.keys()].some((n) => n.startsWith(raiz)),
        raiz,
      ).toBe(true);
    }
    for (const arquivo of [
      PUBLICAR,
      PLANO_ITEM,
      PLANO_KIT,
      MAPEAMENTO,
      VINCULOS_KIT,
      'lib/shopee/anuncios/logisticaPublicacao.ts',
      'lib/shopee/anuncios/reservaRascunho.ts',
      'lib/shopee/anuncios/rascunho.ts',
      'lib/shopee/produtos/planoImportacao.ts',
      'functions/src/processMassImport.ts',
    ]) {
      expect(FONTES.has(arquivo), arquivo).toBe(true);
    }
    expect([...FONTES.keys()].filter((n) => n.endsWith('.test.ts'))).toEqual([]);
  });

  it('o parser vê só CÓDIGO: os docblocks dos escritores nomeiam o campo e não contam', () => {
    // Each writer explains its stamp in prose, write shape included…
    expect(fonteReal(PUBLICAR)).toContain(` * \`${CAMPO}: deps.nowMs\` is written`);
    expect(fonteReal(MAPEAMENTO)).toContain(`\`${CAMPO}: nowMs\` rides beside`);
    // …and the counts below are the code's alone: two in publicarAnuncio.ts, not five.
    expect(fonteReal(PUBLICAR).split(CAMPO).length - 1).toBeGreaterThan(2);
    expect(REAL.escritas[PUBLICAR]).toBe(2);
  });
});

describe('o classificador: escrita é só a CHAVE de um literal de objeto', () => {
  const ESCRITAS: readonly (readonly [string, string])[] = [
    ['o par na mesma chave', `const p = { ${LISTA}: l, ${CAMPO}: deps.nowMs };`],
    [
      'dentro do spread condicional',
      `const p = { ...(c ? {} : { ${LISTA}: l, ${CAMPO}: n }), ultimaPublicacao: u };`,
    ],
    ['chave entre aspas', `const p = { ${LISTA}: l, '${CAMPO}': n };`],
    ['chave computada', `const p = { ${LISTA}: l, ['${CAMPO}']: n };`],
  ];

  it.each(ESCRITAS)('ESCRITA — %s', (_nome, trecho) => {
    const a = deTrecho(trecho);
    expect(a.escritas).toEqual({ 'lib/trecho.ts': 1 });
    expect(a.leituras).toEqual([]);
    expect(a.escritasSemALista).toEqual([]);
  });

  /** `[name, snippet, does the brief's line regex see it?]` */
  const LEITURAS: readonly (readonly [string, string, boolean])[] = [
    ['acesso por ponto', `const ok = raw.${CAMPO} != null;`, true],
    ['acesso opcional', `const ok = raw?.${CAMPO} !== undefined;`, true],
    ['acesso por colchete', `const ok = raw['${CAMPO}'] != null;`, true],
    ['desestruturação curta', `const { ${CAMPO} } = raw;`, false],
    ['desestruturação renomeada', `const { ${CAMPO}: s } = raw;`, false],
    ['atribuição desestruturante', `let s; ({ ${CAMPO}: s } = raw);`, false],
    ['desestruturação aninhada', `let s; ({ a: { ${CAMPO}: s } } = raw);`, false],
    ['parâmetro desestruturado', `function f({ ${CAMPO} }: R): void {}`, false],
    ['o operador in', `const ok = '${CAMPO}' in raw;`, false],
    ['snap.get', `const v = snap.get('${CAMPO}');`, false],
    ['um where (varredura cobrada no Enterprise)', `q.where('${CAMPO}', '!=', null);`, false],
    ['um tipo local', `type T = { readonly ${CAMPO}?: number };`, false],
    ['shorthand num literal', `const p = { ${LISTA}: l, ${CAMPO} };`, false],
  ];

  it.each(LEITURAS)('LEITURA — %s', (_nome, trecho) => {
    const a = deTrecho(trecho);
    expect(a.leituras.length).toBeGreaterThanOrEqual(1);
    expect(a.escritas).toEqual({});
  });

  it('a regex do brief vê só as três primeiras formas — as outras são o porquê do parser', () => {
    const regexDoBrief = /\.logisticaGravadaEm\b|\[['"]logisticaGravadaEm['"]\]/;
    expect(LEITURAS.map(([, trecho]) => regexDoBrief.test(trecho))).toEqual(
      LEITURAS.map(([, , ve]) => ve),
    );
    // …and it would call the computed-key WRITE a read.
    const computada = ESCRITAS.find(([nome]) => nome === 'chave computada');
    expect(computada).toBeDefined();
    expect(regexDoBrief.test(computada?.[1] ?? '')).toBe(true);
  });

  it('near-miss: comentário, outro nome e outra string NÃO são ocorrências', () => {
    const a = deTrecho(
      [
        `// raw.${CAMPO} != null`,
        `/** { ${CAMPO}: deps.nowMs } */`,
        `const x = raw.${CAMPO}Antigo;`,
        `const s = '${CAMPO}X';`,
        `const t = \`${CAMPO} \${x}\`;`,
      ].join('\n'),
    );
    expect(a.leituras).toEqual([]);
    expect(a.escritas).toEqual({});
  });

  it('near-miss: um carimbo sem a lista no MESMO literal é escrita fora do lugar', () => {
    const a = deTrecho(
      `const p = { ...(c ? {} : { ${LISTA}: l }), ${CAMPO}: n, ultimaPublicacao: u };`,
    );
    expect(a.escritas).toEqual({ 'lib/trecho.ts': 1 });
    expect(a.escritasSemALista).toEqual(['lib/trecho.ts:1']);
    // The shorthand list counts as the sibling.
    expect(deTrecho(`const p = { ${LISTA}, ${CAMPO}: n };`).escritasSemALista).toEqual([]);
  });

  it('a origem da confiança: o predicado, a projeção, ou outra coisa', () => {
    const a = deTrecho(
      [
        `f({ armazenadoConfiavel: alvo !== null && ${PREDICADO}(alvo.raw) });`,
        `f({ armazenadoConfiavel: contexto.link?.logisticaConfiavel === true });`,
        `f({ armazenadoConfiavel: contexto.link !== null });`,
        `const l = { logisticaConfiavel: ${PREDICADO}(raw) };`,
        `const m = { logisticaConfiavel: (${PREDICADO}(raw)) };`,
        `const n = { logisticaConfiavel: ${PREDICADO}(raw) || raw.item_id != null };`,
        `const o = { logisticaConfiavel: true };`,
      ].join('\n'),
    );
    expect(a.confiancaPassada).toEqual({ 'lib/trecho.ts': ['predicado', 'projecao', 'outra'] });
    // The projection is the call ITSELF — wrapping it in an `||` is not.
    expect(a.projecaoAtribuida).toEqual({
      'lib/trecho.ts': ['predicado', 'predicado', 'outra', 'outra'],
    });
    expect(a.chamadores).toEqual(['lib/trecho.ts']);
  });

  it('o predicado: importado de outro lugar, ou declarado aqui, é achado', () => {
    expect(
      deTrecho(`import { ${PREDICADO} } from '${MODULO_DO_PREDICADO}';`).predicadoForaDeLugar,
    ).toEqual([]);
    expect(deTrecho(`import { ${PREDICADO} } from './copiaLocal';`).predicadoForaDeLugar).toEqual([
      'lib/trecho.ts:1',
    ]);
    // Another export wearing its name is an impostor, even from the schemas…
    expect(
      deTrecho(`import { outro as ${PREDICADO} } from '${MODULO_DO_PREDICADO}';`)
        .predicadoForaDeLugar,
    ).toEqual(['lib/trecho.ts:1']);
    // …while the real one under a local alias is still the one predicate.
    expect(
      deTrecho(`import { ${PREDICADO} as confia } from '${MODULO_DO_PREDICADO}';`)
        .predicadoForaDeLugar,
    ).toEqual([]);
    expect(
      deTrecho(`function ${PREDICADO}(l: { ${CAMPO}?: unknown }): boolean { return true; }`)
        .predicadoForaDeLugar,
    ).toEqual(['lib/trecho.ts:1']);
    expect(
      deTrecho(`const ${PREDICADO} = (l: unknown): boolean => l !== null;`).predicadoForaDeLugar,
    ).toEqual(['lib/trecho.ts:1']);
  });
});

describe('#2015 no código do app', () => {
  it('ninguém lê o carimbo cru — só o predicado de @delfrance/schemas o lê', () => {
    expect(REAL.leituras, `leia com ${PREDICADO}(raw), nunca o campo`).toEqual([]);
  });

  // #1911 P15 retitled this test (it was «exatamente QUATRO escritores, em três
  // arquivos, cada um no MESMO literal que a lista»): the draft edit is the fifth.
  it('exatamente CINCO escritores, em quatro arquivos, cada um no MESMO literal que a lista', () => {
    expect(REAL.escritas).toEqual(ESCRITORES);
    expect(REAL.escritasSemALista).toEqual([]);
  });

  it('a confiança chega a construirLogistica só pelo predicado (kit) ou pela projeção (item)', () => {
    expect(REAL.confiancaPassada).toEqual({
      [PLANO_ITEM]: ['projecao'],
      [PLANO_KIT]: ['predicado'],
    });
    // The projection is set in ONE place, to the predicate's call itself.
    expect(REAL.projecaoAtribuida).toEqual({ [PUBLICAR]: ['predicado'] });
  });

  it('UM predicado: os dois leitores o chamam, importado de @delfrance/schemas, sem cópia local', () => {
    expect(REAL.chamadores).toEqual(expect.arrayContaining([PUBLICAR, PLANO_KIT]));
    expect(REAL.predicadoForaDeLugar).toEqual([]);
  });
});

describe('o pin MORDE — sobre uma CÓPIA do universo, nada muda no disco', () => {
  it('o kit relê o carimbo cru (`!= null`) em vez do predicado', () => {
    const a = comMutante(
      PLANO_KIT,
      `armazenadoConfiavel: alvo !== null && ${PREDICADO}(alvo.raw),`,
      `armazenadoConfiavel: alvo !== null && alvo.raw.${CAMPO} != null,`,
    );
    expect(a.leituras).toHaveLength(1);
    expect(a.leituras[0]).toMatch(/^lib\/shopee\/kits\/planoKit\.ts:\d+$/);
    expect(a.confiancaPassada[PLANO_KIT]).toEqual(['outra']);
    expect(a.chamadores).not.toContain(PLANO_KIT);
  });

  it('o kit confia em qualquer alvo (`alvo !== null`)', () => {
    const a = comMutante(
      PLANO_KIT,
      `armazenadoConfiavel: alvo !== null && ${PREDICADO}(alvo.raw),`,
      'armazenadoConfiavel: alvo !== null,',
    );
    expect(a.confiancaPassada[PLANO_KIT]).toEqual(['outra']);
    expect(a.leituras).toEqual([]);
  });

  it('o item confia em qualquer vínculo (`contexto.link !== null`)', () => {
    const a = comMutante(
      PLANO_ITEM,
      'armazenadoConfiavel: contexto.link?.logisticaConfiavel === true,',
      'armazenadoConfiavel: contexto.link !== null,',
    );
    expect(a.confiancaPassada[PLANO_ITEM]).toEqual(['outra']);
  });

  it('a projeção fixa `logisticaConfiavel: true`', () => {
    const a = comMutante(
      PUBLICAR,
      `logisticaConfiavel: ${PREDICADO}(raw),`,
      'logisticaConfiavel: true,',
    );
    expect(a.projecaoAtribuida).toEqual({ [PUBLICAR]: ['outra'] });
  });

  it('o carimbo do write-back #1 sai do spread da lista e vai para junto de ultimaPublicacao', () => {
    const a = comMutante(
      PUBLICAR,
      `: { ${LISTA}: corpo.${LISTA}, ${CAMPO}: deps.nowMs }),`,
      `: { ${LISTA}: corpo.${LISTA} }),\n    ${CAMPO}: deps.nowMs,`,
    );
    // Same count — the move is caught by the sibling check alone.
    expect(a.escritas).toEqual(ESCRITORES);
    expect(a.escritasSemALista).toHaveLength(1);
    expect(a.escritasSemALista[0]).toMatch(/^lib\/shopee\/anuncios\/publicarAnuncio\.ts:\d+$/);
  });

  // #1911 P15 retitled this test (it was «um QUINTO escritor: a adoção do ENSURE
  // carimba uma lista que não escreveu»): the draft edit is the fifth now.
  it('um escritor A MAIS: a adoção do ENSURE carimba uma lista que não escreveu', () => {
    const arquivo = 'lib/shopee/anuncios/reservaRascunho.ts';
    const real = fonteReal(arquivo);
    const a = analisar(
      new Map([
        ...FONTES,
        [
          arquivo,
          `${real}\nexport const adocaoMutante = (n: number) => ({ item_id: 1, ${CAMPO}: n });\n`,
        ],
      ]),
    );
    expect(a.escritas).toEqual({ ...ESCRITORES, [arquivo]: 1 });
    // …and that stamp vouches for no list in its own literal.
    expect(a.escritasSemALista).toHaveLength(1);
  });

  it('o pin MORDE: o carimbo da edição do rascunho sai do literal da lista e vai para o spread do parseMerge', () => {
    // #1911 P15: the draft edit's ONE literal (`escritaDoCampo`'s logistics
    // arm) split in two — the list stays in the arm, the stamp moves into the
    // caller's `parseMerge({ ...escrita, … })`, which holds no list of its own.
    const real = fonteReal(RASCUNHO);
    const doBraco = `return { ${LISTA}: patch.${LISTA} ?? null, ${CAMPO}: nowMs };`;
    const doSpread = '...escrita,\n      ultimaModificacao: deps.nowMs,';
    for (const de of [doBraco, doSpread]) {
      expect(real.split(de), `o trecho do mutante existe uma vez: ${de}`).toHaveLength(2);
    }
    const mutante = new Map([
      ...FONTES,
      [
        RASCUNHO,
        real
          .replace(doBraco, `return { ${LISTA}: patch.${LISTA} ?? null };`)
          .replace(
            doSpread,
            `...escrita,\n      ${CAMPO}: deps.nowMs,\n      ultimaModificacao: deps.nowMs,`,
          ),
      ],
    ]);
    const a = analisar(mutante);
    // Same count — the move is caught by the sibling check alone…
    expect(a.escritas).toEqual(ESCRITORES);
    expect(a.escritasSemALista).toHaveLength(1);
    expect(a.escritasSemALista[0]).toMatch(/^lib\/shopee\/anuncios\/rascunho\.ts:\d+$/);
    // …and, from the other direction, the arm's list now rides with no stamp.
    expect(listasSemCarimbo(mutante)).toEqual({ ...LISTAS_SEM_CARIMBO, [RASCUNHO]: 1 });
  });

  it('o kit #2 carimba também (o arquivo passa de 1 para 2 escritas)', () => {
    const real = fonteReal(VINCULOS_KIT);
    const a = analisar(
      new Map([
        ...FONTES,
        [
          VINCULOS_KIT,
          `${real}\nexport const leituraMutante = (n: number) => ({ item_status: 'NORMAL', ${CAMPO}: n });\n`,
        ],
      ]),
    );
    expect(a.escritas[VINCULOS_KIT]).toBe(2);
  });

  it('uma cópia local do predicado, e um leitor que a chama, são achados', () => {
    const arquivo = 'lib/shopee/anuncios/linkAnuncio.ts';
    const a = analisar(
      new Map([
        ...FONTES,
        [
          arquivo,
          `${fonteReal(arquivo)}\nfunction ${PREDICADO}(l: { readonly ${CAMPO}?: unknown }): boolean {\n  return typeof l.${CAMPO} === 'number';\n}\n`,
        ],
      ]),
    );
    expect(a.predicadoForaDeLugar).toHaveLength(1);
    // The local copy's own body reads the field raw — and so does its parameter type.
    expect(a.leituras.length).toBeGreaterThanOrEqual(2);
  });
});

/* -------------------------------------------------------------------------- */
/*              the other direction: every literal holding the LIST            */
/* -------------------------------------------------------------------------- */

/**
 * `arquivo` → how many object literals hold a {@link LISTA} key with NO stamp
 * beside it. The pins above go stamp → list; this one goes list → stamp — the
 * other half of the schema header's ONE rule ("the ONE write of the list with
 * no stamp is the draft create's schema default"). Another WRITE of the list
 * with no stamp would leave an older stamp vouching for a list it never saw,
 * and nothing above would see it: it holds no stamp to count.
 */
function listasSemCarimbo(fontes: ReadonlyMap<string, string>): Record<string, number> {
  const contagem: Record<string, number> = {};
  for (const [arquivo, texto] of fontes) {
    const visitar = (no: ts.Node): void => {
      if (
        ts.isObjectLiteralExpression(no) &&
        !ehAlvoDeDesestruturacao(no) &&
        no.properties.some((p) => chaveDe(p) === LISTA) &&
        !no.properties.some((p) => chaveDe(p) === CAMPO)
      ) {
        contagem[arquivo] = (contagem[arquivo] ?? 0) + 1;
      }
      ts.forEachChild(no, visitar);
    };
    visitar(analisarFonte(arquivo, texto));
  }
  return contagem;
}

/**
 * Every literal that holds the list and no stamp — a reading or a REQUEST
 * body, never a write of the link. A change here is the same review decision
 * as {@link ESCRITORES}: a new entry must say why it is not a link write.
 */
const LISTAS_SEM_CARIMBO: Readonly<Record<string, number>> = {
  // `construirLogistica`'s result — what the planner hands the body builder.
  'lib/shopee/anuncios/logisticaPublicacao.ts': 1,
  // the `add_item` and `update_item` REQUEST bodies.
  'lib/shopee/anuncios/montagemAnuncio.ts': 2,
  // `linkListagemLido`, a READ projection of the raw link.
  [PUBLICAR]: 1,
  // the `add_kit_item` REQUEST body.
  [PLANO_KIT]: 1,
  // the `update_kit_item` REQUEST body (a republish writes no list back).
  'lib/shopee/kits/republicarKit.ts': 1,
  // the kit READ re-shaped into a base row, which `dadosLinkListagem` then stamps.
  'lib/shopee/produtos/kitShopee.ts': 1,
};

describe('a outra direção: todo literal com a LISTA tem o carimbo, ou é leitura / corpo de requisição', () => {
  // #1911 P15 retitled this test (it was «fora dos quatro escritores carimbados,
  // a lista só aparece nos literais nomeados»): the draft edit is the fifth.
  it('fora dos cinco escritores carimbados, a lista só aparece nos literais nomeados', () => {
    expect(listasSemCarimbo(FONTES)).toEqual(LISTAS_SEM_CARIMBO);
  });

  // #1911 P15 retitled this test (it was «o pin MORDE: um QUINTO escritor grava
  // a lista SEM o carimbo»): the draft edit is the fifth now.
  it('o pin MORDE: um escritor A MAIS grava a lista SEM o carimbo', () => {
    const arquivo = 'lib/shopee/anuncios/reservaRascunho.ts';
    const mutante = new Map([
      ...FONTES,
      [
        arquivo,
        `${fonteReal(arquivo)}\nexport const listaMutante = (l: unknown[]) => ({ ${LISTA}: l, ultimaModificacao: 1 });\n`,
      ],
    ]);
    expect(listasSemCarimbo(mutante)).toEqual({ ...LISTAS_SEM_CARIMBO, [arquivo]: 1 });
  });

  it('o pin MORDE: o carimbo do write-back #2 some e a lista fica sozinha', () => {
    const real = fonteReal(PUBLICAR);
    const de = `      logisticaGravadaEm: deps.nowMs,\n      kitNativo: ehKitDe(base),`;
    expect(real.split(de), 'o trecho do mutante existe uma vez').toHaveLength(2);
    const mutante = new Map([
      ...FONTES,
      [PUBLICAR, real.replace(de, '      kitNativo: ehKitDe(base),')],
    ]);
    expect(listasSemCarimbo(mutante)).toEqual({ ...LISTAS_SEM_CARIMBO, [PUBLICAR]: 2 });
  });

  it('o pin MORDE: a edição do rascunho perde o carimbo — a lista fica sozinha', () => {
    // #1911 P15: the draft edit writes the operator's list (or `null`) with no
    // stamp — an older stamp would then vouch for a list it never saw.
    const real = fonteReal(RASCUNHO);
    const de = `return { ${LISTA}: patch.${LISTA} ?? null, ${CAMPO}: nowMs };`;
    expect(real.split(de), 'o trecho do mutante existe uma vez').toHaveLength(2);
    const mutante = new Map([
      ...FONTES,
      [RASCUNHO, real.replace(de, `return { ${LISTA}: patch.${LISTA} ?? null };`)],
    ]);
    expect(listasSemCarimbo(mutante)).toEqual({ ...LISTAS_SEM_CARIMBO, [RASCUNHO]: 1 });
    // …and, from the other direction, the file is no writer any more.
    expect(analisar(mutante).escritas).toEqual(
      Object.fromEntries(Object.entries(ESCRITORES).filter(([arquivo]) => arquivo !== RASCUNHO)),
    );
  });

  it('near-miss: o carimbo no MESMO literal não conta, nem uma desestruturação; a lista sozinha conta', () => {
    const deTexto = (t: string): Record<string, number> =>
      listasSemCarimbo(new Map([['lib/trecho.ts', t]]));
    expect(deTexto(`const p = { ${LISTA}: l, ${CAMPO}: n };`)).toEqual({});
    expect(deTexto(`const { ${LISTA}: a } = raw; let b; ({ ${LISTA}: b } = raw);`)).toEqual({});
    expect(deTexto(`const p = { ${LISTA}: l };`)).toEqual({ 'lib/trecho.ts': 1 });
    expect(deTexto(`const p = { ${LISTA} };`)).toEqual({ 'lib/trecho.ts': 1 });
  });
});
