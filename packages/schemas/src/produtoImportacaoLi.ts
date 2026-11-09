import { z } from 'zod';
import { RECURSO_URI_LI, idDoRecursoLi, opcaoDoRecursoLi } from './catalogoLojaIntegrada';
import { inteiroPositivoCanonicoLi } from './mapaFreteLojaIntegrada';
import { skuDoMembroUnico } from './produto/pureLogic/familia';

/**
 * The ONE reader of a Loja Integrada product into the typed views the product import (master
 * plan step 9) decides on and stores:
 *
 *  - {@link lerProdutoLi} — the ROW view, what a `GET /v1/produto/` list row carries;
 *  - {@link lerDetalheProdutoLi} — the DETAIL view, what a `GET /v1/produto/{id}/` answer adds:
 *    the parent, the brand, the weight and dimensions, the description and the images.
 *
 * Structural input types (this package does not import the integration package, the step-10
 * projection convention): the package validates the wire, this module turns it into views. Both
 * readers are total — no input throws — and a row whose `id` is not a positive safe integer reads
 * as `null`, for the caller to count.
 *
 * ## What the views deliberately do not carry
 * No price, no stock, no SEO, no tags, no store URL: the import never brings price or stock (the
 * owner's decision of 2026-10-27: the ERP is the master, so both flow ERP → store only), and a
 * view is what gets STORED in the job's snapshot. A description longer than
 * {@link MAX_DESCRICAO_LI} is stored as its LENGTH only (`descricaoLonga`), never as text: the
 * ERP's description field holds at most that many characters, and a cut text is never written.
 *
 * ## Ids come from `id`, never from `resource_uri`
 * Every other id is read from a resource URI through the catalogue module's readers
 * ({@link idDoRecursoLi}, {@link opcaoDoRecursoLi}): `filhos`, `pai`, `categorias`, `marca` and the
 * two-id option URIs of `variacoes`. An unreadable URI is COUNTED (`ilegiveis`), never dropped
 * silently and never read as "none".
 *
 * ## Text: `''` is nothing, nothing else is folded
 * `sku`, `nome` and `gtin` are kept VERBATIM; only the exact `''` (and a non-string) reads as
 * `null`. `' X '` stays `' X '`: the SKU is an identity and is compared byte for byte
 * ({@link mesmoSkuLi}). The one place a SKU is folded is the pair {@link skuParecidoLi} and
 * {@link skusParecidosNaLojaLi}: both can only REFUSE a create, never link two products.
 *
 * Pure and total: no clock, no network, no Firestore.
 *
 * ⚠️ Every function here that decides "the same" is listed in
 * `packages/config-eslint/rules/equivalence-fold-inventory.test.js`, with its equal pairs and
 * near-misses pinned in `produtoImportacaoLi.test.ts`.
 */

/* -------------------------------------------------------------------------- */
/*                                  Constants                                  */
/* -------------------------------------------------------------------------- */

/** The ERP description field's ceiling (`extraData.descricao`), HTML included. */
export const MAX_DESCRICAO_LI = 3_000;

/** At most this many images per product are kept, after ordering (the principal first). */
export const MAX_IMAGENS_PRODUTO_LI = 50;

/* -------------------------------------------------------------------------- */
/*                                 The views                                   */
/* -------------------------------------------------------------------------- */

/**
 * A product's `tipo`. `normal` is a simple product, `atributo` a parent with variations,
 * `atributo_opcao` a variation. Anything else reads as `desconhecido` — reported, never treated as
 * `normal`. Exact: `'Normal'` is `desconhecido`.
 */
export const tipoProdutoLiSchema = z.enum(['normal', 'atributo', 'atributo_opcao', 'desconhecido']);
export type TipoProdutoLi = z.infer<typeof tipoProdutoLiSchema>;

/** Named members of {@link tipoProdutoLiSchema} — see `delfrance/prefer-schema-enum`. */
export const TIPO_PRODUTO_LI = {
  normal: 'normal',
  atributo: 'atributo',
  atributoOpcao: 'atributo_opcao',
  desconhecido: 'desconhecido',
} as const satisfies Record<string, TipoProdutoLi>;

