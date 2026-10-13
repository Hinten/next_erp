/**
 * The whole sanitizer run, over an injected file system: argument parsing, the
 * folder checks, pairing, every pair converted BEFORE anything is written,
 * collisions, the output text and the exit code — and the `--verificar` mode.
 *
 * ```
 * sanitizar --entrada <pasta> [--so <nome>]… [--dry-run] [--sobrescrever]
 * sanitizar --entrada <pasta> --verificar <arquivo>…
 * ```
 *
 * **All or nothing.** Any finding in any pair (or an unpaired capture, or a name
 * outside the grammar, or an existing fixture with different bytes and no
 * `--sobrescrever`) means exit 1 and ZERO writes, with every finding listed —
 * not a per-file skip that leaves the rest written.
 *
 * **Nothing raw reaches the output.** It prints request lines after the
 * redactor, and only when the scanner's patterns and the store-name list find
 * nothing in them (otherwise `<omitted: it trips <tipo>>`), classes, statuses,
 * forms, byte counts, leaf paths with types and treatments, and findings as
 * `<nome> <onde> :: <tipo>`. A pair whose NAME trips
 * a pattern or a listed store name is printed as `par-<n>`; a `--verificar` file
 * likewise as `arquivo-<n>`. A usage error is an {@link ErroDeUsoSanitizacao}
 * whose message holds a position or a line number, never an argument.
 *
 * Pure apart from the injected file system: returns `{ saida, escritas, codigo }`
 * and the script does the writing. It reads no environment and opens no
 * connection; `estrutura.test.ts` proves its import closure cannot.
 */
import {
  type ListaDeNomesLi,
  contemNomeDeLoja,
  criarListaDeNomes,
  tiposMascaradosLi,
  tiposNaLinhaLi,
} from '../fixtures/piiScan';
import { NOME_DE_CAPTURA_LI } from '../fixtures/wireCorpus';
import {
  type AchadoDaCapturaLi,
  type ResultadoDaCapturaLi,
  capturaParaFixture,
} from './capturaParaFixture';
import { formatarFolhas } from './folhas';
import { dentroDeCheckout } from './local';
import {
  ARQUIVO_NOMES_PROIBIDOS,
  ErroDeUsoSanitizacao,
  lerNomesProibidos,
  montarLote,
  temHar,
} from './lote';
import { decodificarUtf8 } from './requisicao';

export { ErroDeUsoSanitizacao };

/* -------------------------------------------------------------------------- */
/*                                 Arguments                                  */
/* -------------------------------------------------------------------------- */

export interface OpcoesDaSanitizacao {
  readonly entrada: string;
  readonly so: readonly string[];
  readonly dryRun: boolean;
  readonly sobrescrever: boolean;
  /** `--verificar`'s files, or `null` in a conversion run. */
  readonly verificar: readonly string[] | null;
}

