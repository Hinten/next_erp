import { z } from 'zod';
import { inteiroPositivoCanonicoLi } from './mapaFreteLojaIntegrada';

/**
 * The Loja Integrada CATALOGUE contract (master plan step 10, #1821): what the four read-only routes
 * of `apps/loja-integrada` answer, and the pure rules that turn the store's rows into those answers.
 *
 *  - `GET …/conta/[id]/categorias` → {@link respostaCategoriasLiSchema}
 *  - `GET …/conta/[id]/marcas` → {@link respostaMarcasLiSchema}
 *  - `GET …/conta/[id]/grades` → {@link respostaGradesLiSchema}
 *  - `GET …/conta/[id]/grades/[gradeId]` → {@link respostaGradeLiSchema}
 *
 * Declared ONCE here, because both sides need it (#1369): the backend builds every answer through
 * these schemas, and the web linker parses them. `apps/web` has no dependency edge to any app, so a
 * contract that lived in the backend would be written twice.
 *
 * ## The answers are NON-strict
 * Like `statusContaLojaIntegradaSchema`: a later step may add a field, and a browser built against
 * this version must keep parsing the answer — unknown keys are stripped, never refused. Each answer
 * is an explicit PROJECTION of the store's rows (no wire row is ever forwarded), and every id in it
 * is a positive safe integer, because a variation link can store nothing else.
 *
 * ## Ids come from `id`, never from `resource_uri`
 * A resource URI is read only where the store gives nothing else: a category's parent
 * (`categoria_pai`) and an option's grade (`grade`). {@link idDoRecursoLi} is THE reader of one.
 *
 * Pure and total: no clock, no network, no Firestore, and no input throws.
 *
 * ⚠️ Every function that turns a value into a KEY is listed in
 * `packages/config-eslint/rules/equivalence-fold-inventory.test.js`, with its equal pairs and
 * near-misses, pinned in `catalogoLojaIntegrada.test.ts`.
 */

/* -------------------------------------------------------------------------- */
/*                              Paging constants                               */
/* -------------------------------------------------------------------------- */

/**
 * The `limit` every catalogue list page asks for: 50. The owner's read-only capture of all three
 * lists (`/v1/categoria/`, `/v1/marca/` and `/v1/grades/` with `?limit=50`, two stores) read
 * `meta.limit` back as 50 on every one, and a 67-category store answered 50 rows with `meta.next`
 * set. `limit` is not a declared parameter of these three operations, so the client still reads
 * `meta.limit` back and never assumes it was honoured; no larger value was captured.
 */
export const LIMITE_PAGINA_CATALOGO_LI = 50;

/**
 * The pages one catalogue list may take before the route refuses with `LI_CATALOGO_EXCEDE_LIMITE`
 * — never a truncated list. Sized by the route's time budget, not by a guess at the row count: each
 * page costs the 2 s pacer plus at most the 20 s per-call deadline, so 10 pages + a 30 s margin =
 * 250 s, under the 300 s request ceiling of the backend. At {@link LIMITE_PAGINA_CATALOGO_LI} that
 * is 500 rows per list; the largest list captured (67 categories) takes 2 pages.
 */
export const MAX_PAGINAS_CATALOGO_LI = 10;

/* -------------------------------------------------------------------------- */
/*                          The resource-URI reader                            */
/* -------------------------------------------------------------------------- */

/**
 * The resources whose URI this contract reads. `grades` is PLURAL: an option's `grade` field is
 * `/api/v1/grades/<g>` (in the public document and in the store's captured answers alike), while
 * the option's own URI uses the singular `grade` (and two ids), which is not a grade URI.
 */
export const recursoUriLiSchema = z.enum(['categoria', 'marca', 'grades']);
export type RecursoUriLi = z.infer<typeof recursoUriLiSchema>;
export const RECURSO_URI_LI = {
  categoria: 'categoria',
  marca: 'marca',
  grades: 'grades',
} as const satisfies Record<string, RecursoUriLi>;