/** A Loja Integrada id: a positive safe integer. */
const idLiSchema = z.number().int().positive();

/** One store option of a variation: the grade and the option inside it. */
export const opcaoProdutoLiSchema = z.object({
  gradeId: idLiSchema,
  opcaoId: idLiSchema,
});
export type OpcaoProdutoLi = z.infer<typeof opcaoProdutoLiSchema>;

/** How many URIs of each list could not be read (each one COUNTED, never dropped silently). */
export const ilegiveisProdutoLiSchema = z.object({
  filhos: z.number().int().nonnegative(),
  categorias: z.number().int().nonnegative(),
  opcoes: z.number().int().nonnegative(),
});
export type IlegiveisProdutoLi = z.infer<typeof ilegiveisProdutoLiSchema>;

/** The ROW view: what a list row carries, as the import decides on it. */
export const produtoLiLidoSchema = z.object({
  id: idLiSchema,
  tipo: tipoProdutoLiSchema,
  /** Verbatim; `''` or a non-string ⇒ `null` (the product cannot be linked or created by SKU). */
  sku: z.string().min(1).nullable(),
  nome: z.string().min(1).nullable(),
  /** `null` when the store did not send a boolean. */
  ativo: z.boolean().nullable(),
  bloqueado: z.boolean().nullable(),
  removido: z.boolean().nullable(),
  /** The children a parent names in `filhos`, in the store's order, without repeats. */
  filhoIds: z.array(idLiSchema),
  /** The categories of `categorias`, in the store's order, without repeats. */
  categoriaIds: z.array(idLiSchema),
  /** A variation's options, from `variacoes`, in the store's order, without repeats. */
  opcoes: z.array(opcaoProdutoLiSchema),
  gtin: z.string().min(1).nullable(),
  /** The URIs a link doc stores VERBATIM (only string elements, in order). */
  categorias: z.array(z.string()),
  grades: z.array(z.string()),
  variacoes: z.array(z.string()),
  ilegiveis: ilegiveisProdutoLiSchema,
});
export type ProdutoLiLido = z.infer<typeof produtoLiLidoSchema>;

/** One product image, as stored: the CDN path, never an absolute URL from the body. */
export const imagemProdutoLiSchema = z.object({
  id: idLiSchema,
  caminho: z.string().min(1),
  principal: z.boolean(),
  /** As the store sent it: a string, a number or `null`. */
  posicao: z.union([z.string(), z.number()]).nullable(),
});
export type ImagemProdutoLi = z.infer<typeof imagemProdutoLiSchema>;

/** The DETAIL view: the row view plus what only a detail carries. */
export const produtoLiDetalhadoSchema = produtoLiLidoSchema.extend({
  /** A variation's parent, from `pai`. `null` with `paiIlegivel: false` when there is none. */
  paiId: idLiSchema.nullable(),
  /** `pai` was neither empty nor a readable product URI — never read as "no parent". */
  paiIlegivel: z.boolean(),
  marcaId: idLiSchema.nullable(),
  /**
   * The brand URI a link doc stores VERBATIM (the row URIs' rule), kept only when it reads as a
   * brand URI (`marcaId` set); `null` otherwise. A detail stored before it existed reads `null`.
   */
  marca: z.string().min(1).nullable().default(null),
  destaque: z.boolean().nullable(),
  usado: z.boolean().nullable(),
  /** kg; `null` when absent, unreadable or not positive. */
  pesoKg: z.number().positive().nullable(),
  /** cm; `null` when absent, unreadable or not positive. */
  alturaCm: z.number().positive().nullable(),
  larguraCm: z.number().positive().nullable(),
  profundidadeCm: z.number().positive().nullable(),
  /** `descricao_completa` verbatim when at most {@link MAX_DESCRICAO_LI} characters, else `null`. */
  descricao: z.string().min(1).nullable(),
  /** The store's description exceeds {@link MAX_DESCRICAO_LI}: stored as its length only. */
  descricaoLonga: z.boolean(),
  descricaoTamanho: z.number().int().nonnegative(),
  /** Ordered (the principal first, then by `posicao`), de-duplicated by `id`, at most 50. */
  imagens: z.array(imagemProdutoLiSchema),
  /** Images not kept: unreadable (`id` or `caminho`) or past the ceiling. */
  imagensDescartadas: z.number().int().nonnegative(),
});
export type ProdutoLiDetalhado = z.infer<typeof produtoLiDetalhadoSchema>;