/** Parses the arguments after the script path. Usage errors throw, naming positions only. */
export function lerArgumentos(argv: readonly string[]): OpcoesDaSanitizacao {
  let entrada: string | null = null;
  const so: string[] = [];
  let dryRun = false;
  let sobrescrever = false;
  let verificar: string[] | null = null;

  const repetida = (flag: string) => new ErroDeUsoSanitizacao(`${flag} is given twice`);
  const valor = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) {
      throw new ErroDeUsoSanitizacao(`${flag} needs a value`);
    }
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    switch (arg) {
      case '--entrada':
        if (entrada !== null) throw repetida(arg);
        entrada = valor(i, arg);
        i += 1;
        break;
      case '--so': {
        const nome = valor(i, arg);
        if (!NOME_DE_CAPTURA_LI.test(nome)) {
          throw new ErroDeUsoSanitizacao(
            `--so number ${String(so.length + 1)} is not a capture name (a-z, 0-9 and -, at most 40)`,
          );
        }
        so.push(nome);
        i += 1;
        break;
      }
      case '--dry-run':
        if (dryRun) throw repetida(arg);
        dryRun = true;
        break;
      case '--sobrescrever':
        if (sobrescrever) throw repetida(arg);
        sobrescrever = true;
        break;
      case '--verificar': {
        if (verificar !== null) throw repetida(arg);
        const arquivos: string[] = [];
        while (i + 1 < argv.length && !(argv[i + 1] ?? '').startsWith('--')) {
          arquivos.push(argv[i + 1] ?? '');
          i += 1;
        }
        if (arquivos.length === 0) {
          throw new ErroDeUsoSanitizacao('--verificar needs at least one file');
        }
        verificar = arquivos;
        break;
      }
      case '--':
        throw new ErroDeUsoSanitizacao(
          `argument ${String(i + 1)} is a stray "--": pass the flags directly`,
        );
      default:
        throw new ErroDeUsoSanitizacao(
          arg.startsWith('-')
            ? `argument ${String(i + 1)} is an unknown flag`
            : `argument ${String(i + 1)} is a positional argument: every value follows its flag`,
        );
    }
  }

  if (entrada === null) {
    throw new ErroDeUsoSanitizacao(
      '--entrada is required: the capture folder, outside every git checkout',
    );
  }
  if (verificar !== null && (so.length > 0 || dryRun || sobrescrever)) {
    throw new ErroDeUsoSanitizacao(
      '--verificar takes only --entrada (for the store-name list) and its files',
    );
  }
  return { entrada, so, dryRun, sobrescrever, verificar };
}

/* -------------------------------------------------------------------------- */
/*                                The run                                     */
/* -------------------------------------------------------------------------- */

/** One entry directly inside the capture folder. */
export interface EntradaDaPastaLi {
  readonly nome: string;
  /** A regular file. A link, a folder or anything else is `false`, and is never read. */
  readonly arquivo: boolean;
}

/** Everything the run reads, injected by the script (`node:fs`) or a test. */
export interface SistemaDeArquivosDaSanitizacao {
  /** `--entrada` as an absolute, link-resolved folder; `null` when it is not an existing folder. */
  readonly pastaReal: (caminho: string) => string | null;
  /** Whether a file or a folder exists at this absolute path. */
  readonly existe: (caminho: string) => boolean;
  /** EVERY entry directly inside `pasta`, of any type (the HAR check sees them all). */
  readonly listar: (pasta: string) => readonly EntradaDaPastaLi[];
  readonly ler: (pasta: string, nome: string) => Uint8Array;
  readonly modificadoEmMs: (pasta: string, nome: string) => number;
  /** The text of `__wire__/<nome>.json` when it exists, else `null`. */
  readonly fixtureExistente: (nome: string) => string | null;
  /** A `--verificar` file (relative to the working directory, or absolute); `null` when missing. */
  readonly lerArquivo: (caminho: string) => Uint8Array | null;
}

export interface EscritaDeFixtureLi {
  /** Written as `__wire__/<nome>.json`. */
  readonly nome: string;
  readonly texto: string;
}

export interface ResultadoDaSanitizacao {
  readonly saida: string;
  /** Empty unless the run is clean and not a dry run. */
  readonly escritas: readonly EscritaDeFixtureLi[];
  /** 0 done (or a clean dry run or check); 1 refused, nothing written. Usage errors throw. */
  readonly codigo: 0 | 1;
}

/**
 * A personal-data kind on a path is either a value that escaped the redactor or an
 * allow-listed value that collides with a pattern (a SKU that is a valid CPF).
 */
const DICA_DE_PADRAO =
  'personal data on that path: if the redactor keeps it on purpose (a SKU, a numero), tell the owner; otherwise widen core/redacao.ts';

