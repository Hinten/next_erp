/**
 * The layout rules of `lib/lojaIntegrada`, asserted as raw source text, because
 * breaking any of them fails nothing else:
 *
 *  - Next-free: step 3's functions bundle imports this tree. Only
 *    `core/respond.ts` may import `next/*`, and nothing may reach for the app's
 *    `@/` alias (the admin singleton lives there: `db` is a PARAMETER here);
 *  - no `process.env` read — configuration is a parameter too;
 *  - the test double and its fixtures are imported by tests only;
 *  - the name of the Admin SDK's multi-document atomic-write call appears in NO
 *    file of this app, tests and fakes included. The guard in
 *    `firestore-transaction-inventory.test.js` greps raw text, and a mention —
 *    even in a comment — would demand an inventory class for a site that does
 *    not exist. The word is assembled below so this file does not contain it;
 *  - the logger, the redactor and the valves stay light: `core/redacao.ts` and
 *    `core/refCredencial.ts` import only `zod` and `@delfrance/core/*`, and the
 *    transitive import closure of the logger and of `core/valvulas.ts` never
 *    reaches the Admin SDK, the admin data layer, Next or the app alias;
 *  - the observer seam: outside `core/log.ts`, every observer handed to the
 *    package is exactly `criarObservadorLi(…)` as imported from the logger —
 *    the whole value, under its own name, never shadowed — and no file names
 *    the raw event type: it carries the raw query and the full response text,
 *    and only the logger redacts them;
 *  - the capture sanitizer (`sanitizacao/**`, `fixtures/**`, `scripts/sanitizar.ts`)
 *    cannot reach a network, a process, a token or Firestore: its transitive
 *    import closure — the allow-listed `@delfrance/core/*` subpaths walked too,
 *    not trusted — holds no network or process module, no package client, no
 *    Admin SDK or admin data layer, none of the credential modules, and no text
 *    that calls `fetch`, loads code dynamically, fetches a builtin at run time or
 *    reaches a global by a computed name — and every external module it does
 *    import is on a short allow-list;
 *  - the committed fixture corpus keeps its `.prettierignore` and `.gitattributes`
 *    lines, so a re-run over an unchanged capture writes identical bytes;
 *  - the label routing route (`PUT …/pedidos/[pedidoId]/rota-etiqueta`, step 15) calls
 *    nothing outside the ERP: the run-time import closure of its route file — the app's
 *    `@/` modules walked too, type-only imports set aside because they load nothing —
 *    reaches no package client, no credential module, no context loader, no pacer, no
 *    read switch, no network module and no text that calls `fetch`;
 *  - every READ route — the paid re-check (`GET …/pedidos/[pedidoId]/pagamento`, step 15) and
 *    the four catalogue reads (`GET …/conta/[id]/{categorias,marcas,grades,grades/[gradeId]}`,
 *    step 10) — reaches Loja Integrada only through the context loader, whose first act is the
 *    read switch: in each one's run-time closure no file calls `fetch`, and only
 *    `core/contexto.ts` builds a client;
 *  - none of those routes, nor the label routing route, can reach the WRITE context
 *    (`core/contextoEscrita.ts`) or name its factory, with no exemption;
 *  - the write chokepoint (the write engine's requirement 9, step 7), matched by FULL path in
 *    non-test source: only `core/contextoEscrita.ts` builds a write client; only
 *    `core/escrita.ts` names a package write operation or a write-client method; the write
 *    client's type is named in those two files only; no source names the package's request
 *    core; and no source imports a subpath of the package or reaches its files by a relative
 *    path (its manifest publishes the root alone, and a deep import is how its request core
 *    would be reached). The chokepoint exempts `testing/**`, so nothing in the WHOLE app but a
 *    test may import `testing/`.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const RAIZ_LIB = fileURLToPath(new URL('.', import.meta.url));
const RAIZ_APP = fileURLToPath(new URL('../..', import.meta.url));
const RAIZ_REPO = fileURLToPath(new URL('../../../..', import.meta.url));

function arquivosTs(dir: string): string[] {
  const saida: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.next') continue;
    const caminho = join(dir, e.name);
    if (e.isDirectory()) saida.push(...arquivosTs(caminho));
    else if (/\.(ts|tsx|mjs)$/.test(e.name)) saida.push(caminho);
  }
  return saida;
}

const rel = (p: string) => relative(RAIZ_LIB, p).split(sep).join('/');
const relApp = (p: string) => relative(RAIZ_APP, p).split(sep).join('/');
const ehTeste = (p: string) => p.endsWith('.test.ts');

/** Every module specifier in a source text: `from '…'`, `import '…'`, `import('…')`. */
function especificadores(texto: string): string[] {
  const saida: string[] = [];
  const re =
    /\bfrom\s+['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of texto.matchAll(re)) saida.push(m[1] ?? m[2] ?? m[3] ?? '');
  return saida;
}

/** A source text by its path relative to `lib/lojaIntegrada`, or `null`. */
type LeitorDeFonte = (caminho: string) => string | null;

const lerDoDisco: LeitorDeFonte = (caminho) => {
  const absoluto = join(RAIZ_LIB, ...caminho.split('/'));
  return existsSync(absoluto) ? readFileSync(absoluto, 'utf8') : null;
};

/** The same, by path relative to the APP root (`scripts/…`, `lib/lojaIntegrada/…`). */
const lerDoApp: LeitorDeFonte = (caminho) => {
  const absoluto = join(RAIZ_APP, ...caminho.split('/'));
  return existsSync(absoluto) ? readFileSync(absoluto, 'utf8') : null;
};

/** A non-relative specifier as a source path the walk enters too, or `null` to leave it external. */
type ResolvedorDePacote = (espec: string) => string | null;

/**
 * The transitive closure of RELATIVE imports from `entradas`: every file
 * reached, and every non-relative specifier any of them imports. A relative
 * import that resolves to no file is reported as `?<path>` — fail closed. With
 * `resolver`, a non-relative specifier it maps to a source file is ALSO walked
 * (it stays in `externos`, so it still has to be allow-listed).
 */
function fechoDeImportacoes(
  entradas: readonly string[],
  ler: LeitorDeFonte,
  resolver: ResolvedorDePacote = () => null,
): { arquivos: string[]; externos: string[] } {
  const arquivos: string[] = [];
  const externos = new Set<string>();
  const pendentes = [...entradas];
  while (pendentes.length > 0) {
    const arquivo = pendentes.pop() ?? '';
    if (arquivos.includes(arquivo)) continue;
    const texto = ler(arquivo);
    if (texto === null) {
      externos.add(`?${arquivo}`);
      continue;
    }
    arquivos.push(arquivo);
    for (const espec of especificadores(texto)) {
      if (!espec.startsWith('.')) {
        externos.add(espec);
        const pacote = resolver(espec);
        if (pacote !== null) pendentes.push(pacote);
        continue;
      }
      const base = posix.normalize(posix.join(posix.dirname(arquivo), espec));
      const alvo = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((c) => ler(c) !== null);
      pendentes.push(alvo ?? base);
    }
  }
  return { arquivos: arquivos.sort(), externos: [...externos].sort() };
}

/** What the logger's closure may never reach. */
const proibidoNoFecho = (espec: string) =>
  espec.startsWith('?') ||
  espec.startsWith('firebase-admin') ||
  espec.startsWith('@delfrance/data') ||
  espec.startsWith('next') ||
  espec.startsWith('@/');

/**
 * The logger's entry points, and the valves', which step 3's functions bundle
 * imports too (the sanitizer's own, stricter closure is below). The valves keep
 * their own conta-id grammar: `core/contas.ts` would pull in the collections
 * handle, the credential store and the avisos.
 */
const ENTRADAS_DO_FECHO = [
  'core/log.ts',
  'core/redacao.ts',
  'core/refCredencial.ts',
  'core/valvulas.ts',
];

/* ----------------------------- the sanitizer ------------------------------ */

/** Node modules that open a connection or start a process, with or without `node:`. */
const MODULOS_DE_REDE_OU_PROCESSO = new Set([
  'http',
  'https',
  'http2',
  'net',
  'tls',
  'dns',
  'dgram',
  'child_process',
  'worker_threads',
  'cluster',
]);

/** What the sanitizer's closure may never import (the plan's list, plus the bare spellings). */
function proibidoNoSanitizador(espec: string): boolean {
  const modulo = espec.replace(/^node:/, '').split('/')[0] ?? '';
  return (
    espec.startsWith('?') ||
    espec.startsWith('firebase-admin') ||
    espec.startsWith('@delfrance/data') ||
    espec === '@delfrance/integrations-loja-integrada' ||
    espec.startsWith('@delfrance/integrations-loja-integrada/') ||
    espec.startsWith('next') ||
    espec.startsWith('@/') ||
    espec === 'undici' ||
    MODULOS_DE_REDE_OU_PROCESSO.has(modulo)
  );
}

/**
 * The ONLY external modules the sanitizer's closure imports. Fail closed: a new
 * one fails this test until it is added here, in review.
 */
const EXTERNOS_DO_SANITIZADOR = new Set([
  'zod',
  '@delfrance/core/wire',
  '@delfrance/core/documents',
  'node:fs',
  'node:path',
  'node:url',
  // The catalogue-id pseudonyms (`sanitizacao/pseudonimo.ts`): an HMAC, and the
  // random bytes of a new key. Computation only; it opens nothing.
  'node:crypto',
]);

/** The modules that hold the credential, the context or Firestore handles. */
const MODULOS_DE_CREDENCIAL = [
  'core/credentialStore',
  'core/contexto',
  'core/estacionamento',
  'core/credencial',
].map((m) => `lib/lojaIntegrada/${m}.ts`);

/**
 * Text that calls the network or loads code the import scan cannot see: a
 * builtin fetched at run time (`process.getBuiltinModule`, `process.binding`),
 * and a global or `process` member reached by a computed name
 * (`globalThis['fe' + 'tch']`), which no name-based pattern could follow.
 */
const CHAMADAS_PROIBIDAS = [
  /\bfetch\s*\(/,
  /\brequire\s*\(/,
  /\bcreateRequire\b/,
  /\bimport\s*\(\s*[^'"\s)]/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bgetBuiltinModule\b/,
  /\bprocess\s*\.\s*_?(?:linked)?[bB]inding\b/,
  /\b(?:globalThis|global|self|window|process)\s*(?:\?\.\s*)?\[/,
];

/** The workspace package the sanitizer's closure may import subpaths of (all allow-listed above). */
const PREFIXO_CORE = '@delfrance/core/';
/** Its `exports` map, read from its manifest: `./wire` → `./src/wire/index.ts`. */
const EXPORTACOES_DO_CORE = z
  .object({ exports: z.record(z.string(), z.string()) })
  .parse(
    JSON.parse(readFileSync(join(RAIZ_REPO, 'packages', 'core', 'package.json'), 'utf8')),
  ).exports;

/**
 * `@delfrance/core/<sub>` → its source file, relative to the APP root, so the
 * walk enters the package instead of trusting it: a `fetch` added there would
 * otherwise reach the sanitizer unseen.
 */
const resolverPacoteDoSanitizador: ResolvedorDePacote = (espec) => {
  if (!espec.startsWith(PREFIXO_CORE)) return null;
  const alvo = EXPORTACOES_DO_CORE[`./${espec.slice(PREFIXO_CORE.length)}`];
  return alvo === undefined ? null : posix.join('../../packages/core', alvo);
};

/** A file outside the app (a walked package): its doc comments discuss `fetch()` legitimately. */
const ehDePacote = (arquivo: string) => arquivo.startsWith('../');

/**
 * `texto` with every comment removed, by the TypeScript printer — so a quoted
 * `//` or a regex literal cannot fool it the way a hand-rolled stripper could.
 */
function semComentarios(texto: string): string {
  const fonte = ts.createSourceFile('x.ts', texto, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  return ts.createPrinter({ removeComments: true }).printFile(fonte);
}

/**
 * Why the closure from `entradas` (app-relative paths) breaks the sanitizer's
 * isolation; empty when it does not. The app's own files are scanned raw (a
 * comment that spells a call fails too); a walked package's, without comments.
 */
function violacoesDoSanitizador(
  entradas: readonly string[],
  lerBruto: LeitorDeFonte,
  resolver: ResolvedorDePacote = resolverPacoteDoSanitizador,
): string[] {
  const ler: LeitorDeFonte = (caminho) => {
    const texto = lerBruto(caminho);
    return texto !== null && ehDePacote(caminho) ? semComentarios(texto) : texto;
  };
  const fecho = fechoDeImportacoes(entradas, ler, resolver);
  const violacoes: string[] = [];
  for (const espec of fecho.externos) {
    if (proibidoNoSanitizador(espec)) violacoes.push(`imports ${espec}`);
    else if (!EXTERNOS_DO_SANITIZADOR.has(espec)) {
      violacoes.push(`imports ${espec} (not allow-listed)`);
    }
  }
  for (const arquivo of fecho.arquivos) {
    if (MODULOS_DE_CREDENCIAL.includes(arquivo)) violacoes.push(`reaches ${arquivo}`);
    const texto = ler(arquivo) ?? '';
    for (const re of CHAMADAS_PROIBIDAS) {
      if (re.test(texto)) violacoes.push(`${arquivo} matches ${re.source}`);
    }
  }
  return violacoes;
}

/* ---------------------------- the routing route ---------------------------- */

/** The label routing route (step 15): ERP reads and one guarded pedido write, nothing else. */
const ROTA_ETIQUETA =
  'app/api/marketplace/loja-integrada/pedidos/[pedidoId]/rota-etiqueta/route.ts';

/**
 * What the routing route's closure may never reach: the modules that hold a Loja Integrada
 * client's inputs (the credential, the context loader), the pacer and the read switch. A route
 * that calls nothing has no use for any of them.
 */
const MODULOS_FORA_DA_ROTA_ETIQUETA = [
  ...MODULOS_DE_CREDENCIAL,
  'lib/lojaIntegrada/core/valvulas.ts',
  'lib/lojaIntegrada/core/ritmo.ts',
  'lib/lojaIntegrada/core/contextoEscrita.ts',
];

/** The write context: no step-15 route may reach it, or name its factory or its loader. */
const MODULO_DO_CONTEXTO_DE_ESCRITA = 'lib/lojaIntegrada/core/contextoEscrita.ts';
const NOMES_DO_CONTEXTO_DE_ESCRITA = /\b(criarClienteEscritaLi|loadLojaIntegradaContextoEscrita)\b/;

/**
 * `texto` without its type-only imports and re-exports (`import type …`, `export type … from`):
 * they are erased at emit and load nothing at run time. Anything else stays — an inline
 * `import { type A } from 'x'` too, which keeps the module load under `verbatimModuleSyntax` —
 * so the walk follows every module the code can load.
 */
function semImportacoesDeTipo(texto: string): string {
  const fonte = ts.createSourceFile('x.ts', texto, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  let saida = texto;
  for (const s of [...fonte.statements].reverse()) {
    const soDeTipo =
      (ts.isImportDeclaration(s) && s.importClause?.isTypeOnly === true) ||
      (ts.isExportDeclaration(s) && s.isTypeOnly);
    if (soDeTipo) saida = saida.slice(0, s.getStart(fonte)) + saida.slice(s.getEnd());
  }
  return saida;
}

/**
 * `@/x` → the app-relative source file it names, so the walk enters the app's own aliased
 * modules instead of stopping at them. A name that resolves to no file is returned as is, and
 * the walk reports it as `?<path>` — fail closed.
 */
function resolverAliasDoApp(ler: LeitorDeFonte): ResolvedorDePacote {
  return (espec) => {
    if (!espec.startsWith('@/')) return null;
    const base = espec.slice(2);
    return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((c) => ler(c) !== null) ?? base;
  };
}

/**
 * Why the run-time closure from `entradas` (app-relative paths) lets the routing route reach
 * outside the ERP; empty when it does not. The files are scanned RAW for a `fetch` call: a comment
 * that spells one fails too.
 */
function violacoesDaRotaEtiqueta(entradas: readonly string[], lerBruto: LeitorDeFonte): string[] {
  const ler: LeitorDeFonte = (caminho) => {
    const texto = lerBruto(caminho);
    return texto === null ? null : semImportacoesDeTipo(texto);
  };
  const fecho = fechoDeImportacoes(entradas, ler, resolverAliasDoApp(ler));
  const violacoes: string[] = [];
  for (const espec of fecho.externos) {
    const modulo = espec.replace(/^node:/, '').split('/')[0] ?? '';
    if (
      espec.startsWith('?') ||
      espec === '@delfrance/integrations-loja-integrada' ||
      espec.startsWith('@delfrance/integrations-loja-integrada/') ||
      espec === 'undici' ||
      MODULOS_DE_REDE_OU_PROCESSO.has(modulo)
    ) {
      violacoes.push(`imports ${espec}`);
    }
  }
  for (const arquivo of fecho.arquivos) {
    if (MODULOS_FORA_DA_ROTA_ETIQUETA.includes(arquivo)) violacoes.push(`reaches ${arquivo}`);
    const texto = lerBruto(arquivo) ?? '';
    if (/\bfetch\s*\(/.test(texto)) violacoes.push(`${arquivo} calls fetch`);
    if (NOMES_DO_CONTEXTO_DE_ESCRITA.test(texto)) {
      violacoes.push(`${arquivo} names the write context`);
    }
  }
  return violacoes;
}

/* ------------------------------ the read routes ----------------------------- */

/** The paid re-check route (step 15): ERP reads, then ONE read through the context loader. */
const ROTA_PAGAMENTO = 'app/api/marketplace/loja-integrada/pedidos/[pedidoId]/pagamento/route.ts';

/** The conta route family's folder: the credential routes and the catalogue reads (step 10). */
const PASTA_DA_CONTA = 'app/api/marketplace/loja-integrada/conta/[id]';

/** The catalogue core every catalogue route delegates to. */
const NUCLEO_DO_CATALOGO = 'lib/lojaIntegrada/catalogo/catalogo.ts';

/**
 * Every route that READS Loja Integrada, with the core it delegates to: each must reach the store
 * through the context loader only. A new read route joins this list, or its closure goes unwalked.
 */
const ROTAS_DE_LEITURA_LI: readonly (readonly [string, string])[] = [
  [ROTA_PAGAMENTO, 'lib/lojaIntegrada/pedidos/conferenciaPagamento.ts'],
  [`${PASTA_DA_CONTA}/categorias/route.ts`, NUCLEO_DO_CATALOGO],
  [`${PASTA_DA_CONTA}/marcas/route.ts`, NUCLEO_DO_CATALOGO],
  [`${PASTA_DA_CONTA}/grades/route.ts`, NUCLEO_DO_CATALOGO],
  [`${PASTA_DA_CONTA}/grades/[gradeId]/route.ts`, NUCLEO_DO_CATALOGO],
];

/** The one module of a read route's closure allowed to build a Loja Integrada client. */
const CONSTRUTOR_DO_CLIENTE = 'lib/lojaIntegrada/core/contexto.ts';

/**
 * Why the run-time closure from `entradas` lets a read route reach Loja Integrada other than
 * through the context loader (whose first act is the read switch); empty when it does not. The
 * files are scanned RAW: a `fetch` call anywhere, or a client or a validating GET named outside
 * `core/contexto.ts`, fails — a comment that spells one too.
 */
function violacoesDaRotaDeLeitura(entradas: readonly string[], lerBruto: LeitorDeFonte): string[] {
  const ler: LeitorDeFonte = (caminho) => {
    const texto = lerBruto(caminho);
    return texto === null ? null : semImportacoesDeTipo(texto);
  };
  const fecho = fechoDeImportacoes(entradas, ler, resolverAliasDoApp(ler));
  const violacoes: string[] = [];
  for (const espec of fecho.externos) {
    const modulo = espec.replace(/^node:/, '').split('/')[0] ?? '';
    if (espec.startsWith('?') || espec === 'undici' || MODULOS_DE_REDE_OU_PROCESSO.has(modulo)) {
      violacoes.push(`imports ${espec}`);
    }
  }
  for (const arquivo of fecho.arquivos) {
    const texto = lerBruto(arquivo) ?? '';
    if (/\bfetch\s*\(/.test(texto)) violacoes.push(`${arquivo} calls fetch`);
    if (
      arquivo !== CONSTRUTOR_DO_CLIENTE &&
      /\b(criarClienteLeituraLi|validarPersonalToken)\b/.test(texto)
    ) {
      violacoes.push(`${arquivo} reaches Loja Integrada outside the context loader`);
    }
    // No exemption: not even the read context loader may reach or name the write one.
    if (arquivo === MODULO_DO_CONTEXTO_DE_ESCRITA) violacoes.push(`reaches ${arquivo}`);
    if (NOMES_DO_CONTEXTO_DE_ESCRITA.test(texto)) {
      violacoes.push(`${arquivo} names the write context`);
    }
  }
  return violacoes;
}

/* --------------------------- the write chokepoint -------------------------- */

/** The write engine: the ONE module that sends a write (requirement 9). */
const ARQUIVO_DO_MOTOR = 'lib/lojaIntegrada/core/escrita.ts';

/**
 * Who may NAME each write identifier, by full app-relative path — never by basename: the app
 * already has `sanitizacao/escrita.ts`, `pedidos/escritaPedido.ts` and `pedidos/escritaPagamento.ts`.
 * Word-bounded, and read raw (a comment that names one counts): an aliased import or a method
 * reference names it too, while a longer name built on it does not.
 */
const DONOS_DA_ESCRITA: readonly { readonly nome: RegExp; readonly donos: readonly string[] }[] = [
  { nome: /\bcriarClienteEscritaLi\b/, donos: [MODULO_DO_CONTEXTO_DE_ESCRITA] },
  {
    nome: /\b(?:atualizarObjetoEnvioLi|alterarSituacaoPedidoLi|lerAntesDeEscreverLi|enviarEscritaLi)\b/,
    donos: [ARQUIVO_DO_MOTOR],
  },
  { nome: /\bLiEscritaClient\b/, donos: [MODULO_DO_CONTEXTO_DE_ESCRITA, ARQUIVO_DO_MOTOR] },
  // The package's request core sends a write without the write client: nobody here names it.
  { nome: /\bexecutarLi\b/, donos: [] },
];

/** The package, whose manifest publishes its root alone. */
const PACOTE_LI = '@delfrance/integrations-loja-integrada';

/**
 * A specifier that reaches the package's files by PATH (a relative `…/integrations/loja-integrada/src/…`):
 * it bypasses the manifest, and so the root's surface, exactly as a subpath would.
 */
const CAMINHO_DO_PACOTE_LI = /(?:^|\/)integrations\/loja-integrada(?:\/|$)/;

/** The chokepoint scans non-test source: a test and `lib/lojaIntegrada/testing/**` name the fakes. */
const ehFonteDaEscrita = (arquivo: string) =>
  !ehTeste(arquivo) && !arquivo.startsWith('lib/lojaIntegrada/testing/');

/**
 * App source that is neither a test, the shared test doubles, nor the test runner's own
 * config and setup files (`vitest.*` at the app root): what must never import `testing/`.
 */
const ehFonteQueNaoTesta = (arquivo: string) =>
  ehFonteDaEscrita(arquivo) && !/^vitest\.[^/]+$/.test(arquivo);

/** The `testing/` imports of a source text (`arquivo` relative to the app root): relative, aliased or deep. */
function importacoesDeTesting(arquivo: string, texto: string): string[] {
  return especificadores(texto)
    .filter((espec) => /(?:^|\/)testing\//.test(espec))
    .map((espec) => `${arquivo} imports ${espec}`);
}

/** Why a source text (`arquivo` relative to the app root) breaks the write chokepoint; empty when it does not. */
function violacoesDaEscrita(arquivo: string, texto: string): string[] {
  const violacoes: string[] = [];
  for (const { nome, donos } of DONOS_DA_ESCRITA) {
    const achado = nome.exec(texto);
    if (achado !== null && !donos.includes(arquivo)) {
      violacoes.push(`${arquivo} names ${achado[0]}`);
    }
  }
  for (const espec of especificadores(texto)) {
    if (espec.startsWith(`${PACOTE_LI}/`) || CAMINHO_DO_PACOTE_LI.test(espec)) {
      violacoes.push(`${arquivo} imports ${espec}`);
    }
  }
  return violacoes;
}

const LINHA_WIRE_PRETTIER = 'apps/loja-integrada/lib/lojaIntegrada/fixtures/__wire__/';
const LINHA_WIRE_ATRIBUTOS =
  'apps/loja-integrada/lib/lojaIntegrada/fixtures/__wire__/** text eol=lf';

/** The one file allowed to see the raw call event and build an observer. */
const ARQUIVO_DO_LOGGER = 'lib/lojaIntegrada/core/log.ts';
/** The logger as a module, relative to the app root (`@/` resolves there). */
const MODULO_DO_LOGGER = 'lib/lojaIntegrada/core/log';
const PROPRIEDADE = 'onChamada: ';
const SEAM_OK = `${PROPRIEDADE}criarObservadorLi(`;

/**
 * The index of the `)` that closes the `(` at `abre`, skipping quoted text, or
 * -1 when it never closes.
 */
function fimDaChamada(texto: string, abre: number): number {
  let nivel = 0;
  let aspas: string | null = null;
  for (let i = abre; i < texto.length; i++) {
    const c = texto[i];
    if (aspas !== null) {
      if (c === '\\') i++;
      else if (c === aspas) aspas = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') aspas = c;
    else if (c === '(') nivel += 1;
    else if (c === ')') {
      nivel -= 1;
      if (nivel === 0) return i;
    }
  }
  return -1;
}

/** A specifier as an app-relative module path (`@/x` → `x`, `./x` against the file). */
function moduloDe(arquivo: string, espec: string): string {
  if (espec.startsWith('@/')) return espec.slice(2);
  if (espec.startsWith('.')) return posix.normalize(posix.join(posix.dirname(arquivo), espec));
  return espec;
}

/**
 * Why a source text (`arquivo` relative to the app root) breaks the observer
 * seam; empty when it does not.
 *
 * 1. Every `onChamada` is `onChamada: criarObservadorLi(…)`, and that call is
 *    the WHOLE value: the next token after its closing `)` is `,` or `}` — so
 *    `criarObservadorLi(…) && ((e) => …)` cannot slip an inline observer in.
 * 2. A file that has the seam imports `criarObservadorLi` under its own name
 *    from the logger module, and every other mention of the name is one of its
 *    seam calls — so a local function, a parameter or a renamed import of the
 *    same name cannot stand in for it.
 * 3. No file names the raw event type.
 */
function violacoesDoSeam(arquivo: string, texto: string): string[] {
  if (arquivo === ARQUIVO_DO_LOGGER) return [];
  const violacoes: string[] = [];
  const chamadas = new Set<number>();
  let i = texto.indexOf('onChamada');
  while (i !== -1) {
    if (!texto.startsWith(SEAM_OK, i)) {
      violacoes.push(`${arquivo}: onChamada at ${String(i)} is not ${SEAM_OK}…)`);
    } else {
      const nome = i + PROPRIEDADE.length;
      chamadas.add(nome);
      const fim = fimDaChamada(texto, i + SEAM_OK.length - 1);
      const depois =
        fim === -1
          ? ''
          : texto
              .slice(fim + 1)
              .trimStart()
              .charAt(0);
      if (depois !== ',' && depois !== '}') {
        violacoes.push(`${arquivo}: the observer at ${String(nome)} is not the whole value`);
      }
    }
    i = texto.indexOf('onChamada', i + 1);
  }
  if (chamadas.size > 0) {
    const importacoes: (readonly [number, number])[] = [];
    for (const m of texto.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
      const nomes = (m[1] ?? '').split(',').map((n) => n.trim());
      if (
        nomes.includes('criarObservadorLi') &&
        moduloDe(arquivo, m[2] ?? '') === MODULO_DO_LOGGER
      ) {
        importacoes.push([m.index, m.index + m[0].length]);
      }
    }
    const fora = [...texto.matchAll(/\bcriarObservadorLi\b/g)]
      .map((m) => m.index)
      .filter((j) => !chamadas.has(j) && !importacoes.some(([a, b]) => j >= a && j < b));
    if (importacoes.length === 0 || fora.length > 0) {
      violacoes.push(
        `${arquivo}: criarObservadorLi is not the logger's (imported from it: ${String(importacoes.length > 0)}; other mentions at ${fora.join(', ') || 'none'})`,
      );
    }
  }
  if (/\bChamadaLi\b/.test(texto)) violacoes.push(`${arquivo}: names ChamadaLi`);
  return violacoes;
}

describe('lib/lojaIntegrada layout', () => {
  const todos = arquivosTs(RAIZ_LIB);
  const fontes = todos.filter((p) => !ehTeste(p));

  it('the scan found the tree', () => {
    expect(fontes.map(rel)).toEqual(
      expect.arrayContaining([
        'avisos/avisos.ts',
        'catalogo/cache.ts',
        'catalogo/catalogo.ts',
        'conta/expiracaoSweep.ts',
        'conta/status.ts',
        'conta/validade.ts',
        'core/credentialStore.ts',
        'core/estacionamento.ts',
        'core/contexto.ts',
        'core/contextoEscrita.ts',
        'core/escrita.ts',
        'core/igualdadeJsonLi.ts',
        'core/respond.ts',
        'core/log.ts',
        'core/redacao.ts',
        'core/refCredencial.ts',
        'core/valvulas.ts',
        'core/ritmo.ts',
        'notificacoes/notificacao.ts',
        'pedidos/dataLi.ts',
        'pedidos/janelaPoll.ts',
        'pedidos/orcamentoPoll.ts',
        'pedidos/pollPedidos.ts',
        'pedidos/rotaEtiqueta.ts',
        'sanitizacao/requisicao.ts',
        'sanitizacao/local.ts',
        'sanitizacao/lote.ts',
        'sanitizacao/capturaParaFixture.ts',
        'sanitizacao/folhas.ts',
        'sanitizacao/executar.ts',
        'sanitizacao/escrita.ts',
        'sanitizacao/pseudonimo.ts',
        'sanitizacao/sistemaNode.ts',
        'fixtures/piiScan.ts',
        'fixtures/wireCorpus.ts',
      ]),
    );
  });

  it('only core/respond.ts imports next/*, and nothing imports the @/ alias', () => {
    for (const arquivo of fontes) {
      const texto = readFileSync(arquivo, 'utf8');
      const importaNext = /from 'next(\/[^']*)?'/.test(texto);
      expect(importaNext, rel(arquivo)).toBe(rel(arquivo) === 'core/respond.ts');
      expect(/from '@\//.test(texto), rel(arquivo)).toBe(false);
    }
  });

  it('reads no process.env', () => {
    for (const arquivo of fontes) {
      expect(readFileSync(arquivo, 'utf8'), rel(arquivo)).not.toContain('process.env');
    }
  });

  it('testing/ is imported by tests only — anywhere in the app (the chokepoint exempts testing/, so nothing else may reach it)', () => {
    const fontesDoApp = arquivosTs(RAIZ_APP).map(relApp).filter(ehFonteQueNaoTesta);
    const violacoes = fontesDoApp.flatMap((p) => importacoesDeTesting(p, lerDoApp(p) ?? ''));
    expect(violacoes).toEqual([]);
    // Anti-vacuity: the scan reached the app's other roots, not only this tree.
    expect(fontesDoApp).toEqual(
      expect.arrayContaining([
        'functions/src/index.ts',
        ...ROTAS_DE_LEITURA_LI.map(([rota]) => rota),
        NUCLEO_DO_CATALOGO,
        MODULO_DO_CONTEXTO_DE_ESCRITA,
        'proxy.ts',
      ]),
    );
    expect(fontesDoApp.some((p) => p.startsWith('lib/lojaIntegrada/testing/'))).toBe(false);
  });

  it('core/redacao.ts and core/refCredencial.ts import only zod and @delfrance/core/*', () => {
    const permitido = (espec: string) => espec === 'zod' || espec.startsWith('@delfrance/core/');
    for (const arquivo of ['core/redacao.ts', 'core/refCredencial.ts']) {
      const texto = lerDoDisco(arquivo);
      expect(texto, arquivo).not.toBeNull();
      expect(
        especificadores(texto ?? '').filter((e) => !permitido(e)),
        arquivo,
      ).toEqual([]);
    }
    // Anti-vacuity: the reader sees the redactor's real imports.
    expect(especificadores(lerDoDisco('core/redacao.ts') ?? '')).toEqual(
      expect.arrayContaining(['zod', '@delfrance/core/wire', '@delfrance/core/documents']),
    );
  });

  it('core/igualdadeJsonLi.ts is a LEAF: it imports nothing, so every closure that embeds it stays as it is', () => {
    const texto = lerDoDisco('core/igualdadeJsonLi.ts');
    expect(texto).not.toBeNull();
    expect(texto).toContain('export function deepEqual(');
    expect(especificadores(texto ?? '')).toEqual([]);
  });

  it("the logger's and the valves' import closure reaches no Admin SDK, admin data layer, Next or @/ alias", () => {
    const fecho = fechoDeImportacoes(ENTRADAS_DO_FECHO, lerDoDisco);
    expect(fecho.arquivos).toEqual(ENTRADAS_DO_FECHO.slice().sort());
    expect(fecho.externos.filter(proibidoNoFecho)).toEqual([]);
  });

  it('the observer seam: only criarObservadorLi(…) is handed to the package, and only log.ts names the raw event', () => {
    const fontes = arquivosTs(RAIZ_APP).filter((p) => !ehTeste(p));
    const violacoes = fontes.flatMap((p) => violacoesDoSeam(relApp(p), readFileSync(p, 'utf8')));
    expect(violacoes).toEqual([]);
    // Anti-vacuity: the four wired sites exist, and the logger itself is exempt.
    const sites = fontes.filter((p) => readFileSync(p, 'utf8').includes(SEAM_OK)).map(relApp);
    expect(sites.sort()).toEqual([
      'app/api/marketplace/loja-integrada/conta/[id]/credencial/route.ts',
      'app/api/marketplace/loja-integrada/conta/[id]/credencial/validade/route.ts',
      'lib/lojaIntegrada/core/contexto.ts',
      'lib/lojaIntegrada/core/contextoEscrita.ts',
    ]);
    // The write context builds TWO clients, each with its own inline observer (never a shared const).
    const doContextoDeEscrita = lerDoApp(MODULO_DO_CONTEXTO_DE_ESCRITA) ?? '';
    expect(doContextoDeEscrita.split(SEAM_OK)).toHaveLength(3);
    expect(fontes.map(relApp)).toContain(ARQUIVO_DO_LOGGER);
  });

  it('the sanitizer cannot reach a network, a process, a token or Firestore', () => {
    const entradas = [
      ...fontes
        .map(relApp)
        .filter(
          (p) =>
            p.startsWith('lib/lojaIntegrada/sanitizacao/') ||
            p.startsWith('lib/lojaIntegrada/fixtures/'),
        ),
      'scripts/sanitizar.ts',
    ];
    expect(violacoesDoSanitizador(entradas, lerDoApp)).toEqual([]);
    // Anti-vacuity: the walk reached the script, the run and the redactor, and saw real imports.
    const fecho = fechoDeImportacoes(entradas, lerDoApp, resolverPacoteDoSanitizador);
    expect(fecho.arquivos).toEqual(
      expect.arrayContaining([
        'scripts/sanitizar.ts',
        'lib/lojaIntegrada/sanitizacao/executar.ts',
        'lib/lojaIntegrada/sanitizacao/escrita.ts',
        'lib/lojaIntegrada/sanitizacao/pseudonimo.ts',
        'lib/lojaIntegrada/sanitizacao/sistemaNode.ts',
        'lib/lojaIntegrada/fixtures/piiScan.ts',
        'lib/lojaIntegrada/core/redacao.ts',
        // The shared comparator leaf, which imports nothing.
        'lib/lojaIntegrada/core/igualdadeJsonLi.ts',
        // The allow-listed workspace packages are walked too, not trusted.
        '../../packages/core/src/wire/index.ts',
        '../../packages/core/src/wire/prazo.ts',
        '../../packages/core/src/documents/index.ts',
      ]),
    );
    expect(fecho.externos).toEqual(expect.arrayContaining(['node:fs', 'zod']));
  });

  it('the label routing route calls nothing outside the ERP: no package client, credential, context, pacer, read switch or fetch in its run-time closure', () => {
    expect(violacoesDaRotaEtiqueta([ROTA_ETIQUETA], lerDoApp)).toEqual([]);
    // Anti-vacuity: the walk entered the route's own modules through the alias, and saw the
    // data layer it does use.
    const ler: LeitorDeFonte = (c) => {
      const texto = lerDoApp(c);
      return texto === null ? null : semImportacoesDeTipo(texto);
    };
    const fecho = fechoDeImportacoes([ROTA_ETIQUETA], ler, resolverAliasDoApp(ler));
    expect(fecho.arquivos).toEqual(
      expect.arrayContaining([
        ROTA_ETIQUETA,
        'lib/lojaIntegrada/pedidos/rotaEtiqueta.ts',
        'lib/lojaIntegrada/core/respond.ts',
        'lib/lojaIntegrada/core/erros.ts',
        'lib/auth/verifyCaller.ts',
      ]),
    );
    expect(fecho.externos).toEqual(
      expect.arrayContaining([
        '@delfrance/schemas',
        '@delfrance/data/admin/collections',
        '@delfrance/data/admin/grpcErrors',
      ]),
    );
    // The type-only import of the package in `core/respond.ts` is real, and set aside.
    expect(lerDoApp('lib/lojaIntegrada/core/respond.ts')).toContain(
      "import type { ValidacaoTokenLi } from '@delfrance/integrations-loja-integrada';",
    );
  });

  it.each(ROTAS_DE_LEITURA_LI)(
    'the read route %s reaches Loja Integrada only through the context loader: no fetch, and no client or validating GET of its own, in its run-time closure',
    (rota, nucleo) => {
      expect(lerDoApp(rota), rota).not.toBeNull();
      expect(violacoesDaRotaDeLeitura([rota], lerDoApp)).toEqual([]);
      // Anti-vacuity: the walk entered the core and the context loader, and the exemption is real.
      const ler: LeitorDeFonte = (c) => {
        const texto = lerDoApp(c);
        return texto === null ? null : semImportacoesDeTipo(texto);
      };
      const fecho = fechoDeImportacoes([rota], ler, resolverAliasDoApp(ler));
      expect(fecho.arquivos).toEqual(
        expect.arrayContaining([rota, nucleo, CONSTRUTOR_DO_CLIENTE, 'lib/auth/verifyCaller.ts']),
      );
      expect(fecho.externos).toContain('@delfrance/integrations-loja-integrada');
      expect(lerDoApp(CONSTRUTOR_DO_CLIENTE)).toContain('criarClienteLeituraLi({');
    },
  );

  it('every route file under the conta folder is in ROTAS_DE_LEITURA_LI or one of the credential routes (a new read route cannot skip the walk)', () => {
    const naPasta = arquivosTs(RAIZ_APP)
      .map(relApp)
      .filter((p) => p.startsWith(`${PASTA_DA_CONTA}/`) && p.endsWith('/route.ts'));
    const listadas = new Set(ROTAS_DE_LEITURA_LI.map(([rota]) => rota));
    // The status route calls nothing, and the credential routes read the conta uncached and
    // validate a candidate token: each has its own guard (`prazos.test.ts`), and none goes
    // through the context loader.
    const daCredencial = new Set([
      `${PASTA_DA_CONTA}/route.ts`,
      `${PASTA_DA_CONTA}/credencial/route.ts`,
      `${PASTA_DA_CONTA}/credencial/validade/route.ts`,
    ]);
    expect(naPasta.filter((p) => !listadas.has(p) && !daCredencial.has(p))).toEqual([]);
    // Anti-vacuity: the scan found the four catalogue routes and the three credential ones.
    expect(naPasta.filter((p) => listadas.has(p))).toHaveLength(4);
    expect(naPasta.filter((p) => daCredencial.has(p))).toHaveLength(3);
  });

  it('the write chokepoint: only core/contextoEscrita.ts builds a write client, only core/escrita.ts calls a write operation or method, no source imports a package subpath', () => {
    const fontes = arquivosTs(RAIZ_APP).map(relApp).filter(ehFonteDaEscrita);
    const violacoes = fontes.flatMap((p) => violacoesDaEscrita(p, lerDoApp(p) ?? ''));
    expect(violacoes).toEqual([]);
    // Anti-vacuity: the scan reached the owners, and they really hold the calls.
    expect(fontes).toEqual(
      expect.arrayContaining([
        ARQUIVO_DO_MOTOR,
        MODULO_DO_CONTEXTO_DE_ESCRITA,
        ROTA_PAGAMENTO,
        NUCLEO_DO_CATALOGO,
      ]),
    );
    const motor = lerDoApp(ARQUIVO_DO_MOTOR) ?? '';
    expect(motor).toContain('atualizarObjetoEnvioLi(');
    expect(motor).toContain('alterarSituacaoPedidoLi(');
    expect(motor).toContain('.lerAntesDeEscreverLi(');
    expect(lerDoApp(MODULO_DO_CONTEXTO_DE_ESCRITA)).toContain('criarClienteEscritaLi({');
  });

  it('scripts/ is typechecked and linted: the tsconfig includes **/*.ts, the ESLint config ignores nothing of it', () => {
    const tsconfig = readFileSync(join(RAIZ_APP, 'tsconfig.json'), 'utf8');
    expect(tsconfig).toContain('"**/*.ts"');
    expect(readFileSync(join(RAIZ_APP, 'eslint.config.mjs'), 'utf8')).not.toMatch(/\bignores\b/);
    expect(existsSync(join(RAIZ_APP, 'scripts', 'sanitizar.ts'))).toBe(true);
  });

  it('the committed corpus keeps its .prettierignore and .gitattributes lines', () => {
    const linhas = (arquivo: string) =>
      readFileSync(join(RAIZ_REPO, arquivo), 'utf8').split(/\r?\n/);
    expect(linhas('.prettierignore')).toContain(LINHA_WIRE_PRETTIER);
    expect(linhas('.gitattributes')).toContain(LINHA_WIRE_ATRIBUTOS);
  });

  it('no file of this app names the multi-document atomic-write call', () => {
    const palavra = ['run', 'Transaction'].join('');
    const arquivos = arquivosTs(RAIZ_APP);
    expect(arquivos.length).toBeGreaterThan(20);
    for (const arquivo of arquivos) {
      expect(readFileSync(arquivo, 'utf8').includes(palavra), relative(RAIZ_APP, arquivo)).toBe(
        false,
      );
    }
  });
});

// The two guards above can only fail on a file that does not exist yet, so pin
// them on synthetic source text: each must flag what it exists to flag.
describe('the guards, on synthetic source', () => {
  const leitor =
    (arquivos: Readonly<Record<string, string>>): LeitorDeFonte =>
    (caminho) =>
      Object.hasOwn(arquivos, caminho) ? (arquivos[caminho] ?? null) : null;

  it('import closure: log.ts → refCredencial.ts is accepted', () => {
    const fecho = fechoDeImportacoes(
      ['core/log.ts'],
      leitor({
        'core/log.ts': "import { versaoDaRef } from './refCredencial';\nimport { z } from 'zod';",
        'core/refCredencial.ts': 'export const x = 1;',
      }),
    );
    expect(fecho.arquivos).toEqual(['core/log.ts', 'core/refCredencial.ts']);
    expect(fecho.externos.filter(proibidoNoFecho)).toEqual([]);
  });

  it('import closure: log.ts → credencial.ts is flagged, through what credencial.ts imports', () => {
    const fecho = fechoDeImportacoes(
      ['core/log.ts'],
      leitor({
        'core/log.ts': "import { versaoDaRef } from './credencial';",
        'core/credencial.ts': "import { sha256Hex } from '@delfrance/data/admin';",
      }),
    );
    expect(fecho.externos.filter(proibidoNoFecho)).toEqual(['@delfrance/data/admin']);
  });

  it("import closure: valvulas.ts → log.ts is accepted; valvulas.ts → contas.ts is flagged, through Firestore's handle", () => {
    const aceito = fechoDeImportacoes(
      ['core/valvulas.ts'],
      leitor({
        'core/valvulas.ts': "import { registrarEventoLi } from './log';",
        'core/log.ts': "import { versaoDaRef } from './refCredencial';",
        'core/refCredencial.ts': 'export const x = 1;',
      }),
    );
    expect(aceito.externos.filter(proibidoNoFecho)).toEqual([]);
    const recusado = fechoDeImportacoes(
      ['core/valvulas.ts'],
      leitor({
        'core/valvulas.ts': "import { naoEhIdDeConta } from './contas';",
        'core/contas.ts':
          "import { integracaoCollection } from '@delfrance/data/admin/collections';",
      }),
    );
    expect(recusado.externos.filter(proibidoNoFecho)).toEqual([
      '@delfrance/data/admin/collections',
    ]);
  });

  it.each([
    ["import type { Firestore } from 'firebase-admin/firestore';", 'firebase-admin/firestore'],
    ["import { NextResponse } from 'next/server';", 'next/server'],
    ["import { x } from '@/lib/firebase/admin';", '@/lib/firebase/admin'],
    ["const m = await import('@delfrance/data/admin/cache');", '@delfrance/data/admin/cache'],
    ["export { y } from './sumiu';", '?core/sumiu'],
  ])('import closure flags %s', (fonte, esperado) => {
    const fecho = fechoDeImportacoes(['core/log.ts'], leitor({ 'core/log.ts': fonte }));
    expect(fecho.externos.filter(proibidoNoFecho)).toEqual([esperado]);
  });

  const IMPORTA_DO_LOGGER = "import { criarObservadorLi } from './log';\n";

  it.each([
    ['an inline observer', 'cliente({ onChamada: (e) => console.warn(e) })'],
    ['a forwarded one', 'cliente({ onChamada: deps.x })'],
    ['the shorthand', 'cliente({ onChamada })'],
    ['a destructured one', 'const { onChamada } = deps;'],
    [
      'the raw event type',
      "import type { ChamadaLi } from '@delfrance/integrations-loja-integrada';",
    ],
    [
      'the call combined with an inline observer',
      `${IMPORTA_DO_LOGGER}cliente({ onChamada: criarObservadorLi({ conta }) && ((e) => console.warn(e.corpo)) })`,
    ],
    [
      'the call combined with a forwarded one',
      `${IMPORTA_DO_LOGGER}cliente({ onChamada: criarObservadorLi({ conta }) || deps.x, x: 1 })`,
    ],
    [
      'an unbalanced call',
      `${IMPORTA_DO_LOGGER}cliente({ onChamada: criarObservadorLi({ conta: f(") })`,
    ],
    [
      'a local function of the same name',
      'const criarObservadorLi = (o) => (e) => console.log(e.corpo);\n' +
        'cliente({ onChamada: criarObservadorLi({ conta }) });',
    ],
    [
      'the name imported from elsewhere',
      "import { criarObservadorLi } from './outro/log';\n" +
        'cliente({ onChamada: criarObservadorLi({ conta }) });',
    ],
    [
      'another export renamed to the name',
      "import { escritorPadrao as criarObservadorLi } from './log';\n" +
        'cliente({ onChamada: criarObservadorLi({ conta }) });',
    ],
    [
      'a parameter that shadows the import',
      `${IMPORTA_DO_LOGGER}function f(criarObservadorLi) { return cliente({ onChamada: criarObservadorLi({ conta }) }); }`,
    ],
  ])('seam flags %s', (_caso, fonte) => {
    expect(violacoesDoSeam('lib/lojaIntegrada/core/contexto.ts', fonte)).toHaveLength(1);
  });

  const SANITIZADOR = 'lib/lojaIntegrada/sanitizacao/x.ts';
  const comRedator = (fonte: string) =>
    leitor({
      [SANITIZADOR]: fonte,
      'lib/lojaIntegrada/core/redacao.ts': "import { z } from 'zod';",
      'lib/lojaIntegrada/core/contexto.ts':
        "import { x } from '@delfrance/integrations-loja-integrada';",
    });

  it('sanitizer closure: node:fs, zod and the redactor are accepted', () => {
    expect(
      violacoesDoSanitizador(
        [SANITIZADOR],
        comRedator("import { readFileSync } from 'node:fs';\nimport { x } from '../core/redacao';"),
      ),
    ).toEqual([]);
  });

  it.each([
    ['a call to fetch(', "export const f = () => fetch('https://x.example');"],
    ['an import of ../core/contexto', "import { y } from '../core/contexto';"],
    ['node:child_process', "import { spawn } from 'node:child_process';"],
    ['bare child_process', "import { spawn } from 'child_process';"],
    ['node:https', "import https from 'node:https';"],
    ['dns/promises', "import { lookup } from 'node:dns/promises';"],
    ['undici', "import { request } from 'undici';"],
    ['the package client', "import { URL_BASE_LI } from '@delfrance/integrations-loja-integrada';"],
    ['the Admin SDK', "import type { Firestore } from 'firebase-admin/firestore';"],
    ['the admin data layer', "import { x } from '@delfrance/data/admin';"],
    ['a module off the allow-list', "import pad from 'left-pad';"],
    ['a dynamic import of a computed name', 'const m = await import(nome);'],
    ['a require call', "const m = require('x');"],
    ['process.getBuiltinModule', "export const h = process.getBuiltinModule('node:https');"],
    ['process.binding', "export const t = process.binding('tcp_wrap');"],
    [
      'a global reached by a computed name',
      "export const f = (globalThis['fe' + 'tch'] as (u: string) => unknown)('https://x.invalid');",
    ],
  ])('sanitizer closure flags %s', (_caso, fonte) => {
    expect(violacoesDoSanitizador([SANITIZADOR], comRedator(fonte)).length).toBeGreaterThan(0);
  });

  // A network module is FORBIDDEN, not merely off the allow-list: allow-listing it
  // in review must still fail. Both spellings; the modules spelled out here, not
  // read from the set under test, so dropping one from the set fails.
  it.each(
    [
      'http',
      'https',
      'http2',
      'net',
      'tls',
      'dns',
      'dgram',
      'child_process',
      'worker_threads',
      'cluster',
    ].flatMap((m) => [`node:${m}`, m, `node:${m}/promises`]),
  )('sanitizer closure forbids %s even if it were allow-listed', (espec) => {
    expect(proibidoNoSanitizador(espec)).toBe(true);
    expect(
      violacoesDoSanitizador([SANITIZADOR], comRedator(`import x from '${espec}';`)),
    ).toContain(`imports ${espec}`);
  });

  /** An allow-listed workspace package, walked like the app's own files. */
  const PACOTE = '../../packages/core/src/wire/index.ts';
  const comPacote = (fontePacote: string, extras: Readonly<Record<string, string>> = {}) =>
    leitor({
      [SANITIZADOR]: "import { lerRespostaJson } from '@delfrance/core/wire';",
      [PACOTE]: fontePacote,
      ...extras,
    });
  const resolver = (espec: string) => (espec === '@delfrance/core/wire' ? PACOTE : null);

  it('sanitizer closure: an allow-listed package is walked, and its comments are not code', () => {
    const fonte = "import { z } from 'zod';\n/** `fetch()` has no timeout. */\nexport const x = 1;";
    expect(violacoesDoSanitizador([SANITIZADOR], comPacote(fonte), resolver)).toEqual([]);
    expect(fechoDeImportacoes([SANITIZADOR], comPacote(fonte), resolver).arquivos).toEqual([
      PACOTE,
      SANITIZADOR,
    ]);
  });

  it.each([
    ['a fetch call', "export const f = () => fetch('https://x.invalid');"],
    ['a network module', "import { request } from 'node:https';"],
    ['a module off the allow-list', "import pad from 'left-pad';"],
    ['the same, one relative import deeper', "export { y } from './prazo';"],
  ])('sanitizer closure flags, inside an allow-listed package, %s', (_caso, fonte) => {
    const extras = { '../../packages/core/src/wire/prazo.ts': "export const y = fetch('x');" };
    expect(
      violacoesDoSanitizador([SANITIZADOR], comPacote(fonte, extras), resolver).length,
    ).toBeGreaterThan(0);
  });

  const ROTA = 'app/x/route.ts';
  const NUCLEO = 'lib/lojaIntegrada/pedidos/x.ts';
  const daRota = (nucleo: string, rota = "import { f } from '@/lib/lojaIntegrada/pedidos/x';") =>
    leitor({
      [ROTA]: rota,
      [NUCLEO]: nucleo,
      'lib/lojaIntegrada/core/contexto.ts':
        "import { x } from '@delfrance/integrations-loja-integrada';",
      'lib/lojaIntegrada/core/valvulas.ts': 'export const v = 1;',
      'lib/lojaIntegrada/core/erros.ts': 'export class E extends Error {}',
      [MODULO_DO_CONTEXTO_DE_ESCRITA]: "import { y } from '../core/erros';",
    });

  it('routing route closure: the data layer, an app error and a TYPE-only import of the package are accepted', () => {
    const nucleo =
      "import { pedidoCollection } from '@delfrance/data/admin/collections';\n" +
      "import type { LiError } from '@delfrance/integrations-loja-integrada';\n" +
      "export type { LiAuthError } from '@delfrance/integrations-loja-integrada';\n" +
      "import { E } from '../core/erros';";
    expect(violacoesDaRotaEtiqueta([ROTA], daRota(nucleo))).toEqual([]);
  });

  it.each([
    [
      'the package client',
      "import { criarClienteLeituraLi } from '@delfrance/integrations-loja-integrada';",
    ],
    ['a package subpath', "import { x } from '@delfrance/integrations-loja-integrada/pedidos';"],
    [
      'an INLINE type specifier (the module still loads)',
      "import { type LiError } from '@delfrance/integrations-loja-integrada';",
    ],
    ['the context loader', "import { loadLojaIntegradaContext } from '../core/contexto';"],
    [
      'the WRITE context (a module that itself names nothing forbidden)',
      "import { y } from '../core/contextoEscrita';",
    ],
    [
      'the write context’s loader, by name',
      'export const z = (c: { loadLojaIntegradaContextoEscrita: unknown }) => c;',
    ],
    ['the read switch', "import { lerChamadasLi } from '../core/valvulas';"],
    ['a fetch call', "export const f = () => fetch('https://x.invalid');"],
    ['a network module', "import { request } from 'node:https';"],
    ['undici', "import { request } from 'undici';"],
  ])('routing route closure flags, one module deep, %s', (_caso, nucleo) => {
    expect(violacoesDaRotaEtiqueta([ROTA], daRota(nucleo)).length).toBeGreaterThan(0);
  });

  it('routing route closure flags an alias that resolves to no file (fail closed)', () => {
    expect(
      violacoesDaRotaEtiqueta([ROTA], daRota('', "import { f } from '@/lib/lojaIntegrada/sumiu';")),
    ).toEqual(['imports ?lib/lojaIntegrada/sumiu']);
  });

  const LEITURA = 'app/y/route.ts';
  const daRotaDeLeitura = (
    nucleo: string,
    construtor = "import { criarClienteLeituraLi } from '@delfrance/integrations-loja-integrada';\n" +
      'export const c = () => criarClienteLeituraLi({});',
  ) =>
    leitor({
      [LEITURA]: "import { f } from '@/lib/lojaIntegrada/pedidos/y';",
      'lib/lojaIntegrada/pedidos/y.ts': nucleo,
      [CONSTRUTOR_DO_CLIENTE]: construtor,
      [MODULO_DO_CONTEXTO_DE_ESCRITA]: 'export const w = 1;',
    });

  it('read route closure: the context loader building the client, and the package read through it, are accepted', () => {
    const nucleo =
      "import { buscarPedidoLi } from '@delfrance/integrations-loja-integrada';\n" +
      "import { c } from '../core/contexto';\n" +
      'export const f = () => buscarPedidoLi(c(), 1);';
    expect(violacoesDaRotaDeLeitura([LEITURA], daRotaDeLeitura(nucleo))).toEqual([]);
  });

  it.each([
    [
      'a client built outside the context loader',
      "import { criarClienteLeituraLi } from '@delfrance/integrations-loja-integrada';",
    ],
    [
      'a validating GET',
      "import { validarPersonalToken } from '@delfrance/integrations-loja-integrada';",
    ],
    ['a fetch call', "export const f = () => fetch('https://x.invalid');"],
    ['a network module', "import { request } from 'node:https';"],
    ['an alias that resolves to no file', "import { f } from '@/lib/lojaIntegrada/sumiu';"],
  ])('read route closure flags, one module deep, %s', (_caso, nucleo) => {
    expect(violacoesDaRotaDeLeitura([LEITURA], daRotaDeLeitura(nucleo)).length).toBeGreaterThan(0);
  });

  it.each([
    ['the write context module', "import { w } from '../core/contextoEscrita';"],
    [
      'the write client factory, even imported for its type position',
      "import { criarClienteEscritaLi } from '@delfrance/integrations-loja-integrada';",
    ],
    ['the write context loader, by name', 'export const n = "loadLojaIntegradaContextoEscrita";'],
  ])('read route closure flags the write side: %s', (_caso, nucleo) => {
    expect(violacoesDaRotaDeLeitura([LEITURA], daRotaDeLeitura(nucleo)).length).toBeGreaterThan(0);
  });

  it('read route closure: the read context loader has NO exemption for the write factory', () => {
    const construtor =
      "import { criarClienteLeituraLi, criarClienteEscritaLi } from '@delfrance/integrations-loja-integrada';\n" +
      'export const c = () => criarClienteLeituraLi({});';
    const nucleo = "import { c } from '../core/contexto';\n" + 'export const f = () => c();';
    expect(violacoesDaRotaDeLeitura([LEITURA], daRotaDeLeitura(nucleo, construtor))).toEqual([
      `${CONSTRUTOR_DO_CLIENTE} names the write context`,
    ]);
  });

  /* The write chokepoint (requirement 9), on synthetic source. */
  const OUTRO = 'lib/lojaIntegrada/rastreio/x.ts';

  it.each([
    [
      'a second caller of an operation',
      OUTRO,
      "import { atualizarObjetoEnvioLi } from '@delfrance/integrations-loja-integrada';\n" +
        "await atualizarObjetoEnvioLi(c, 801, 'X');",
    ],
    [
      'an aliased import',
      OUTRO,
      "import { alterarSituacaoPedidoLi as mudar } from '@delfrance/integrations-loja-integrada';\n" +
        "await mudar(c, 1, 'pedido_enviado');",
    ],
    ['a method reference', OUTRO, 'const ler = contexto.escrita.lerAntesDeEscreverLi;'],
    ['a destructured method', OUTRO, 'const { enviarEscritaLi } = contexto.escrita;'],
    [
      'the write client built outside the write context',
      CONSTRUTOR_DO_CLIENTE,
      "import { criarClienteEscritaLi } from '@delfrance/integrations-loja-integrada';",
    ],
    [
      'the engine building its own client',
      ARQUIVO_DO_MOTOR,
      'criarClienteEscritaLi({ obterCredencial })',
    ],
    [
      'the write context calling an operation itself',
      MODULO_DO_CONTEXTO_DE_ESCRITA,
      "await alterarSituacaoPedidoLi(escrita, 1, 'pedido_enviado');",
    ],
    [
      'a file named like the engine elsewhere (matched by FULL path)',
      'lib/lojaIntegrada/sanitizacao/escrita.ts',
      "await atualizarObjetoEnvioLi(c, 801, 'X');",
    ],
    [
      'the client type named elsewhere',
      OUTRO,
      "import type { LiEscritaClient } from '@delfrance/integrations-loja-integrada';",
    ],
    ['a comment that names a write method', OUTRO, '// then call enviarEscritaLi on the client'],
    [
      'a package subpath import',
      OUTRO,
      "import { executarLi } from '@delfrance/integrations-loja-integrada/src/client';",
    ],
    [
      'a package subpath re-export',
      'app/x/route.ts',
      "export { rotaDeEscritaLi } from '@delfrance/integrations-loja-integrada/src/rotasEscrita';",
    ],
    [
      'a RELATIVE import into the package source',
      OUTRO,
      "import { lerComSchemaLi } from '../../../../packages/integrations/loja-integrada/src/client';",
    ],
    [
      'a relative import of the package directory itself',
      'functions/src/x.ts',
      "import * as li from '../../../../packages/integrations/loja-integrada';",
    ],
    ['the request core named anywhere', OUTRO, 'await executarLi(opcoes, pedido);'],
  ])('chokepoint flags %s', (_caso, arquivo, fonte) => {
    expect(violacoesDaEscrita(arquivo, fonte).length).toBeGreaterThan(0);
  });

  it('chokepoint passes the owners, a bare `.ler(` on another receiver, longer names and the package root', () => {
    expect(
      violacoesDaEscrita(
        ARQUIVO_DO_MOTOR,
        "await atualizarObjetoEnvioLi(c, 801, 'X');\n" +
          "await alterarSituacaoPedidoLi(c, 1, 'pedido_enviado');\n" +
          'await contexto.escrita.lerAntesDeEscreverLi(p);\n' +
          'type C = LiEscritaClient;',
      ),
    ).toEqual([]);
    expect(
      violacoesDaEscrita(
        MODULO_DO_CONTEXTO_DE_ESCRITA,
        'const escrita: LiEscritaClient = criarClienteEscritaLi({ obterCredencial });',
      ),
    ).toEqual([]);
    // The positive control: the sanitizer's own file-system `ler` is not a write method.
    expect(
      violacoesDaEscrita(
        'lib/lojaIntegrada/sanitizacao/executar.ts',
        'const texto = fs.ler(caminho);',
      ),
    ).toEqual([]);
    expect(
      violacoesDaEscrita(OUTRO, 'const v = lerAntesDeEscreverLiV2(); enviarEscritaLista();'),
    ).toEqual([]);
    expect(
      violacoesDaEscrita(
        OUTRO,
        "import { buscarPedidoLi } from '@delfrance/integrations-loja-integrada';",
      ),
    ).toEqual([]);
    // A path that merely names the channel is not the package's source.
    expect(
      violacoesDaEscrita(
        OUTRO,
        "import { x } from '../../../../web/lib/loja-integrada/rotaEtiqueta';\n" +
          'const y = executarLista();',
      ),
    ).toEqual([]);
    // Test sources and the shared test doubles are exempt; source is not.
    expect(ehFonteDaEscrita('lib/lojaIntegrada/core/escrita.test.ts')).toBe(false);
    expect(ehFonteDaEscrita('lib/lojaIntegrada/testing/fakeDb.ts')).toBe(false);
    expect(ehFonteDaEscrita(OUTRO)).toBe(true);
  });

  it.each([
    [
      'a functions source, through the alias',
      'functions/src/x.ts',
      "import { FakeDb } from '@/lib/lojaIntegrada/testing/fakeDb';",
    ],
    [
      'a route, relatively',
      'app/x/route.ts',
      "import { f } from '../../lib/lojaIntegrada/testing/fixtures';",
    ],
    ['a lib source, dynamically', OUTRO, "const m = await import('../testing/pedidosLi');"],
    [
      'a re-export',
      'proxy.ts',
      "export { seedConta } from './lib/lojaIntegrada/testing/fixtures';",
    ],
  ])('testing/ guard flags %s', (_caso, arquivo, fonte) => {
    expect(ehFonteQueNaoTesta(arquivo)).toBe(true);
    expect(importacoesDeTesting(arquivo, fonte)).toHaveLength(1);
  });

  it('testing/ guard passes a package whose NAME ends in testing, a comment, and the test runner’s own files', () => {
    expect(
      importacoesDeTesting(
        OUTRO,
        "import { x } from '@firebase/rules-unit-testing';\n// testing/fakeDb.ts builds the SDK's classes",
      ),
    ).toEqual([]);
    expect(ehFonteQueNaoTesta('vitest.setup.ts')).toBe(false);
    expect(ehFonteQueNaoTesta('vitest.tasks.setup.ts')).toBe(false);
    expect(ehFonteQueNaoTesta('functions/src/vitest.x.ts')).toBe(true);
    expect(ehFonteQueNaoTesta('lib/lojaIntegrada/testing/fakeDb.ts')).toBe(false);
  });

  it('seam accepts criarObservadorLi(…) imported from the logger, and exempts the logger itself', () => {
    expect(
      violacoesDoSeam(
        'lib/lojaIntegrada/core/contexto.ts',
        "import { type OpcoesObservadorLi, criarObservadorLi } from './log';\n" +
          'cliente({\n  onChamada: criarObservadorLi({ ...deps.registro, conta: id }),\n  x: 1,\n});',
      ),
    ).toEqual([]);
    expect(
      violacoesDoSeam(
        'app/x/route.ts',
        "import { criarObservadorLi } from '@/lib/lojaIntegrada/core/log';\n" +
          'validarPersonalToken({ token, onChamada: criarObservadorLi({ conta: f(")") }) })',
      ),
    ).toEqual([]);
    // Near-miss: the same call, but the import path is relative to ANOTHER directory.
    expect(
      violacoesDoSeam(
        'app/x/route.ts',
        "import { criarObservadorLi } from './log';\n" +
          'validarPersonalToken({ token, onChamada: criarObservadorLi({ conta: id }) })',
      ),
    ).toHaveLength(1);
    expect(
      violacoesDoSeam(ARQUIVO_DO_LOGGER, 'export function f(e: ChamadaLi) { onChamada(e); }'),
    ).toEqual([]);
    // A longer name that merely contains the type's name is not the type.
    expect(violacoesDoSeam('app/x/route.ts', 'type R = ResultadoChamadaLi;')).toEqual([]);
  });
});
