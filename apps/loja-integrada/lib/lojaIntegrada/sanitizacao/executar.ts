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
 * files (a doc, a fixture, a PR-body draft), reported as `<arquivo>:<linha> ::
 * <tipo>` — never the term, never the value. The repository's mandated fakes
 * (`000.000.000-00`, `…@….invalid`) are skipped. Reads no capture.
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
    texto.texto.split(/\r?\n/).forEach((linha, n) => {
      linhasLidas += 1;
      for (const tipo of tiposNaLinhaLi(linha, lista)) {
        achados.push(`${rotulo}:${String(n + 1)} :: ${tipo}`);
      }
    });
  });
  const cabecalho = `sanitizar --verificar: ${String(caminhos.length)} file(s), ${String(linhasLidas)} line(s).`;
  if (achados.length === 0) return { saida: fim([cabecalho, 'clean.']), escritas: [], codigo: 0 };
  return {
    saida: fim([
      cabecalho,
      `FOUND ${String(achados.length)}: each line is <file>:<line> :: <kind>; a value is never printed.`,
      ...achados.map((a) => `  ${a}`),
    ]),
    escritas: [],
    codigo: 1,
  };
}
