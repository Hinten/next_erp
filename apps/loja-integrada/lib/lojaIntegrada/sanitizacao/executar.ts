/**
 * The whole sanitizer run, over an injected file system: argument parsing, the
 * folder checks, pairing, every pair converted BEFORE anything is written,
 * collisions, the output text and the exit code — and the `--verificar` mode.
 *
 * ```
 * sanitizar --entrada <pasta> [--so <nome>]… [--dry-run] [--sobrescrever]
 * sanitizar --entrada <pasta> --verificar <arquivo>…
 * sanitizar --entrada <pasta> --gerar-chave
 * ```
 *
 * **The pseudonym key.** A catalogue pair has its kept ids replaced by keyed
 * pseudonyms (`pseudonimo.ts`); the key is `.chave-fixtures` in the capture
 * folder, read here and handed to each pair as data. `--gerar-chave` creates it
 * (through the injected `criarChave`) and refuses when it exists: a new key
 * changes every catalogue id. The key is never printed, never put in a finding
 * and never written anywhere else. Two different ids on one pseudonym, across
 * the run's pairs, refuse the run (`colisao-de-pseudonimo`).
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
  ARQUIVO_CHAVE_FIXTURES,
  ARQUIVO_NOMES_PROIBIDOS,
  ErroDeUsoSanitizacao,
  lerNomesProibidos,
  montarLote,
  temHar,
} from './lote';
import { ChaveDeFixturesLi } from './pseudonimo';
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
  /** `--gerar-chave`: create the pseudonym key, and nothing else. */
  readonly gerarChave: boolean;
}

