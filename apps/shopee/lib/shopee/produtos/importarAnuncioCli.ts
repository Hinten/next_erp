/**
 * The pure half of `scripts/importar-anuncio.ts` (#1517, step 9) — argument
 * parsing, the **allow-list** summaries of an import plan, their renderers and
 * the usage text.
 *
 * ⚠️ **It lives here rather than in the script because `scripts/` is outside
 * this app's vitest `include`** (`{app,lib,functions}/**\/*.test.ts`), so logic
 * written in a script file can never be tested. Same reasoning, same shape as
 * `importarPedidoCli.ts`, `liquidarPagamentosCli.ts`, `rastrearPedidoCli.ts` and
 * `varrerReservasCli.ts`. The script keeps the I/O and nothing else.
 *
 * ⚠️ **Script-only, imported by no route, no job and no bundle.** Nothing here
 * reads `process.env`, opens a client, touches Firestore or reads a clock: every
 * instant it renders arrives inside the plan it was handed. Its only value
 * imports are two pure modules of this app (the CLI error describer and the
 * blocked-import error class); everything from the IO modules is `import type`,
 * which is erased.
 *
 * ## The redaction is an ALLOW-LIST, and that is the whole design
 *
 * No builder below copies an input object. Every field of
 * {@link ResumoImportacaoShopee} is named and constructed one at a time, so a
 * field that is not listed cannot appear in the output — including a field a
 * future schema change adds to the produto, to the link document or to Shopee's
 * own row. A denylist has the opposite property: it protects the fields somebody
 * remembered.
 *
 * Four fields deserve their own sentence, and each is a decision:
 *
 *  - **`description` is NEVER printed** — only {@link ResumoImportacaoShopee.descricaoChars},
 *    the character count of the text this import WOULD store. A listing
 *    description is seller-authored prose that can carry a phone number, an
 *    address or a shop's private terms, and a terminal transcript gets pasted
 *    into issues exactly like a log stream does.
 *  - **`tax_info` VALUES are never printed** — only
 *    {@link ResumoImportacaoShopee.taxInfoCampos}, the KEYS that arrived. The
 *    fiscal block is the shop's own configuration (NCM, CSOSN, CFOP pairs), the
 *    rehearsal only has to answer "did it arrive and how complete is it", and
 *    the block rides `.passthrough()` so a key nobody declared can appear in it.
 *  - **Image URLs are printed as COUNTS**, never as URLs: `redact.ts` already
 *    denylists a product image URL, and a signed Shopee URL is a credential
 *    shaped like a link.
 *  - **`item_name` IS printed.** It is the seller's public listing title, it is
 *    what the produto will be called, and showing it is the one thing this
 *    rehearsal exists for.
 *
 * ## ⚠️ What a dry run can and cannot know
 *
 * Everything here is read off the PLAN, which is pure data produced before any
 * write. So a count it reports is what the importer intends, never what landed:
 * `variacoes.criar` is the set of children the plan mints, and the child ids it
 * prints come from the plan's own derivation input — the same array the writer
 * walks index-aligned with `filhos`.
 */
import { ArgumentoInvalidoError, descreverErro } from '../pedidos/importarPedidoCli';
import { ShopeeImportBlockedError } from './errosImportacao';
import type { ItemLido, ResultadoImportacaoShopee } from './itemLido';
// ⚠️ TYPE-ONLY, and structurally so: a VALUE import of either module would pull
// `firebase-admin/firestore` and the collection handles into the `--help` path,
// which the script keeps free of every heavy import behind a dynamic one.
import type { ComponenteDoKitShopee } from './kitShopee';
import type { PlanoImportacaoShopee } from './planoImportacao';

export { ArgumentoInvalidoError };

/* -------------------------------------------------------------------------- */
/*                                  arguments                                  */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ No `--` separator in any documented invocation: pnpm forwards the literal
 * token INTO the script and every CLI in this repo parses `process.argv` itself,
 * so the separator would be read as an argument.
 * `packages/config-eslint/rules/pnpm-run-args.test.js` fails CI on the spelling
 * that carries one — including inside this string.
 */
