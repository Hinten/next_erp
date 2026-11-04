/**
 * The whole sanitizer run, over an injected file system: argument parsing, the
 * folder checks, the run-wide refusals, pairing, the salt, every pair converted
 * BEFORE anything is written, collisions, the output text and the exit code —
 * and the `--verificar` mode.
 *
 * ```
 * sanitizar --entrada <pasta> [--so <nome>]… [--dry-run] [--sobrescrever]
 * sanitizar --entrada <pasta> --verificar <arquivo>…
 * ```
 *
 * **All or nothing.** Any finding in any pair (or a run-wide refusal, an unpaired
 * capture, a name outside the grammar, or an existing fixture with different
 * bytes and no `--sobrescrever`) means exit 1 and ZERO fixture writes, with every
 * finding listed — never a per-file skip that leaves the rest written. The one
 * other file a run may create is the salt (beside the captures, the first time
 * pairs are converted, a dry run included), and the output then says so.
 *
 * **Nothing raw reaches the output.** It prints request lines after the redactor
 * (and only when they trip nothing; otherwise `<omitted: it trips <kind>>`),
 * credentials, roles, statuses, forms, byte counts, leaf paths with types and
 * treatments, and findings as `<nome> <onde> :: <tipo>`. A pair or an entry whose
 * NAME trips a pattern, a listed term or a digit run
 * ({@link tiposDoNomeAmazon}) is printed as `par-<n>` / `entrada-<n>` — and such
 * a pair refuses the run, since its name would be a committed file name; a
 * `--verificar` file as `arquivo-<n>`. A usage error is an
 * {@link ErroDeUsoSanitizacao} whose message holds a position or a line number,
 * never an argument.
 *
 * Pure apart from the injected file system: returns `{ saida, escritas, codigo }`
 * and the script does the fixture writing (the salt is created through the
 * injected `criarSal`). It reads no environment and opens no connection;
 * `estrutura.test.ts` proves its import closure cannot.
 */
import {
  type ListaDeNomesAmazon,
  criarListaDeNomes,
  tiposNaLinhaAmazon,
} from '../fixtures/piiScan';
import {
  type AchadoDaCapturaAmazon,
  type ResultadoDaCapturaAmazon,
  capturaParaFixture,
} from './capturaParaFixture';
import { TAMANHO_DO_SAL, criarFalsificadorAmazon } from './falsificacao';
import { formatarFolhas } from './folhas';
import { dentroDeCheckout } from './local';
import {
  ARQUIVO_NOMES_PROIBIDOS,
  ARQUIVO_SAL,
  BYTES_DE_ASSINATURA,
  ErroDeUsoSanitizacao,
  NOME_DE_CAPTURA_AMAZON,
  assinaturaBinaria,
  ehEnv,
  ehHar,
  lerNomesProibidos,
  montarLote,
  tiposDoNomeAmazon,
  validarSal,
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
        if (!NOME_DE_CAPTURA_AMAZON.test(nome)) {
          throw new ErroDeUsoSanitizacao(
            `--so number ${String(so.length + 1)} is not a capture name (a-z, 0-9 and -, at most 40, no run of 6+ digits or of 8+ split by -)`,
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
      '--verificar takes only --entrada (for the denylist) and its files',
    );
  }
  return { entrada, so, dryRun, sobrescrever, verificar };
}

/* -------------------------------------------------------------------------- */
/*                                The run                                     */
/* -------------------------------------------------------------------------- */

/** One entry directly inside the capture folder. */
export interface EntradaDaPastaAmazon {
  readonly nome: string;
  /** A regular file. A link, a folder or anything else is `false`, and is never read. */
  readonly arquivo: boolean;
}

/** Everything the run reads (and the one thing it creates), injected by the script or a test. */
export interface SistemaDeArquivosDaSanitizacao {
  /** `--entrada` as an absolute, link-resolved folder; `null` when it is not an existing folder. */
  readonly pastaReal: (caminho: string) => string | null;
  /** Whether a file or a folder exists at this absolute path. */
  readonly existe: (caminho: string) => boolean;
  /** EVERY entry directly inside `pasta`, of any type (the HAR check sees them all). */
  readonly listar: (pasta: string) => readonly EntradaDaPastaAmazon[];
  /** At most the first `n` bytes of a regular file: the signature check, nothing more. */
  readonly lerInicio: (pasta: string, nome: string, n: number) => Uint8Array;
  readonly ler: (pasta: string, nome: string) => Uint8Array;
  readonly modificadoEmMs: (pasta: string, nome: string) => number;
  /** Creates `pasta/<nome>` with these bytes, EXCLUSIVELY (it never overwrites). */
  readonly criarExclusivo: (pasta: string, nome: string, bytes: Uint8Array) => void;
  /** `n` cryptographically random bytes. */
  readonly aleatorio: (n: number) => Uint8Array;
  /** The text of `__wire__/<nome>.json` when it exists, else `null`. */
  readonly fixtureExistente: (nome: string) => string | null;
  /** A `--verificar` file (relative to the working directory, or absolute); `null` when missing. */
  readonly lerArquivo: (caminho: string) => Uint8Array | null;
}

