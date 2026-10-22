/**
 * The layout rules of `lib/amazon`, asserted as raw source text, because
 * breaking any of them fails nothing else:
 *
 *  - Next-free: step 3's functions bundle will import this tree. Only
 *    `core/respond.ts` may import `next/*`, and nothing may reach for the app's
 *    `@/` alias (the admin singleton lives there: `db` is a PARAMETER here);
 *  - no `process.env` read — the environment is a parameter too (`env.ts`);
 *  - the test doubles and fixtures are imported by tests only;
 *  - the routes never import the park (`core/estacionamento.ts`): a refusal at
 *    connect time is a verdict on a consent, never on a stored credential;
 *  - only the context loader reads through the conta cache: the connect flow
 *    must see a delete at once (its re-read decides the credential undo);
 *  - the name of the Admin SDK's multi-document atomic-write call appears in NO
 *    file of this app, tests and fakes included: this app adds ZERO such sites
 *    (the OAuth seam's redeem is already inventoried in `packages/data`), and
 *    `firestore-transaction-inventory.test.js` greps raw text — a mention, even
 *    in a comment, would demand an inventory class for a site that does not
 *    exist. The word is assembled below so this file does not contain it;
 *  - (step 2b) the logger stays LIGHT: the transitive relative-import closure of
 *    `core/log.ts`, `core/redacao.ts`, `core/formatoDaRef.ts`, `core/idConta.ts`
 *    and `core/valvulas.ts` never reaches the Admin SDK, the admin data layer,
 *    Next or the app alias; the redactor imports only `zod` and
 *    `@delfrance/core/{wire,documents}`, and the two format modules nothing;
 *  - (step 2b) the observer seam: outside `core/log.ts`, every observer handed to
 *    the package is exactly `criarObservadorAmazon(…)` as imported from the
 *    logger — the whole value, under its own name, never shadowed — at exactly
 *    three sites, and no file names the raw event type: it carries the raw
 *    query, the credential ref and the full response text, and only the logger
 *    redacts them;
 *  - (step 2b) no `.message` inside a logger call (any `.info|warn|error(`, or
 *    any non-call line writer), no `console.` anywhere, no `catch` in the
 *    logger or the redactor (they are total by construction), and only the
 *    logger writes a `trechoCorpo` campo;
 *  - (step 2b) the generated leaf inventory keeps its `.prettierignore` and
 *    `.gitattributes` lines, so a regeneration diffs leaf by leaf;
 *  - (step 2b-b) the capture sanitizer (`sanitizacao/**`, `fixtures/**`,
 *    `scripts/sanitizar.ts`) cannot reach a network, a process, a token or
 *    Firestore: its transitive import closure — the allow-listed
 *    `@delfrance/core/*` subpaths walked too, not trusted — holds no network or
 *    process module, no package client, no Admin SDK or admin data layer, none of
 *    the credential modules, and no text that names `fetch` at all, loads code
 *    dynamically, fetches a builtin at run time or reaches a global by a computed
 *    name; every external module it imports is on a short allow-list; and the
 *    committed corpus keeps its `.prettierignore` and `.gitattributes` lines;
 *  - (step 3, PR 3-d) the nested functions codebase (`functions/src`) is the
 *    first production surface outside `lib/` and `app/`, so the `.message`,
 *    seller-id, `trechoCorpo`, `testing/` and conta-cache scans read it too; and
 *    there the app keeps ONE logger: no `firebase-functions` logger import, no
 *    `console.`, and every line written through `LOGGER_STDOUT_AMAZON`;
 *  - (step 20) D11 by construction on the conta trigger, which runs on EVERY
 *    conta write of every channel: its transitive import closure (type edges
 *    walked too, so it fails closed) is pinned file by file, reaches no context,
 *    conta read, credential, park, valve, env reader, intake or queue module, and
 *    imports the SP-API package as TYPES only (read off the TypeScript AST).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CAMINHO_RECEPTOR_AMAZON } from '@delfrance/schemas';

const RAIZ_LIB = fileURLToPath(new URL('.', import.meta.url));
const RAIZ_APP = fileURLToPath(new URL('../..', import.meta.url));
const RAIZ_REPO = fileURLToPath(new URL('../../../..', import.meta.url));

function arquivosTs(dir: string): string[] {
  const saida: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.next' || e.name === '.turbo') continue;
    const caminho = join(dir, e.name);
    if (e.isDirectory()) saida.push(...arquivosTs(caminho));
    else if (/\.(ts|tsx|mjs)$/.test(e.name)) saida.push(caminho);
  }
  return saida;
}

const rel = (p: string) => relative(RAIZ_LIB, p).split(sep).join('/');
const relApp = (p: string) => relative(RAIZ_APP, p).split(sep).join('/');
const ehTeste = (p: string) => p.endsWith('.test.ts');

/** The nested functions codebase's sources (PR 3-d): a production surface outside `lib/` and `app/`. */
const RAIZ_FUNCOES = join(RAIZ_APP, 'functions', 'src');

/** Its PRODUCTION files (tests excluded), absolute. */
const fontesDasFuncoes = () => arquivosTs(RAIZ_FUNCOES).filter((p) => !ehTeste(p));

/** Every PRODUCTION file under `lib/amazon`, `app/` and `functions/src`, absolute. */
const fontesDeProducaoDoApp = () =>
  [
    ...arquivosTs(RAIZ_LIB),
    ...arquivosTs(join(RAIZ_APP, 'app')),
    ...arquivosTs(RAIZ_FUNCOES),
  ].filter((p) => !ehTeste(p));

/** The source without its comments (the TypeScript printer), so prose cannot trip a code rule. */
function semComentarios(texto: string): string {
  const fonte = ts.createSourceFile('x.ts', texto, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  return ts.createPrinter({ removeComments: true }).printFile(fonte);
}

/* ------------------------------ import closure ----------------------------- */

/** Every module specifier in a source text: `from '…'`, `import '…'`, `import('…')`. */
function especificadores(texto: string): string[] {
  const saida: string[] = [];
  const re =
    /\bfrom\s+['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of texto.matchAll(re)) saida.push(m[1] ?? m[2] ?? m[3] ?? '');
  return saida;
}

/** A source text by its path relative to `lib/amazon`, or `null`. */
type LeitorDeFonte = (caminho: string) => string | null;

const lerDoDisco: LeitorDeFonte = (caminho) => {
  const absoluto = join(RAIZ_LIB, ...caminho.split('/'));
  return existsSync(absoluto) ? readFileSync(absoluto, 'utf8') : null;
};

/** The same, by path relative to the APP root (`scripts/…`, `lib/amazon/…`). */
const lerDoApp: LeitorDeFonte = (caminho) => {
  const absoluto = join(RAIZ_APP, ...caminho.split('/'));
  return existsSync(absoluto) ? readFileSync(absoluto, 'utf8') : null;
};

/** A non-relative specifier as a source path the walk enters too, or `null` to leave it external. */
type ResolvedorDePacote = (espec: string) => string | null;

/**
 * Where a RELATIVE specifier in `arquivo` lands: the first of `.ts`, `.tsx`,
 * `/index.ts` that exists, else the bare normalized path (which reads as
 * nothing). ONE resolution, shared by the walk and by {@link violacoesD11}'s
 * "was it walked?" check, so the two cannot drift apart.
 */
function resolverRelativo(arquivo: string, espec: string, ler: LeitorDeFonte): string {
  const base = posix.normalize(posix.join(posix.dirname(arquivo), espec));
  return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((c) => ler(c) !== null) ?? base;
}

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
      pendentes.push(resolverRelativo(arquivo, espec, ler));
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
 * imports too. `env.ts` is reached (type-only, from the valves).
 */
const ENTRADAS_DO_FECHO = [
  'core/log.ts',
  'core/redacao.ts',
  'core/formatoDaRef.ts',
  'core/idConta.ts',
  'core/valvulas.ts',
];

/* ------------------------------ the sanitizer ------------------------------ */

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

/** What the sanitizer's closure may never import, even if it were allow-listed. */
function proibidoNoSanitizador(espec: string): boolean {
  const modulo = espec.replace(/^node:/, '').split('/')[0] ?? '';
  return (
    espec.startsWith('?') ||
    espec.startsWith('firebase-admin') ||
    espec.startsWith('@delfrance/data') ||
    espec === '@delfrance/integrations-amazon-sp-api' ||
    espec.startsWith('@delfrance/integrations-amazon-sp-api/') ||
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
  'node:crypto',
]);

/** The modules that hold the credential, the context, the park or Firestore handles. */
const MODULOS_DE_CREDENCIAL = [
  'core/credentialStore',
  'core/contexto',
  'core/estacionamento',
  'core/refCredencial',
  'core/contas',
].map((m) => `lib/amazon/${m}.ts`);

/**
 * Text that calls the network or loads code the import scan cannot see: ANY
 * reference to the global `fetch` (a call, but also this repo's own injection
 * idiom — a `f: typeof fetch = fetch` default, `const f = globalThis.fetch`,
 * `{ fetch }` — which a call-only pattern misses), a builtin fetched at run time
 * (`process.getBuiltinModule`, `process.binding`), and a global or `process`
 * member reached by a computed name (`globalThis['fe' + 'tch']`), which no
 * name-based pattern could follow.
 */
const CHAMADAS_PROIBIDAS = [
  /\bfetch\b/,
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

const WIRE = 'apps/amazon/lib/amazon/fixtures/__wire__';
const LINHA_WIRE_PRETTIER = `${WIRE}/`;
const LINHA_WIRE_ATRIBUTOS = `${WIRE}/** text eol=lf`;

/* ------------------------------ observer seam ------------------------------ */

/** The one file allowed to see the raw call event and build an observer. */
const ARQUIVO_DO_LOGGER = 'lib/amazon/core/log.ts';
/** The logger as a module, relative to the app root (`@/` resolves there). */
const MODULO_DO_LOGGER = 'lib/amazon/core/log';
const PROPRIEDADE = 'onChamada: ';
const SEAM_OK = `${PROPRIEDADE}criarObservadorAmazon(`;

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
 * 1. Every `onChamada` is `onChamada: criarObservadorAmazon(…)`, and that call
 *    is the WHOLE value: the next token after its closing `)` is `,` or `}` —
 *    so `criarObservadorAmazon(…) && ((e) => …)` cannot slip an inline
 *    observer in.
 * 2. A file that has the seam imports `criarObservadorAmazon` under its own
 *    name from the logger module, and every other mention of the name is one of
 *    its seam calls — so a local function, a parameter or a renamed import of
 *    the same name cannot stand in for it.
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
        nomes.includes('criarObservadorAmazon') &&
        moduloDe(arquivo, m[2] ?? '') === MODULO_DO_LOGGER
      ) {
        importacoes.push([m.index, m.index + m[0].length]);
      }
    }
    const fora = [...texto.matchAll(/\bcriarObservadorAmazon\b/g)]
      .map((m) => m.index)
      .filter((j) => !chamadas.has(j) && !importacoes.some(([a, b]) => j >= a && j < b));
    if (importacoes.length === 0 || fora.length > 0) {
      violacoes.push(
        `${arquivo}: criarObservadorAmazon is not the logger's (imported from it: ${String(importacoes.length > 0)}; other mentions at ${fora.join(', ') || 'none'})`,
      );
    }
  }
  if (/\bChamadaAmazon\b/.test(texto)) violacoes.push(`${arquivo}: names ChamadaAmazon`);
  return violacoes;
}

/* --------------------------- no `.message` logged -------------------------- */

/**
 * Every way a line is written here: ANY `.info(` / `.warn(` / `.error(` call —
 * on `logger`, `LOGGER_STDOUT_AMAZON`, `deps.logger?`, or the object
 * `warnNaoTipado(…)` returns — plus the three non-call line writers (the valve's
 * run-start line takes an envelope a caller fills) and the step-4 poll's own
 * line writer (`registrarPoll`, `pedidos/pollPedidos.ts`), whose campos would
 * otherwise reach `registrarEventoAmazon` unread by these scans. Fail closed: a
 * receiver of another name is still a logger call to this scan.
 */
