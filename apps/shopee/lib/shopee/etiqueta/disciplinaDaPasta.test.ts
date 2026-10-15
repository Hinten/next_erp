/**
 * The discipline of the `etiqueta/` folder (#1523, step 15; review 1, R5-1 /
 * R5-2): the raw-text searches that keep the folder's module split honest, run
 * as a test in every `CI test`. The mechanics are `nfe/disciplinaDaPasta.test.ts`'s
 * — the same universe reader, exact exception sets, and a PAIR plus a
 * NEAR-MISS per rule.
 *
 * ## Why each rule exists
 *
 * 1. Importing `next/server` — only `respostaEtiqueta.ts`, the route's mapper.
 *    Step 15b's automatic arrange reaches this folder from the functions
 *    bundle, which must stay Next-free (the `validationIssues.ts` rule in
 *    `apps/shopee/CLAUDE.md`). A MENTION in prose is not an import and is not
 *    matched.
 * 2. A non-type import of `./respostaEtiqueta` — none. Rule 1 sees only the
 *    file that imports Next; this is the TRANSITIVE half: the runner once took
 *    its sentences from that module and loaded Next through it (R5-1).
 *    `import type` is erased and stays legal. Matched over the WHOLE file,
 *    because an import statement spans lines.
 * 3. `console.` — only `executarEtiqueta.ts`, whose log lines are the folder's
 *    only ones (and carry no order, package or tracking number). Everything
 *    else answers through its return value.
 * 4. `@delfrance/data`, `firebase-admin` and the app's firebase singleton —
 *    only `etiquetaCli.ts`, which reads the pedido for its dry run. Outside it
 *    only the route touches Firestore, which is what makes "the runner writes
 *    nothing" (R-o) structural rather than a promise.
 * 5–7. The five PURE modules — `faseEtiqueta.ts`, `modoDeEnvio.ts`,
 *    `motivosEtiqueta.ts`, `pendenteEtiqueta.ts`, `alvoEtiqueta.ts` — name no
 *    credential store, no listing module and no `.message`: the decisions
 *    once loaded the conta, credential and listing graph for a string table
 *    (R5-2), and a decision that reads a thrown sentence reads OUR prefix, not
 *    Shopee's words.
 * 8. …and none of them value-imports an IMPURE sibling (the classifier, the
 *    runner, the arrange, the mapper, the CLI). Rules 5–7 see only the pure
 *    module's own text; R5-2 was TRANSITIVE — the decisions named no credential
 *    store, they imported the classifier, which does. `import type` stays legal.
 *
 * ## The shape is `git grep`'s, on purpose
 *
 * The universe is every file under the folder, recursive, minus `*.test.ts` and
 * `*.md`, read from disk. Rules match LINE BY LINE, comments included — a
 * prohibition is written without spelling the forbidden name — except rules 2
 * and 8, which match the whole file (an import statement spans lines) and
 * report the line the statement starts on.
 * A rule with an exception demands the EXACT set of files: an exception that
 * stops matching points at nothing, and fails too.
 *
 * ⚠️ This file is a `*.test.ts`, so it sits outside its own universe and may
 * spell every pattern.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The folder examined. */
const RAIZ_ETIQUETA = new URL('./', import.meta.url);

/** The five pure modules rules 5–8 look at. */
const PUROS: readonly string[] = [
  'faseEtiqueta.ts',
  'modoDeEnvio.ts',
  'motivosEtiqueta.ts',
  'pendenteEtiqueta.ts',
  'alvoEtiqueta.ts',
];

/** One raw-text search, with its scope and its EXACT exceptions. */
interface Regra {
  readonly id: number;
  readonly descricao: string;
  /** Never with the `g` flag (`test` keeps state with it); rules 2 and 8 carry `m`. */
  readonly padrao: RegExp;
  /** `linha` = each LINE, like `git grep`; `arquivo` = the whole text. */
  readonly escopo: 'linha' | 'arquivo';
  /** `null` = the whole folder; else ONLY these files are examined. */
  readonly soNosArquivos: readonly string[] | null;
  /** The files that MUST match — exactly these, no other. Empty = none matches. */
  readonly exatamente: readonly string[];
}