export interface EscritaDeFixtureAmazon {
  /** Written as `__wire__/<nome>.json`. */
  readonly nome: string;
  readonly texto: string;
}

export interface ResultadoDaSanitizacao {
  readonly saida: string;
  /** Empty unless the run is clean and not a dry run. */
  readonly escritas: readonly EscritaDeFixtureAmazon[];
  /** 0 done (or a clean dry run or check); 1 refused, nothing written. Usage errors throw. */
  readonly codigo: 0 | 1;
}

const DICA_DE_PADRAO =
  'personal data on that path: if the table keeps it on purpose (a SKU, an id), tell the owner; otherwise widen core/redacao.ts';

/** One line of advice per finding kind that has one; printed once, after the findings. */
const DICAS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    ['email', 'cpf', 'cnpj', 'cnpj-raiz', 'telefone', 'cep', 'endereco'].map((t) => [
      t,
      DICA_DE_PADRAO,
    ]),
  ),
  har: 'a HAR file carries the x-amz-access-token header: delete it (never "Save all as HAR")',
  env: 'a .env file never sits in the capture folder: move it out',
  'binario-zip':
    'a zip (a label?) sits in the folder: delete it; only its listing <nome>.zip.txt belongs there',
  'binario-zpl': 'a ZPL label sits in the folder: delete it',
  'binario-pdf': 'a PDF sits in the folder: delete it',
  'binario-gzip': 'a gzip sits in the folder: delete it',
  'credencial-na-url':
    'a credential sits in the URL: delete BOTH files, and capture again without it',
  'url-na-query': 'a query value is a URL (pre-signed?): delete both files',
  host: 'only sellingpartnerapi-na.amazon.com is captured (never LWA, S3 or a pre-signed host)',
  segredo:
    'a secret-class path (RDT, client secret, /documents) is never captured: delete both files',
  'sem-tabela':
    'that operation has no redaction table yet: its step adds one before its captures can become fixtures',
  'metodo-da-operacao':
    'the method on line 1 is not one that operation is captured under (e.g. GET on the invoice submission): write the method the request really used; if it already is the real one (PATCH on the Easy Ship package), that operation has no redaction table yet and its step adds one before its captures can become fixtures',
  'curl-so-get': 'token-legado-curl is GET only: a write endpoint is copia-do-legado',
  utf16: 'the file is UTF-16 (a BOM or NUL bytes): re-save it as UTF-8 text',
  'utf8-invalido': 'the file is not valid UTF-8: re-save it as UTF-8 text',
  'nao-e-arquivo':
    'a capture must be a regular file in the folder, not a link or a folder: copy the file itself in',
  'linha-nao-reconhecida':
    'a sidecar holds only the request line, credencial:, papeis:, data: and limite-taxa: (never a header); fix that line',
  'sem-credencial': 'add the credencial: line naming the credential the capture really ran under',
  'sem-papeis': 'add the papeis: line naming the roles the capture ran under',
  'papeis-incoerentes':
    'nao-se-aplica is for modelo-sandbox / documentacao-aws only, and those take nothing else',
  'fixture-existente-diferente':
    'a fixture of that name already exists with different bytes: pass --sobrescrever to replace it',
  'nome-de-loja':
    'a listed term survived: the fixture cannot be committed until the redactor fakes that path',
  residuo: 'a value escaped the redactor: fix core/redacao.ts (its tables), never the scanner',
  'valor-mantido-falsificado':
    'a value the table keeps had to be faked: tell the owner which path; an exemption is a reviewed change for that one path',
  'rotulo-fora-do-vocabulario':
    'a label leaf (carrier, shipping service, card brand, marketplace name) holds free text outside the fixture vocabulary: a real carrier, service or brand is added to ROTULOS_DA_FIXTURE_AMAZON in core/redacao.ts as a reviewed change; a person never is',
  'digitos-no-nome':
    'a name holds a run of 6 or more digits, or of 8 or more split by - (an order id, a phone, a CEP, a document, a date?): rename the files after the request, e.g. c1-pedido-cpf',
  'inteiro-alterado-pelo-parse':
    'an integer of 16 or more digits was already changed by JSON.parse: the fixture would disagree with production',
  'sem-sidecar': 'a body with no <nome>.txt beside it: write the sidecar, or move the body out',
  'sem-corpo': 'a sidecar with no <nome>.json beside it: add the body, or move the sidecar out',
  'anexo-sem-par': 'a .req.json or .zip.txt with no complete pair beside it',
  'anexo-indevido':
    'a .req.json or .zip.txt belongs to the Easy Ship bulk capture (C3, POST /easyShip/2022-03-23/packages/bulk) only',
  'nome-fora-da-gramatica':
    'capture names are lowercase letters, digits and -, at most 40, with no run of 6 or more digits nor of 8 or more split by - (a name describes the request, e.g. c1-pedido-cpf, never an order id or a phone), ending .json, .txt, .req.json or .zip.txt',
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