/** One line of advice per finding kind that has one; printed once, after the findings. */
const DICAS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    ['email', 'cpf', 'cnpj', 'telefone', 'cep', 'endereco', 'rastreio'].map((t) => [
      t,
      DICA_DE_PADRAO,
    ]),
  ),
  har: 'a HAR file carries the Authorization header and cookies: delete it',
  'credencial-na-url':
    'a credential sits in the URL: delete BOTH files, and capture again without it',
  utf16:
    'the file is UTF-16 (a BOM, or NUL bytes: UTF-16 without a BOM, or a binary file): re-save it as UTF-8 text',
  'nao-e-arquivo':
    'a capture must be a regular file in the folder, not a link or a folder: copy the file itself in',
  'linha-nao-reconhecida':
    'a sidecar holds only the request line, credencial: and data: (never a header); fix that line',
  'sem-credencial': 'add the credencial: line naming the credential the capture really ran under',
  'fixture-existente-diferente':
    'a fixture of that name already exists with different bytes: pass --sobrescrever to replace it',
  'nome-de-loja':
    'a listed store name or domain survived: the fixture cannot be committed until the redactor fakes that path',
  residuo: 'a value escaped the redactor: fix core/redacao.ts (its tables), never the scanner',
  'valor-mantido-falsificado':
    'an allow-listed value had to be faked: tell the owner which path; an exemption is a reviewed change for that one path',
  'inteiro-alterado-pelo-parse':
    'an integer of 16 or more digits was already changed by JSON.parse: the fixture would disagree with production',
  'sem-sidecar': 'a body with no <nome>.txt beside it: write the sidecar, or move the body out',
  'sem-corpo': 'a sidecar with no <nome>.json beside it: add the body, or move the sidecar out',
  'nome-fora-da-gramatica':
    'capture names are lowercase letters, digits and -, at most 40, ending .json or .txt',
};

const fim = (linhas: readonly string[]) => `${linhas.join('\n')}\n`;

function dicasPara(tipos: Iterable<string>): string[] {
  const vistos = new Set<string>();
  const linhas: string[] = [];
  for (const tipo of tipos) {
    const raiz = tipo.split(' ')[0] ?? tipo;
    const dica = DICAS[raiz];
    if (dica !== undefined && !vistos.has(raiz)) {
      vistos.add(raiz);
      linhas.push(`  hint (${raiz}): ${dica}`);
    }
  }
  return linhas;
}

/** A name or a path, printable only when it trips no pattern and no listed name. */
function imprimivel(texto: string, lista: ListaDeNomesLi): boolean {
  return (
    tiposMascaradosLi(texto, { digitos: true }).length === 0 && !contemNomeDeLoja(texto, lista)
  );
}

/**
 * The run. Throws {@link ErroDeUsoSanitizacao} for a usage error (the script
 * exits 2); returns the output, the writes and the exit code otherwise.
 */