/** The eight rules (see the module docblock for why each exists). */
const REGRAS: readonly Regra[] = [
  {
    id: 1,
    descricao: 'importar next/server — só o mapeador da rota',
    padrao: /from\s+['"]next\/server['"]|import\(\s*['"]next\/server['"]\s*\)/,
    escopo: 'linha',
    soNosArquivos: null,
    exatamente: ['respostaEtiqueta.ts'],
  },
  {
    id: 2,
    descricao: 'importar ./respostaEtiqueta por VALOR — ninguém (import type é livre)',
    padrao:
      /^[ \t]*(?:import|export)(?![ \t]+type\b)[^;]*?\bfrom[ \t]+['"]\.\/respostaEtiqueta['"]|^[ \t]*import[ \t]+['"]\.\/respostaEtiqueta['"]|\bimport\([ \t]*['"]\.\/respostaEtiqueta['"]/m,
    escopo: 'arquivo',
    soNosArquivos: null,
    exatamente: [],
  },
  {
    id: 3,
    descricao: 'console — só o runner',
    padrao: /\bconsole\./,
    escopo: 'linha',
    soNosArquivos: null,
    exatamente: ['executarEtiqueta.ts'],
  },
  {
    id: 4,
    descricao: 'o Firestore e o firebase-admin — só a CLI',
    padrao: /@delfrance\/data\b|firebase-admin|(?:@\/lib|\.\.)\/firebase\b/,
    escopo: 'linha',
    soNosArquivos: null,
    exatamente: ['etiquetaCli.ts'],
  },
  {
    id: 5,
    descricao: 'o cofre de credenciais nos módulos puros',
    padrao: /core\/tokenStore/,
    escopo: 'linha',
    soNosArquivos: PUROS,
    exatamente: [],
  },
  {
    id: 6,
    descricao: 'a pasta de anúncios nos módulos puros',
    padrao: /\banuncios\//,
    escopo: 'linha',
    soNosArquivos: PUROS,
    exatamente: [],
  },
  {
    id: 7,
    descricao: 'a frase montada de um erro (`.message`) nos módulos puros',
    padrao: /\.message\b/,
    escopo: 'linha',
    soNosArquivos: PUROS,
    exatamente: [],
  },
  {
    id: 8,
    descricao: 'um irmão IMPURO importado por valor nos módulos puros',
    padrao:
      /^[ \t]*(?:import|export)(?![ \t]+type\b)[^;]*?\bfrom[ \t]+['"]\.\/(?:errosEtiqueta|executarEtiqueta|programarPacote|respostaEtiqueta|etiquetaCli)['"]/m,
    escopo: 'arquivo',
    soNosArquivos: PUROS,
    exatamente: [],
  },
];

/**
 * The universe: every file under the folder, recursive, minus `*.test.ts` and
 * `*.md`, named relative to the folder (`/` as the separator).
 */
function fontesDaPasta(dir: URL = RAIZ_ETIQUETA, prefixo = ''): Map<string, string> {
  const fontes = new Map<string, string>();
  for (const nome of readdirSync(dir)) {
    const url = new URL(nome, dir);
    if (statSync(url).isDirectory()) {
      for (const [sub, texto] of fontesDaPasta(new URL(`${nome}/`, dir), `${prefixo}${nome}/`)) {
        fontes.set(sub, texto);
      }
      continue;
    }
    if (nome.endsWith('.test.ts') || nome.endsWith('.md')) continue;
    fontes.set(`${prefixo}${nome}`, readFileSync(url, 'utf8'));
  }
  return fontes;
}

/** One finding, in `git grep -n`'s shape. */
interface Achado {
  readonly arquivo: string;
  readonly linha: number;
}

/**
 * Where the rule matches — the sources come in as a parameter so the rule's
 * own tests can feed it synthetic text.
 */
function achadosDa(regra: Regra, fontes: ReadonlyMap<string, string>): Achado[] {
  const achados: Achado[] = [];
  for (const [arquivo, texto] of fontes) {
    if (regra.soNosArquivos !== null && !regra.soNosArquivos.includes(arquivo)) continue;
    if (regra.escopo === 'linha') {
      texto.split(/\r?\n/).forEach((linha, i) => {
        if (regra.padrao.test(linha)) achados.push({ arquivo, linha: i + 1 });
      });
      continue;
    }
    // A LOCAL global copy: the rule's own regex never carries `g`.
    const todos = new RegExp(regra.padrao.source, `${regra.padrao.flags}g`);
    for (const m of texto.matchAll(todos)) {
      const antes = texto.slice(0, m.index);
      achados.push({ arquivo, linha: antes.split('\n').length });
    }
  }
  return achados;
}

/** A rule's verdict: the files that matched OUTSIDE the exception, and the exceptions that did not match. */
function violacoesDa(
  regra: Regra,
  fontes: ReadonlyMap<string, string>,
): { readonly proibidos: string[]; readonly excecoesMortas: string[] } {
  const achados = achadosDa(regra, fontes);
  const casaram = new Set(achados.map((a) => a.arquivo));
  return {
    proibidos: achados
      .filter((a) => !regra.exatamente.includes(a.arquivo))
      .map((a) => `${a.arquivo}:${String(a.linha)}`),
    excecoesMortas: regra.exatamente.filter((arquivo) => !casaram.has(arquivo)),
  };
}

describe('o universo: a pasta, lida do disco', () => {
  it('a pasta foi lida, os testes e o README ficaram fora, e os arquivos das regras estão nela', () => {
    // Without this anchor an empty universe would pass every rule below.
    const fontes = fontesDaPasta();
    expect(fontes.size).toBeGreaterThanOrEqual(11);
    for (const nome of [
      'respostaEtiqueta.ts',
      'executarEtiqueta.ts',
      'etiquetaCli.ts',
      'errosEtiqueta.ts',
      ...PUROS,
    ]) {
      expect(fontes.has(nome), nome).toBe(true);
    }
    expect([...fontes.keys()].filter((n) => n.endsWith('.test.ts') || n.endsWith('.md'))).toEqual(
      [],
    );
  });

  it('as regras são as OITO, numeradas em ordem, e todo arquivo com escopo próprio existe', () => {
    expect(REGRAS.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const fontes = fontesDaPasta();
    for (const regra of REGRAS) {
      // The `g` flag would make `test` remember the last position and skip lines.
      expect(regra.padrao.global, `regra ${String(regra.id)}`).toBe(false);
      for (const arquivo of regra.soNosArquivos ?? []) {
        expect(fontes.has(arquivo), `regra ${String(regra.id)}: ${arquivo}`).toBe(true);
      }
    }
    // The pinned exceptions — changing one is a review decision, not a tweak.
    expect(
      REGRAS.filter((r) => r.exatamente.length > 0).map(
        (r) => `${String(r.id)}: ${r.exatamente.join(',')}`,
      ),
    ).toEqual(['1: respostaEtiqueta.ts', '3: executarEtiqueta.ts', '4: etiquetaCli.ts']);
  });
});

describe('as oito buscas sobre a pasta de verdade', () => {
  it.each(REGRAS.map((r) => [r.id, r.descricao, r] as const))(
    'regra %i — %s: casa EXATAMENTE onde a exceção diz (ou em lugar nenhum)',
    (_id, _descricao, regra) => {
      const { proibidos, excecoesMortas } = violacoesDa(regra, fontesDaPasta());
      expect(proibidos, `regra ${String(regra.id)}: linhas que casam fora da exceção`).toEqual([]);
      expect(
        excecoesMortas,
        `regra ${String(regra.id)}: exceções que não casam mais — tire-as`,
      ).toEqual([]);
    },
  );
});

describe('as regras MORDEM: cada uma sobre um PAR que casa e um QUASE-MISS que não casa', () => {
  /** The rule of a number — fails loudly if it disappears. */
  function regra(id: number): Regra {
    const achada = REGRAS.find((r) => r.id === id);
    if (achada === undefined) throw new RangeError(`regra ${String(id)} inexistente`);
    return achada;
  }

  /** The synthetic file falls inside the rule's scope (its first scoped file, when it has any). */
  function casa(id: number, texto: string): boolean {
    const r = regra(id);
    const arquivo = r.soNosArquivos?.[0] ?? 'sintetico.ts';
    return achadosDa(r, new Map([[arquivo, texto]])).length > 0;
  }

  it.each([
    [
      1,
      "import { NextResponse } from 'next/server';",
      ' * loads neither the runner nor `next/server`.',
    ],
    [
      1,
      "const { NextResponse } = await import('next/server');",
      "import { x } from 'next-server-helpers';",
    ],
    [
      2,
      "import { respostaDaEtiqueta } from './respostaEtiqueta';",
      "import type { DesfechoNfe } from './respostaEtiqueta';",
    ],
    [
      2,
      "import {\n  MENSAGEM_DA_FASE,\n  type EtiquetaPendente,\n} from './respostaEtiqueta';",
      "import type {\n  EtiquetaPendente,\n  Progresso,\n} from './respostaEtiqueta';",
    ],
    [
      2,
      "export { respostaDaEtiqueta } from './respostaEtiqueta';",
      "export type { DesfechoNfe } from './respostaEtiqueta';",
    ],
    [
      2,
      "const m = await import('./respostaEtiqueta');",
      "import { MENSAGEM_DA_FASE } from './pendenteEtiqueta';",
    ],
    [
      2,
      "import { x } from './respostaEtiqueta';",
      " * the runner once took its sentences from './respostaEtiqueta' and loaded Next",
    ],
    [3, "console.warn('[shopee etiqueta] x', { bytes: 3 });", 'deps.log(linha);'],
    [
      4,
      "import { pedidoCollection } from '@delfrance/data/admin/collections';",
      "import { INTEGRACAO_FRETE } from '@delfrance/schemas';",
    ],
    [4, "import type { Firestore } from 'firebase-admin/firestore';", '// the Firebase console'],
    [
      4,
      "import { getAdminFirestore } from '@/lib/firebase/admin';",
      "import { x } from '@delfrance/database-tools';",
    ],
    [
      4,
      "import { getAdminFirestore } from '../../firebase/admin';",
      "import { y } from './firebaseless';",
    ],
    [
      5,
      "import { ShopeeRefreshEmAndamentoError } from '../core/tokenStore';",
      "import { readConta } from '../core/contaCache';",
    ],
    [
      5,
      "import { x } from '@/lib/shopee/core/tokenStore';",
      "import { x } from '../core/recusaShopee';",
    ],
    [
      6,
      "import { proximaViradaDaCotaMs } from '../anuncios/pausarAnuncio';",
      "import { x } from '../precos/anunciosPreco';",
    ],
    [7, 'const texto = err.message;', 'const texto = err.providerMessage;'],
    [
      8,
      // The pre-split line of `faseEtiqueta.ts` (R5-2) — the near-miss is its fix.
      "import { MOTIVO_ETIQUETA_SHOPEE, type MotivoEtiquetaShopee } from './errosEtiqueta';",
      "import { MOTIVO_ETIQUETA_SHOPEE, type MotivoEtiquetaShopee } from './motivosEtiqueta';",
    ],
    [
      8,
      "import {\n  programarPacoteShopee,\n} from './programarPacote';",
      "import type {\n  OperacaoEtiqueta,\n} from './errosEtiqueta';",
    ],
    [
      8,
      "import { executarEtiquetaShopee } from './executarEtiqueta';",
      "import type { ResultadoEtiqueta } from './executarEtiqueta';",
    ],
  ] as const)('regra %i — PAR `%s` casa; QUASE-MISS `%s` não casa', (id, par, quase) => {
    expect(casa(id, par)).toBe(true);
    expect(casa(id, quase)).toBe(false);
  });

  it('o ESCOPO: as regras dos módulos puros não olham os outros arquivos', () => {
    const linha = "import { ShopeeRefreshEmAndamentoError } from '../core/tokenStore';";
    expect(achadosDa(regra(5), new Map([['errosEtiqueta.ts', linha]]))).toEqual([]);
    for (const puro of PUROS) {
      expect(achadosDa(regra(5), new Map([[puro, linha]]))).toEqual([{ arquivo: puro, linha: 1 }]);
    }
    // Rule 8: the runner may import the classifier; a pure module may not.
    const classificador = "import { classificarErroDeEtiqueta } from './errosEtiqueta';";
    expect(achadosDa(regra(8), new Map([['executarEtiqueta.ts', classificador]]))).toEqual([]);
    expect(achadosDa(regra(8), new Map([['modoDeEnvio.ts', classificador]]))).toEqual([
      { arquivo: 'modoDeEnvio.ts', linha: 1 },
    ]);
  });

  it('a exceção cobre só o SEU arquivo, e a exceção MORTA é apontada', () => {
    const noMapeador = new Map([
      ['respostaEtiqueta.ts', "import { NextResponse } from 'next/server';"],
    ]);
    expect(violacoesDa(regra(1), noMapeador)).toEqual({ proibidos: [], excecoesMortas: [] });
    const noRunner = new Map([
      ['respostaEtiqueta.ts', "import { NextResponse } from 'next/server';"],
      ['executarEtiqueta.ts', "\nimport { NextResponse } from 'next/server';"],
    ]);
    expect(violacoesDa(regra(1), noRunner)).toEqual({
      proibidos: ['executarEtiqueta.ts:2'],
      excecoesMortas: [],
    });
    const semNext = new Map([['respostaEtiqueta.ts', 'const x = 1;']]);
    expect(violacoesDa(regra(1), semNext)).toEqual({
      proibidos: [],
      excecoesMortas: ['respostaEtiqueta.ts'],
    });
  });

  it('o número da linha é o do `git grep -n`, com CRLF ou LF — e na regra 2 é o INÍCIO da importação', () => {
    const crlf = new Map([['sintetico.ts', "a\r\nb\r\nconsole.info('x');\r\n"]]);
    const lf = new Map([['sintetico.ts', "a\nb\nconsole.info('x');\n"]]);
    expect(achadosDa(regra(3), crlf)).toEqual([{ arquivo: 'sintetico.ts', linha: 3 }]);
    expect(achadosDa(regra(3), lf)).toEqual([{ arquivo: 'sintetico.ts', linha: 3 }]);
    const multi =
      "import type { A } from './a';\r\n\r\nimport {\r\n  B,\r\n} from './respostaEtiqueta';\r\n";
    expect(achadosDa(regra(2), new Map([['sintetico.ts', multi]]))).toEqual([
      { arquivo: 'sintetico.ts', linha: 3 },
    ]);
  });
});