export const USO_IMPORTAR_ANUNCIO = `
Importa UM anúncio da Shopee para o catálogo do ERP, pelo caminho real do step 9.

  pnpm --filter @delfrance/shopee-app importar:anuncio \\
    --integracao <integracaoId> --item <item_id> [opções]

Obrigatórios
  --integracao <id>   documento da integração Shopee (ex.: int-1)
  --item <item_id>    o anúncio da Shopee, só dígitos (ex.: 2500139861)

Opções
  --dry-run           lê, resolve e PLANEJA, sem gravar nada. É o PADRÃO.
  --live              GRAVA: roda o importador de verdade (produto, variações,
                      grupos, categorias, vínculos, estoque, preço e fotos) e
                      depois relê o produto.
  --project <id>      sobrescreve FIREBASE_PROJECT_ID antes de abrir o admin.
  --json              imprime o mesmo resumo redigido em JSON no stdout
                      (o cabeçalho vai para o stderr).
  --help, -h          mostra esta ajuda e sai com 0, sem abrir o Firestore
                      nem chamar a Shopee.

O dry-run continua CHAMANDO a Shopee (get_item_base_info e, conforme o anúncio,
get_model_list ou get_kit_item_info) e lendo o Firestore — ele não grava, e isso
é estrutural: a metade write-free do importador não tem escritor nenhum no corpo.
Um anúncio BLOQUEADO (kit sem componente vinculado, item deletado, sem nome) é
uma RESPOSTA: sai com 0. Ver apps/shopee/scripts/README.md.
`.trim();

export interface ArgsImportarAnuncio {
  readonly integracaoId: string;
  /** The Shopee `item_id`, a NUMBER — a stringified id matches no link composite. */
  readonly itemId: number;
  /** `false` — the DRY-RUN default. `--live` is the only way to write. */
  readonly live: boolean;
  readonly json: boolean;
  /** `null` keeps whatever the environment resolves. */
  readonly projectId: string | null;
}

export type ComandoImportarAnuncio =
  | { readonly kind: 'ajuda' }
  | { readonly kind: 'importar'; readonly args: ArgsImportarAnuncio };

/** `--item` took something that is not a bare run of digits. */
export const MSG_ITEM_NAO_NUMERICO =
  '--item exige o item_id só em dígitos (ex.: 2500139861): sem espaços, sinal, ponto ou vírgula.';

function valorDe(nome: string, inline: string | undefined, proximo: string | undefined): string {
  const bruto = (inline ?? proximo)?.trim();
  if (bruto == null || bruto.length === 0 || bruto.startsWith('--')) {
    throw new ArgumentoInvalidoError(`--${nome} exige um valor.`);
  }
  return bruto;
}

/**
 * The raw token, deliberately NOT trimmed.
 *
 * ⚠️ `--item " 2500139861"` is refused rather than cleaned up. The value becomes
 * a NUMBER that keys `prodshopee.item_id` and the deterministic produto id, so a
 * reader that silently repairs its input is a reader that cannot tell a typo
 * from an id — and the one thing the operator must be sure of is that the id
 * they typed is the id that was imported.
 */
function valorBrutoDe(
  nome: string,
  inline: string | undefined,
  proximo: string | undefined,
): string {
  const bruto = inline ?? proximo;
  if (bruto == null || bruto.length === 0 || bruto.startsWith('--')) {
    throw new ArgumentoInvalidoError(`--${nome} exige um valor.`);
  }
  return bruto;
}

const SO_DIGITOS = /^[0-9]+$/;

function itemIdDe(bruto: string): number {
  if (!SO_DIGITOS.test(bruto)) throw new ArgumentoInvalidoError(MSG_ITEM_NAO_NUMERICO);
  const valor = Number(bruto);
  // ⚠️ `0` passes the digit test and is not an item_id; and Shopee's ids are
  // int64, so a run of digits can exceed what a JS number represents exactly —
  // which would import a DIFFERENT listing without a word.
  if (!Number.isSafeInteger(valor) || valor <= 0) {
    throw new ArgumentoInvalidoError(
      `--item ${bruto} não é um item_id utilizável (inteiro positivo dentro do seguro).`,
    );
  }
  return valor;
}