export function executarSanitizacao(
  argv: readonly string[],
  fs: SistemaDeArquivosDaSanitizacao,
): ResultadoDaSanitizacao {
  const opcoes = lerArgumentos(argv);
  const pasta = fs.pastaReal(opcoes.entrada);
  if (pasta === null) throw new ErroDeUsoSanitizacao('--entrada is not an existing folder');
  if (dentroDeCheckout(pasta, fs.existe)) {
    throw new ErroDeUsoSanitizacao(
      '--entrada is inside a git checkout (a .git entry in it or in an ancestor): captures live outside every checkout, see scripts/README.md',
    );
  }

  const entradas = fs.listar(pasta);
  if (temHar(entradas.map((e) => e.nome))) {
    return {
      saida: fim([
        'sanitizar: REFUSED, nothing was written.',
        '  pasta :: har',
        ...dicasPara(['har']),
      ]),
      escritas: [],
      codigo: 1,
    };
  }
  const arquivos = entradas.filter((e) => e.arquivo).map((e) => e.nome);
  const lista = criarListaDeNomes(
    lerNomesProibidos(
      arquivos.includes(ARQUIVO_NOMES_PROIBIDOS) ? fs.ler(pasta, ARQUIVO_NOMES_PROIBIDOS) : null,
    ),
  );

  if (opcoes.verificar !== null) return verificar(opcoes.verificar, fs, lista);

  const lote = montarLote(
    arquivos,
    opcoes.so,
    entradas.filter((e) => !e.arquivo).map((e) => e.nome),
  );
  const rotulos = new Map(
    lote.pares.map((nome, i) => [nome, imprimivel(nome, lista) ? nome : `par-${String(i + 1)}`]),
  );
  const achados: string[] = [];
  const tipos: string[] = [];
  const porPar = new Map<string, number>();
  const registrar = (rotulo: string, itens: readonly AchadoDaCapturaLi[], par?: string) => {
    for (const a of itens) {
      achados.push(`${rotulo} ${a.onde} :: ${a.tipo}`);
      tipos.push(a.tipo);
    }
    if (par !== undefined) porPar.set(par, (porPar.get(par) ?? 0) + itens.length);
  };

  // Unpaired captures, links and names outside the grammar refuse the run too.
  lote.problemas.forEach((p, i) => {
    if (p.tipo === 'nome-fora-da-gramatica') {
      registrar('pasta', [{ onde: `${String(p.quantidade)} file(s)`, tipo: p.tipo }]);
    } else if (p.tipo === 'nao-e-arquivo') {
      registrar(imprimivel(p.nome, lista) ? p.nome : `entrada-${String(i + 1)}`, [
        { onde: `.${p.extensao}`, tipo: p.tipo },
      ]);
    } else {
      registrar(imprimivel(p.nome, lista) ? p.nome : `arquivo-sem-par-${String(i + 1)}`, [
        { onde: p.tipo === 'sem-sidecar' ? '.txt' : '.json', tipo: p.tipo },
      ]);
    }
  });

  const resultados = new Map<string, ResultadoDaCapturaLi>();
  for (const nome of lote.pares) {
    const rotulo = rotulos.get(nome) ?? nome;
    if (rotulo !== nome) {
      const tiposDoNome = tiposMascaradosLi(nome, { digitos: true });
      registrar(
        rotulo,
        (tiposDoNome.length > 0 ? tiposDoNome : ['nome-de-loja']).map((tipo) => ({
          onde: 'nome',
          tipo,
        })),
        nome,
      );
    }
    const resultado = capturaParaFixture(
      {
        sidecar: fs.ler(pasta, `${nome}.txt`),
        corpo: fs.ler(pasta, `${nome}.json`),
        corpoModificadoEmMs: fs.modificadoEmMs(pasta, `${nome}.json`),
      },
      lista,
    );
    resultados.set(nome, resultado);
    if (!resultado.ok) registrar(rotulo, resultado.achados, nome);
  }

  // Collisions: identical bytes are a no-op; different bytes need --sobrescrever.
  const escritas: EscritaDeFixtureLi[] = [];
  const estados = new Map<string, 'escrita' | 'inalterada'>();
  for (const [nome, resultado] of resultados) {
    if (!resultado.ok) continue;
    const existente = fs.fixtureExistente(nome);
    if (existente === resultado.texto) {
      estados.set(nome, 'inalterada');
    } else if (existente !== null && !opcoes.sobrescrever) {
      registrar(
        rotulos.get(nome) ?? nome,
        [{ onde: '__wire__', tipo: 'fixture-existente-diferente' }],
        nome,
      );
    } else {
      estados.set(nome, 'escrita');
      escritas.push({ nome, texto: resultado.texto });
    }
  }

  const cabecalho = `sanitizar: ${String(lote.pares.length)} pair(s), ${String(lote.ignorados)} other file(s) ignored${opcoes.dryRun ? ', dry run' : ''}.`;
  const linhas: string[] = [cabecalho];

  if (opcoes.dryRun) {
    for (const [nome, resultado] of resultados) {
      const rotulo = rotulos.get(nome) ?? nome;
      linhas.push(`[${rotulo}]`);
      const resumo = resultado.resumo;
      if (resumo === null) {
        linhas.push('  the sidecar was refused; see the findings');
        continue;
      }
      linhas.push(
        `  request: ${resumo.linhaRequisicao ?? `<omitted: it trips ${resumo.linhaOmitidaPor.join(', ')}>`}`,
        `  class ${resumo.politica}, status ${String(resumo.status)}, form ${resumo.forma ?? '-'}, ${String(resumo.bytes)} byte(s)`,
      );
      if (resumo.folhas.length > 0) {
        linhas.push('  leaves:', ...formatarFolhas(resumo.folhas).map((l) => `    ${l}`));
      }
      const n = porPar.get(nome) ?? 0;
      linhas.push(n === 0 ? '  findings: none' : `  findings: ${String(n)}`);
    }
  }

  if (achados.length > 0) {
    linhas.push(
      'REFUSED, nothing was written. Each line is <name> <where> :: <kind>; a value is never printed.',
      ...achados.map((a) => `  ${a}`),
      ...dicasPara(tipos),
    );
    return { saida: fim(linhas), escritas: [], codigo: 1 };
  }

  if (opcoes.dryRun) {
    linhas.push('dry run: clean, nothing was written.');
    return { saida: fim(linhas), escritas: [], codigo: 0 };
  }
  for (const [nome, estado] of estados) {
    linhas.push(
      `  ${rotulos.get(nome) ?? nome} -> ${estado === 'escrita' ? 'written' : 'unchanged'}`,
    );
  }
  linhas.push(
    `done: ${String(escritas.length)} written, ${String(estados.size - escritas.length)} unchanged, in lib/lojaIntegrada/fixtures/__wire__/.`,
  );
  return { saida: fim(linhas), escritas, codigo: 0 };
}