/**
 * A capture's name, a folder entry or a `--verificar` path, printable only when
 * it trips nothing ({@link tiposDoNomeAmazon}: every pattern of the scanner, a
 * listed term, a digit run).
 */
function imprimivel(texto: string, lista: ListaDeNomesAmazon): boolean {
  return tiposDoNomeAmazon(texto, lista).length === 0;
}

/**
 * The salt: read when it is in the folder (exactly 32 bytes, a regular file),
 * created otherwise — once, exclusively. A fresh salt never starts with a
 * binary signature, so the folder's own signature check never refuses it.
 *
 * It is created by the first run that converts pairs, a dry run or a refused one
 * included, so a dry run prints the very fakes the writing run will write; the
 * output says so (`criado`) instead of claiming nothing was written.
 */
function obterSal(
  pasta: string,
  entradas: readonly EntradaDaPastaAmazon[],
  fs: SistemaDeArquivosDaSanitizacao,
): { readonly sal: Uint8Array; readonly criado: boolean } {
  const existente = entradas.find((e) => e.nome === ARQUIVO_SAL);
  if (existente !== undefined) {
    if (!existente.arquivo) {
      throw new ErroDeUsoSanitizacao(`${ARQUIVO_SAL} is not a regular file`);
    }
    return { sal: validarSal(fs.ler(pasta, ARQUIVO_SAL)), criado: false };
  }
  let sal = fs.aleatorio(TAMANHO_DO_SAL);
  while (assinaturaBinaria(sal) !== null) sal = fs.aleatorio(TAMANHO_DO_SAL);
  fs.criarExclusivo(pasta, ARQUIVO_SAL, validarSal(sal));
  return { sal, criado: true };
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

  // Run-wide refusals, before ANY file is read whole: names of every entry, and
  // at most the first bytes of every regular file.
  const entradas = fs.listar(pasta);
  const recusasDaPasta: { readonly nome: string; readonly tipo: string }[] = [];
  for (const e of entradas) {
    if (ehHar(e.nome)) recusasDaPasta.push({ nome: e.nome, tipo: 'har' });
    else if (ehEnv(e.nome)) recusasDaPasta.push({ nome: e.nome, tipo: 'env' });
    else if (e.arquivo) {
      const tipo = assinaturaBinaria(fs.lerInicio(pasta, e.nome, BYTES_DE_ASSINATURA));
      if (tipo !== null) recusasDaPasta.push({ nome: e.nome, tipo: `binario-${tipo}` });
    }
  }
  const arquivos = entradas.filter((e) => e.arquivo).map((e) => e.nome);
  const temDenylist =
    arquivos.includes(ARQUIVO_NOMES_PROIBIDOS) &&
    !recusasDaPasta.some((r) => r.nome === ARQUIVO_NOMES_PROIBIDOS);
  if (recusasDaPasta.length > 0) {
    // Without a readable denylist, no entry name is printed at all.
    const listaParaRotulos = temDenylist
      ? criarListaDeNomes(lerNomesProibidos(fs.ler(pasta, ARQUIVO_NOMES_PROIBIDOS)))
      : null;
    const ordenadas = [...recusasDaPasta].sort((a, b) => (a.nome < b.nome ? -1 : 1));
    return {
      saida: fim([
        'sanitizar: REFUSED, nothing was written.',
        ...ordenadas.map(
          (r, i) =>
            `  pasta ${listaParaRotulos !== null && imprimivel(r.nome, listaParaRotulos) ? r.nome : `entrada-${String(i + 1)}`} :: ${r.tipo}`,
        ),
        ...dicasPara(ordenadas.map((r) => r.tipo)),
      ]),
      escritas: [],
      codigo: 1,
    };
  }
  const lista = criarListaDeNomes(
    lerNomesProibidos(temDenylist ? fs.ler(pasta, ARQUIVO_NOMES_PROIBIDOS) : null),
  );

  if (opcoes.verificar !== null) return verificar(opcoes.verificar, fs, lista);

  const lote = montarLote(
    arquivos,
    opcoes.so,
    entradas.filter((e) => !e.arquivo).map((e) => e.nome),
  );
  const sal = obterSal(pasta, entradas, fs);
  const falsificador = criarFalsificadorAmazon(sal.sal);
  const notaDoSal = sal.criado ? ` (the salt ${ARQUIVO_SAL} was created beside the captures)` : '';
  const rotulos = new Map(
    lote.pares.map((p, i) => [p.nome, imprimivel(p.nome, lista) ? p.nome : `par-${String(i + 1)}`]),
  );
  const achados: string[] = [];
  const tipos: string[] = [];
  const porPar = new Map<string, number>();
  const registrar = (rotulo: string, itens: readonly AchadoDaCapturaAmazon[], par?: string) => {
    for (const a of itens) {
      achados.push(`${rotulo} ${a.onde} :: ${a.tipo}`);
      tipos.push(a.tipo);
    }
    if (par !== undefined) porPar.set(par, (porPar.get(par) ?? 0) + itens.length);
  };

  // Half pairs, orphan attachments, links and names outside the grammar refuse the run too.
  lote.problemas.forEach((p, i) => {
    if (p.tipo === 'nome-fora-da-gramatica') {
      registrar('pasta', [{ onde: `${String(p.quantidade)} file(s)`, tipo: p.tipo }]);
      return;
    }
    const rotulo = imprimivel(p.nome, lista) ? p.nome : `entrada-${String(i + 1)}`;
    if (p.tipo === 'nao-e-arquivo' || p.tipo === 'anexo-sem-par') {
      registrar(rotulo, [{ onde: `.${p.extensao}`, tipo: p.tipo }]);
    } else {
      registrar(rotulo, [{ onde: p.tipo === 'sem-sidecar' ? '.txt' : '.json', tipo: p.tipo }]);
    }
  });

  const resultados = new Map<string, ResultadoDaCapturaAmazon>();
  for (const par of lote.pares) {
    const nome = par.nome;
    const rotulo = rotulos.get(nome) ?? nome;
    if (rotulo !== nome) {
      // The name would be a committed file name: whatever it trips refuses the run.
      registrar(
        rotulo,
        tiposDoNomeAmazon(nome, lista).map((tipo) => ({ onde: 'nome', tipo })),
        nome,
      );
    }
    const resultado = capturaParaFixture(
      {
        sidecar: fs.ler(pasta, `${nome}.txt`),
        corpo: fs.ler(pasta, `${nome}.json`),
        corpoModificadoEmMs: fs.modificadoEmMs(pasta, `${nome}.json`),
        requisicao: par.requisicao ? fs.ler(pasta, `${nome}.req.json`) : null,
        zip: par.zip ? fs.ler(pasta, `${nome}.zip.txt`) : null,
      },
      lista,
      falsificador,
    );
    resultados.set(nome, resultado);
    if (!resultado.ok) registrar(rotulo, resultado.achados, nome);
  }

  // Collisions: identical bytes are a no-op; different bytes need --sobrescrever.
  const escritas: EscritaDeFixtureAmazon[] = [];
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
        `  credential ${resumo.credencial}, roles ${resumo.papeis.join(',')}, status ${resumo.status === null ? '-' : String(resumo.status)}, form ${resumo.forma ?? '-'}, ${String(resumo.bytes)} byte(s)`,
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
      `REFUSED, no fixture was written${notaDoSal}. Each line is <name> <where> :: <kind>; a value is never printed.`,
      ...achados.map((a) => `  ${a}`),
      ...dicasPara(tipos),
    );
    return { saida: fim(linhas), escritas: [], codigo: 1 };
  }

  if (opcoes.dryRun) {
    linhas.push(`dry run: clean, no fixture was written${notaDoSal}.`);
    return { saida: fim(linhas), escritas: [], codigo: 0 };
  }
  for (const [nome, estado] of estados) {
    linhas.push(
      `  ${rotulos.get(nome) ?? nome} -> ${estado === 'escrita' ? 'written' : 'unchanged'}`,
    );
  }
  linhas.push(
    `done: ${String(escritas.length)} written, ${String(estados.size - escritas.length)} unchanged, in lib/amazon/fixtures/__wire__/${notaDoSal}.`,
  );
  return { saida: fim(linhas), escritas, codigo: 0 };
}