/* -------------------------------------------------------------------------- */
/*                            The structural inputs                            */
/* -------------------------------------------------------------------------- */

/** A `GET /v1/produto/` row as the package reads it. Only `id` is typed: everything is read. */
export interface LinhaProdutoLi {
  readonly id: number;
  readonly tipo?: unknown;
  readonly sku?: unknown;
  readonly nome?: unknown;
  readonly ativo?: unknown;
  readonly bloqueado?: unknown;
  readonly removido?: unknown;
  readonly filhos?: unknown;
  readonly categorias?: unknown;
  readonly grades?: unknown;
  readonly variacoes?: unknown;
  readonly gtin?: unknown;
}

/** A `GET /v1/produto/{id}/` answer as the package projects it. */
export interface LinhaDetalheProdutoLi extends LinhaProdutoLi {
  readonly pai?: unknown;
  readonly marca?: unknown;
  readonly destaque?: unknown;
  readonly usado?: unknown;
  readonly peso?: unknown;
  readonly altura?: unknown;
  readonly largura?: unknown;
  readonly profundidade?: unknown;
  readonly descricao_completa?: unknown;
  readonly imagem_principal?: unknown;
  readonly imagens?: unknown;
}

/* -------------------------------------------------------------------------- */
/*                                  Readers                                    */
/* -------------------------------------------------------------------------- */