/* -------------------------------------------------------------------------- */
/*                                 --verificar                                */
/* -------------------------------------------------------------------------- */

/**
 * Every listed store name and every redactor pattern in the named UTF-8 text
 * files (a doc, a fixture, a PR-body draft) — never the term, never the value.
 * The repository's mandated fakes (`000.000.000-00`, `…@….invalid`) are
 * skipped. Reads no capture. Each file gets two passes (`achadosDasLinhas`):
 *
 * 1. **Each line**, reported as `<arquivo>:<linha> :: <tipo>`.
 * 2. **Each window of 2 and of 3 consecutive lines**, reported as
 *    `<arquivo>:<primeira>-<ultima> :: <tipo>`. A hard wrap can split a
 *    multi-word store name (`…the Loja Exemplo` / `Moda store`) so that no
 *    single line holds it, and a line-only check then prints `clean.` and
 *    exits 0: the gate before a public push would fail OPEN. The window's lines
 *    are joined by one space, every whitespace run collapsed, and the joined
 *    text gets the same detectors as a line (`tiposNaLinhaLi`) twice: once with
 *    each continuation line's leading whitespace, `>` quote markers and list
 *    marker dropped (`1. … Loja` / `2. Exemplo …`), and once as written (a
 *    `2000.` opening a line may be the end of a name, not a list number).
 *
 * A window reports a kind only as the SMALLEST span that finds it: never when
 * one of its own lines already reports that kind, and a 3-line window never
 * when one of its two 2-line windows finds it. A second occurrence hidden that
 * way still leaves the file refused (exit 1), and surfaces on the re-run once
 * the reported one is fixed.
 *
 * A blank line is a line like any other and joins as nothing, so a name split
 * by one blank line is still reported (`<arquivo>:1-3`): fail-closed, because
 * the check cannot tell a paragraph break from a wrap (a bare `>` inside a
 * quote, loose list items), and a false alarm costs a re-run where a miss
 * publishes the name.
 *
 * Out of reach: a name spread over four or more lines, and a token cut inside
 * itself (a wrapper breaks only at whitespace, which the one-space join puts
 * back). No redactor pattern needs the joining space to match: a phone wrapped
 * after its `(DD)` is reported on the line holding the number.
 */