/* -------------------------------------------------------------------------- */
/*                                 --verificar                                */
/* -------------------------------------------------------------------------- */

/**
 * Every listed term and every pattern of `piiScan`'s layer 2 in the named UTF-8
 * text files (a doc, a fixture, a PR-body draft) — never the term, never the
 * value. The mandated fakes and the redactor's placeholders are skipped. A file
 * that is UTF-16 or not valid UTF-8 is refused whole. Each file gets two passes:
 *
 * 1. **Each line**, reported as `<arquivo>:<linha> :: <tipo>`; a line holding a
 *    backslash is also read with its string escapes decoded.
 * 2. **Each window of 2 and of 3 consecutive lines**, reported as
 *    `<arquivo>:<primeira>-<ultima> :: <tipo>`: a hard wrap can split a
 *    multi-word term so that no single line holds it, and a line-only check
 *    would then print `clean.` and the gate before a public push would fail
 *    OPEN. The window's lines are joined (one space, or nothing after a line
 *    ending in a hyphen), every whitespace run collapsed, each continuation read
 *    both as written and with its quote / list marker dropped.
 *
 * A window reports a kind only as the SMALLEST span that finds it. A blank line
 * joins as nothing (fail closed: a paragraph break cannot be told from a wrap).
 */
function verificar(
  caminhos: readonly string[],
  fs: SistemaDeArquivosDaSanitizacao,
  lista: ListaDeNomesAmazon,
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
      achados.push(`${rotulo} :: ${texto.motivo}`);
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
 * What a continuation line can lose in a window's reading: leading whitespace,
 * `>` quote markers, list markers (`-`, `*`, `+`, `1.`, `1)`, `a.`, `(1)`, `(a)`),
 * a task box and a bare number, a marker only when a space or the end follows.
 */
const PREFIXO_DE_CONTINUACAO =
  /^(?:\s*(?:>|(?:[-*+]|\d{1,9}[.)]?|[A-Za-z][.)]|\((?:\d{1,9}|[A-Za-z])\)|\[[ xX]\])(?=\s|$)))*\s*/;