/** Parses the arguments after the script path. Usage errors throw, naming positions only. */
export function lerArgumentos(argv: readonly string[]): OpcoesDaSanitizacao {
  let entrada: string | null = null;
  const so: string[] = [];
  let dryRun = false;
  let sobrescrever = false;
  let verificar: string[] | null = null;
  let gerarChave = false;

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
      case '--gerar-chave':
        if (gerarChave) throw repetida(arg);
        gerarChave = true;
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
  if (gerarChave && (so.length > 0 || dryRun || sobrescrever || verificar !== null)) {
    throw new ErroDeUsoSanitizacao('--gerar-chave takes only --entrada (the capture folder)');
  }
  if (verificar !== null && (so.length > 0 || dryRun || sobrescrever)) {
    throw new ErroDeUsoSanitizacao(
      '--verificar takes only --entrada (for the store-name list) and its files',
    );
  }
  return { entrada, so, dryRun, sobrescrever, verificar, gerarChave };
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
  /**
   * Creates the new pseudonym key file `nome` in `pasta` (32 random bytes as
   * hex). Called only when the listing has no entry of that name; the binding
   * still refuses to overwrite (it creates exclusively) and prints nothing.
   */
  readonly criarChave: (pasta: string, nome: string) => void;
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
  'sem-chave-de-fixtures': `a catalogue pair needs the pseudonym key ${ARQUIVO_CHAVE_FIXTURES} (a regular file in the capture folder): restore it if committed catalogue fixtures were made with it, else create it once with --gerar-chave; keep it as long as any catalogue fixture exists (it outlives the captures), and re-run`,
  'colisao-de-pseudonimo': `two different ids got one pseudonym: move ${ARQUIVO_CHAVE_FIXTURES} out, create a new key with --gerar-chave, and re-run every catalogue pair (a new key changes every catalogue id)`,
  'chave-existente': `${ARQUIVO_CHAVE_FIXTURES} already exists and is never replaced: a new key changes every catalogue id, so every catalogue pair would have to be re-run`,
  'numero-em-erro-do-catalogo':
    'a catalogue error body keeps a number, which may echo a resource id, and a pseudonym cannot replace it there: capture an error whose body holds no number other than its status, or leave the pair out',
  'catalogo-fora-da-classe':
    'a catalogue resource on a path the catalogue class does not admit would keep its real ids: admit the path in ehCatalogo (core/redacao.ts) in a reviewed change, or leave the pair out',
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
  if (opcoes.gerarChave) return gerarChave(pasta, entradas, fs);
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
  const chave = lerChave(pasta, arquivos, fs);

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
      chave,
    );
    resultados.set(nome, resultado);
    if (!resultado.ok) registrar(rotulo, resultado.achados, nome);
  }

  // Pseudonym collisions ACROSS pairs (each pair checks its own): one pseudonym,
  // two different real ids. Reported on the later pair; the ids are never printed.
  const pseudonimosDoLote = new Map<number, string>();
  for (const [nome, resultado] of resultados) {
    if (!resultado.ok) continue;
    let colidiu = false;
    for (const [falso, real] of resultado.pseudonimos) {
      const anterior = pseudonimosDoLote.get(falso);
      if (anterior === undefined) pseudonimosDoLote.set(falso, real);
      else if (anterior !== real) colidiu = true;
    }
    if (colidiu) {
      registrar(
        rotulos.get(nome) ?? nome,
        [{ onde: 'pseudonimos', tipo: 'colisao-de-pseudonimo' }],
        nome,
      );
    }
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
/*                              The pseudonym key                             */
/* -------------------------------------------------------------------------- */

/**
 * The capture folder's key, or `null` when it has none as a regular file (a
 * catalogue pair is then refused, by `capturaParaFixture`). A file that is not a
 * key is a usage error that never quotes it.
 */
function lerChave(
  pasta: string,
  arquivos: readonly string[],
  fs: SistemaDeArquivosDaSanitizacao,
): ChaveDeFixturesLi | null {
  if (!arquivos.includes(ARQUIVO_CHAVE_FIXTURES)) return null;
  const texto = decodificarUtf8(fs.ler(pasta, ARQUIVO_CHAVE_FIXTURES));
  const chave = texto.ok ? ChaveDeFixturesLi.deTexto(texto.texto) : null;
  if (chave === null) {
    throw new ErroDeUsoSanitizacao(
      `${ARQUIVO_CHAVE_FIXTURES} is not a key (64 hexadecimal digits, UTF-8): restore it from where the captures are kept; a new key changes every catalogue id`,
    );
  }
  return chave;
}

/** `--gerar-chave`: creates the key unless an entry of that name exists. Reads nothing. */
function gerarChave(
  pasta: string,
  entradas: readonly EntradaDaPastaLi[],
  fs: SistemaDeArquivosDaSanitizacao,
): ResultadoDaSanitizacao {
  if (entradas.some((e) => e.nome === ARQUIVO_CHAVE_FIXTURES)) {
    return {
      saida: fim([
        'sanitizar --gerar-chave: REFUSED, nothing was written.',
        `  pasta ${ARQUIVO_CHAVE_FIXTURES} :: chave-existente`,
        ...dicasPara(['chave-existente']),
      ]),
      escritas: [],
      codigo: 1,
    };
  }
  fs.criarChave(pasta, ARQUIVO_CHAVE_FIXTURES);
  return {
    saida: fim([
      `sanitizar --gerar-chave: created ${ARQUIVO_CHAVE_FIXTURES} in the capture folder (32 random bytes; never printed).`,
      '  Never commit it, and keep it for as long as any catalogue fixture exists: it outlives the captures (deleting merged pairs never deletes it). A new key changes every catalogue id, so every catalogue fixture would have to be re-captured and re-run in one change.',
    ]),
    escritas: [],
    codigo: 0,
  };
}

/* -------------------------------------------------------------------------- */
/*                                 --verificar                                */
/* -------------------------------------------------------------------------- */

/**
 * Every listed store name and every redactor pattern in the named UTF-8 text
 * files (a doc, a fixture, a PR-body draft) — never the term, never the value.
 * The repository's mandated fakes (`000.000.000-00`, `…@….invalid`) are
 * skipped. Reads no capture. A file that is UTF-16 or not valid UTF-8 is
 * refused whole (`<arquivo> :: utf16` / `:: utf8-invalido`), never read through
 * replacement characters. Each file gets two passes (`achadosDasLinhas`):
 *
 * 1. **Each line**, reported as `<arquivo>:<linha> :: <tipo>`. A line holding a
 *    backslash is also read with its string escapes decoded, so a fixture's or
 *    a `.ts` literal's `Exemplo\nModa` is not read `exemplo nmoda`.
 * 2. **Each window of 2 and of 3 consecutive lines**, reported as
 *    `<arquivo>:<primeira>-<ultima> :: <tipo>`. A hard wrap can split a
 *    multi-word store name (`…the Loja Exemplo` / `Moda store`) so that no
 *    single line holds it, and a line-only check then prints `clean.` and
 *    exits 0: the gate before a public push would fail OPEN. The window's lines
 *    are joined, every whitespace run collapsed, and each reading of the joined
 *    text gets the same detectors as a line (`tiposNaLinhaLi`). Every
 *    continuation line is read both with its leading whitespace, `>` quote
 *    markers and list marker dropped (`1. … Loja` / `2. Exemplo …`) and as
 *    written (a `2000.` opening a line may be the end of a name, not a list
 *    number), each line's choice on its own. Each join is one space, or nothing
 *    after a line ending in a hyphen or a soft hyphen (`Exem-` / `plaria`: a
 *    one-word name has no separator-free form to fall back on).
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
 * The same fail-closed trade makes false alarms across structural boundaries
 * (two list items, a heading and the next paragraph, two table rows) when a
 * listed name is built from common words; there is no allow-list, so such a
 * line is reworded.
 *
 * Out of reach: a name spread over four or more lines (paragraph breaks inside
 * it); a continuation prefix holding letters or digits next to other text
 * (Supercite `LF>`, `REM`); a token cut inside itself with no hyphen at the
 * cut; and, on one line too, markup between the words (`Exemplo<br>Moda`,
 * `&nbsp;`, a footnote marker) and look-alike characters (fullwidth,
 * Cyrillic). No redactor pattern needs the joining space to match: a phone
 * wrapped after its `(DD)` is reported on the line holding the number.
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
    if (!utf8Valido(bytes)) {
      achados.push(`${rotulo} :: utf8-invalido`);
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
 * Whether `bytes` are valid UTF-8. The lenient decoder turns a stray Windows-1252
 * byte into U+FFFD, which folds to a word break: `Ex\xEAmplo` would read
 * `ex mplo` and a listed name would pass. The fatal one throws a `TypeError`.
 */
function utf8Valido(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch (err) {
    if (err instanceof TypeError) return false;
    throw err;
  }
}

/**
 * What a continuation line can lose in a window's reading: leading whitespace,
 * `>` quote markers (nested ones too), list markers (`-`, `*`, `+`, `1.`, `1)`,
 * `a.`, `B)`, `(1)`, `(a)`), a task box (`[ ]`, `[x]`) and a bare number (a
 * pasted listing's line-number gutter), a marker only when a space or the end
 * of the line follows it.
 */
const PREFIXO_DE_CONTINUACAO =
  /^(?:\s*(?:>|(?:[-*+]|\d{1,9}[.)]?|[A-Za-z][.)]|\((?:\d{1,9}|[A-Za-z])\)|\[[ xX]\])(?=\s|$)))*\s*/;