function verificar(
  caminhos: readonly string[],
  fs: SistemaDeArquivosDaSanitizacao,
  lista: ListaDeNomesLi,
): ResultadoDaSanitizacao {
  const achados: string[] = [];
  let linhasLidas = 0;
  caminhos.forEach((caminho, i) => {
    const bytes = fs.lerArquivo(caminho);
    if (bytes === null) {
      throw new ErroDeUsoSanitizacao(`--verificar file number ${String(i + 1)} does not exist`);
    }
    const rotulo = imprimivel(caminho, lista) ? caminho : `arquivo-${String(i + 1)}`;
    const texto = decodificarUtf8(bytes);
    if (!texto.ok) {
      achados.push(`${rotulo} :: utf16`);
      return;
    }
    const linhas = texto.texto.split(/\r?\n/);
    linhasLidas += linhas.length;
    achados.push(...achadosDasLinhas(rotulo, linhas, lista));
  });
  const cabecalho = `sanitizar --verificar: ${String(caminhos.length)} file(s), ${String(linhasLidas)} line(s).`;
  if (achados.length === 0) return { saida: fim([cabecalho, 'clean.']), escritas: [], codigo: 0 };
  return {
    saida: fim([
      cabecalho,
      `FOUND ${String(achados.length)}: each line is <file>:<line> :: <kind>, or <file>:<first>-<last> :: <kind> for a span of wrapped lines; a value is never printed.`,
      ...achados.map((a) => `  ${a}`),
    ]),
    escritas: [],
    codigo: 1,
  };
}

/**
 * What a continuation line loses in the first reading of a window: leading
 * whitespace, `>` quote markers (nested ones too) and list markers (`-`, `*`,
 * `+`, `1.`, `1)`), a marker only when a space or the end of the line follows it.
 */
const PREFIXO_DE_CONTINUACAO = /^(?:\s*(?:>|(?:[-*+]|\d{1,9}[.)])(?=\s|$)))*\s*/;

/** Consecutive lines joined by one space, whitespace runs collapsed: prefixes dropped, then as written. */
function leiturasDaJanela(linhas: readonly string[]): readonly string[] {
  const juntar = (partes: readonly string[]) => partes.join(' ').replace(/\s+/g, ' ');
  return [
    juntar(linhas.map((l, i) => (i === 0 ? l : l.replace(PREFIXO_DE_CONTINUACAO, '')))),
    juntar(linhas),
  ];
}

/** One file's findings, in line order: each line, then each window it opens (see {@link verificar}). */
function achadosDasLinhas(
  rotulo: string,
  linhas: readonly string[],
  lista: ListaDeNomesLi,
): string[] {
  const nenhum: ReadonlySet<string> = new Set();
  const tiposDaJanela = (inicio: number, quantas: number): ReadonlySet<string> =>
    inicio + quantas > linhas.length
      ? nenhum
      : new Set(
          leiturasDaJanela(linhas.slice(inicio, inicio + quantas)).flatMap((t) =>
            tiposNaLinhaLi(t, lista),
          ),
        );
  const porLinha = linhas.map((linha) => new Set<string>(tiposNaLinhaLi(linha, lista)));
  const porPar = linhas.map((_, n) => tiposDaJanela(n, 2));
  const algumaLinhaTem = (inicio: number, quantas: number, tipo: string) =>
    porLinha.slice(inicio, inicio + quantas).some((tipos) => tipos.has(tipo));
  const daJanela = (inicio: number, quantas: number, tipo: string) =>
    `${rotulo}:${String(inicio + 1)}-${String(inicio + quantas)} :: ${tipo}`;

  const achados: string[] = [];
  porLinha.forEach((tipos, n) => {
    for (const tipo of tipos) achados.push(`${rotulo}:${String(n + 1)} :: ${tipo}`);
    for (const tipo of porPar[n] ?? nenhum) {
      if (!algumaLinhaTem(n, 2, tipo)) achados.push(daJanela(n, 2, tipo));
    }
    for (const tipo of tiposDaJanela(n, 3)) {
      const numPar = porPar.slice(n, n + 2).some((par) => par.has(tipo));
      if (!numPar && !algumaLinhaTem(n, 3, tipo)) achados.push(daJanela(n, 3, tipo));
    }
  });
  return achados;
}