/** `/api/v1/<recurso>/<id>` or `/v1/<recurso>/<id>`, with at most ONE trailing slash. */
const FORMA_URI_RECURSO_LI = /^(?:\/api)?\/v1\/([a-z_]+)\/([^/?#]+)\/?$/;

/**
 * THE reader of a Loja Integrada resource URI: the positive safe-integer id it names for
 * `recurso`, else `null`. It owns only the path SHAPE; the id segment goes through
 * `inteiroPositivoCanonicoLi`, the one reader of the positive integers the Loja Integrada surfaces
 * key on.
 *
 * Both prefixes, because the store answers both: the owner's read-only capture of both stores shows
 * a category's `resource_uri` and `categoria_pai` as `/v1/categoria/<id>` (no `/api`, no trailing
 * slash), while an option's `grade` is `/api/v1/grades/<g>` and a brand's `resource_uri`
 * `/api/v1/marca/<id>`, as in the public document. Anything else reads as `null`, so the caller can
 * count it as unreadable (never as "no parent").
 *
 * Equal (⇒ `7645875`): `/api/v1/categoria/7645875` ≡ `/api/v1/categoria/7645875/` ≡
 * `/v1/categoria/7645875` ≡ `/v1/categoria/7645875/`.
 * Distinct (⇒ `null`): a leading zero (`/07645875`), a query string (`?id_externo=1` makes the id
 * OUR external id), a fragment, an absolute URL, an extra segment (`/1/2`), a doubled slash, two
 * trailing slashes, another API version (`/api/v2/…`), another resource (`/api/v1/marca/…` read as
 * `categoria`; the singular `/api/v1/grade/…` read as `grades`), `None`, `REDACTED`, `''`, and
 * anything that is not a string.
 */
export function idDoRecursoLi(uri: unknown, recurso: RecursoUriLi): number | null {
  if (typeof uri !== 'string') return null;
  const partes = FORMA_URI_RECURSO_LI.exec(uri);
  if (partes === null || partes[1] !== recurso) return null;
  const id = inteiroPositivoCanonicoLi(partes[2]);
  return id === null ? null : Number(id);
}

/**
 * A route's `gradeId` segment, as the canonical decimal the store's ids are compared in, else
 * `null` (the route answers 400 before reading anything).
 *
 * Equal: `'8946'` ⇒ `'8946'`. Distinct (⇒ `null`): `'08946'`, `' 8946'`, `'8946 '`, `'8946.0'`,
 * `'1e3'`, `'0'`, `'-1'`, `''`.
 */
export function gradeIdDaRotaLi(segmento: string): string | null {
  return inteiroPositivoCanonicoLi(segmento);
}

/**
 * Whether the grade detail the store answered IS the grade the route asked for: its `id` (a number
 * from the wire, or its decimal string) against the route's `gradeId`, both canonical.
 *
 * Equal: detail `8946` and route `'8946'`. Distinct: detail `8947`; a route `'08946'`; a detail
 * id that is not a positive safe integer (`null`, `0`, `8946.5`) is never the same grade.
 */
export function mesmaGradeLi(idDoDetalhe: unknown, gradeId: string): boolean {
  const doDetalhe = inteiroPositivoCanonicoLi(idDoDetalhe);
  return doDetalhe !== null && doDetalhe === gradeIdDaRotaLi(gradeId);
}

/* -------------------------------------------------------------------------- */
/*                              The route answers                              */
/* -------------------------------------------------------------------------- */

/** A Loja Integrada id a variation link could store: a positive safe integer. */
const idLiSchema = z.number().int().positive();

/** ms — when the answer's copy was read from the store (the backend cache's own clock). */
const lidaEmMsSchema = z.number().int().nonnegative();

/**
 * A category's parent has THREE states, never two:
 *  - `raiz`: `categoria_pai` is `null`, `''` or absent;
 *  - `id`: a URI {@link idDoRecursoLi} reads;
 *  - `ilegivel`: anything else (another prefix, an absolute URL, an object…). Never folded into
 *    `raiz`: a consumer building the tree must refuse that branch, not flatten it.
 */
export const tipoPaiCategoriaLiSchema = z.enum(['raiz', 'id', 'ilegivel']);
export type TipoPaiCategoriaLi = z.infer<typeof tipoPaiCategoriaLiSchema>;
export const TIPO_PAI_CATEGORIA_LI = {
  raiz: 'raiz',
  id: 'id',
  ilegivel: 'ilegivel',
} as const satisfies Record<string, TipoPaiCategoriaLi>;

export const paiCategoriaLiSchema = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal(TIPO_PAI_CATEGORIA_LI.raiz) }),
  z.object({ tipo: z.literal(TIPO_PAI_CATEGORIA_LI.id), id: idLiSchema }),
  z.object({ tipo: z.literal(TIPO_PAI_CATEGORIA_LI.ilegivel) }),
]);
export type PaiCategoriaLi = z.infer<typeof paiCategoriaLiSchema>;

export const categoriaCatalogoLiSchema = z.object({
  id: idLiSchema,
  nome: z.string(),
  pai: paiCategoriaLiSchema,
});
export type CategoriaCatalogoLi = z.infer<typeof categoriaCatalogoLiSchema>;

/**
 * `GET …/conta/[id]/categorias`: the store's categories, flat, in the store's order. The order is
 * undocumented, so a consumer builds the tree from `pai` without assuming parents come first.
 */