/** A hyphen or a soft hyphen (U+00AD) ending a line: a word may be cut there. */
const HIFEN_NO_FIM = /[-­]\s*$/;

const colapsar = (t: string) => t.replace(/\s+/g, ' ');

/**
 * Every reading of consecutive lines joined into one, whitespace runs collapsed:
 * each continuation line as written AND with its prefix dropped, each choice on
 * its own (`2.` dropped, `2000.` kept), and each join one space or, after a line
 * ending in a hyphen, nothing (`Exem-` / `plaria`). Deduplicated, so plain prose
 * costs one reading.
 */
function leiturasDaJanela(linhas: readonly string[]): ReadonlySet<string> {
  const [primeira = '', ...continuacoes] = linhas;
  let leituras: ReadonlySet<string> = new Set([colapsar(primeira)]);
  for (const linha of continuacoes) {
    const formas = new Set([linha, linha.replace(PREFIXO_DE_CONTINUACAO, '')]);
    const seguintes = new Set<string>();
    for (const anterior of leituras) {
      const cortada = HIFEN_NO_FIM.test(anterior) ? anterior.replace(HIFEN_NO_FIM, '') : null;
      for (const forma of formas) {
        seguintes.add(colapsar(`${anterior} ${forma}`));
        if (cortada !== null) seguintes.add(colapsar(`${cortada}${forma}`));
      }
    }
    leituras = seguintes;
  }
  return leituras;
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
          [...leiturasDaJanela(linhas.slice(inicio, inicio + quantas))].flatMap((t) =>
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