/**
 * Parse the command line. Pure — it reads no environment and no clock.
 *
 * ⚠️ `--help` is answered BEFORE anything is validated, so `--help` on its own
 * exits 0 instead of complaining about the two required flags. The script's side
 * of that bargain is to return before its first dynamic import.
 *
 * ⚠️ **Dry-run is the default and `--live` is the only opt-in.** Passing both
 * `--dry-run` and `--live` is a contradiction and is REFUSED rather than
 * resolved by precedence: whichever way a precedence rule fell, half the readers
 * of the command line would expect the other.
 */
export function parseArgsImportarAnuncio(argv: readonly string[]): ComandoImportarAnuncio {
  if (argv.some((a) => a === '--help' || a === '-h')) return { kind: 'ajuda' };

  let integracaoId: string | undefined;
  let itemBruto: string | undefined;
  let projectId: string | undefined;
  let live = false;
  let dryRunExplicito = false;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--') {
      throw new ArgumentoInvalidoError(
        'Separador "--" recebido como argumento: o pnpm repassa esse token para o script. ' +
          'Remova-o e passe as flags direto (veja --help).',
      );
    }
    const igual = arg.indexOf('=');
    const nome = igual === -1 ? arg : arg.slice(0, igual);
    const inline = igual === -1 ? undefined : arg.slice(igual + 1);
    switch (nome) {
      case '--integracao':
        integracaoId = valorDe('integracao', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        break;
      case '--item':
        itemBruto = valorBrutoDe('item', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        break;
      case '--project':
        projectId = valorDe('project', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        break;
      case '--live':
        live = true;
        break;
      case '--dry-run':
        dryRunExplicito = true;
        break;
      case '--json':
        json = true;
        break;
      default:
        throw new ArgumentoInvalidoError(`Opção desconhecida: ${arg}`);
    }
  }

  if (live && dryRunExplicito) {
    throw new ArgumentoInvalidoError('--live e --dry-run são contraditórios; escolha um.');
  }
  if (integracaoId == null) {
    throw new ArgumentoInvalidoError('--integracao <integracaoId> é obrigatório.');
  }
  if (itemBruto == null) throw new ArgumentoInvalidoError('--item <item_id> é obrigatório.');

  return {
    kind: 'importar',
    args: { integracaoId, itemId: itemIdDe(itemBruto), live, json, projectId: projectId ?? null },
  };
}

/* -------------------------------------------------------------------------- */
/*                            the redacted summary                             */
/* -------------------------------------------------------------------------- */

/** One `grupoDeVariacoes` tier, as the plan decided it. */
export interface ResumoGrupoShopee {
  readonly grupoId: string;
  /** The tier NAME, and only on a create — a match carries no document to read it from. */
  readonly nome: string | null;
  readonly criar: boolean;
  /** A match that still has something to say writes a guarded patch. */
  readonly temPatch: boolean;
  readonly variantes: number;
}

/** One model's write plan, reduced. */
export interface ResumoVariacaoShopee {
  readonly modelId: number;
  readonly produtoId: string | null;
  readonly criar: boolean;
  readonly temPatch: boolean;
  readonly link: 'add' | 'merge' | 'nenhum';
  readonly estoque: number | null;
  readonly precoIgnorado: string | null;
  readonly estoqueIgnorado: string | null;
}

/** One kit component, resolved — the K1 table. */
export interface ResumoComponenteKitShopee {
  readonly modelId: number;
  readonly itemId: number;
  readonly modelIdDoComponente: number;
  readonly sku: string | null;
  readonly quantidade: number;
  readonly produtoId: string | null;
  readonly via: string;
}

/** ONE import, reduced to what a rehearsal needs and nothing a seller authored. */
export interface ResumoImportacaoShopee {
  readonly itemId: number;
  readonly produtoId: string;
  readonly acao: 'criar' | 'atualizar';
  readonly nome: string;
  readonly nomeChars: number;
  readonly sku: string | null;
  readonly gtin: string | null;
  readonly publicado: boolean | null;
  readonly pesoKg: number | null;
  readonly alturaCm: number | null;
  readonly larguraCm: number | null;
  readonly profundidadeCm: number | null;
  /** The produto keys this import would write. KEYS, never values. */
  readonly camposProduto: readonly string[];
  /** The `extraData` keys this import would write — `descricao` and `marca` live here. */
  readonly camposExtraData: readonly string[];
  /** REDACTED: the character count of the description that would be written. */
  readonly descricaoChars: number | null;
  readonly taxInfoPresente: boolean;
  /** The fiscal block's KEYS that carry a value. NEVER the values. */
  readonly taxInfoCampos: readonly string[];
  readonly preco: { readonly tabelaId: string; readonly valor: number } | null;
  readonly precoIgnorado: string | null;
  readonly estoque: number | null;
  readonly estoqueIgnorado: string | null;
  readonly variacoes: {
    readonly total: number;
    readonly criar: number;
    readonly existentes: number;
    readonly semLink: number;
  };
  readonly filhos: readonly ResumoVariacaoShopee[];
  readonly grupos: readonly ResumoGrupoShopee[];
  readonly categorias: {
    /** The chain's NAMES, root-first — public taxonomy, never seller data. */
    readonly caminho: readonly string[];
    readonly aCriar: number;
  };
  readonly links: {
    readonly pai: 'add' | 'merge';
    readonly paiRefPendente: boolean;
    readonly filhosAdd: number;
    readonly filhosMerge: number;
    readonly filhosSemLink: number;
  };
  readonly fotos: {
    readonly noAnuncio: number;
    readonly jaEmCache: number;
    readonly aBaixar: number;
  };
  readonly ehKit: boolean;
  readonly kit: {
    readonly componentes: readonly ResumoComponenteKitShopee[];
    readonly resolvidos: number;
    readonly produtos: number;
  } | null;
}

/* ------------------------------ raw readers ------------------------------- */

function texto(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function numero(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function booleano(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function objeto(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * The single price this import would write, from whichever of the two shapes
 * carries it: the `precos` map of a CREATE, or the dotted-path patch of an
 * UPDATE (`precos.<tabelaId>`).
 */
function precoDoPlano(
  plano: PlanoImportacaoShopee,
): { readonly tabelaId: string; readonly valor: number } | null {
  const patch = plano.precosPai?.patch;
  if (patch !== undefined) {
    for (const [chave, bruto] of Object.entries(patch)) {
      const valor = numero(objeto(bruto)?.valor);
      if (valor !== null) return { tabelaId: chave.replace('precos.', ''), valor };
    }
  }
  const mapa = objeto(plano.produtoPai?.data.precos);
  if (mapa !== null) {
    for (const [tabelaId, bruto] of Object.entries(mapa)) {
      const valor = numero(objeto(bruto)?.valor);
      if (valor !== null) return { tabelaId, valor };
    }
  }
  return null;
}

/** The KEYS of the fiscal block that carry a value. Never a value. */
export function taxInfoCamposDe(entrada: ItemLido): readonly string[] {
  const bloco = entrada.taxInfo;
  if (bloco === null) return [];
  return Object.entries(bloco)
    .filter(([, valor]) => valor != null && valor !== '')
    .map(([chave]) => chave)
    .sort();
}

function resumoDoGrupo(grupo: PlanoImportacaoShopee['taxonomia'][number]): ResumoGrupoShopee {
  return {
    grupoId: grupo.grupoId,
    nome: texto(grupo.docNovo?.nome),
    criar: grupo.criar,
    temPatch: grupo.patch !== null,
    variantes: grupo.varianteIds.length,
  };
}

function resumoDoFilho(
  filho: PlanoImportacaoShopee['filhos'][number],
  produtoId: string | null,
): ResumoVariacaoShopee {
  return {
    modelId: filho.modelId,
    produtoId,
    criar: filho.produto?.criar === true,
    temPatch: filho.produto !== null && !filho.produto.criar,
    link: filho.link === null ? 'nenhum' : filho.link.acao,
    estoque: numero(filho.estoque?.data.quantidade),
    precoIgnorado: filho.precoIgnorado,
    estoqueIgnorado: filho.estoqueIgnorado,
  };
}

/** The K1 component table, field by field. */
export function resumoDosComponentesKit(
  componentes: readonly ComponenteDoKitShopee[],
): readonly ResumoComponenteKitShopee[] {
  return componentes.map((c) => ({
    modelId: c.modelId,
    itemId: c.itemId,
    modelIdDoComponente: c.modelIdDoComponente,
    sku: c.sku,
    quantidade: c.quantidade,
    produtoId: c.produtoId,
    via: c.via,
  }));
}

/**
 * The whole plan, reduced to the allow-list above.
 *
 * `entrada` is read for exactly three things — the picture COUNT, whether the
 * fiscal block arrived and which of its keys did — and for nothing else: the
 * plan is the authority on every decision, and reading the payload twice is how
 * a rehearsal starts disagreeing with the importer it rehearses.
 */
export function resumoDoPlano(
  plano: PlanoImportacaoShopee,
  entrada: ItemLido,
  componentes?: readonly ComponenteDoKitShopee[],
): ResumoImportacaoShopee {
  const dados = plano.produtoPai?.data ?? {};
  const ids = plano.filhoUnico.idsPlanejados;
  const filhos = plano.filhos.map((f, i) => resumoDoFilho(f, ids[i] ?? null));
  const tabela = resumoDosComponentesKit(componentes ?? []);

  return {
    itemId: plano.itemId,
    produtoId: plano.produtoId,
    acao: plano.criar ? 'criar' : 'atualizar',
    nome: plano.nome,
    nomeChars: plano.nome.length,
    sku: texto(dados.sku),
    gtin: texto(dados.gtin),
    publicado: booleano(dados.publicado),
    pesoKg: numero(dados.pesoBrutoKg),
    alturaCm: numero(dados.alturaCm),
    larguraCm: numero(dados.larguraCm),
    profundidadeCm: numero(dados.profundidadeCm),
    camposProduto: Object.keys(dados).sort(),
    // ⚠️ KEYS only: `descricao` and `marca` are values inside this map.
    camposExtraData: Object.keys(plano.extraData ?? {}).sort(),
    descricaoChars: texto(plano.extraData?.descricao)?.length ?? null,
    taxInfoPresente: entrada.taxInfo !== null,
    taxInfoCampos: taxInfoCamposDe(entrada),
    preco: precoDoPlano(plano),
    precoIgnorado: plano.precoPaiIgnorado,
    estoque: numero(plano.estoquePai?.data.quantidade),
    estoqueIgnorado: plano.estoquePaiIgnorado,
    variacoes: {
      total: plano.resultado.variacoes.total,
      criar: plano.resultado.variacoes.criadas,
      existentes: plano.resultado.variacoes.total - plano.resultado.variacoes.criadas,
      semLink: plano.resultado.variacoes.semLink,
    },
    filhos,
    grupos: plano.taxonomia.map(resumoDoGrupo),
    categorias: {
      caminho: plano.categorias.map((c) => texto(c.data.nome) ?? c.docId),
      aCriar: plano.categorias.length,
    },
    links: {
      pai: plano.linkPai.acao,
      paiRefPendente: plano.linkPaiRefPendente,
      filhosAdd: filhos.filter((f) => f.link === 'add').length,
      filhosMerge: filhos.filter((f) => f.link === 'merge').length,
      filhosSemLink: filhos.filter((f) => f.link === 'nenhum').length,
    },
    fotos: {
      // COUNTS, never URLs.
      noAnuncio: entrada.base.image?.image_url_list?.length ?? 0,
      jaEmCache: plano.fotos.ignoradas,
      aBaixar: plano.fotos.baixar.length,
    },
    ehKit: componentes !== undefined || dados.ehKit === true,
    kit:
      componentes === undefined
        ? null
        : {
            componentes: tabela,
            resolvidos: tabela.filter((c) => c.produtoId !== null).length,
            produtos: new Set(
              tabela.map((c) => c.produtoId).filter((id): id is string => id !== null),
            ).size,
          },
  };
}

/** `--json`: the SAME allow-list, as an object. One builder, no second copy. */
export function resumirPlanoJson(
  plano: PlanoImportacaoShopee,
  entrada: ItemLido,
  componentes?: readonly ComponenteDoKitShopee[],
): ResumoImportacaoShopee {
  return resumoDoPlano(plano, entrada, componentes);
}

/* -------------------------------------------------------------------------- */
/*                                 rendering                                   */
/* -------------------------------------------------------------------------- */

function txt(v: string | null): string {
  return v ?? '—';
}

function num(v: number | null): string {
  return v == null ? '—' : String(v);
}

function lista(v: readonly string[]): string {
  return v.length === 0 ? '(nenhum)' : v.join(', ');
}

/** The human rendering of one plan — Design-P §12's printout. */
export function renderResumoImportacao(r: ResumoImportacaoShopee): string[] {
  const linhas: string[] = [];
  linhas.push(`## O que uma gravação faria (item ${String(r.itemId)})`);
  linhas.push(
    `  produto ................. ${r.acao}  id=${r.produtoId}  kit=${r.ehKit ? 'sim' : 'não'}`,
  );
  linhas.push(`  nome .................... "${r.nome}" (${String(r.nomeChars)} ch)`);
  linhas.push(`  sku / gtin .............. ${txt(r.sku)} / ${txt(r.gtin)}`);
  linhas.push(
    `  peso / dimensões ........ ${num(r.pesoKg)} kg  ${num(r.alturaCm)}×${num(r.larguraCm)}×${num(r.profundidadeCm)} cm`,
  );
  linhas.push(
    `  publicado ............... ${r.publicado == null ? '— (não seria escrito)' : `${String(r.publicado)} (só na criação)`}`,
  );
  linhas.push(`  campos do produto ....... ${lista(r.camposProduto)}`);
  linhas.push(`  campos de extraData ..... ${lista(r.camposExtraData)}`);
  linhas.push(
    `  descrição ............... ${r.descricaoChars == null ? 'nenhuma seria gravada' : `«REDIGIDA — ${String(r.descricaoChars)} caractere(s)»`}`,
  );
  linhas.push(
    `  tax_info ................ ${r.taxInfoPresente ? 'presente' : 'ausente'} · campos: ${lista(r.taxInfoCampos)}`,
  );
  linhas.push('  (os VALORES de tax_info e a descrição são omitidos de propósito)');

  linhas.push('');
  linhas.push('### preço e estoque');
  linhas.push(
    `  preço ................... ${r.preco === null ? `(nenhum) motivo=${txt(r.precoIgnorado)}` : `${String(r.preco.valor)} na tabela ${r.preco.tabelaId}`}`,
  );
  linhas.push(
    `  estoque ................. ${r.estoque === null ? `(nenhum) motivo=${txt(r.estoqueIgnorado)}` : String(r.estoque)}`,
  );

  linhas.push('');
  linhas.push(
    `### variações (${String(r.variacoes.total)} models → ${String(r.variacoes.criar)} a criar, ${String(r.variacoes.existentes)} existentes, ${String(r.variacoes.semLink)} sem vínculo)`,
  );
  if (r.filhos.length === 0) {
    linhas.push('  (nenhuma)');
  } else {
    for (const f of r.filhos) {
      linhas.push(
        `  model ${String(f.modelId).padEnd(14)} ${(f.criar ? 'criar' : f.temPatch ? 'atualizar' : 'sem mudança').padEnd(12)} ` +
          `id=${txt(f.produtoId)}  link=${f.link}  estoque=${num(f.estoque)}` +
          (f.precoIgnorado === null ? '' : `  preço:${f.precoIgnorado}`) +
          (f.estoqueIgnorado === null ? '' : `  estoque:${f.estoqueIgnorado}`),
      );
    }
  }

  linhas.push('');
  linhas.push(`### grupos de variações (${String(r.grupos.length)})`);
  if (r.grupos.length === 0) {
    linhas.push('  (nenhum)');
  } else {
    for (const g of r.grupos) {
      linhas.push(
        `  ${txt(g.nome).padEnd(20)} ${(g.criar ? 'novo' : g.temPatch ? 'match + patch' : 'match').padEnd(14)} ` +
          `id=${g.grupoId}  variantes=${String(g.variantes)}`,
      );
    }
  }

  linhas.push('');
  linhas.push('### categoria, vínculos e fotos');
  linhas.push(
    `  categoria ............... ${r.categorias.caminho.length === 0 ? '(nenhuma — id desconhecido ou opção desligada)' : r.categorias.caminho.join(' > ')}`,
  );
  linhas.push(`  docs de categoria ....... ${String(r.categorias.aCriar)} a criar se ausentes`);
  linhas.push(
    `  prodshopee .............. ${r.links.pai === 'add' ? 'CRIAR' : 'MERGE'}${r.links.paiRefPendente ? '  (a ref do pai é carimbada depois do add)' : ''}`,
  );
  linhas.push(
    `  variashopee ............. ${String(r.links.filhosMerge)} MERGE · ${String(r.links.filhosAdd)} CRIAR · ${String(r.links.filhosSemLink)} sem vínculo`,
  );
  linhas.push(
    `  fotos ................... ${String(r.fotos.noAnuncio)} no anúncio · ${String(r.fotos.jaEmCache)} já em cache · ${String(r.fotos.aBaixar)} a baixar`,
  );
  linhas.push('  (as URLs das imagens são omitidas de propósito — só contagens)');

  if (r.kit !== null) {
    linhas.push('');
    linhas.push(
      `### kit — componentes (${String(r.kit.resolvidos)}/${String(r.kit.componentes.length)} resolvidos, ${String(r.kit.produtos)} produtos distintos)`,
    );
    for (const linha of renderComponentesKit(r.kit.componentes)) linhas.push(linha);
  }

  return linhas;
}

/** The K1 table on its own — what a BLOCKED kit prints. */
export function renderComponentesKit(componentes: readonly ResumoComponenteKitShopee[]): string[] {
  if (componentes.length === 0) return ['  (nenhum componente)'];
  const linhas: string[] = [
    '  model do kit   item          model         qtd   sku                  produto',
  ];
  for (const c of componentes) {
    linhas.push(
      `  ${String(c.modelId).padEnd(14)} ${String(c.itemId).padEnd(13)} ` +
        `${String(c.modelIdDoComponente).padEnd(13)} ${String(c.quantidade).padEnd(5)} ` +
        `${txt(c.sku).padEnd(20)} ${c.produtoId ?? `NÃO VINCULADO (${c.via})`}`,
    );
  }
  return linhas;
}

/** `resumirPlano` — the plan, straight to the lines a terminal shows. */
export function resumirPlano(
  plano: PlanoImportacaoShopee,
  entrada: ItemLido,
  componentes?: readonly ComponenteDoKitShopee[],
): string[] {
  return renderResumoImportacao(resumoDoPlano(plano, entrada, componentes));
}

/**
 * `--live`: what the importer reported.
 *
 * Built by NAME off {@link ResultadoImportacaoShopee}, like the route's own 200
 * body — echoing the object whole is how a field added for the job's bookkeeping
 * starts leaving through a surface nobody reviewed.
 */
export function resumirResultado(res: ResultadoImportacaoShopee): string[] {
  const linhas: string[] = ['## O que o importador gravou'];
  linhas.push(`  produtoId ............... ${res.produtoId}`);
  linhas.push(`  criado .................. ${res.criado ? 'SIM (documento novo)' : 'não (merge)'}`);
  linhas.push(`  nome .................... "${res.nome}"`);
  linhas.push(
    `  variações ............... ${String(res.variacoes.total)} no total · ${String(res.variacoes.criadas)} criadas · ${String(res.variacoes.semLink)} sem vínculo`,
  );
  linhas.push(
    `  fotos ................... ${String(res.fotos.importadas)} importadas · ${String(res.fotos.ignoradas)} ignoradas · ${String(res.fotos.falhas)} falhas`,
  );
  if (res.kit !== undefined) {
    linhas.push(
      `  kit ..................... ${String(res.kit.componentes)} componentes · produto ${res.kit.criado ? 'criado' : 'atualizado'}`,
    );
  }
  return linhas;
}

/* --------------------------- the stored produto ---------------------------- */

/** The produto as Firestore holds it, on the same allow-list. */
export interface ResumoProdutoArmazenado {
  readonly produtoId: string;
  readonly existe: boolean;
  readonly nome: string | null;
  readonly sku: string | null;
  readonly gtin: string | null;
  readonly paiId: string | null;
  readonly filhoUnicoId: string | null;
  readonly publicado: boolean | null;
  readonly ehKit: boolean | null;
  readonly pesoBrutoKg: number | null;
  readonly categoriaProdutoOuterRef: string | null;
  readonly precos: readonly { readonly tabelaId: string; readonly valor: number | null }[];
}

export function resumoDoProdutoArmazenado(
  produtoId: string,
  doc: Record<string, unknown> | null,
): ResumoProdutoArmazenado {
  const d = doc ?? {};
  const precos = objeto(d.precos) ?? {};
  return {
    produtoId,
    existe: doc !== null,
    nome: texto(d.nome),
    sku: texto(d.sku),
    gtin: texto(d.gtin),
    paiId: texto(d.paiId),
    filhoUnicoId: texto(d.filhoUnicoId),
    publicado: booleano(d.publicado),
    ehKit: booleano(d.ehKit),
    pesoBrutoKg: numero(d.pesoBrutoKg),
    categoriaProdutoOuterRef: texto(d.categoriaProdutoOuterRef),
    precos: Object.entries(precos).map(([tabelaId, bruto]) => ({
      tabelaId,
      valor: numero(objeto(bruto)?.valor),
    })),
  };
}

export function renderProdutoArmazenado(r: ResumoProdutoArmazenado): string[] {
  if (!r.existe) {
    return [
      '## O produto relido',
      `  ⚠️ ${r.produtoId} não foi encontrado na releitura. Confira o projeto e o database acima.`,
    ];
  }
  const linhas: string[] = ['## O produto relido'];
  linhas.push(`  produtoId ............... ${r.produtoId}`);
  linhas.push(`  nome .................... "${txt(r.nome)}"`);
  linhas.push(`  sku / gtin .............. ${txt(r.sku)} / ${txt(r.gtin)}`);
  linhas.push(
    `  paiId / filhoUnicoId .... ${txt(r.paiId)} / ${txt(r.filhoUnicoId)}   (família de um)`,
  );
  linhas.push(
    `  publicado / ehKit ....... ${r.publicado == null ? '—' : String(r.publicado)} / ${r.ehKit == null ? '—' : String(r.ehKit)}`,
  );
  linhas.push(`  pesoBrutoKg ............. ${num(r.pesoBrutoKg)}`);
  linhas.push(`  categoria ............... ${txt(r.categoriaProdutoOuterRef)}`);
  if (r.precos.length === 0) {
    linhas.push('  preços .................. (nenhum)');
  } else {
    for (const p of r.precos)
      linhas.push(`  preço ................... ${p.tabelaId} = ${num(p.valor)}`);
  }
  return linhas;
}

/* -------------------------------------------------------------------------- */
/*                                   errors                                    */
/* -------------------------------------------------------------------------- */

/**
 * A listing the importer REFUSES — an answer, never a failure, so the script
 * prints this and exits 0.
 *
 * ⚠️ `mensagem` is a MECHANISM sentence by that class's own contract (no
 * payload, no listing name, no fiscal value), which is what makes it printable
 * here at all.
 */
export function descreverBloqueio(err: ShopeeImportBlockedError): string[] {
  return [
    `bloqueado: ${err.motivo}${err.mensagem === '' ? '' : ` — ${err.mensagem}`}`,
    `  item_id ................. ${String(err.itemId)}`,
    '  Nada foi gravado para este anúncio: a recusa acontece ANTES de qualquer escrita.',
  ];
}

/**
 * One failure, described by CLASS plus Shopee's `code`/`path` — never a payload.
 *
 * ⚠️ The Shopee half is `importarPedidoCli.ts`'s {@link descreverErro},
 * IMPORTED rather than re-implemented — the CLIs of this app face the same error
 * taxonomy and a second copy of that table is how one of them starts printing a
 * payload. Only the ARGUMENT arm is this module's, because the usage text it has
 * to print is this module's.
 */
export function descreverErroImportacao(err: unknown): string[] {
  if (err instanceof ArgumentoInvalidoError) {
    return [`❌ ${err.message}`, '', USO_IMPORTAR_ANUNCIO];
  }
  if (err instanceof ShopeeImportBlockedError) {
    return [`❌ ShopeeImportBlockedError (${err.motivo})`, ...descreverBloqueio(err)];
  }
  return descreverErro(err);
}