/** A hyphen or a soft hyphen (U+00AD) ending a line: a word may be cut there. */
const HIFEN_NO_FIM = /[-­]\s*$/;

const colapsar = (t: string) => t.replace(/\s+/g, ' ');

/** Every reading of consecutive lines joined into one, whitespace runs collapsed. */
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

/** One file's findings, in line order: each line, then each window it opens. */
function achadosDasLinhas(
  rotulo: string,
  linhas: readonly string[],
  lista: ListaDeNomesAmazon,
): string[] {
  const nenhum: ReadonlySet<string> = new Set();
  const tiposDaJanela = (inicio: number, quantas: number): ReadonlySet<string> =>
    inicio + quantas > linhas.length
      ? nenhum
      : new Set(
          [...leiturasDaJanela(linhas.slice(inicio, inicio + quantas))].flatMap((t) =>
            tiposNaLinhaAmazon(t, lista),
          ),
        );
  const porLinha = linhas.map((linha) => new Set<string>(tiposNaLinhaAmazon(linha, lista)));
  const porPar = linhas.map((_, n) => tiposDaJanela(n, 2));
  const algumaLinhaTem = (inicio: number, quantas: number, tipo: string) =>
    porLinha.slice(inicio, inicio + quantas).some((t) => t.has(tipo));
  const daJanela = (inicio: number, quantas: number, tipo: string) =>
    `${rotulo}:${String(inicio + 1)}-${String(inicio + quantas)} :: ${tipo}`;

  const achados: string[] = [];
  porLinha.forEach((t, n) => {
    for (const tipo of t) achados.push(`${rotulo}:${String(n + 1)} :: ${tipo}`);
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