export const respostaCategoriasLiSchema = z.object({
  categorias: z.array(categoriaCatalogoLiSchema),
  lidaEmMs: lidaEmMsSchema,
});
export type RespostaCategoriasLi = z.infer<typeof respostaCategoriasLiSchema>;

export const marcaCatalogoLiSchema = z.object({
  id: idLiSchema,
  nome: z.string(),
  /** `null` when the store did not say. Inactive brands are listed, marked. */
  ativo: z.boolean().nullable(),
});
export type MarcaCatalogoLi = z.infer<typeof marcaCatalogoLiSchema>;

/** `GET …/conta/[id]/marcas`: every brand of the store, active or not. */
export const respostaMarcasLiSchema = z.object({
  marcas: z.array(marcaCatalogoLiSchema),
  lidaEmMs: lidaEmMsSchema,
});
export type RespostaMarcasLi = z.infer<typeof respostaMarcasLiSchema>;

export const gradeCatalogoLiSchema = z.object({
  id: idLiSchema,
  /** The grade's `nome`: what a variation link stores as its label. */
  nome: z.string(),
  /** The grade's `nome_visivel`; `''`, `null` or absent ⇒ `null`. */
  nomeVisivel: z.string().nullable(),
});
export type GradeCatalogoLi = z.infer<typeof gradeCatalogoLiSchema>;

/**
 * `GET …/conta/[id]/grades`: the store's own grades AND the platform's, which no field tells
 * apart — shown as `nome (id)`. Carries no options: they come one grade at a time.
 */
export const respostaGradesLiSchema = z.object({
  grades: z.array(gradeCatalogoLiSchema),
  lidaEmMs: lidaEmMsSchema,
});
export type RespostaGradesLi = z.infer<typeof respostaGradesLiSchema>;

export const opcaoGradeCatalogoLiSchema = z.object({
  id: idLiSchema,
  nome: z.string(),
});
export type OpcaoGradeCatalogoLi = z.infer<typeof opcaoGradeCatalogoLiSchema>;

/** `GET …/conta/[id]/grades/[gradeId]`: one grade and the options it offers. */
export const respostaGradeLiSchema = z.object({
  grade: gradeCatalogoLiSchema,
  opcoes: z.array(opcaoGradeCatalogoLiSchema),
  lidaEmMs: lidaEmMsSchema,
});
export type RespostaGradeLi = z.infer<typeof respostaGradeLiSchema>;

/* -------------------------------------------------------------------------- */
/*                                 Projections                                 */
/* -------------------------------------------------------------------------- */

/*
 * Each projection takes the rows the package already validated (structural types: this package
 * does not import the integration package) and returns the answer's body plus COUNTERS of what it
 * could not read, for the route's WARN line. It refuses nothing it can carry; a row whose `id` is
 * not a positive safe integer is dropped and counted in `linhasSemId`, because no link could ever
 * store it.
 */

/** A `/v1/categoria/` row as the package reads it. */
export interface LinhaCategoriaLi {
  readonly id: number;
  readonly nome: string;
  readonly categoria_pai?: unknown;
}

/** A `/v1/marca/` row as the package reads it. */
export interface LinhaMarcaLi {
  readonly id: number;
  readonly nome: string;
  readonly ativo?: unknown;
}

/** A `/v1/grades/` row as the package reads it. */
export interface LinhaGradeLi {
  readonly id: number;
  readonly nome: string;
  readonly nome_visivel?: unknown;
}

/** One `variacoes[]` row of a `/v1/grades/{id}/` detail. */
export interface LinhaOpcaoGradeLi {
  readonly id: number;
  readonly nome: string;
  readonly grade?: unknown;
}

/** A `/v1/grades/{id}/` detail as the package reads it. */
export interface DetalheGradeLi extends LinhaGradeLi {
  readonly variacoes: readonly LinhaOpcaoGradeLi[];
}

function idDaLinha(id: number): number | null {
  return inteiroPositivoCanonicoLi(id) === null ? null : id;
}

function paiDaCategoria(valor: unknown): PaiCategoriaLi {
  if (valor === null || valor === undefined || valor === '') {
    return { tipo: TIPO_PAI_CATEGORIA_LI.raiz };
  }
  const id = idDoRecursoLi(valor, RECURSO_URI_LI.categoria);
  return id === null
    ? { tipo: TIPO_PAI_CATEGORIA_LI.ilegivel }
    : { tipo: TIPO_PAI_CATEGORIA_LI.id, id };
}

/** Only the exact `''` is empty: `' '` stays `' '`. */
function nomeVisivel(valor: unknown): string | null {
  return typeof valor === 'string' && valor !== '' ? valor : null;
}

