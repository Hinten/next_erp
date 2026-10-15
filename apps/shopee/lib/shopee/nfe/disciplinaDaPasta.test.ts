/**
 * A disciplina da pasta `nfe/` (#1522, passo 14): as dez buscas de texto cru
 * que o plano chama de `Gword14`, como um teste que roda em todo `CI test`.
 *
 * Até aqui elas eram um `git grep` no brief de cada onda — um portão que só
 * existe enquanto alguém lembra de rodá-lo. O passo 13 não tem um arquivo
 * equivalente para `precos/` (tem só a checagem de ambiente do
 * `constantesPreco.test.ts`, teste 19), então este não é um porte: é a lista do
 * brief, regra por regra, com as MESMAS exceções.
 *
 * ## Por que cada regra existe
 *
 * 1. `runTransaction` — só `carimboFreteNfe.ts` (a única transação da pasta,
 *    classe C no inventário `firestore-transaction-inventory.test.js`, que
 *    também lê texto cru).
 * 2. relógio, timers, `millisToMicros` e `next/server` — NENHUM. O relógio é
 *    PARÂMETRO (`deps.nowMs`); o bundle das functions alcança esta pasta e ela
 *    tem de continuar livre de Next (a regra do `validationIssues.ts` em
 *    `apps/shopee/CLAUDE.md`); e a pasta não é um sítio de conversão de µs.
 * 3. `coerceToMicros` — só `carimboFreteNfe.ts`, o quinto LEITOR de µs (coage o
 *    `ultimaModificacao` ARMAZENADO; não converte nada que recebe).
 * 4. `.collection(` — nenhum: todo acesso ao Firestore passa pelos handles de
 *    `@delfrance/data/admin/collections` (regra 3 do app).
 * 5. o ambiente — nenhum: a válvula da fila é lida pelo helper do canal, e o
 *    script do CLI (fora da pasta) é quem lê o resto.
 * 6. o canal logístico — nenhum: a NF-e nunca decide por transportadora (o
 *    `90003` é o id de um canal; chavear nele é o erro que a regra impede).
 * 7. `.message` em `classificarNfe.ts` — nenhum: as agulhas leem
 *    `providerMessage`, o texto da Shopee; `.message` é a NOSSA frase montada,
 *    e casar nela é casar no nosso próprio prefixo (mutante 29).
 * 8. as dobras compartilhadas — nenhuma: a pasta não compara valores com
 *    `normalizeLoose`/`deepEqual`/`stripNullsDeep`/`localizarDecimal`, e por
 *    isso não tem linha no `equivalence-fold-inventory.test.js`.
 * 9. `access_key` — só `notaNaShopee.ts`, o ÚNICO leitor da chave que a Shopee
 *    devolve (a chave é PII: um segundo leitor é um segundo lugar por onde ela
 *    vaza).
 * 10. o nome do outro canal em `errosNfe.ts` — nenhum: as frases ao operador
 *    descrevem o mecanismo DESTA integração (mutante 41).
 *
 * ## A forma é a do `git grep`, de propósito
 *
 * O universo é o pathspec do brief — `nfe/*` sem `*.test.ts` e sem `*.md`,
 * RECURSIVO (no pathspec do git o `*` atravessa `/`) — lido do disco, o que é
 * um pouco MAIS estrito que o `git grep` (que não vê um arquivo não rastreado).
 * Cada regra casa LINHA A LINHA, comentários incluídos: uma proibição se
 * escreve sem soletrar o nome proibido. As regras com exceção (1, 3, 9) exigem
 * o conjunto EXATO de arquivos — a exceção que deixa de casar é uma exceção
 * apontando para o nada, e cai também.
 *
 * ⚠️ Este arquivo é `*.test.ts` e por isso fica fora do próprio universo e dos
 * dois inventários do repositório — ele pode soletrar cada padrão.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** A pasta examinada. */
const RAIZ_NFE = new URL('./', import.meta.url);