const CHAMADA_DE_LOG =
  /(?:\.(?:info|warn|error)|\b(?:registrarEventoAmazon|registrarChamadaBloqueadaAmazon|registrarValvulaAmazon|registrarPoll))\(/g;

/**
 * Logger calls whose argument list reads a `.message` (an `AmazonError` message
 * embeds the request path, which can carry a seller id; a Firestore one, a
 * document path). An unbalanced call is read to the end of the text: fail
 * closed.
 */
function mensagensLogadas(arquivo: string, texto: string): string[] {
  const achados: string[] = [];
  for (const m of texto.matchAll(CHAMADA_DE_LOG)) {
    const abre = m.index + m[0].length - 1;
    const fim = fimDaChamada(texto, abre);
    const argumentos = texto.slice(abre, fim === -1 ? texto.length : fim + 1);
    if (/\.message\b/.test(argumentos)) achados.push(`${arquivo}: ${m[0]} at ${String(m.index)}`);
  }
  return achados;
}

/* ------------------------ step 3: the seller id, the SDK ------------------------ */

/**
 * The seller id under each of its five spellings: ours (`sellerId`), the stored
 * field (`selling_partner_id`), the push's (`SellerId`), and the local the OAuth
 * callback and the vínculo code name it by (`sellingPartnerId`,
 * `SellingPartnerId`). The `\b` keeps a longer name (`sellingPartnerIdValido`,
 * `contasPorSellingPartnerId`) out.
 */
const NOME_DE_SELLER_ID =
  /\b(?:sellerId|SellerId|selling_partner_id|sellingPartnerId|SellingPartnerId)\b/;

/**
 * Logger calls whose argument list names the seller id (step 3): a seller id is
 * never logged — by value, by key, or as a word in the message. The
 * `.message` scan's shape: every way a line is written, read to the matching
 * `)`, an unbalanced call to the end of the text (fail closed).
 */
function sellersLogados(arquivo: string, texto: string): string[] {
  const achados: string[] = [];
  for (const m of texto.matchAll(CHAMADA_DE_LOG)) {
    const abre = m.index + m[0].length - 1;
    const fim = fimDaChamada(texto, abre);
    const argumentos = texto.slice(abre, fim === -1 ? texto.length : fim + 1);
    if (NOME_DE_SELLER_ID.test(argumentos))
      achados.push(`${arquivo}: ${m[0]} at ${String(m.index)}`);
  }
  return achados;
}

/** The ONE production module under `lib/amazon` that may import the Cloud Tasks SDK. */
const IMPORTADOR_DO_SDK_DE_TAREFAS = 'notificacoes/agendador.ts';

/**
 * Of `fontes` (paths relative to `lib/amazon`, with their text), the PRODUCTION
 * files that import `firebase-admin/functions` (type-only included: fail
 * closed). Tests and `testing/**` are exempt — `testing/falhaDeEnfileiramento.ts`
 * must build the SDK's own classes.
 */
function importadoresDoSdkDeTarefas(fontes: readonly (readonly [string, string])[]): string[] {
  return fontes
    .filter(([caminho]) => !ehTeste(caminho) && !caminho.startsWith('testing/'))
    .filter(([, texto]) => especificadores(texto).includes('firebase-admin/functions'))
    .map(([caminho]) => caminho)
    .sort();
}

/** The App Hosting composition root of the reads queue (3-c): one of the app's two `getFunctions(` callers. */
const ARQUIVO_RAIZ_DA_FILA = 'lib/firebase/filaLeitura.ts';

/** The push receiver's route and body, relative to the app root (3-c). */
const ARQUIVOS_DO_RECEPTOR = [
  'app/api/webhooks/amazon/route.ts',
  'lib/amazon/notificacoes/receptor.ts',
] as const;

/** What the receiver may never import DIRECTLY: the conta context, the conta reads, the park, the Amazon client. */
const MODULOS_PROIBIDOS_NO_RECEPTOR = [
  'lib/amazon/core/contexto',
  'lib/amazon/core/contas',
  'lib/amazon/core/estacionamento',
];

/**
 * The receiver's forbidden direct imports (`arquivo` relative to the app
 * root): a relative or `@/` specifier that resolves to one of
 * {@link MODULOS_PROIBIDOS_NO_RECEPTOR}, or the Amazon package at all.
 */
function importacoesProibidasNoReceptor(arquivo: string, texto: string): string[] {
  return especificadores(texto)
    .filter((espec) => {
      if (espec === '@delfrance/integrations-amazon-sp-api') return true;
      if (espec.startsWith('@delfrance/integrations-amazon-sp-api/')) return true;
      if (!espec.startsWith('.') && !espec.startsWith('@/')) return false;
      return MODULOS_PROIBIDOS_NO_RECEPTOR.includes(moduloDe(arquivo, espec));
    })
    .map((espec) => `${arquivo} imports ${espec}`);
}

/** A CALL of the Admin SDK's `getFunctions` (comments aside): only a composition root binds the queue. */
const chamaGetFunctions = (texto: string) => /\bgetFunctions\s*\(/.test(semComentarios(texto));

/** The functions codebase's composition root of the reads queue (3-d): the app's other `getFunctions(` caller. */
const ARQUIVO_RAIZ_DA_FILA_FUNCOES = 'functions/src/agendador.ts';

/* --------------------- step 3 (3-d): the functions codebase --------------------- */

/**
 * Does a source import the test doubles or fixtures (`lib/amazon/testing/…`), by
 * any path — relative, `@/`, or a dynamic `import()`? Production code never
 * does: a fake Firestore in the deploy bundle is a fake Firestore in production.
 */
const importaDoublesDeTeste = (texto: string) =>
  especificadores(texto).some((espec) => /(?:^|\/)amazon\/testing(?:\/|$)/.test(espec));

/**
 * Why a `functions/src` source opens a SECOND logger (run on comment-free
 * code; empty when it does not). `apps/amazon` has ONE logger
 * (`core/log.ts`), and Loja Integrada's functions root — the precedent — logs
 * through `firebase-functions`' `logger`, so the copy is the likely mistake:
 *
 * - a named `logger` import (any alias) from `firebase-functions` or any subpath;
 * - any import of a `…/logger` subpath (its `info`/`warn`/`error`, or the
 *   `compat` module that patches `console`);
 * - a namespace, default or side-effect import of `firebase-functions*`, or a
 *   run-time `import()`/`require()` of it — each reaches the logger by another
 *   name, and this codebase needs none of them (fail closed);
 * - any `console.`.
 */
function loggersParalelos(texto: string): string[] {
  const codigo = semComentarios(texto);
  const achados: string[] = [];
  for (const m of codigo.matchAll(
    /\bimport\s+(?:type\s+)?([^'";]*?)\s*from\s*['"](firebase-functions(?:\/[^'"]*)?)['"]/g,
  )) {
    const clausula = (m[1] ?? '').trim();
    const espec = m[2] ?? '';
    if (/(?:^|\/)logger(?:\/|$)/.test(espec)) achados.push(`${espec}: the logger module`);
    else if (/\*\s*as\b/.test(clausula)) achados.push(`${espec}: a namespace import`);
    else if (/^[A-Za-z_$][\w$]*\s*(?:,|$)/.test(clausula))
      achados.push(`${espec}: a default import`);
    else if (/\{[^}]*\blogger\b[^}]*\}/.test(clausula)) achados.push(`${espec}: imports logger`);
  }
  for (const m of codigo.matchAll(/\bimport\s*['"](firebase-functions[^'"]*)['"]/g)) {
    achados.push(`${m[1] ?? ''}: a side-effect import`);
  }
  for (const m of codigo.matchAll(/\b(?:import|require)\(\s*['"](firebase-functions[^'"]*)['"]/g)) {
    achados.push(`${m[1] ?? ''}: loaded at run time`);
  }
  if (/\bconsole\./.test(codigo)) achados.push('console.');
  return achados;
}

/** The non-call line writers, whose FIRST argument is the logger they write through. */
const ESCRITOR_COM_LOGGER =
  /^(?:registrarEventoAmazon|registrarChamadaBloqueadaAmazon|registrarValvulaAmazon)\($/;

/**
 * Every log call in a `functions/src` source (comment-free code) — any
 * `.info|warn|error(` or non-call writer, {@link CHAMADA_DE_LOG} — and those
 * that do NOT go through the app's stdout sink: a method call on anything but
 * `LOGGER_STDOUT_AMAZON`, or a writer whose first argument is anything else. A
 * writer handed a second logger is still a second logger.
 */
function chamadasDeLogNasFuncoes(
  arquivo: string,
  texto: string,
): { chamadas: number; fora: string[] } {
  const codigo = semComentarios(texto);
  let chamadas = 0;
  const fora: string[] = [];
  for (const m of codigo.matchAll(CHAMADA_DE_LOG)) {
    chamadas += 1;
    if (!ESCRITOR_COM_LOGGER.test(m[0])) {
      if (!/\bLOGGER_STDOUT_AMAZON\s*$/.test(codigo.slice(0, m.index))) {
        fora.push(`${arquivo}: ${m[0]} at ${String(m.index)} is not on LOGGER_STDOUT_AMAZON`);
      }
      continue;
    }
    const abre = m.index + m[0].length - 1;
    const fim = fimDaChamada(codigo, abre);
    const primeiro = codigo
      .slice(abre + 1, fim === -1 ? codigo.length : fim)
      .split(',')[0]
      ?.trim();
    if (primeiro !== 'LOGGER_STDOUT_AMAZON') {
      fora.push(`${arquivo}: ${m[0]} at ${String(m.index)} writes through ${primeiro ?? '?'}`);
    }
  }
  return { chamadas, fora };
}

/**
 * A LOCAL crypto compare in the receiver (run on comment-free source): the
 * primitives a hand-rolled key check would reach for, WebCrypto's `subtle`, or
 * any import of `crypto` / `node:crypto`. The receiver compares the relay key
 * only through the shared `verifyStaticSecret` (#1431).
 */
const CRIPTO_LOCAL =
  /\b(?:timingSafeEqual|createHmac|createHash|subtle)\b|['"](?:node:)?crypto['"]/;

/* ------------------------- step 4 (4-a): the backstop poll ------------------------- */

/** The ONE module that may call `searchOrders` (step-3/4 plan §3 decision 21). */
const CHAMADOR_DE_SEARCH_ORDERS = 'lib/amazon/pedidos/pollPedidos.ts';

/**
 * Files that NAME `searchOrders` without calling it, each with why: the log and
 * fixture redactor keys its allow-list tables by the operation and its path
 * (its import closure is pinned to `zod` and `@delfrance/core/*` above, so it
 * cannot reach a client).
 */
const NOMEIAM_SEARCH_ORDERS_SEM_CHAMAR = ['lib/amazon/core/redacao.ts'];

/**
 * A `searchOrders` call site, in comment-free code: the package's helper, its
 * path constant, its operation-name constant, its page schema (a direct
 * `cliente.get` needs it), the bare list path as a WHOLE string (a `getOrder`
 * path continues with `/`), or the operation name handed to a client. Any one
 * is enough to spend the poll's tokens: the bucket refills ≈ 5 per tick per app
 * and seller, so a second caller makes the poll throttle itself.
 */
const CHAMADA_DE_SEARCH_ORDERS =
  /\bbuscarPedidosAtualizados\b|\bCAMINHO_SEARCH_ORDERS\b|\bOPERACAO_SEARCH_ORDERS\b|\brespostaSearchOrdersSchema\b|['"`]\/orders\/2026-01-01\/orders['"`]|['"`]searchOrders['"`]/;

/**
 * What the single-caller scan reads: every production file of the app PLUS its
 * `scripts/`, the natural home of a one-off verification script (the W7
 * listing must never call `searchOrders` while the poll runs). Only this scan
 * is widened; the others keep their scope.
 */
const fontesDoChamadorDeSearchOrders = () => [
  ...fontesDeProducaoDoApp(),
  ...arquivosTs(join(RAIZ_APP, 'scripts')).filter((p) => !ehTeste(p)),
];

const nomeiaSearchOrders = (texto: string) => CHAMADA_DE_SEARCH_ORDERS.test(semComentarios(texto));

/* --------------------- step 20: the conta trigger, D11 by construction --------------------- */

/** The conta trigger and the app's one `int_frete` binding, relative to the APP root. */
const ENTRADAS_DO_GATILHO = [
  'functions/src/onIntegracaoAmazonChanged.ts',
  'lib/amazon/frete/intFrete.ts',
];

/** The SP-API package: the only thing in this app that can call Amazon. */
const PACOTE_SP_API = '@delfrance/integrations-amazon-sp-api';
const ehDoPacoteSpApi = (espec: string) =>
  espec === PACOTE_SP_API || espec.startsWith(`${PACOTE_SP_API}/`);

/**
 * The app files (relative to the APP root) the trigger's closure may never
 * reach: the conta context and every module that reads a conta, a credential,
 * the park, a valve or the environment; the intake, the poll and the conta
 * flows; the App Hosting composition roots; and the functions codebase's other
 * roots (`options.ts` included: the trigger must not carry a region of its own).
 */
const PROIBIDOS_NO_GATILHO = [
  /^lib\/amazon\/core\/(?:contexto|contas|valvulas|estacionamento|credentialStore|renovacaoUnica|agente|contaCache)\.ts$/,
  /^lib\/amazon\/env\.ts$/,
  /^lib\/amazon\/(?:notificacoes|pedidos|conta)\//,
  /^lib\/firebase\//,
  /^functions\/src\/(?:depsLeitura|agendador|filaLeitura|pollPedidos|options)\.ts$/,
];

/**
 * The module specifiers a source loads AS A VALUE, read off the TypeScript AST
 * (comments are not code here). TYPE-only — and so not a value — is: an
 * `import type …`, an `import { type A, type B }` with no default or namespace
 * binding (elided: this app's tsconfig keeps `verbatimModuleSyntax` off, and
 * esbuild follows it), and an `export type { … } from` (or every specifier
 * `type`). Everything else is a value: a mixed `{ type A, b }`, a default or
 * namespace import, a side-effect `import '…'`, an empty `import {} from`, a
 * value re-export, `import x = require(…)`, a `require(…)` call and a dynamic
 * `import(…)` — whose computed argument is `<dinamico>` (fail closed). A
 * no-substitution template (`` import(`…`) ``) is a plain specifier here.
 */
function importacoesDeValor(texto: string): string[] {
  const fonte = ts.createSourceFile('x.ts', texto, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const saida: string[] = [];
  const visitar = (no: ts.Node): void => {
    if (ts.isImportDeclaration(no) && ts.isStringLiteral(no.moduleSpecifier)) {
      const clausula = no.importClause;
      const nomeados = clausula?.namedBindings;
      const soTipo =
        clausula !== undefined &&
        (clausula.phaseModifier === ts.SyntaxKind.TypeKeyword ||
          (clausula.name === undefined &&
            nomeados !== undefined &&
            ts.isNamedImports(nomeados) &&
            nomeados.elements.length > 0 &&
            nomeados.elements.every((e) => e.isTypeOnly)));
      if (!soTipo) saida.push(no.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(no) &&
      no.moduleSpecifier !== undefined &&
      ts.isStringLiteral(no.moduleSpecifier)
    ) {
      const exportados = no.exportClause;
      const soTipo =
        no.isTypeOnly ||
        (exportados !== undefined &&
          ts.isNamedExports(exportados) &&
          exportados.elements.length > 0 &&
          exportados.elements.every((e) => e.isTypeOnly));
      if (!soTipo) saida.push(no.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(no) && !no.isTypeOnly) {
      const ref = no.moduleReference;
      if (ts.isExternalModuleReference(ref)) {
        saida.push(ts.isStringLiteral(ref.expression) ? ref.expression.text : '<dinamico>');
      }
    } else if (
      ts.isCallExpression(no) &&
      (no.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(no.expression) && no.expression.text === 'require'))
    ) {
      const alvo = no.arguments[0];
      saida.push(alvo !== undefined && ts.isStringLiteralLike(alvo) ? alvo.text : '<dinamico>');
    }
    ts.forEachChild(no, visitar);
  };
  visitar(fonte);
  return saida;
}

/**
 * Why the trigger's closure (a {@link fechoDeImportacoes} walk from app-root
 * paths) could reach Amazon; empty when it cannot:
 *
 * - every reached file whose RESOLVED path is in {@link PROIBIDOS_NO_GATILHO};
 * - every VALUE import of the SP-API package, or any subpath, in any reached
 *   file ({@link importacoesDeValor}) — a type import is fine, and is what
 *   `core/log.ts` does; a dynamic import of a computed name too (fail closed);
 * - every relative import the walk could not resolve (`?<path>`), and every
 *   `@/` import (the walk does not follow the alias) — fail closed;
 * - every module a reached file loads as a value that the walk did NOT follow
 *   (`unwalked <file> → <espec>`): the walk reads specifiers with a regex that
 *   knows only quoted `from '…'`, `import '…'` and `import('…')`, so a
 *   template-literal `` import(`…`) ``, a `require('…')`, an `import x = require(…)`
 *   or an `import ('…')` with a space would put a module in the bundle (esbuild
 *   follows all of them) that no check above ever reads — fail closed.
 *
 * TRANSITIVE by construction — the walk reaches every hop; a direct-only check
 * (`importacoesProibidasNoReceptor`) cannot see a module two hops away.
 */
function violacoesD11(
  fecho: { arquivos: readonly string[]; externos: readonly string[] },
  ler: LeitorDeFonte,
): string[] {
  const violacoes: string[] = [];
  const externos = new Set(fecho.externos);
  /** Did the walk follow this edge (a reached file, or a reported `?<path>`)? */
  const percorrida = (arquivo: string, espec: string): boolean => {
    if (!espec.startsWith('.')) return externos.has(espec);
    const alvo = resolverRelativo(arquivo, espec, ler);
    return fecho.arquivos.includes(alvo) || externos.has(`?${alvo}`);
  };
  for (const arquivo of fecho.arquivos) {
    if (PROIBIDOS_NO_GATILHO.some((re) => re.test(arquivo))) violacoes.push(`reaches ${arquivo}`);
    for (const espec of importacoesDeValor(ler(arquivo) ?? '')) {
      if (ehDoPacoteSpApi(espec)) violacoes.push(`${arquivo} imports ${espec} as a value`);
      else if (espec === '<dinamico>') violacoes.push(`${arquivo} imports a computed module`);
      else if (!percorrida(arquivo, espec)) violacoes.push(`unwalked ${arquivo} → ${espec}`);
    }
  }
  for (const espec of fecho.externos) {
    if (espec.startsWith('?')) violacoes.push(`unresolved ${espec.slice(1)}`);
    else if (espec.startsWith('@/')) violacoes.push(`imports ${espec} (the alias is not walked)`);
  }
  return violacoes;
}

/* -------------------------------- the pinned lines -------------------------------- */

const INVENTARIO = 'apps/amazon/lib/amazon/testing/especificacaoFolhas.json';
const LINHA_INVENTARIO_PRETTIER = INVENTARIO;
const LINHA_INVENTARIO_ATRIBUTOS = `${INVENTARIO} text eol=lf`;

describe('lib/amazon layout', () => {
  const todos = arquivosTs(RAIZ_LIB);
  const fontes = todos.filter((p) => !ehTeste(p));

  it('the scan found the tree (anti-vacuity)', () => {
    expect(fontes.map(rel)).toEqual(
      expect.arrayContaining([
        'env.ts',
        'avisos/avisos.ts',
        'conta/conectar.ts',
        'conta/expiracaoSweep.ts',
        'conta/iniciar.ts',
        'conta/oauthState.ts',
        'conta/status.ts',
        'conta/vinculoVendedor.ts',
        'core/agente.ts',
        'core/contaCache.ts',
        'core/contas.ts',
        'core/contexto.ts',
        'core/credentialStore.ts',
        'core/erros.ts',
        'core/estacionamento.ts',
        'core/formatoDaRef.ts',
        'core/idConta.ts',
        'core/log.ts',
        'core/redacao.ts',
        'core/refCredencial.ts',
        'core/renovacaoUnica.ts',
        'core/respond.ts',
        'core/valvulas.ts',
        'frete/intFrete.ts',
        'notificacoes/agendador.ts',
        'notificacoes/corpo.ts',
        'notificacoes/envelope.ts',
        'notificacoes/notificacao.ts',
        'notificacoes/prazo.ts',
        'notificacoes/receptor.ts',
        'pedidos/janelaPoll.ts',
        'pedidos/notificacaoSintetica.ts',
        'pedidos/orcamentoPoll.ts',
        'pedidos/orderIds.ts',
        'pedidos/pollPedidos.ts',
        'testing/documentos.ts',
        'testing/falhaDeEnfileiramento.ts',
        'testing/fakeDb.ts',
        'testing/fakeOauthState.ts',
        'testing/fixtures.ts',
        'testing/guardaDaLaneDeTarefas.ts',
        'testing/sandboxBr.ts',
        'sanitizacao/requisicao.ts',
        'sanitizacao/local.ts',
        'sanitizacao/lote.ts',
        'sanitizacao/falsificacao.ts',
        'sanitizacao/zip.ts',
        'sanitizacao/capturaParaFixture.ts',
        'sanitizacao/folhas.ts',
        'sanitizacao/executar.ts',
        'sanitizacao/escrita.ts',
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

  it('testing/ is imported by tests only', () => {
    for (const arquivo of fontes) {
      if (rel(arquivo).startsWith('testing/')) continue;
      expect(readFileSync(arquivo, 'utf8'), rel(arquivo)).not.toMatch(/from '[^']*testing\//);
    }
    // …and nothing outside lib/amazon reaches it from production code either —
    // the functions codebase included (3-d): its bundle ships to the cloud.
    for (const arquivo of arquivosTs(join(RAIZ_APP, 'app')).filter((p) => !ehTeste(p))) {
      expect(readFileSync(arquivo, 'utf8'), relApp(arquivo)).not.toMatch(/amazon\/testing\//);
    }
    const funcoes = fontesDasFuncoes();
    expect(funcoes.length).toBeGreaterThanOrEqual(5);
    for (const arquivo of funcoes) {
      expect(importaDoublesDeTeste(readFileSync(arquivo, 'utf8')), relApp(arquivo)).toBe(false);
    }
  });

  it('only the context loader reads through the conta cache — the connect flow never does', () => {
    // A cached copy that `isFresh` accepts (active, connected) would hide a conta
    // deleted mid-callback, and the undo would leave its credential orphaned.
    // The callback may only INVALIDATE the cache (`invalidarContaEmCache`).
    // The functions codebase (3-d) is read too: it binds the same pipeline.
    const fontes = fontesDeProducaoDoApp();
    const leitores = fontes
      .filter((p) => readFileSync(p, 'utf8').includes('lerContaEmCache'))
      .map((p) => (p.startsWith(RAIZ_LIB) ? rel(p) : relApp(p)))
      .sort();
    expect(leitores).toEqual(['core/contaCache.ts', 'core/contexto.ts']);
    // Anti-vacuity (3-d): the scan reads the functions codebase's own files.
    expect(fontes.map(relApp)).toEqual(
      expect.arrayContaining(['functions/src/index.ts', 'functions/src/depsLeitura.ts']),
    );
  });

  it('no route imports the park', () => {
    const rotas = arquivosTs(join(RAIZ_APP, 'app')).filter((p) => /[\\/]route\.ts$/.test(p));
    expect(rotas.length).toBeGreaterThanOrEqual(5);
    for (const rota of rotas) {
      expect(readFileSync(rota, 'utf8'), relApp(rota)).not.toMatch(/estacionamento/);
    }
  });

  it('no file of this app names the multi-document atomic-write call', () => {
    const palavra = ['run', 'Transaction'].join('');
    const arquivos = arquivosTs(RAIZ_APP);
    expect(arquivos.length).toBeGreaterThan(40);
    for (const arquivo of arquivos) {
      expect(readFileSync(arquivo, 'utf8').includes(palavra), relApp(arquivo)).toBe(false);
    }
  });

  it('every test file sits beside a vitest-collected path (the config includes app, lib and the proxy)', () => {
    expect(existsSync(join(RAIZ_APP, 'proxy.test.ts'))).toBe(true);
    const config = readFileSync(join(RAIZ_APP, 'vitest.config.ts'), 'utf8');
    expect(config).toContain("'{app,lib,functions}/**/*.test.ts'");
    expect(config).toContain("'proxy.test.ts'");
  });

  // PR 3-e. The two configs PARTITION the app's tests by suffix, and a drift is
  // silent both ways: an emulator suite the offline config collects skips for
  // lack of its emulator host and reports green in `CI test`, and one neither
  // config collects runs nowhere. The emulator config runs only in ci-amazon.yml.
  // An app-wide directory walk (like the getFunctions( scan): CI headroom, not a budget.
  it(
    'the emulator config collects exactly the two emulator suffixes, and the offline config excludes them',
    { timeout: 30_000 },
    () => {
      const offline = readFileSync(join(RAIZ_APP, 'vitest.config.ts'), 'utf8');
      const emulador = readFileSync(join(RAIZ_APP, 'vitest.tasks.config.ts'), 'utf8');
      const includes = [...emulador.matchAll(/\binclude:\s*\[([^\]]*)\]/g)];
      expect(includes).toHaveLength(1);
      // The quoted entries, whole: a glob holds commas inside its braces.
      const globs = [...(includes[0]?.[1] ?? '').matchAll(/'([^']*)'/g)].map((m) => m[1]);
      expect(globs).toEqual([
        '{app,lib,functions}/**/*.{tasks,firestore}.test.ts',
        '*.{tasks,firestore}.test.ts',
      ]);
      expect(emulador).toContain("setupFiles: ['./vitest.tasks.setup.ts']");
      expect(emulador).toContain('fileParallelism: false');
      // Unanchored on purpose (the config says why): a root-level suite too.
      expect(offline).toContain("'**/*.firestore.test.ts'");
      expect(offline).toContain("'**/*.tasks.test.ts'");
      const pacote = JSON.parse(readFileSync(join(RAIZ_APP, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      };
      expect(pacote.scripts['test:tasks']).toBe('vitest run --config vitest.tasks.config.ts');
      // Every emulator suite on disk sits where that include collects it — and
      // the scan found the three this PR adds (anti-vacuity).
      const suites = arquivosTs(RAIZ_APP)
        .map(relApp)
        .filter((p) => /\.(tasks|firestore)\.test\.ts$/.test(p));
      expect(suites).toEqual(
        expect.arrayContaining([
          'app/api/webhooks/amazon/route.tasks.test.ts',
          'functions/src/filaLeitura.tasks.test.ts',
          'functions/src/onIntegracaoAmazonChanged.tasks.test.ts',
          'lib/amazon/notificacoes/notificacao.firestore.test.ts',
        ]),
      );
      for (const suite of suites) {
        expect(/^(?:app|lib|functions)\//.test(suite) || !suite.includes('/'), suite).toBe(true);
      }
    },
  );

  // PR 3-e, D11's second layer. The setup only ever runs inside the lane, so a
  // refusal deleted from it fails nothing anywhere: pin that it CALLS both
  // (their behaviour is `testing/guardaDaLaneDeTarefas.test.ts`'s) and throws
  // on each answer, outside any comment.
  it('the emulator setup runs both D11 refusals and throws on them', () => {
    const setup = semComentarios(readFileSync(join(RAIZ_APP, 'vitest.tasks.setup.ts'), 'utf8'));
    // The printer re-quotes string literals, so the module specifier is matched either way.
    expect(setup).toMatch(/from ['"]\.\/lib\/amazon\/testing\/guardaDaLaneDeTarefas['"]/);
    expect(setup).toMatch(
      /if \(chamadasLigadasNoAmbiente\(process\.env\)\) \{\s*throw new Error\(/,
    );
    expect(setup).toMatch(
      /const (\w+) = envsDoArtefatoQueNomeiamAChave\(\);\s*if \(\1\.length > 0\) \{\s*throw new Error\(/,
    );
    // …and the fetch kill-switch replaces the global fetch, in this process.
    expect(setup).toMatch(/globalThis\.fetch = \(async \(/);
  });

  // PR 3-e. The same argument for the two fail-loud gates: the lane always has
  // both emulator hosts, so neither gate ever fires there, and deleting one
  // fails nothing anywhere — while it is all that keeps a lane missing an
  // emulator from skipping every suite and exiting 0 on a `required` row.
  it('the emulator setup throws without either emulator host under CI or REQUIRE_EMULATOR', () => {
    const setup = semComentarios(readFileSync(join(RAIZ_APP, 'vitest.tasks.setup.ts'), 'utf8'));
    expect(setup).toMatch(
      /export const EMULATED = Boolean\(process\.env\.FIRESTORE_EMULATOR_HOST\);/,
    );
    expect(setup).toMatch(
      /if \(!EMULATED && \(process\.env\.CI \|\| process\.env\.REQUIRE_EMULATOR\)\) \{\s*throw new Error\(/,
    );
    expect(setup).toMatch(
      /if \(!process\.env\.CLOUD_TASKS_EMULATOR_HOST && \(process\.env\.CI \|\| process\.env\.REQUIRE_EMULATOR\)\) \{\s*throw new Error\(/,
    );
  });
});

describe('the step-2b logger guards', () => {
  it('the redactor imports only zod and @delfrance/core/{wire,documents}; the two format modules import nothing', () => {
    const permitido = (espec: string) =>
      espec === 'zod' || espec === '@delfrance/core/wire' || espec === '@delfrance/core/documents';
    const redator = lerDoDisco('core/redacao.ts') ?? '';
    expect(especificadores(redator).filter((e) => !permitido(e))).toEqual([]);
    // Anti-vacuity: the reader sees the redactor's real imports.
    expect(especificadores(redator)).toEqual(
      expect.arrayContaining(['zod', '@delfrance/core/wire', '@delfrance/core/documents']),
    );
    for (const arquivo of ['core/formatoDaRef.ts', 'core/idConta.ts']) {
      expect(lerDoDisco(arquivo), arquivo).not.toBeNull();
      expect(especificadores(lerDoDisco(arquivo) ?? ''), arquivo).toEqual([]);
    }
  });

  it("the logger's and the valves' import closure reaches no Admin SDK, admin data layer, Next or @/ alias", () => {
    const fecho = fechoDeImportacoes(ENTRADAS_DO_FECHO, lerDoDisco);
    expect(fecho.arquivos).toEqual([...ENTRADAS_DO_FECHO, 'env.ts'].sort());
    expect(fecho.externos.filter(proibidoNoFecho)).toEqual([]);
    // Anti-vacuity: the closure really walks the package and core imports.
    expect(fecho.externos).toEqual(
      expect.arrayContaining(['@delfrance/integrations-amazon-sp-api', 'zod']),
    );
  });

  it('the observer seam: only criarObservadorAmazon(…) is handed to the package, at exactly 3 sites, and only log.ts names the raw event', () => {
    const fontes = arquivosTs(RAIZ_APP).filter((p) => !ehTeste(p));
    const violacoes = fontes.flatMap((p) => violacoesDoSeam(relApp(p), readFileSync(p, 'utf8')));
    expect(violacoes).toEqual([]);
    // Anti-vacuity: the three wired sites — the LWA refresh, the SP-API client,
    // the code exchange — and the logger itself is exempt.
    const sites = fontes.flatMap((p) =>
      [...readFileSync(p, 'utf8').matchAll(new RegExp(SEAM_OK.replace('(', '\\('), 'g'))].map(() =>
        relApp(p),
      ),
    );
    expect(sites.sort()).toEqual([
      'lib/amazon/conta/conectar.ts',
      'lib/amazon/core/contexto.ts',
      'lib/amazon/core/contexto.ts',
    ]);
    expect(fontes.map(relApp)).toContain(ARQUIVO_DO_LOGGER);
  });

  it('no `.message` inside the arguments of a logger call, under lib/amazon, app/ and functions/src', () => {
    const fontes = fontesDeProducaoDoApp();
    const achados = fontes.flatMap((p) => mensagensLogadas(relApp(p), readFileSync(p, 'utf8')));
    expect(achados).toEqual([]);
    // Anti-vacuity (3-d): the scan reads the functions codebase's own lines.
    expect(fontes.map(relApp)).toEqual(
      expect.arrayContaining(['functions/src/index.ts', 'functions/src/filaLeitura.ts']),
    );
    // Anti-vacuity: the scan sees the real logger calls AND the non-call writers.
    const chamadas = fontes.flatMap((p) =>
      [...readFileSync(p, 'utf8').matchAll(CHAMADA_DE_LOG)].map((m) => m[0]),
    );
    expect(chamadas.length).toBeGreaterThanOrEqual(15);
    expect(chamadas).toEqual(
      expect.arrayContaining([
        'registrarEventoAmazon(',
        'registrarChamadaBloqueadaAmazon(',
        'registrarValvulaAmazon(',
      ]),
    );
  });

  // An app-wide parse (≈ 0.2–0.4 s locally, more on a CI runner): CI headroom, not a budget.
  it(
    'only core/log.ts writes a `trechoCorpo` campo (the sink exempts it on a call line)',
    { timeout: 30_000 },
    () => {
      const fontes = fontesDeProducaoDoApp();
      const escritores = fontes
        .filter((p) => /\btrechoCorpo\b/.test(semComentarios(readFileSync(p, 'utf8'))))
        .map(relApp);
      expect(escritores).toEqual([ARQUIVO_DO_LOGGER]);
      // Anti-vacuity (3-d): the scan reads the functions codebase's own lines.
      expect(fontes.map(relApp)).toEqual(
        expect.arrayContaining(['functions/src/index.ts', 'functions/src/filaLeitura.ts']),
      );
    },
  );

  it('no `console.` under lib/amazon (comments aside): the sink writes stdout itself', () => {
    for (const arquivo of arquivosTs(RAIZ_LIB).filter((p) => !ehTeste(p))) {
      expect(semComentarios(readFileSync(arquivo, 'utf8')), rel(arquivo)).not.toMatch(
        /\bconsole\./,
      );
    }
  });

  it('neither the logger nor the redactor has a `catch` at all (total by construction)', () => {
    for (const arquivo of ['core/log.ts', 'core/redacao.ts']) {
      const codigo = semComentarios(lerDoDisco(arquivo) ?? '');
      expect(codigo.length, arquivo).toBeGreaterThan(1000);
      expect(codigo, arquivo).not.toMatch(/\bcatch\b/);
    }
  });

  it('the generated leaf inventory keeps its .prettierignore and .gitattributes lines', () => {
    const linhas = (arquivo: string) =>
      readFileSync(join(RAIZ_REPO, arquivo), 'utf8').split(/\r?\n/);
    expect(linhas('.prettierignore')).toContain(LINHA_INVENTARIO_PRETTIER);
    expect(linhas('.gitattributes')).toContain(LINHA_INVENTARIO_ATRIBUTOS);
    expect(existsSync(join(RAIZ_REPO, INVENTARIO))).toBe(true);
  });
});

describe('the step-3 intake guards', () => {
  it('no seller id inside the arguments of a logger call, under lib/amazon, app/ and functions/src', () => {
    const fontes = fontesDeProducaoDoApp();
    const achados = fontes.flatMap((p) => sellersLogados(relApp(p), readFileSync(p, 'utf8')));
    expect(achados).toEqual([]);
    // Anti-vacuity (3-d): the scan reads the functions codebase's own lines.
    expect(fontes.map(relApp)).toEqual(
      expect.arrayContaining(['functions/src/index.ts', 'functions/src/filaLeitura.ts']),
    );
    // Anti-vacuity: the scan reads the intake's own logger calls, and the intake
    // really does handle the seller id beside them.
    const intake = readFileSync(join(RAIZ_LIB, 'notificacoes', 'notificacao.ts'), 'utf8');
    expect([...intake.matchAll(CHAMADA_DE_LOG)].map((m) => m[0])).toEqual(
      expect.arrayContaining(['registrarEventoAmazon(', 'registrarChamadaBloqueadaAmazon(']),
    );
    expect(NOME_DE_SELLER_ID.test(intake)).toBe(true);
  });

  it(`among PRODUCTION files under lib/amazon, only ${IMPORTADOR_DO_SDK_DE_TAREFAS} imports firebase-admin/functions`, () => {
    const fontes = arquivosTs(RAIZ_LIB).map((p) => [rel(p), readFileSync(p, 'utf8')] as const);
    expect(importadoresDoSdkDeTarefas(fontes)).toEqual([IMPORTADOR_DO_SDK_DE_TAREFAS]);
    // Anti-vacuity: the test double that builds the SDK's classes is seen, and exempt.
    expect(
      fontes.some(
        ([c, t]) =>
          c === 'testing/falhaDeEnfileiramento.ts' &&
          especificadores(t).includes('firebase-admin/functions'),
      ),
    ).toBe(true);
  });

  // An app-wide parse (≈ 0.2–0.4 s locally, more on a CI runner): CI headroom, not a budget.
  it(
    'no file under lib/amazon calls getFunctions(, and the two composition roots are the app’s only callers',
    { timeout: 30_000 },
    () => {
      const lib = arquivosTs(RAIZ_LIB).filter((p) => !ehTeste(p));
      expect(lib.filter((p) => chamaGetFunctions(readFileSync(p, 'utf8'))).map(rel)).toEqual([]);
      // The EXACT list of composition roots, app-wide: the App Hosting receiver's
      // `lib/firebase/filaLeitura.ts` (3-c) and the functions codebase's
      // `functions/src/agendador.ts` (3-d, the step-4 poll's).
      // Every file the walk returns (`.ts`, `.tsx`, `.mjs`): a `.tsx` page is app code too.
      const app = arquivosTs(RAIZ_APP).filter((p) => !ehTeste(p));
      expect(app.length).toBeGreaterThan(40);
      expect(
        app
          .filter((p) => chamaGetFunctions(readFileSync(p, 'utf8')))
          .map(relApp)
          .sort(),
      ).toEqual([ARQUIVO_RAIZ_DA_FILA_FUNCOES, ARQUIVO_RAIZ_DA_FILA].sort());
    },
  );

  // DIRECT imports only: the closure still reaches them through `./notificacao`
  // and `../env`. That the happy path never uses them is pinned elsewhere:
  // `receptor.test.ts` (the db resolver never called, zero Firestore operations)
  // and `prazos.test.ts` (no Amazon call site in the route or its bodies).
  it('neither the push receiver route nor the receptor DIRECTLY imports the context, the conta reads, the park or the package', () => {
    const violacoes = ARQUIVOS_DO_RECEPTOR.flatMap((arquivo) => {
      const texto = lerDoApp(arquivo);
      expect(texto, arquivo).not.toBeNull();
      return importacoesProibidasNoReceptor(arquivo, texto ?? '');
    });
    expect(violacoes).toEqual([]);
    // Anti-vacuity: the scan reads the receptor's real imports.
    expect(especificadores(lerDoApp(ARQUIVOS_DO_RECEPTOR[1]) ?? '')).toEqual(
      expect.arrayContaining(['./notificacao', './agendador', '@delfrance/data/admin/signatures']),
    );
  });

  it('the receiver compares the relay key ONLY through the shared primitive (#1431)', () => {
    const receptor = semComentarios(lerDoApp(ARQUIVOS_DO_RECEPTOR[1]) ?? '');
    expect(receptor).toContain('verifyStaticSecret(');
    expect(receptor).not.toMatch(CRIPTO_LOCAL);
  });

  it('the route file sits at the relay contract’s path (CAMINHO_RECEPTOR_AMAZON)', () => {
    expect(ARQUIVOS_DO_RECEPTOR[0]).toBe(`app${CAMINHO_RECEPTOR_AMAZON}/route.ts`);
    expect(existsSync(join(RAIZ_APP, ...ARQUIVOS_DO_RECEPTOR[0].split('/')))).toBe(true);
    // …and that route exports the one verb the relay sends.
    expect(lerDoApp(ARQUIVOS_DO_RECEPTOR[0])).toMatch(/export async function POST\(/);
  });
});

describe('the step-3 functions codebase guards (3-d)', () => {
  it('the scan found the codebase (anti-vacuity)', () => {
    const funcoes = fontesDasFuncoes().map(relApp);
    expect(funcoes.length).toBeGreaterThanOrEqual(5);
    expect(funcoes).toEqual(
      expect.arrayContaining([
        'functions/src/agendador.ts',
        'functions/src/depsLeitura.ts',
        'functions/src/filaLeitura.ts',
        'functions/src/index.ts',
        'functions/src/lib/admin.ts',
        'functions/src/onIntegracaoAmazonChanged.ts',
        'functions/src/options.ts',
        'functions/src/pollPedidos.ts',
        'functions/src/tasksInvoker.ts',
      ]),
    );
  });

  it('no functions/src file opens a second logger: no firebase-functions logger, no console.', () => {
    const achados = fontesDasFuncoes().flatMap((p) =>
      loggersParalelos(readFileSync(p, 'utf8')).map((a) => `${relApp(p)}: ${a}`),
    );
    expect(achados).toEqual([]);
    // Anti-vacuity: the scan reads the codebase's real firebase-functions imports.
    const imports = fontesDasFuncoes().flatMap((p) => especificadores(readFileSync(p, 'utf8')));
    expect(imports).toEqual(
      expect.arrayContaining([
        'firebase-functions/v2',
        'firebase-functions/v2/scheduler',
        'firebase-functions/v2/tasks',
      ]),
    );
  });

  it('every log call in functions/src writes through LOGGER_STDOUT_AMAZON', () => {
    let chamadas = 0;
    const fora: string[] = [];
    for (const p of fontesDasFuncoes()) {
      const r = chamadasDeLogNasFuncoes(relApp(p), readFileSync(p, 'utf8'));
      chamadas += r.chamadas;
      fora.push(...r.fora);
    }
    expect(fora).toEqual([]);
    // Anti-vacuity: the dispatch line, the two lane lines and the expiry line.
    expect(chamadas).toBeGreaterThanOrEqual(3);
  });
});

describe('the step-4 backstop poll guards (4-a)', () => {
  const pedidos = arquivosTs(join(RAIZ_LIB, 'pedidos')).filter((p) => !ehTeste(p));

  it('pedidos/ reads no process environment: the environment is the deps’ `ambiente`', () => {
    expect(pedidos.map(rel).sort()).toEqual([
      'pedidos/janelaPoll.ts',
      'pedidos/notificacaoSintetica.ts',
      'pedidos/orcamentoPoll.ts',
      'pedidos/orderIds.ts',
      'pedidos/pollPedidos.ts',
    ]);
    for (const arquivo of pedidos) {
      expect(readFileSync(arquivo, 'utf8'), rel(arquivo)).not.toMatch(/process\s*\.\s*env/);
    }
  });

  // An app-wide parse (≈ 0.2–0.4 s locally, more on a CI runner): CI headroom, not a budget.
  it(
    `searchOrders has exactly ONE caller module under lib/amazon, app/, functions/src and scripts/: ${CHAMADOR_DE_SEARCH_ORDERS}`,
    { timeout: 30_000 },
    () => {
      const fontes = fontesDoChamadorDeSearchOrders();
      const nomeiam = fontes
        .filter((p) => nomeiaSearchOrders(readFileSync(p, 'utf8')))
        .map(relApp)
        .sort();
      expect(nomeiam.filter((p) => !NOMEIAM_SEARCH_ORDERS_SEM_CHAMAR.includes(p))).toEqual([
        CHAMADOR_DE_SEARCH_ORDERS,
      ]);
      // Anti-vacuity: the scan sees the redactor's table (exempt, by name) and
      // reads the functions codebase and the app's scripts too.
      expect(nomeiam).toEqual(expect.arrayContaining(NOMEIAM_SEARCH_ORDERS_SEM_CHAMAR));
      expect(fontes.map(relApp)).toEqual(
        expect.arrayContaining([
          'functions/src/index.ts',
          'scripts/sanitizar.ts',
          CHAMADOR_DE_SEARCH_ORDERS,
        ]),
      );
    },
  );

  it('the poll narrows an enqueue failure through ehFalhaDoSdkDeTarefasAmazon and imports no SDK module', () => {
    const texto = lerDoApp(CHAMADOR_DE_SEARCH_ORDERS) ?? '';
    expect(semComentarios(texto)).toMatch(/\behFalhaDoSdkDeTarefasAmazon\(/);
    const especs = especificadores(texto);
    // The Cloud Tasks SDK's two error modules: the narrowing lives in agendador.ts.
    expect(
      especs.filter((e) => e === 'firebase-admin/functions' || e === 'firebase-admin/app'),
    ).toEqual([]);
    expect(especs).toContain('../notificacoes/agendador');
  });
});

describe('the step-20 conta trigger guards (D11 by construction)', () => {
  it('the trigger’s import closure reaches no Amazon client, context, credential, park, valve or env reader — transitively, type edges walked', () => {
    const fecho = fechoDeImportacoes(ENTRADAS_DO_GATILHO, lerDoApp);
    expect(violacoesD11(fecho, lerDoApp)).toEqual([]);
    // EXACT, both lists: anti-vacuity AND a review gate. A new edge out of the
    // trigger, the binding or the logger reds this test until a reviewer reads
    // it — the trigger runs on EVERY conta write of every channel, so an
    // Amazon-capable path there must never arrive unnoticed.
    expect(fecho.arquivos).toEqual([
      'functions/src/lib/admin.ts',
      'functions/src/onIntegracaoAmazonChanged.ts',
      'lib/amazon/core/formatoDaRef.ts',
      'lib/amazon/core/idConta.ts',
      'lib/amazon/core/log.ts',
      'lib/amazon/core/redacao.ts',
      'lib/amazon/frete/intFrete.ts',
    ]);
    // `@delfrance/schemas` and `@delfrance/data` do not depend on the SP-API
    // package (their manifests), so those two package edges are not walked.
    expect(fecho.externos).toEqual(
      [
        'firebase-functions/v2/firestore',
        'firebase-admin/app',
        'firebase-admin/firestore',
        '@delfrance/schemas',
        '@delfrance/data/admin/frete',
        'zod',
        '@delfrance/core/documents',
        '@delfrance/core/wire',
        // TYPE-only, from `core/log.ts` — accepted by the value check above.
        PACOTE_SP_API,
      ].sort(),
    );
    // Anti-vacuity of the type-aware half: the logger really does import the
    // package, and only its types.
    const log = lerDoApp('lib/amazon/core/log.ts') ?? '';
    expect(especificadores(log)).toContain(PACOTE_SP_API);
    expect(importacoesDeValor(log)).not.toContain(PACOTE_SP_API);
    expect(importacoesDeValor(log)).toEqual(
      expect.arrayContaining(['./formatoDaRef', './idConta', './redacao']),
    );
  });

  it('neither package edge the walk leaves unwalked depends on the SP-API package', () => {
    for (const pacote of ['schemas', 'data']) {
      const manifesto = z
        .object({
          dependencies: z.record(z.string(), z.string()).optional(),
          peerDependencies: z.record(z.string(), z.string()).optional(),
        })
        .parse(
          JSON.parse(readFileSync(join(RAIZ_REPO, 'packages', pacote, 'package.json'), 'utf8')),
        );
      const deps = Object.keys({ ...manifesto.dependencies, ...manifesto.peerDependencies });
      expect(deps.filter(ehDoPacoteSpApi), pacote).toEqual([]);
      // Anti-vacuity: the manifest was read.
      expect(deps.length, pacote).toBeGreaterThan(0);
    }
  });
});

describe('the step-2b capture sanitizer guards', () => {
  it('the sanitizer cannot reach a network, a process, a token or Firestore', () => {
    const fontes = arquivosTs(RAIZ_LIB)
      .filter((p) => !ehTeste(p))
      .map(relApp);
    const entradas = [
      ...fontes.filter(
        (p) => p.startsWith('lib/amazon/sanitizacao/') || p.startsWith('lib/amazon/fixtures/'),
      ),
      'scripts/sanitizar.ts',
    ];
    expect(violacoesDoSanitizador(entradas, lerDoApp)).toEqual([]);
    // Anti-vacuity: the walk reached the script, the run, the faker and the
    // redactor, walked the allow-listed package, and saw real imports.
    const fecho = fechoDeImportacoes(entradas, lerDoApp, resolverPacoteDoSanitizador);
    expect(fecho.arquivos).toEqual(
      expect.arrayContaining([
        'scripts/sanitizar.ts',
        'lib/amazon/sanitizacao/executar.ts',
        'lib/amazon/sanitizacao/escrita.ts',
        'lib/amazon/sanitizacao/falsificacao.ts',
        'lib/amazon/fixtures/piiScan.ts',
        'lib/amazon/core/redacao.ts',
        '../../packages/core/src/wire/index.ts',
        '../../packages/core/src/wire/prazo.ts',
        '../../packages/core/src/documents/index.ts',
      ]),
    );
    expect(fecho.externos).toEqual(expect.arrayContaining(['node:fs', 'node:crypto', 'zod']));
    expect(entradas.length).toBeGreaterThanOrEqual(12);
  });

  it('scripts/ is typechecked and linted: the tsconfig includes **/*.ts, the ESLint config ignores nothing of it', () => {
    expect(readFileSync(join(RAIZ_APP, 'tsconfig.json'), 'utf8')).toContain('"**/*.ts"');
    expect(readFileSync(join(RAIZ_APP, 'eslint.config.mjs'), 'utf8')).not.toMatch(/\bignores\b/);
    expect(existsSync(join(RAIZ_APP, 'scripts', 'sanitizar.ts'))).toBe(true);
    // No shebang: the script runs through `tsx` (package.json), never as an executable.
    expect(readFileSync(join(RAIZ_APP, 'scripts', 'sanitizar.ts'), 'utf8').startsWith('#!')).toBe(
      false,
    );
  });

  it('the committed corpus keeps its .prettierignore and .gitattributes lines', () => {
    const linhas = (arquivo: string) =>
      readFileSync(join(RAIZ_REPO, arquivo), 'utf8').split(/\r?\n/);
    expect(linhas('.prettierignore')).toContain(LINHA_WIRE_PRETTIER);
    expect(linhas('.gitattributes')).toContain(LINHA_WIRE_ATRIBUTOS);
    expect(existsSync(join(RAIZ_REPO, WIRE, 'README.md'))).toBe(true);
  });
});

// The guards above can only fail on a file that does not exist yet, so pin
// them on synthetic source text: each must flag what it exists to flag.
describe('the guards, on synthetic source', () => {
  const leitor =
    (arquivos: Readonly<Record<string, string>>): LeitorDeFonte =>
    (caminho) =>
      Object.hasOwn(arquivos, caminho) ? (arquivos[caminho] ?? null) : null;

  it('import closure: log.ts → formatoDaRef.ts and idConta.ts is accepted', () => {
    const fecho = fechoDeImportacoes(
      ['core/log.ts'],
      leitor({
        'core/log.ts':
          "import { versaoDaRef } from './formatoDaRef';\nimport { idDeContaValido } from './idConta';",
        'core/formatoDaRef.ts': 'export const x = 1;',
        'core/idConta.ts': 'export const y = 1;',
      }),
    );
    expect(fecho.arquivos).toEqual(['core/formatoDaRef.ts', 'core/idConta.ts', 'core/log.ts']);
    expect(fecho.externos.filter(proibidoNoFecho)).toEqual([]);
  });

  it('import closure: log.ts → refCredencial.ts is flagged, through the hash it imports', () => {
    const fecho = fechoDeImportacoes(
      ['core/log.ts'],
      leitor({
        'core/log.ts': "import { versaoDaRef } from './refCredencial';",
        'core/refCredencial.ts': "import { sha256Hex } from '@delfrance/data/admin';",
      }),
    );
    expect(fecho.externos.filter(proibidoNoFecho)).toEqual(['@delfrance/data/admin']);
  });

  it('import closure: valvulas.ts → idConta.ts and log.ts is accepted (the conta grammar, light)', () => {
    const fecho = fechoDeImportacoes(
      ['core/valvulas.ts'],
      leitor({
        'core/valvulas.ts':
          "import type { AmbienteAmazon } from '../env';\nimport { idDeContaValido } from './idConta';\nimport { registrarEventoAmazon } from './log';",
        'env.ts': "import { somarDiasCivis } from '@delfrance/core/datetime';",
        'core/idConta.ts': 'export const y = 1;',
        'core/log.ts': "import { idDeContaValido } from './idConta';",
      }),
    );
    expect(fecho.arquivos).toEqual([
      'core/idConta.ts',
      'core/log.ts',
      'core/valvulas.ts',
      'env.ts',
    ]);
    expect(fecho.externos.filter(proibidoNoFecho)).toEqual([]);
  });

  it("import closure: valvulas.ts → contas.ts is flagged, through Firestore's handle", () => {
    const recusado = fechoDeImportacoes(
      ['core/valvulas.ts'],
      leitor({
        'core/valvulas.ts': "import { idDeContaValido } from './contas';",
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

  const IMPORTA_DO_LOGGER = "import { criarObservadorAmazon } from './log';\n";

  it.each([
    ['an inline observer', 'cliente({ onChamada: (e) => console.warn(e) })'],
    ['a forwarded one', 'cliente({ onChamada: deps.onChamada })'],
    ['the shorthand', 'cliente({ onChamada })'],
    ['a destructured one', 'const { onChamada } = deps;'],
    [
      'the raw event type',
      "import type { ChamadaAmazon } from '@delfrance/integrations-amazon-sp-api';",
    ],
    [
      'the call combined with an inline observer (&&)',
      `${IMPORTA_DO_LOGGER}cliente({ onChamada: criarObservadorAmazon({ conta }) && ((e) => console.warn(e.corpo)) })`,
    ],
    [
      'the call combined with a forwarded one (||)',
      `${IMPORTA_DO_LOGGER}cliente({ onChamada: criarObservadorAmazon({ conta }) || deps.x, x: 1 })`,
    ],
    [
      'an unbalanced call',
      `${IMPORTA_DO_LOGGER}cliente({ onChamada: criarObservadorAmazon({ conta: f(") })`,
    ],
    [
      'a local function of the same name',
      'const criarObservadorAmazon = (o) => (e) => console.log(e.corpo);\n' +
        'cliente({ onChamada: criarObservadorAmazon({ conta }) });',
    ],
    [
      'the name imported from elsewhere',
      "import { criarObservadorAmazon } from './outro/log';\n" +
        'cliente({ onChamada: criarObservadorAmazon({ conta }) });',
    ],
    [
      'another export renamed to the name',
      "import { linhaDaChamada as criarObservadorAmazon } from './log';\n" +
        'cliente({ onChamada: criarObservadorAmazon({ conta }) });',
    ],
    [
      'a parameter that shadows the import',
      `${IMPORTA_DO_LOGGER}function f(criarObservadorAmazon) { return cliente({ onChamada: criarObservadorAmazon({ conta }) }); }`,
    ],
  ])('seam flags %s', (_caso, fonte) => {
    expect(violacoesDoSeam('lib/amazon/core/contexto.ts', fonte).length).toBeGreaterThan(0);
  });

  it('seam accepts criarObservadorAmazon(…) imported from the logger, and exempts the logger itself', () => {
    expect(
      violacoesDoSeam(
        'lib/amazon/core/contexto.ts',
        "import { type LoggerAmazon, criarObservadorAmazon } from './log';\n" +
          'cliente({\n  onChamada: criarObservadorAmazon({ ...deps.registro, logger, conta: id }),\n  x: 1,\n});',
      ),
    ).toEqual([]);
    expect(
      violacoesDoSeam(
        'lib/amazon/conta/conectar.ts',
        "import { criarObservadorAmazon } from '../core/log';\n" +
          'trocar({ codigo, onChamada: criarObservadorAmazon({ logger, conta: f(")") }) })',
      ),
    ).toEqual([]);
    expect(
      violacoesDoSeam(
        'app/x/route.ts',
        "import { criarObservadorAmazon } from '@/lib/amazon/core/log';\n" +
          'trocar({ onChamada: criarObservadorAmazon({ logger, conta: id }) })',
      ),
    ).toEqual([]);
    // Near-miss: the same call, but the import path is relative to ANOTHER directory.
    expect(
      violacoesDoSeam(
        'app/x/route.ts',
        "import { criarObservadorAmazon } from './log';\n" +
          'trocar({ onChamada: criarObservadorAmazon({ logger, conta: id }) })',
      ),
    ).toHaveLength(1);
    expect(
      violacoesDoSeam(ARQUIVO_DO_LOGGER, 'export function f(e: ChamadaAmazon) { onChamada(e); }'),
    ).toEqual([]);
    // A longer name that merely contains the type's name is not the type.
    expect(violacoesDoSeam('app/x/route.ts', 'type R = ResultadoChamadaAmazon;')).toEqual([]);
  });

  it('`.message` in a logger call is flagged; outside one, or `.name` inside one, is not', () => {
    expect(mensagensLogadas('x.ts', "logger.warn('falhou', { erro: err.message });")).toHaveLength(
      1,
    );
    expect(
      mensagensLogadas('x.ts', "deps.logger?.warn('m', { e: (err as Error).message })"),
    ).toHaveLength(1);
    expect(
      mensagensLogadas('x.ts', "LOGGER_STDOUT_AMAZON.error('m', { e: x.message })"),
    ).toHaveLength(1);
    // Unbalanced: read to the end, fail closed.
    expect(mensagensLogadas('x.ts', "logger.info('m', { a: f(')' }, err.message")).toHaveLength(1);
    // The non-call writers, the untyped adapter, and a logger under another name.
    for (const fonte of [
      "registrarEventoAmazon(logger, 'chamada-bloqueada', 'INFO', 'm', { e: err.message });",
      'registrarChamadaBloqueadaAmazon(logger, { rota: err.message, valor });',
      'registrarValvulaAmazon(logger, valvula, { idTarefa: err.message });',
      "registrarPoll(deps, conta, 'WARNING', 'm', { e: err.message });",
      "warnNaoTipado(deps.logger).warn('m', { e: err.message });",
      "registro.error('m', { e: err.message });",
    ]) {
      expect(mensagensLogadas('x.ts', fonte), fonte).toHaveLength(1);
    }
    expect(
      mensagensLogadas(
        'x.ts',
        "registrarEventoAmazon(logger, 'chamada-bloqueada', 'INFO', 'm', { e: err.name });",
      ),
    ).toEqual([]);
    // Near-misses.
    expect(mensagensLogadas('x.ts', "logger.warn('falhou', { erro: err.name });")).toEqual([]);
    expect(
      mensagensLogadas(
        'x.ts',
        "const m = err.message;\nlogger.warn('a mensagem (message) não', {});",
      ),
    ).toEqual([]);
  });

  it('a seller id in a logger call is flagged — by value, by key, in the message, under all five spellings', () => {
    for (const fonte of [
      "logger.warn('m', { s: p.sellerId });",
      "logger.info('m', { selling_partner_id: conta.selling_partner_id });",
      "deps.logger?.error('m', { SellerId });",
      "registrarEventoAmazon(logger, 'tarefa', 'ERROR', 'm', { v: payload.sellerId }, {});",
      'registrarChamadaBloqueadaAmazon(logger, { rota: sellerId, valor });',
      'LOGGER_STDOUT_AMAZON.info(`sellerId ${x}`);',
      "logger.info('m', { a: f(')' }, sellerId",
      "logger.warn('m', { integracaoId, vendedor: sellingPartnerId });",
      "logger.error('m', { s: SellingPartnerId });",
      "registrarPoll(deps, conta, 'INFO', 'm', { v: contexto.conta.selling_partner_id });",
    ]) {
      expect(sellersLogados('x.ts', fonte), fonte).toHaveLength(1);
    }
  });

  it('near-miss: the seller id OUTSIDE a logger call, or a longer word, is not flagged', () => {
    expect(
      sellersLogados(
        'x.ts',
        "const ids = await contasPorSellingPartnerId(db, payload.sellerId);\nlogger.error('m', { contas: ids.join(',') });",
      ),
    ).toEqual([]);
    expect(sellersLogados('x.ts', "logger.info('m', { sellerIdade: 1, vendedor: 'x' });")).toEqual(
      [],
    );
    // A longer name holding a spelling, inside a logger call's arguments.
    expect(
      sellersLogados(
        'x.ts',
        "logger.warn('m', { valido: sellingPartnerIdValido(x), n: contasPorSellingPartnerId(db, x).length });",
      ),
    ).toEqual([]);
  });

  it('the searchOrders caller scan finds every call shape, and nothing alike', () => {
    for (const fonte of [
      'await buscarPedidosAtualizados(contexto.cliente, filtro);',
      'cliente.get({ operacao: x, caminho: CAMINHO_SEARCH_ORDERS, schema });',
      "cliente.get({ operacao: x, caminho: '/orders/2026-01-01/orders', schema });",
      'cliente.get({ operacao: `searchOrders`, caminho: c, schema });',
      'const { buscarPedidosAtualizados: b } = pacote;',
      // A direct read built from the package's own exports, with a template path.
      'contexto.cliente.get({ operacao: OPERACAO_SEARCH_ORDERS, caminho: `/orders/${V}/orders`, query, schema: x });',
      'cliente.get({ operacao: op, caminho: `/orders/${V}/orders`, query, schema: respostaSearchOrdersSchema });',
    ]) {
      expect(nomeiaSearchOrders(fonte), fonte).toBe(true);
    }
    for (const fonte of [
      '// buscarPedidosAtualizados(contexto.cliente, filtro)',
      "const caminho = '/orders/2026-01-01/orders/' + id;",
      'const caminho = `/orders/2026-01-01/orders/${id}`;',
      'const corpo = searchOrdersBr();',
      'buscarPedidosAtualizadosV2(cliente);',
      'const op = OPERACAO_SEARCH_ORDERS_V2;',
      'respostaSearchOrdersSchemaAntiga.parse(corpo);',
    ]) {
      expect(nomeiaSearchOrders(fonte), fonte).toBe(false);
    }
  });

  it('the SDK import guard flags another production file, and exempts tests and testing/', () => {
    const sdk = "import { FirebaseFunctionsError } from 'firebase-admin/functions';";
    expect(
      importadoresDoSdkDeTarefas([
        [IMPORTADOR_DO_SDK_DE_TAREFAS, sdk],
        ['notificacoes/receptor.ts', "import type { TaskQueue } from 'firebase-admin/functions';"],
        ['pedidos/poll.ts', "const m = await import('firebase-admin/functions');"],
      ]),
    ).toEqual([IMPORTADOR_DO_SDK_DE_TAREFAS, 'notificacoes/receptor.ts', 'pedidos/poll.ts'].sort());
    expect(
      importadoresDoSdkDeTarefas([
        [IMPORTADOR_DO_SDK_DE_TAREFAS, sdk],
        ['testing/falhaDeEnfileiramento.ts', sdk],
        ['notificacoes/agendador.test.ts', sdk],
        ['notificacoes/receptor.ts', "import { ehFalhaDoSdkDeTarefasAmazon } from './agendador';"],
        ['core/x.ts', "import { FirebaseAppError } from 'firebase-admin/app';"],
      ]),
    ).toEqual([IMPORTADOR_DO_SDK_DE_TAREFAS]);
  });

  it('the receiver import guard flags the context, the conta reads, the park and the package — by any path', () => {
    const R = ARQUIVOS_DO_RECEPTOR[1];
    for (const fonte of [
      "import { loadAmazonContext } from '../core/contexto';",
      "import { contasPorSellingPartnerId } from '../core/contas';",
      "import type { X } from '../core/estacionamento';",
      "import { AmazonError } from '@delfrance/integrations-amazon-sp-api';",
      "import { y } from '@delfrance/integrations-amazon-sp-api/errors';",
      "const m = await import('../core/contexto');",
    ]) {
      expect(importacoesProibidasNoReceptor(R, fonte), fonte).toHaveLength(1);
    }
    expect(
      importacoesProibidasNoReceptor(
        ARQUIVOS_DO_RECEPTOR[0],
        "import { x } from '@/lib/amazon/core/contas';",
      ),
    ).toHaveLength(1);
    // Near-misses: the env module, the pipeline, another module named alike.
    for (const fonte of [
      "import { lerConfigDoReceptorAmazon } from '../env';",
      "import { persistirFalhaNotificacaoAmazon } from './notificacao';",
      "import { x } from '../core/contaCache';",
      "import { y } from './contexto';",
      "import { z } from '@delfrance/integrations-amazon-sp-apix';",
    ]) {
      expect(importacoesProibidasNoReceptor(R, fonte), fonte).toEqual([]);
    }
  });

  it('the local-crypto guard flags a hand-rolled compare or a crypto import, and nothing alike', () => {
    for (const fonte of [
      'const ok = crypto.timingSafeEqual(a, b);',
      "const h = createHash('sha256').update(v).digest();",
      "const m = createHmac('sha256', k);",
      "const d = await globalThis.crypto.subtle.digest('SHA-256', v);",
      "import { x } from 'node:crypto';",
      'import { y } from "crypto";',
      "const c = require('crypto');",
    ]) {
      expect(CRIPTO_LOCAL.test(fonte), fonte).toBe(true);
    }
    // Near-misses: the shared primitive, the digest-prefix helper, longer names.
    for (const fonte of [
      'const casa = verifyStaticSecret({ received: r, expected: e });',
      'const igual = timingSafeEquality(a, b);',
      'const prefixo = sha256Hex(v).slice(0, 8);',
      "const t = 'subtleza';",
      "import { z } from 'node:cryptography';",
    ]) {
      expect(CRIPTO_LOCAL.test(fonte), fonte).toBe(false);
    }
  });

  it('a second logger in functions/src is flagged — every way it can be opened', () => {
    for (const fonte of [
      "import { logger } from 'firebase-functions/v2';",
      "import { logger as log, setGlobalOptions } from 'firebase-functions/v2';",
      "import { logger } from 'firebase-functions';",
      "import { info } from 'firebase-functions/logger';",
      "import 'firebase-functions/logger/compat';",
      "import * as ff from 'firebase-functions/v2';",
      "import functions from 'firebase-functions';",
      "const { logger } = await import('firebase-functions/v2');",
      "registrarEventoAmazon(LOGGER_STDOUT_AMAZON, 'tarefa', 'INFO', 'm', {});\nconsole.warn('x');",
    ]) {
      expect(loggersParalelos(fonte), fonte).not.toEqual([]);
    }
  });

  it('near-miss: the codebase’s own imports, the app logger and a mention in a comment are not a second logger', () => {
    for (const fonte of [
      "import { onSchedule } from 'firebase-functions/v2/scheduler';",
      "import { onTaskDispatched } from 'firebase-functions/v2/tasks';",
      "import { setGlobalOptions } from 'firebase-functions/v2';",
      "import { LOGGER_STDOUT_AMAZON } from '../../lib/amazon/core/log';",
      "import { loggerX } from 'firebase-functions/v2';",
      "// never `import { logger } from 'firebase-functions/v2'`, never console.log\nconst x = 1;",
    ]) {
      expect(loggersParalelos(fonte), fonte).toEqual([]);
    }
  });

  it('a functions/src log call outside LOGGER_STDOUT_AMAZON is flagged; through it, it is not', () => {
    for (const fonte of [
      "logger.info('m', {});",
      "deps.logger.warn('m', {});",
      "registrarEventoAmazon(logger, 'varredura', 'INFO', 'm', {});",
      "registrarChamadaBloqueadaAmazon(deps.logger, { rota: 'x', valor });",
    ]) {
      const r = chamadasDeLogNasFuncoes('functions/src/x.ts', fonte);
      expect(r.chamadas, fonte).toBe(1);
      expect(r.fora, fonte).toHaveLength(1);
    }
    for (const fonte of [
      "registrarEventoAmazon(LOGGER_STDOUT_AMAZON, 'varredura', 'INFO', 'm', {});",
      "registrarEventoAmazon(\n  LOGGER_STDOUT_AMAZON,\n  'tarefa',\n  'INFO',\n  'm',\n  {},\n);",
      "LOGGER_STDOUT_AMAZON.warn('m', {});",
      "// logger.info('m') in prose\nconst y = 2;",
    ]) {
      const r = chamadasDeLogNasFuncoes('functions/src/x.ts', fonte);
      expect(r.fora, fonte).toEqual([]);
    }
  });

  it('`err.message` in a functions-shaped sweep line is flagged; the document id is not', () => {
    expect(
      mensagensLogadas(
        'functions/src/index.ts',
        "registrarEventoAmazon(LOGGER_STDOUT_AMAZON, 'varredura', 'WARNING', 'm', { erro: result.errors[0].message });",
      ),
    ).toHaveLength(1);
    expect(
      mensagensLogadas(
        'functions/src/index.ts',
        "registrarEventoAmazon(LOGGER_STDOUT_AMAZON, 'varredura', 'WARNING', 'm', { docIds: result.errors.map((e) => e.docId).join(',') });",
      ),
    ).toEqual([]);
  });

  it('the test doubles are found in an import by any path, and nothing alike is', () => {
    for (const fonte of [
      "import { FakeDb } from '../../lib/amazon/testing/fakeDb';",
      "import { seedConta } from '@/lib/amazon/testing/fixtures';",
      "const f = await import('../../lib/amazon/testing/fixtures');",
      "export { x } from '../../lib/amazon/testing';",
    ]) {
      expect(importaDoublesDeTeste(fonte), fonte).toBe(true);
    }
    for (const fonte of [
      "import { LOGGER_STDOUT_AMAZON } from '../../lib/amazon/core/log';",
      "import { x } from '../../lib/amazon/testingx/y';",
      "// a test imports '../../lib/amazon/testing/fakeDb'\nconst z = 3;",
    ]) {
      expect(importaDoublesDeTeste(fonte), fonte).toBe(false);
    }
  });

  it('getFunctions( is found in code and ignored in a comment or inside a longer name', () => {
    expect(chamaGetFunctions('const f = getFunctions(app).taskQueue(x);')).toBe(true);
    expect(chamaGetFunctions('export const g = () => getFunctions (app);')).toBe(true);
    expect(chamaGetFunctions('// nothing here calls getFunctions(\nconst x = 1;')).toBe(false);
    expect(chamaGetFunctions('/** see getFunctions(app) */ const y = 2;')).toBe(false);
    // Lowercase on purpose: only the leading `\b` rejects it.
    expect(chamaGetFunctions('const z = forgetFunctions(app);')).toBe(false);
  });

  it('`console.` is found in code and ignored in a comment', () => {
    expect(semComentarios('// console.warn\nconst x = 1;')).not.toMatch(/\bconsole\./);
    expect(semComentarios('/* x */ console.warn(1);')).toMatch(/\bconsole\./);
  });

  const SANITIZADOR = 'lib/amazon/sanitizacao/x.ts';
  const comRedator = (fonte: string) =>
    leitor({
      [SANITIZADOR]: fonte,
      'lib/amazon/core/redacao.ts': "import { z } from 'zod';",
      'lib/amazon/core/contexto.ts': "import { x } from '@delfrance/integrations-amazon-sp-api';",
      'lib/amazon/core/contas.ts': "import { y } from './idConta';",
      'lib/amazon/core/idConta.ts': 'export const y = 1;',
    });

  it('sanitizer closure: node:fs, node:crypto, zod and the redactor are accepted', () => {
    expect(
      violacoesDoSanitizador(
        [SANITIZADOR],
        comRedator(
          "import { readFileSync } from 'node:fs';\nimport { createHmac } from 'node:crypto';\nimport { x } from '../core/redacao';",
        ),
      ),
    ).toEqual([]);
  });

  it.each([
    ['a call to fetch(', "export const f = () => fetch('https://x.example');"],
    ['an injected fetch default', 'export const g = (u: string, f: typeof fetch = fetch) => f(u);'],
    [
      'a fetch bound off globalThis',
      'const f = globalThis.fetch; export const g = (u: string) => f(u);',
    ],
    ['an import of ../core/contexto', "import { y } from '../core/contexto';"],
    [
      'an import of ../core/contas (a credential module, even with clean imports)',
      "import { y } from '../core/contas';",
    ],
    ['node:child_process', "import { spawn } from 'node:child_process';"],
    ['bare child_process', "import { spawn } from 'child_process';"],
    ['node:https', "import https from 'node:https';"],
    ['dns/promises', "import { lookup } from 'node:dns/promises';"],
    ['undici', "import { request } from 'undici';"],
    [
      'the package client',
      "import { criarClienteSpApi } from '@delfrance/integrations-amazon-sp-api';",
    ],
    ['the Admin SDK', "import type { Firestore } from 'firebase-admin/firestore';"],
    ['the admin data layer', "import { x } from '@delfrance/data/admin';"],
    ['a module off the allow-list', "import pad from 'left-pad';"],
    ['a dynamic import of a computed name', 'const m = await import(nome);'],
    ['a require call', "const m = require('x');"],
    ['createRequire', "import { createRequire } from 'node:module';"],
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

  /* ------------------- step 20: the conta trigger's D11 guard ------------------- */

  const GATILHO = 'functions/src/onIntegracaoAmazonChanged.ts';
  /** The relative specifier the trigger would write for an app-root path (`./x` beside it). */
  const especDoGatilhoPara = (alvo: string): string => {
    const relativo = posix.relative(posix.dirname(GATILHO), alvo.replace(/\.ts$/, ''));
    return relativo.startsWith('.') ? relativo : `./${relativo}`;
  };
  /** The trigger's closure on synthetic source: the guard's verdict. */
  const d11 = (arquivos: Readonly<Record<string, string>>): string[] => {
    const ler = leitor(arquivos);
    return violacoesD11(fechoDeImportacoes([GATILHO], ler), ler);
  };

  it.each([
    ['a named value import', `import { criarClienteSpApi } from '${PACOTE_SP_API}';`],
    ['a default import', `import cliente from '${PACOTE_SP_API}';`],
    ['a namespace import', `import * as sp from '${PACOTE_SP_API}';`],
    [
      'a MIXED import (one value binding beside a type)',
      `import { type ChamadaAmazon, criarObservador } from '${PACOTE_SP_API}';`,
    ],
    ['a side-effect import', `import '${PACOTE_SP_API}';`],
    ['an empty named import', `import {} from '${PACOTE_SP_API}';`],
    ['a value re-export', `export { criarClienteSpApi } from '${PACOTE_SP_API}';`],
    ['a dynamic import', `const sp = await import('${PACOTE_SP_API}');`],
    ['a subpath value import', `import { x } from '${PACOTE_SP_API}/errors';`],
    ['a require call', `const sp = require('${PACOTE_SP_API}');`],
  ])('D11 guard flags the SP-API package loaded as a value: %s', (_caso, fonte) => {
    expect(d11({ [GATILHO]: fonte })).toEqual([
      `${GATILHO} imports ${fonte.includes('/errors') ? `${PACOTE_SP_API}/errors` : PACOTE_SP_API} as a value`,
    ]);
  });

  it.each([
    ['an import type', `import type { ChamadaAmazon } from '${PACOTE_SP_API}';`],
    [
      'inline type specifiers only (elided)',
      `import { type ChamadaAmazon, type CodigoErroLwa } from '${PACOTE_SP_API}';`,
    ],
    ['an export type', `export type { ChamadaAmazon } from '${PACOTE_SP_API}';`],
    ['inline type re-exports only', `export { type ChamadaAmazon } from '${PACOTE_SP_API}';`],
    ['a longer package name', `import { x } from '${PACOTE_SP_API}x';`],
    [
      'a mention in a comment',
      `// never import { criarClienteSpApi } from the package\nconst x = 1;`,
    ],
  ])('NEAR-MISS: the D11 guard accepts %s', (_caso, fonte) => {
    expect(d11({ [GATILHO]: fonte })).toEqual([]);
  });

  it("D11 guard: the logger's REAL type-only import is accepted, through the closure", () => {
    const log = lerDoApp('lib/amazon/core/log.ts') ?? '';
    expect(
      d11({
        [GATILHO]: "import { LOGGER_STDOUT_AMAZON } from '../../lib/amazon/core/log';",
        'lib/amazon/core/log.ts': log,
        'lib/amazon/core/formatoDaRef.ts': 'export const a = 1;',
        'lib/amazon/core/idConta.ts': 'export const b = 1;',
        'lib/amazon/core/redacao.ts': "import { z } from 'zod';",
      }),
    ).toEqual([]);
    // …and the same logger with that import turned into a value one is flagged ONE hop away.
    const valor = log.replace(/^import type \{/m, 'import {');
    expect(valor).not.toBe(log);
    expect(
      d11({
        [GATILHO]: "import { LOGGER_STDOUT_AMAZON } from '../../lib/amazon/core/log';",
        'lib/amazon/core/log.ts': valor,
        'lib/amazon/core/formatoDaRef.ts': 'export const a = 1;',
        'lib/amazon/core/idConta.ts': 'export const b = 1;',
        'lib/amazon/core/redacao.ts': "import { z } from 'zod';",
      }),
    ).toEqual([`lib/amazon/core/log.ts imports ${PACOTE_SP_API} as a value`]);
  });

  it('D11 guard flags the context reached TWO hops deep, by its resolved path — which a direct-only check misses', () => {
    const arquivos = {
      [GATILHO]: "import { syncX } from '../../lib/amazon/frete/x';",
      'lib/amazon/frete/x.ts': "import { loadAmazonContext } from '../core/contexto';",
      'lib/amazon/core/contexto.ts': 'export const loadAmazonContext = 1;',
    };
    expect(d11(arquivos)).toEqual(['reaches lib/amazon/core/contexto.ts']);
    // The receiver's guard is DIRECT-only: on the same entry it sees nothing.
    expect(importacoesProibidasNoReceptor(GATILHO, arquivos[GATILHO])).toEqual([]);
  });

  it.each([
    'lib/amazon/core/contexto.ts',
    'lib/amazon/core/contas.ts',
    'lib/amazon/core/valvulas.ts',
    'lib/amazon/core/estacionamento.ts',
    'lib/amazon/core/credentialStore.ts',
    'lib/amazon/core/renovacaoUnica.ts',
    'lib/amazon/core/agente.ts',
    'lib/amazon/core/contaCache.ts',
    'lib/amazon/env.ts',
    'lib/amazon/notificacoes/notificacao.ts',
    'lib/amazon/pedidos/pollPedidos.ts',
    'lib/amazon/conta/conectar.ts',
    'lib/firebase/filaLeitura.ts',
    'functions/src/depsLeitura.ts',
    'functions/src/agendador.ts',
    'functions/src/filaLeitura.ts',
    'functions/src/pollPedidos.ts',
    'functions/src/options.ts',
  ])('D11 guard forbids reaching %s', (alvo) => {
    const espec = especDoGatilhoPara(alvo);
    expect(
      d11({ [GATILHO]: `import { x } from '${espec}';`, [alvo]: 'export const x = 1;' }),
    ).toEqual([`reaches ${alvo}`]);
  });

  it.each([
    'lib/amazon/core/log.ts',
    'lib/amazon/core/idConta.ts',
    'lib/amazon/frete/intFrete.ts',
    'functions/src/lib/admin.ts',
    'lib/amazon/core/contaCacheX.ts',
    'functions/src/optionsX.ts',
  ])('NEAR-MISS: the D11 guard lets the closure reach %s', (alvo) => {
    const espec = especDoGatilhoPara(alvo);
    expect(
      d11({ [GATILHO]: `import { x } from '${espec}';`, [alvo]: 'export const x = 1;' }),
    ).toEqual([]);
  });

  it('D11 guard fails closed: an unresolved relative import, an `@/` import and a computed dynamic import', () => {
    expect(d11({ [GATILHO]: "import { x } from './inexistente';" })).toEqual([
      'unresolved functions/src/inexistente',
    ]);
    expect(d11({ [GATILHO]: "import { x } from '@/lib/amazon/core/contexto';" })).toEqual([
      'imports @/lib/amazon/core/contexto (the alias is not walked)',
    ]);
    expect(d11({ [GATILHO]: 'const m = await import(nome);' })).toEqual([
      `${GATILHO} imports a computed module`,
    ]);
    expect(d11({ [GATILHO]: 'const m = require(nome);' })).toEqual([
      `${GATILHO} imports a computed module`,
    ]);
  });

  it.each([
    [
      'a template-literal dynamic import',
      'const m = await import(`../../lib/amazon/core/contexto`);',
    ],
    ['a require call', "const m = require('../../lib/amazon/core/contexto');"],
    ['an import-equals require', "import m = require('../../lib/amazon/core/contexto');"],
    ['a dynamic import with a space', "const m = await import ('../../lib/amazon/core/contexto');"],
  ])(
    'D11 guard fails closed on a module loaded in a form the walk does not follow: %s',
    (_caso, fonte) => {
      const arquivos = {
        [GATILHO]: fonte,
        'lib/amazon/core/contexto.ts': 'export const loadAmazonContext = 1;',
      };
      // The walk never reaches the context (so `reaches …` cannot fire)…
      expect(fechoDeImportacoes([GATILHO], leitor(arquivos)).arquivos).toEqual([GATILHO]);
      // …and the value import it did not follow is what flags it.
      expect(d11(arquivos)).toEqual([`unwalked ${GATILHO} → ../../lib/amazon/core/contexto`]);
    },
  );

  it.each([
    // The `@/` check reads only what the walk listed, so on its own it would pass this.
    [
      'an `@/` module through require',
      "const m = require('@/lib/amazon/core/contexto');",
      '@/lib/amazon/core/contexto',
    ],
    // The real tree's exact `externos` pin would not list this one either.
    [
      'a network module through a template-literal import',
      'const m = await import(`node:https`);',
      'node:https',
    ],
  ])(
    'D11 guard fails closed on a NON-relative module the walk does not follow: %s',
    (_caso, fonte, espec) => {
      expect(fechoDeImportacoes([GATILHO], leitor({ [GATILHO]: fonte })).externos).toEqual([]);
      expect(d11({ [GATILHO]: fonte })).toEqual([`unwalked ${GATILHO} → ${espec}`]);
    },
  );

  it('NEAR-MISS: a `require(…)` or template import only MENTIONED (a string, a comment) loads nothing', () => {
    expect(
      d11({
        [GATILHO]: [
          `const s = "require('../../lib/amazon/core/contexto')";`,
          '// await import(`../../lib/amazon/core/contexto`)',
          'export const x = s;',
        ].join('\n'),
        'lib/amazon/core/contexto.ts': 'export const loadAmazonContext = 1;',
      }),
    ).toEqual([]);
  });
});