export interface ProjecaoCategoriasLi {
  readonly categorias: CategoriaCatalogoLi[];
  /** Rows whose parent is neither empty nor a readable category URI (⇒ `ilegivel`). */
  readonly paisIlegiveis: number;
  readonly linhasSemId: number;
}

/** The categories, in the store's order, each parent in one of its three states. */
export function projetarCategoriasLi(linhas: readonly LinhaCategoriaLi[]): ProjecaoCategoriasLi {
  const categorias: CategoriaCatalogoLi[] = [];
  let paisIlegiveis = 0;
  let linhasSemId = 0;
  for (const linha of linhas) {
    const id = idDaLinha(linha.id);
    if (id === null) {
      linhasSemId += 1;
      continue;
    }
    const pai = paiDaCategoria(linha.categoria_pai);
    if (pai.tipo === TIPO_PAI_CATEGORIA_LI.ilegivel) paisIlegiveis += 1;
    categorias.push({ id, nome: linha.nome, pai });
  }
  return { categorias, paisIlegiveis, linhasSemId };
}

export interface ProjecaoMarcasLi {
  readonly marcas: MarcaCatalogoLi[];
  readonly linhasSemId: number;
}

/** Every brand, inactive ones included; an `ativo` that is not a boolean reads as `null`. */
export function projetarMarcasLi(linhas: readonly LinhaMarcaLi[]): ProjecaoMarcasLi {
  const marcas: MarcaCatalogoLi[] = [];
  let linhasSemId = 0;
  for (const linha of linhas) {
    const id = idDaLinha(linha.id);
    if (id === null) {
      linhasSemId += 1;
      continue;
    }
    marcas.push({
      id,
      nome: linha.nome,
      ativo: typeof linha.ativo === 'boolean' ? linha.ativo : null,
    });
  }
  return { marcas, linhasSemId };
}

export interface ProjecaoGradesLi {
  readonly grades: GradeCatalogoLi[];
  readonly linhasSemId: number;
}

function grade(id: number, linha: LinhaGradeLi): GradeCatalogoLi {
  return { id, nome: linha.nome, nomeVisivel: nomeVisivel(linha.nome_visivel) };
}

/** Every grade, the store's and the platform's, in the store's order. */
export function projetarGradesLi(linhas: readonly LinhaGradeLi[]): ProjecaoGradesLi {
  const grades: GradeCatalogoLi[] = [];
  let linhasSemId = 0;
  for (const linha of linhas) {
    const id = idDaLinha(linha.id);
    if (id === null) {
      linhasSemId += 1;
      continue;
    }
    grades.push(grade(id, linha));
  }
  return { grades, linhasSemId };
}

export interface ProjecaoGradeLi {
  readonly grade: GradeCatalogoLi;
  readonly opcoes: OpcaoGradeCatalogoLi[];
  /**
   * Options whose `grade` READS as another grade: NOT offered. Offered, one would be stored under
   * the wrong `grade_id`, and a publish would address `/grade/{g}/variacao/{v}` with the wrong `g`.
   */
  readonly opcoesDeOutraGrade: number;
  /**
   * Options whose `grade` is absent or unreadable: still OFFERED (a wrong guess at the URI form
   * must never empty a grade), and counted.
   */
  readonly opcoesComGradeIlegivel: number;
  readonly linhasSemId: number;
}

/**
 * One grade and the options it offers. `null` when the detail's own `id` is not a positive safe
 * integer: it cannot be carried, and the route refuses such an answer (as it refuses a detail of
 * another grade, through {@link mesmaGradeLi}).
 */
export function projetarGradeLi(detalhe: DetalheGradeLi): ProjecaoGradeLi | null {
  const gradeId = idDaLinha(detalhe.id);
  if (gradeId === null) return null;
  const opcoes: OpcaoGradeCatalogoLi[] = [];
  let opcoesDeOutraGrade = 0;
  let opcoesComGradeIlegivel = 0;
  let linhasSemId = 0;
  for (const opcao of detalhe.variacoes) {
    const id = idDaLinha(opcao.id);
    if (id === null) {
      linhasSemId += 1;
      continue;
    }
    const daOpcao = idDoRecursoLi(opcao.grade, RECURSO_URI_LI.grades);
    if (daOpcao === null) {
      opcoesComGradeIlegivel += 1;
    } else if (daOpcao !== gradeId) {
      opcoesDeOutraGrade += 1;
      continue;
    }
    opcoes.push({ id, nome: opcao.nome });
  }
  return {
    grade: grade(gradeId, detalhe),
    opcoes,
    opcoesDeOutraGrade,
    opcoesComGradeIlegivel,
    linhasSemId,
  };
}