/** Uma busca de texto cru, com o seu escopo e as exceções EXATAS. */
interface Regra {
  /** O número da busca no brief (`Gword14`). */
  readonly id: number;
  readonly descricao: string;
  /** Aplicado a cada LINHA, como o `git grep`. Sem a flag `g` (o `test` guarda estado com ela). */
  readonly padrao: RegExp;
  /** `null` = a pasta inteira; senão, o ÚNICO arquivo examinado. */
  readonly soNoArquivo: string | null;
  /** Os arquivos que DEVEM casar — exatamente estes, nenhum outro. Vazio = nenhum casa. */
  readonly exatamente: readonly string[];
}

/** As dez regras do brief, na ordem e com os padrões dele. */
const REGRAS: readonly Regra[] = [
  {
    id: 1,
    descricao: 'a transação — só o carimbo',
    padrao: /runTransaction/,
    soNoArquivo: null,
    exatamente: ['carimboFreteNfe.ts'],
  },
  {
    id: 2,
    descricao: 'relógio, timers, a conversão ms→µs e o Next',
    padrao:
      /Date\.now\(|new Date\(\)|setTimeout\(|setInterval\(|millisToMicros|from 'next\/server'/,
    soNoArquivo: null,
    exatamente: [],
  },
  {
    id: 3,
    descricao: 'a coerção tolerante de µs — só o carimbo',
    padrao: /coerceToMicros/,
    soNoArquivo: null,
    exatamente: ['carimboFreteNfe.ts'],
  },
  {
    id: 4,
    descricao: 'coleção crua do Firestore',
    padrao: /\.collection\(/,
    soNoArquivo: null,
    exatamente: [],
  },
  {
    id: 5,
    descricao: 'leitura do ambiente',
    padrao: /process\.env/,
    soNoArquivo: null,
    exatamente: [],
  },
  {
    id: 6,
    descricao: 'chavear num canal logístico',
    padrao: /logistic_id|logistics_channel_id|90003/,
    soNoArquivo: null,
    exatamente: [],
  },
  {
    id: 7,
    descricao: 'as agulhas do classificador leem `providerMessage`, nunca `.message`',
    padrao: /\.message\b/,
    soNoArquivo: 'classificarNfe.ts',
    exatamente: [],
  },
  {
    id: 8,
    descricao: 'as dobras compartilhadas',
    padrao: /\b(normalizeLoose|deepEqual|stripNullsDeep|localizarDecimal)\b/,
    soNoArquivo: null,
    exatamente: [],
  },
  {
    id: 9,
    descricao: 'o campo da chave devolvida — só o leitor dela',
    padrao: /access_key/,
    soNoArquivo: null,
    exatamente: ['notaNaShopee.ts'],
  },
  {
    id: 10,
    descricao: 'o nome do outro canal nas frases ao operador',
    padrao: /mercado livre/i,
    soNoArquivo: 'errosNfe.ts',
    exatamente: [],
  },
];

/**
 * O universo do brief: todo arquivo sob a pasta, recursivo, menos `*.test.ts`
 * e `*.md`, com o nome relativo à pasta (`/` como separador).
 */
function fontesDaPasta(dir: URL = RAIZ_NFE, prefixo = ''): Map<string, string> {
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

/** Um achado, na forma do `git grep -n`. */
interface Achado {
  readonly arquivo: string;
  readonly linha: number;
}

/**
 * Onde a regra casa, linha a linha — recebe as fontes por parâmetro para que o
 * teste da própria regra possa alimentá-la com texto sintético.
 */
function achadosDa(regra: Regra, fontes: ReadonlyMap<string, string>): Achado[] {
  const achados: Achado[] = [];
  for (const [arquivo, texto] of fontes) {
    if (regra.soNoArquivo !== null && arquivo !== regra.soNoArquivo) continue;
    texto.split(/\r?\n/).forEach((linha, i) => {
      if (regra.padrao.test(linha)) achados.push({ arquivo, linha: i + 1 });
    });
  }
  return achados;
}

/** O veredito de uma regra: os arquivos que casaram FORA da exceção, e as exceções que não casaram. */
function violacoesDa(
  regra: Regra,
  fontes: ReadonlyMap<string, string>,
): { readonly proibidos: string[]; readonly excecoesMortas: string[] } {
  const achados = achadosDa(regra, fontes);
  const casaram = new Set(achados.map((a) => a.arquivo));
  return {
    proibidos: achados
      .filter((a) => !regra.exatamente.includes(a.arquivo))
      .map((a) => `${a.arquivo}:${a.linha}`),
    excecoesMortas: regra.exatamente.filter((arquivo) => !casaram.has(arquivo)),
  };
}

describe('o universo: o pathspec do brief, lido do disco', () => {
  it('a pasta foi lida, os testes e o README ficaram fora, e os arquivos das exceções estão nela', () => {
    // Sem esta âncora, um universo vazio passaria em todas as regras abaixo.
    const fontes = fontesDaPasta();
    expect(fontes.size).toBeGreaterThanOrEqual(12);
    for (const nome of [
      'errosNfe.ts',
      'classificarNfe.ts',
      'carimboFreteNfe.ts',
      'notaNaShopee.ts',
      'processarNfe.ts',
    ]) {
      expect(fontes.has(nome), nome).toBe(true);
    }
    expect([...fontes.keys()].filter((n) => n.endsWith('.test.ts') || n.endsWith('.md'))).toEqual(
      [],
    );
  });

  it('as regras são as DEZ do brief, numeradas em ordem, e todo arquivo com escopo próprio existe', () => {
    expect(REGRAS.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const fontes = fontesDaPasta();
    for (const regra of REGRAS) {
      // A flag `g` faria `test` lembrar a última posição e pular linhas.
      expect(regra.padrao.global, `regra ${regra.id}`).toBe(false);
      if (regra.soNoArquivo !== null) {
        expect(fontes.has(regra.soNoArquivo), `regra ${regra.id}: ${regra.soNoArquivo}`).toBe(true);
      }
    }
    // As exceções fixadas — mudar uma é uma decisão de revisão, não um ajuste.
    expect(
      REGRAS.filter((r) => r.exatamente.length > 0).map(
        (r) => `${r.id}: ${r.exatamente.join(',')}`,
      ),
    ).toEqual(['1: carimboFreteNfe.ts', '3: carimboFreteNfe.ts', '9: notaNaShopee.ts']);
  });
});

describe('as dez buscas sobre a pasta de verdade', () => {
  it.each(REGRAS.map((r) => [r.id, r.descricao, r] as const))(
    'regra %i — %s: casa EXATAMENTE onde a exceção diz (ou em lugar nenhum)',
    (_id, _descricao, regra) => {
      const { proibidos, excecoesMortas } = violacoesDa(regra, fontesDaPasta());
      expect(proibidos, `regra ${regra.id}: linhas que casam fora da exceção`).toEqual([]);
      expect(
        excecoesMortas,
        `regra ${regra.id}: exceções que não casam mais — tire-as (e o inventário que as cita)`,
      ).toEqual([]);
    },
  );
});

describe('as regras MORDEM: cada uma sobre um PAR que casa e um QUASE-MISS que não casa', () => {
  /** A regra de um número — falha alto se ele sumir. */
  function regra(id: number): Regra {
    const achada = REGRAS.find((r) => r.id === id);
    if (achada === undefined) throw new RangeError(`regra ${id} inexistente`);
    return achada;
  }

  /** O arquivo sintético cai no escopo da regra (o seu arquivo único, se ela tiver). */
  function casa(id: number, linha: string): boolean {
    const r = regra(id);
    const arquivo = r.soNoArquivo ?? 'sintetico.ts';
    return achadosDa(r, new Map([[arquivo, linha]])).length > 0;
  }

  it.each([
    [1, 'await db.runTransaction(async (tx) => {', 'const transacao = abrir(tx);'],
    [2, 'const agora = Date.now();', 'const agora = deps.nowMs;'],
    [2, 'const agora = new Date();', 'const data = new Date(deps.nowMs);'],
    [2, 'setTimeout(resolver, 10);', 'deps.esperar(10);'],
    [2, "import { NextResponse } from 'next/server';", "import { x } from 'next-server-helpers';"],
    [2, 'const us = millisToMicros(nowMs);', 'const us = agoraUsDe({ nowMs });'],
    [3, 'coerceToMicros(raw.ultimaModificacao)', 'coerceToMillis(nfe.data_autorizacao)'],
    [4, "db.collection('pedidos')", 'nfev4Collection.docRef(db, { pedidoId }, nfeId)'],
    [5, "process.env['SHOPEE_TASKS_DISABLED']", 'shopeeTasksDesabilitado()'],
    [6, 'if (linha.logistics_channel_id === x)', 'if (linha.fulfillment_flag === x)'],
    [6, 'const canal = 90003;', 'const canal = 9000;'],
    [7, 'const texto = err.message;', 'const texto = err.providerMessage;'],
    [8, 'if (deepEqual(a, b))', 'if (deepEqualish(a, b))'],
    [9, 'const chave = linha.access_key;', "const agulha = 'invalid access key';"],
    [10, "'confira a conta no Mercado Livre'", "'confira a conta mercado-livre'"],
  ] as const)('regra %i — PAR `%s` casa; QUASE-MISS `%s` não casa', (id, par, quase) => {
    expect(casa(id, par)).toBe(true);
    expect(casa(id, quase)).toBe(false);
  });

  it('regra 10 — PAR: a caixa não importa (`MERCADO LIVRE` casa como `mercado livre`)', () => {
    expect(casa(10, 'MERCADO LIVRE')).toBe(true);
    expect(casa(10, 'mercado livre')).toBe(true);
  });

  it('o ESCOPO: a regra de um arquivo só não olha os outros; a exceção cobre só o SEU arquivo', () => {
    // Regra 7: `.message` num arquivo que não é o classificador não é achado.
    expect(achadosDa(regra(7), new Map([['processarNfe.ts', 'err.message']]))).toEqual([]);
    expect(achadosDa(regra(7), new Map([['classificarNfe.ts', 'err.message']]))).toEqual([
      { arquivo: 'classificarNfe.ts', linha: 1 },
    ]);
    // Regra 1: a transação no carimbo passa; a MESMA linha noutro arquivo é proibida.
    const noCarimbo = new Map([['carimboFreteNfe.ts', 'db.runTransaction(fn)']]);
    expect(violacoesDa(regra(1), noCarimbo)).toEqual({ proibidos: [], excecoesMortas: [] });
    const noOutro = new Map([
      ['carimboFreteNfe.ts', 'db.runTransaction(fn)'],
      ['pedidoNfe.ts', '\n// runTransaction'],
    ]);
    expect(violacoesDa(regra(1), noOutro)).toEqual({
      proibidos: ['pedidoNfe.ts:2'],
      excecoesMortas: [],
    });
  });

  it('a exceção MORTA é apontada: o carimbo que deixasse de casar derruba a regra', () => {
    const semTransacao = new Map([['carimboFreteNfe.ts', 'const x = 1;']]);
    expect(violacoesDa(regra(1), semTransacao)).toEqual({
      proibidos: [],
      excecoesMortas: ['carimboFreteNfe.ts'],
    });
  });

  it('LINHA A LINHA, com CRLF ou LF: o número da linha é o do `git grep -n`', () => {
    const crlf = new Map([['sintetico.ts', 'a\r\nb\r\nconst t = Date.now();\r\n']]);
    const lf = new Map([['sintetico.ts', 'a\nb\nconst t = Date.now();\n']]);
    expect(achadosDa(regra(2), crlf)).toEqual([{ arquivo: 'sintetico.ts', linha: 3 }]);
    expect(achadosDa(regra(2), lf)).toEqual([{ arquivo: 'sintetico.ts', linha: 3 }]);
  });
});