function texto(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function booleano(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

/** The string elements of a list, verbatim and in order; anything else ⇒ `[]`. */
function textos(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const lista: readonly unknown[] = v;
  return lista.filter((e): e is string => typeof e === 'string');
}

/** Every element of a list read by `ler`, without repeats; the unreadable ones counted. */
function lerLista<T>(
  v: unknown,
  ler: (e: unknown) => T | null,
  chave: (t: T) => string,
): { readonly lidos: T[]; readonly ilegiveis: number } {
  if (!Array.isArray(v)) return { lidos: [], ilegiveis: 0 };
  const lista: readonly unknown[] = v;
  const lidos: T[] = [];
  const vistos = new Set<string>();
  let ilegiveis = 0;
  for (const e of lista) {
    const t = ler(e);
    if (t === null) {
      ilegiveis += 1;
      continue;
    }
    const k = chave(t);
    if (vistos.has(k)) continue;
    vistos.add(k);
    lidos.push(t);
  }
  return { lidos, ilegiveis };
}

function lerTipo(v: unknown): TipoProdutoLi {
  switch (v) {
    case TIPO_PRODUTO_LI.normal:
      return TIPO_PRODUTO_LI.normal;
    case TIPO_PRODUTO_LI.atributo:
      return TIPO_PRODUTO_LI.atributo;
    case TIPO_PRODUTO_LI.atributoOpcao:
      return TIPO_PRODUTO_LI.atributoOpcao;
    default:
      return TIPO_PRODUTO_LI.desconhecido;
  }
}

/** A positive safe integer id (number or canonical decimal text), else `null`. */
function idLi(v: unknown): number | null {
  const id = inteiroPositivoCanonicoLi(v);
  return id === null ? null : Number(id);
}

/**
 * The ROW view of a list row, or `null` when its `id` is not a positive safe integer (no link
 * could ever store it; the caller counts it).
 */
export function lerProdutoLi(linha: LinhaProdutoLi): ProdutoLiLido | null {
  const id = idLi(linha.id);
  if (id === null) return null;
  const filhos = lerLista(linha.filhos, (e) => idDoRecursoLi(e, RECURSO_URI_LI.produto), String);
  const categorias = lerLista(
    linha.categorias,
    (e) => idDoRecursoLi(e, RECURSO_URI_LI.categoria),
    String,
  );
  const opcoes = lerLista(linha.variacoes, opcaoDoRecursoLi, (o) => `${o.gradeId}:${o.opcaoId}`);
  return {
    id,
    tipo: lerTipo(linha.tipo),
    sku: texto(linha.sku),
    nome: texto(linha.nome),
    ativo: booleano(linha.ativo),
    bloqueado: booleano(linha.bloqueado),
    removido: booleano(linha.removido),
    filhoIds: filhos.lidos,
    categoriaIds: categorias.lidos,
    opcoes: opcoes.lidos.map((o) => ({ gradeId: o.gradeId, opcaoId: o.opcaoId })),
    gtin: texto(linha.gtin),
    categorias: textos(linha.categorias),
    grades: textos(linha.grades),
    variacoes: textos(linha.variacoes),
    ilegiveis: {
      filhos: filhos.ilegiveis,
      categorias: categorias.ilegiveis,
      opcoes: opcoes.ilegiveis,
    },
  };
}

/** A plain decimal as the store writes a weight: digits, optionally `.` and digits. */
const DECIMAL_SIMPLES = /^[0-9]+(?:\.[0-9]+)?$/;

/**
 * A positive measure (kg or cm), else `null`.
 *
 * The store sends the weight as a STRING decimal (`"0.200"`; float noise such as
 * `"0.450000000000000011…"` reads as `0.45`, `"0.500"` as `0.5`) and the dimensions as integers;
 * either form is read, as a finite number or a plain decimal text. Not a measure: a comma decimal
 * (`"0,5"`), an exponent, a sign, `''`, a non-number. ⚠️ ZERO reads as `null` (nothing), never
 * as a value: a `0` weight or dimension is no measure, and writing it into an empty ERP field
 * would fill that field for good with a number no freight quote can use.
 */
export function medidaPositivaLi(v: unknown): number | null {
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && DECIMAL_SIMPLES.test(v)) n = Number(v);
  else return null;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function objeto(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** `posicao` as a sort key: a finite number, or a digit text; anything else sorts LAST. */
function chavePosicao(posicao: string | number | null): number | null {
  if (typeof posicao === 'number') return Number.isFinite(posicao) ? posicao : null;
  if (typeof posicao === 'string' && /^[0-9]{1,15}$/.test(posicao)) return Number(posicao);
  return null;
}

/**
 * The images of a detail: `imagem_principal` and `imagens[]`, de-duplicated by `id` (an image
 * named in both is ONE image, principal if either says so), ordered the principal first, then by
 * `posicao` ascending (a `null` or unreadable `posicao` after every number), then in the store's
 * order; at most {@link MAX_IMAGENS_PRODUTO_LI}. Only `caminho` is kept as the address: the
 * body's absolute URLs (`grande`, `media`…) are never stored, so a fetch can only ever be built
 * from a pinned host and a path.
 */
function lerImagens(detalhe: LinhaDetalheProdutoLi): {
  readonly imagens: ImagemProdutoLi[];
  readonly descartadas: number;
} {
  // `imagem_principal` is the principal by being that field, whatever its own flag says.
  const brutas: { readonly bruta: unknown; readonly doCampoPrincipal: boolean }[] = [];
  if (detalhe.imagem_principal !== null && detalhe.imagem_principal !== undefined) {
    brutas.push({ bruta: detalhe.imagem_principal, doCampoPrincipal: true });
  }
  if (Array.isArray(detalhe.imagens)) {
    const lista: readonly unknown[] = detalhe.imagens;
    for (const bruta of lista) brutas.push({ bruta, doCampoPrincipal: false });
  }

  const porId = new Map<number, { imagem: ImagemProdutoLi; ordem: number }>();
  let descartadas = 0;
  brutas.forEach(({ bruta, doCampoPrincipal }, ordem) => {
    const o = objeto(bruta);
    const id = o === null ? null : idLi(o.id);
    const caminho = o === null ? null : texto(o.caminho);
    if (o === null || id === null || caminho === null) {
      descartadas += 1;
      return;
    }
    const principal = doCampoPrincipal || o.principal === true;
    const posicao =
      typeof o.posicao === 'string' || typeof o.posicao === 'number' ? o.posicao : null;
    const ja = porId.get(id);
    if (ja !== undefined) {
      if (principal && !ja.imagem.principal) ja.imagem = { ...ja.imagem, principal: true };
      return;
    }
    porId.set(id, { imagem: { id, caminho, principal, posicao }, ordem });
  });

  const ordenadas = [...porId.values()].sort((a, b) => {
    if (a.imagem.principal !== b.imagem.principal) return a.imagem.principal ? -1 : 1;
    const pa = chavePosicao(a.imagem.posicao);
    const pb = chavePosicao(b.imagem.posicao);
    if (pa !== null && pb !== null && pa !== pb) return pa - pb;
    if (pa === null && pb !== null) return 1;
    if (pa !== null && pb === null) return -1;
    return a.ordem - b.ordem;
  });
  const imagens = ordenadas.slice(0, MAX_IMAGENS_PRODUTO_LI).map((x) => x.imagem);
  return { imagens, descartadas: descartadas + (ordenadas.length - imagens.length) };
}

/**
 * The DETAIL view of a product detail, or `null` when its `id` is not a positive safe integer.
 *
 * A variation's detail carries its own `peso` and dimensions, its `pai` and its option URIs, and
 * no images and no categories (those are read from its parent). `pai`, like a category's parent,
 * is never folded into "none": empty (`null`, `''`, absent) ⇒ `paiId: null`; a readable product
 * URI ⇒ its id; anything else ⇒ `paiIlegivel: true`.
 */
export function lerDetalheProdutoLi(detalhe: LinhaDetalheProdutoLi): ProdutoLiDetalhado | null {
  const linha = lerProdutoLi(detalhe);
  if (linha === null) return null;

  const paiVazio = detalhe.pai === null || detalhe.pai === undefined || detalhe.pai === '';
  const paiId = paiVazio ? null : idDoRecursoLi(detalhe.pai, RECURSO_URI_LI.produto);

  const descricaoBruta = texto(detalhe.descricao_completa);
  const descricaoTamanho = descricaoBruta === null ? 0 : descricaoBruta.length;
  const descricaoLonga = descricaoTamanho > MAX_DESCRICAO_LI;

  const { imagens, descartadas } = lerImagens(detalhe);
  const marcaId = idDoRecursoLi(detalhe.marca, RECURSO_URI_LI.marca);

  return {
    ...linha,
    paiId,
    paiIlegivel: !paiVazio && paiId === null,
    marcaId,
    marca: marcaId !== null && typeof detalhe.marca === 'string' ? detalhe.marca : null,
    destaque: booleano(detalhe.destaque),
    usado: booleano(detalhe.usado),
    pesoKg: medidaPositivaLi(detalhe.peso),
    alturaCm: medidaPositivaLi(detalhe.altura),
    larguraCm: medidaPositivaLi(detalhe.largura),
    profundidadeCm: medidaPositivaLi(detalhe.profundidade),
    descricao: descricaoLonga ? null : descricaoBruta,
    descricaoLonga,
    descricaoTamanho,
    imagens,
    imagensDescartadas: descartadas,
  };
}

/* -------------------------------------------------------------------------- */
/*                                  SKU folds                                  */
/* -------------------------------------------------------------------------- */

/**
 * THE SKU identity of the import: exact bytes, no fold. Two products are the same only when both
 * SKUs are non-empty strings with the same characters.
 *
 * Equal: `'Q65VXE4BB'` ≡ `'Q65VXE4BB'`; a 15-digit numeric SKU ≡ itself.
 * Distinct: `'q65vxe4bb'`, `'Q65VXE4BB '`, `' Q65VXE4BB'`, a no-break space, `'01'` vs `'1'`, a
 * child's `'Q65VXE4BB-abacaxi'`; `''` is never equal to anything, not even `''`.
 */
export function mesmoSkuLi(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && a !== '' && a === b;
}

/**
 * The SKU probe forms of the create guard ("parecido"): the store SKU verbatim, trimmed,
 * upper-cased, lower-cased, trimmed and upper-cased, trimmed and lower-cased — in that order,
 * without repeats, never `''`. An ERP produto whose stored SKU equals one of them is a NEAR
 * duplicate: the import refuses to create beside it and asks a person, it NEVER links by it.
 *
 * ⚠️ A guard for the common cases, never a full fold: only the STORE side is folded. An ERP SKU in
 * MIXED case (`'Abc-1'` against the store's `'abc-1'`) or with spaces at its own ends (`'ABC-1 '`)
 * is not reached — the Simular report is the backstop for those.
 *
 * Parecido: store `'abc-1'` vs ERP `'ABC-1'`; `'ABC-1 '` vs `'ABC-1'`; `' Abc-1'` vs `'ABC-1'`.
 * Not parecido: `'ABC-2'`, `'ABC1'`, `'ABC-1-UN'` vs `'ABC-1'`.
 */
export function skuParecidoLi(sku: unknown): string[] {
  if (typeof sku !== 'string') return [];
  const aparado = sku.trim();
  const formas = [
    sku,
    aparado,
    sku.toUpperCase(),
    sku.toLowerCase(),
    aparado.toUpperCase(),
    aparado.toLowerCase(),
  ];
  const saida: string[] = [];
  for (const forma of formas) if (forma !== '' && !saida.includes(forma)) saida.push(forma);
  return saida;
}

/** One row of the job's assembly, as {@link skusParecidosNaLojaLi} reads it. */
export interface SkuDaLojaLi {
  /** The row's SKU, verbatim. Anything but a non-empty string carries no SKU. */
  readonly sku: unknown;
  /** A simple store product: its create also writes its sole member's derived SKU. */
  readonly simples: boolean;
}

/**
 * The store-side near duplicates, decided from the whole snapshot before anything is created, so
 * processing order never picks a winner and Simular answers as `aplicar` does. Every SKU the job
 * would write (each row's own, and a simple product's `skuDoMembroUnico`) is listed under its probe
 * forms ({@link skuParecidoLi}); two rows whose written SKUs share a form collide, and BOTH rows' OWN
 * SKUs are returned. Both sides are in memory here, so the probe's stated ERP-side limit does not
 * apply. Two rows with the SAME bytes are one SKU here: an exact repeat is the caller's other rule
 * (`sku-repetido-na-loja`), never this one.
 *
 * Equal (both returned): `'ABC-1'` and `'abc-1'`; `'ABC-1'` and `'ABC-1 '`; `' Abc-1'` and `'ABC-1'`;
 * `'Abc-1'` and `'aBC-1'`; a simple `'X'` (derived `'X-UN'`) and a row `'X-UN'`; a simple `'X'` and a
 * row `'x-un'`.
 * Distinct: `'ABC-1'` and `'ABC-2'`; `'X-AZ'` and `'X-AZUL'`; `'ABC-1'` and `'ABC1'`; `'01'` and `'1'`;
 * a simple `'X'` and a row `'X-UNI'`; a PARENT `'X'` (no member) and a row `'X-UN'`; `'X'` twice;
 * a simple `'X'` alone (its own derived SKU is no other row).
 *
 * ⚠️ Sharing a form is exact on ASCII (non-empty, trimmed, case-folded equality) and WIDER beyond it:
 * characters that share an upper or a lower case collide, as `'ß'` and `'ss'` do through `'SS'` and
 * the Kelvin sign and `'K'` through `'k'`, although the probe calls neither parecido with the other.
 * A stated over-fold, kept on purpose: asking for the probe's one-way reach instead would lose
 * `'Abc-1'` and `'aBC-1'`, and its worst case is one refused create with an actionable pendência.
 *
 * Pure and total.
 */
export function skusParecidosNaLojaLi(linhas: readonly SkuDaLojaLi[]): ReadonlySet<string> {
  const donosPorForma = new Map<string, Set<string>>();
  const registrar = (escrito: string, dono: string): void => {
    for (const forma of skuParecidoLi(escrito)) {
      const donos = donosPorForma.get(forma) ?? new Set<string>();
      donos.add(dono);
      donosPorForma.set(forma, donos);
    }
  };
  for (const { sku, simples } of linhas) {
    if (typeof sku !== 'string' || sku === '') continue;
    registrar(sku, sku);
    if (simples) {
      const membro = skuDoMembroUnico(sku);
      if (membro !== null) registrar(membro, sku);
    }
  }
  const saida = new Set<string>();
  for (const donos of donosPorForma.values()) {
    if (donos.size > 1) for (const dono of donos) saida.add(dono);
  }
  return saida;
}
