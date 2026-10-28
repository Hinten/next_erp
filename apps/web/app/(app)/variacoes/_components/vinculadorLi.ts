/**
 * The Loja Integrada variation linker's pure rules (master plan step 10): what
 * the tab edits in `grupoDeVariacoes.linksVariacoesli`, what a save of the grupo
 * checks, and how a conflicting save merges. No React, no clock, no I/O.
 *
 * ## Untouched entries are written back exactly as stored
 *
 * The field stays tolerant (`z.array(z.json())`): a stored entry nobody touched
 * is carried back as it is — valid or not, of an active conta or not — and a
 * defect among untouched entries is SHOWN, never blocking a save that does not
 * touch them (renaming the grupo, adding a size). Every entry the operator
 * creates or changes must be complete and break no uniqueness rule. The shared
 * validator (`conflitosLinksVariacoesLi`) decides both; this module decides
 * which entries are EDITED.
 *
 * ## Edited or untouched: by VALUE, against the form's seed, failing closed
 *
 * An entry is untouched when it equals (`valuesEqual`: key set + recursive,
 * `null` ≠ absent, arrays positional) an entry of the field's SEED — what the
 * form was last reset to — each seed entry vouching for ONE entry. Anything else
 * is edited, and a seed not yet published makes every entry edited. Object
 * identity is never used: a form re-applies kept edits through clones, a staged
 * removal undone is a copy, and `validate` sees the prepared value.
 *
 * ## Transient marks, stripped on save ({@link prepararVinculosLi})
 *
 *  - `DELETE_MARK` (the app's staged deletion): the entry is dropped on save;
 *  - {@link MARCA_CONFLITO_VINCULO_LI}: a conflict merge's note on an entry —
 *    `alterado` (both sides changed this link: the other side's version is kept,
 *    redo yours) is written as the other side left it; `removido` (the other
 *    side removed what you changed) is dropped, unless you edit it again.
 *
 * Every comparison is exact: no case, trim or number↔string fold.
 */
import {
  DELETE_MARK,
  valuesEqual,
  type ConflictRebaseInput,
  type ConflictRebaseResult,
  type ValidationIssue,
} from '@delfrance/ui';
import {
  TIPO_CONFLITO_LINK_LI,
  TIPO_ENTRADA_LINK_LI,
  conflitosLinksVariacoesLi,
  lerLinksVariacoesLi,
  type ConflitoLinkLi,
  type EntradaLinkVariacoesLi,
} from '@delfrance/schemas';

/** The transient key a conflict merge sets on an entry (see the module header). */
export const MARCA_CONFLITO_VINCULO_LI = '_conflitoVinculoLi';

export const CONFLITO_VINCULO_LI = {
  /** Both sides changed this link: the other side's version is kept. Redo yours. */
  alterado: 'alterado',
  /** The other side removed the link you changed: dropped on save unless you edit it again. */
  removido: 'removido',
} as const;
export type ConflitoVinculoLi = (typeof CONFLITO_VINCULO_LI)[keyof typeof CONFLITO_VINCULO_LI];

/**
 * Where an element that is NOT an object waits while staged for removal: it is
 * wrapped as `{ [DELETE_MARK]: true, [VALOR_ILEGIVEL_LI]: elemento }`, and the
 * undo unwraps it. A save drops the wrapper with the rest of the marked entries.
 */
const VALOR_ILEGIVEL_LI = '_valorIlegivelLi';

type Registro = Record<string, unknown>;

/** A plain object in the Firestore sense: not `null`, not an array, not a primitive. */
function ehObjeto(v: unknown): v is Registro {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** An OWN property only: an inherited one is not stored data. */
function proprio(o: Registro, chave: string): unknown {
  return Object.hasOwn(o, chave) ? o[chave] : undefined;
}

/** The marks this module or the app may set on an entry. */
const MARCAS = [DELETE_MARK, MARCA_CONFLITO_VINCULO_LI] as const;

/** Whether the operator staged this entry for removal. */
export function removidaNoFormularioLi(entrada: unknown): boolean {
  return ehObjeto(entrada) && proprio(entrada, DELETE_MARK) === true;
}

/** The conflict merge's note on an entry, or `null`. */
export function marcaDeConflitoLi(entrada: unknown): ConflitoVinculoLi | null {
  if (!ehObjeto(entrada)) return null;
  const marca = proprio(entrada, MARCA_CONFLITO_VINCULO_LI);
  return marca === CONFLITO_VINCULO_LI.alterado || marca === CONFLITO_VINCULO_LI.removido
    ? marca
    : null;
}

/**
 * The entry as it would be STORED: every mark stripped (a copy only when there
 * was one), a wrapped non-object element unwrapped. Anything else is returned
 * as the very same value.
 */
export function normalizarEntradaLi(entrada: unknown): unknown {
  if (!ehObjeto(entrada)) return entrada;
  if (Object.hasOwn(entrada, VALOR_ILEGIVEL_LI)) return entrada[VALOR_ILEGIVEL_LI];
  if (!MARCAS.some((m) => Object.hasOwn(entrada, m))) return entrada;
  const copia: Registro = { ...entrada };
  for (const m of MARCAS) delete copia[m];
  return copia;
}

/** Whether a save drops this entry: staged for removal, or `removido` by a conflict. */
function descartadaNaGravacao(entrada: unknown): boolean {
  return (
    removidaNoFormularioLi(entrada) || marcaDeConflitoLi(entrada) === CONFLITO_VINCULO_LI.removido
  );
}

/**
 * {@link prepararVinculosLi} plus, for each written entry, its index in the
 * form's value — so a finding on the written list can be shown on the form's.
 */
export function prepararVinculosLiComOrigem(valor: unknown): {
  readonly lista: unknown[];
  readonly origem: number[];
} {
  const lista: unknown[] = [];
  const origem: number[] = [];
  if (!Array.isArray(valor)) return { lista, origem };
  const elementos: readonly unknown[] = valor;
  elementos.forEach((e, i) => {
    if (descartadaNaGravacao(e)) return;
    lista.push(normalizarEntradaLi(e));
    origem.push(i);
  });
  return { lista, origem };
}

/**
 * The field's `prepareForSave`: drops the entries staged for removal (and the
 * `removido` ones), strips every mark from the rest. An entry that carries no
 * mark is written back as the very same object. A value that is not a list
 * passes through (the schema reports it).
 */
export function prepararVinculosLi(valor: unknown): unknown {
  return Array.isArray(valor) ? prepararVinculosLiComOrigem(valor).lista : valor;
}

/**
 * The form's seed for the linker: the values its two fields were last reset to.
 * Published by the tab; `null` (never published) fails closed everywhere.
 */
export interface SeedVinculadorLi {
  readonly links: unknown;
  readonly variacoes: unknown;
}

/**
 * The indices of `lista` (a WRITTEN list: no marks) that this save creates or
 * changes, decided BY VALUE: an entry equal to an unused seed entry is
 * untouched, and consumes it. `seed === null` ⇒ every index (fail closed).
 */
export function editadasPorValorLi(
  lista: readonly unknown[],
  seed: SeedVinculadorLi | null,
): Set<number> {
  const editadas = new Set<number>();
  const guardadas: readonly unknown[] =
    seed !== null && Array.isArray(seed.links) ? seed.links : [];
  const usadas = guardadas.map(() => false);
  lista.forEach((entrada, i) => {
    if (seed === null) {
      editadas.add(i);
      return;
    }
    const j = guardadas.findIndex((g, k) => !usadas[k] && valuesEqual(g, entrada));
    if (j < 0) editadas.add(i);
    else usadas[j] = true;
  });
  return editadas;
}

/** The ids of a `variacoes` value, minus any staged for deletion. Exact, no fold. */
export function idsDasVariantesLi(variacoes: unknown): string[] {
  if (!Array.isArray(variacoes)) return [];
  const lista: readonly unknown[] = variacoes;
  const ids: string[] = [];
  for (const v of lista) {
    if (!ehObjeto(v) || proprio(v, DELETE_MARK) === true) continue;
    const id = proprio(v, 'id');
    if (typeof id === 'string') ids.push(id);
  }
  return ids;
}

/** `id → nome` over one or more `variacoes` values; the first name wins. */
export function nomesDasVariantesLi(...listas: unknown[]): Map<string, string> {
  const nomes = new Map<string, string>();
  for (const variacoes of listas) {
    if (!Array.isArray(variacoes)) continue;
    const lista: readonly unknown[] = variacoes;
    for (const v of lista) {
      if (!ehObjeto(v)) continue;
      const id = proprio(v, 'id');
      const nome = proprio(v, 'nome');
      if (typeof id === 'string' && typeof nome === 'string' && nome !== '' && !nomes.has(id))
        nomes.set(id, nome);
    }
  }
  return nomes;
}

/** The shared rules over a WRITTEN list, with the variantes this save leaves. */
function avaliar(
  lista: readonly unknown[],
  variantesIds: readonly string[],
  seed: SeedVinculadorLi | null,
): ConflitoLinkLi[] {
  const doGrupo = new Set(variantesIds);
  // Without a seed nothing can be said to be removed BY THIS save; the stale ids
  // are still caught, as `varianteInexistente` on entries that all count as edited.
  const removidas =
    seed === null ? [] : idsDasVariantesLi(seed.variacoes).filter((id) => !doGrupo.has(id));
  return conflitosLinksVariacoesLi({
    variantesIds,
    variantesRemovidasNestaGravacao: removidas,
    entradas: lerLinksVariacoesLi(lista).entradas,
    editadas: editadasPorValorLi(lista, seed),
  });
}

/** The operator's copy of one finding (pt-BR). `nomeDaVariante` labels a variante id. */
export function mensagemDoConflitoLi(
  conflito: ConflitoLinkLi,
  nomeDaVariante: (id: string) => string,
): string {
  const variante = `"${nomeDaVariante(conflito.varianteId ?? '')}"`;
  switch (conflito.tipo) {
    case TIPO_CONFLITO_LINK_LI.entradaInvalida:
      return (
        'um vínculo está incompleto ou inválido' +
        (conflito.campos.length === 0 ? '' : ` (campos: ${conflito.campos.join(', ')})`)
      );
    case TIPO_CONFLITO_LINK_LI.gradeRepetidaNaConta:
      return `a grade #${String(conflito.gradeId)} aparece em mais de um vínculo desta loja`;
    case TIPO_CONFLITO_LINK_LI.opcaoRepetidaNoVinculo:
      return `a opção #${String(conflito.opcaoId)} aparece duas vezes no mesmo vínculo`;
    case TIPO_CONFLITO_LINK_LI.varianteEmDuasOpcoes:
      return (
        `a variante ${variante} está em mais de uma opção desta loja; cada variante aponta ` +
        'para uma só opção por loja'
      );
    case TIPO_CONFLITO_LINK_LI.varianteRemovidaVinculada:
      return `a variante ${variante} está vinculada à Loja Integrada; desvincule-a antes de excluir`;
    case TIPO_CONFLITO_LINK_LI.varianteInexistente:
      return `a variante ${variante} não existe mais neste grupo; desvincule-a`;
    case TIPO_CONFLITO_LINK_LI.opcaoComVariasVariantes:
      return (
        'duas variantes usam a mesma opção; um produto que tenha as duas não poderá ser ' +
        'enviado'
      );
  }
}

/**
 * The page's `validate` body: the issues that BLOCK this save. Runs on the
 * PREPARED values (`ObjectView` applies every `prepareForSave` first), so
 * `linksVariacoesli` is the list about to be written.
 *
 * A finding blocks only through an edited entry, or because this save removes a
 * variante an entry still names — that one sits under `variacoes`, where
 * the removal happened. One issue per field, every message joined.
 */
export function validarVinculosLi(
  values: Readonly<Record<string, unknown>>,
  seed: SeedVinculadorLi | null,
): ValidationIssue[] {
  const valor = values.linksVariacoesli;
  // Not a list: the schema's own error speaks for it.
  if (!Array.isArray(valor)) return [];
  const lista: readonly unknown[] = valor;
  if (lista.length === 0) return [];
  const nomes = nomesDasVariantesLi(values.variacoes, seed?.variacoes);
  const nome = (id: string) => nomes.get(id) ?? id;
  const doVinculo: string[] = [];
  const dasVariantes: string[] = [];
  for (const conflito of avaliar(lista, idsDasVariantesLi(values.variacoes), seed)) {
    if (!conflito.bloqueia) continue;
    const mensagem = mensagemDoConflitoLi(conflito, nome);
    if (conflito.tipo === TIPO_CONFLITO_LINK_LI.varianteRemovidaVinculada)
      dasVariantes.push(mensagem);
    else doVinculo.push(mensagem);
  }
  const issues: ValidationIssue[] = [];
  if (doVinculo.length > 0) {
    issues.push({
      path: 'linksVariacoesli',
      message: `Vínculos da Loja Integrada: ${doVinculo.join('; ')}.`,
    });
  }
  if (dasVariantes.length > 0) issues.push({ path: 'variacoes', message: dasVariantes.join('; ') });
  return issues;
}

/**
 * The tab's findings over the form's CURRENT value: the same rules as the save,
 * on what the save would write, with the indices mapped back to the form's
 * value. `variacoesVivas` is the form's live `variacoes` (a variante staged for
 * deletion already counts as removed).
 */
export function achadosDoVinculadorLi(
  valor: unknown,
  variacoesVivas: unknown,
  seed: SeedVinculadorLi | null,
): ConflitoLinkLi[] {
  const { lista, origem } = prepararVinculosLiComOrigem(valor);
  return avaliar(lista, idsDasVariantesLi(variacoesVivas), seed).map((c) => ({
    ...c,
    indices: c.indices.map((i) => origem[i] ?? i),
  }));
}

/** One element of the form's value, as the tab shows it. */
export interface ItemVinculoLi {
  /** Its index in the form's value. */
  readonly indice: number;
  /** The element itself, marks included. */
  readonly bruto: unknown;
  /** The reader's view of the element as it would be stored. */
  readonly entrada: EntradaLinkVariacoesLi;
  readonly removida: boolean;
  readonly conflito: ConflitoVinculoLi | null;
}

export interface GruposVinculadorLi {
  /** The valid entries of each ACTIVE conta, keyed by the conta id exactly. */
  readonly porConta: ReadonlyMap<string, readonly ItemVinculoLi[]>;
  /** Everything else: another or unknown conta, and every invalid entry. */
  readonly outras: readonly ItemVinculoLi[];
  /** A value is stored and it is not a list. */
  readonly formatoInvalido: boolean;
}

/**
 * Split the form's value for the tab. A conta is matched by EXACT equality of
 * `integracaoLiId` with an active conta's doc id — a path, another case or a
 * trailing space is "conta não reconhecida", never folded in. Nothing is dropped.
 */
export function agruparVinculosLi(
  valor: unknown,
  contasAtivas: ReadonlySet<string>,
): GruposVinculadorLi {
  const porConta = new Map<string, ItemVinculoLi[]>();
  const outras: ItemVinculoLi[] = [];
  if (!Array.isArray(valor)) {
    return { porConta, outras, formatoInvalido: valor !== null && valor !== undefined };
  }
  const elementos: readonly unknown[] = valor;
  const leitura = lerLinksVariacoesLi(elementos.map(normalizarEntradaLi));
  for (const entrada of leitura.entradas) {
    const bruto = elementos[entrada.indice];
    const item: ItemVinculoLi = {
      indice: entrada.indice,
      bruto,
      entrada,
      removida: removidaNoFormularioLi(bruto),
      conflito: marcaDeConflitoLi(bruto),
    };
    const conta = entrada.tipo === TIPO_ENTRADA_LINK_LI.valida ? entrada.link.integracaoLiId : null;
    if (conta !== null && contasAtivas.has(conta)) {
      const doGrupo = porConta.get(conta) ?? [];
      doGrupo.push(item);
      porConta.set(conta, doGrupo);
    } else {
      outras.push(item);
    }
  }
  return { porConta, outras, formatoInvalido: false };
}

/** A store option, as the tab offers it. */
export interface OpcaoDoVinculadorLi {
  readonly id: number;
  /** The store's `nome` (or the stored label); `null` when neither is known. */
  readonly nome: string | null;
}

/**
 * The entry with `opcao` now holding exactly `variantes` — a NEW object, the
 * input untouched, every other key and option kept as stored. An option left
 * with no variante is DROPPED here, as it is edited (never by the save). An edit
 * redoes a link a conflict marked, so the mark goes.
 */
export function definirVariantesDaOpcaoLi(
  entrada: unknown,
  opcao: OpcaoDoVinculadorLi,
  variantes: readonly string[],
): Registro {
  const base = normalizarEntradaLi(entrada);
  const registro: Registro = ehObjeto(base) ? { ...base } : {};
  const valorOpcoes = proprio(registro, 'variationOptions');
  const opcoes: readonly unknown[] = Array.isArray(valorOpcoes) ? valorOpcoes : [];
  const novas: unknown[] = [];
  let encontrada = false;
  for (const o of opcoes) {
    if (!encontrada && ehObjeto(o) && proprio(o, 'li_option_id') === opcao.id) {
      encontrada = true;
      if (variantes.length > 0) novas.push({ ...o, arakene_variation_id: [...variantes] });
      continue;
    }
    novas.push(o);
  }
  if (!encontrada && variantes.length > 0) {
    novas.push({
      li_option_id: opcao.id,
      li_option_name: opcao.nome,
      arakene_variation_id: [...variantes],
    });
  }
  registro.variationOptions = novas;
  return registro;
}

/** Stage the element at `indice` for removal, or undo it: a NEW list. */
export function alternarRemocaoLi(lista: readonly unknown[], indice: number): unknown[] {
  return lista.map((e, i) => {
    if (i !== indice) return e;
    if (removidaNoFormularioLi(e)) return normalizarEntradaLi(e);
    return ehObjeto(e)
      ? { ...e, [DELETE_MARK]: true }
      : { [DELETE_MARK]: true, [VALOR_ILEGIVEL_LI]: e };
  });
}

/** The element at `indice` replaced by `nova`: a NEW list. */
export function substituirEntradaLi(
  lista: readonly unknown[],
  indice: number,
  nova: unknown,
): unknown[] {
  return lista.map((e, i) => (i === indice ? nova : e));
}

/**
 * A new link of `contaId` (stored verbatim) to `grade`, with no option yet. The
 * grade's `nome` is its label — never `nome_visivel`.
 */
export function novoVinculoLi(contaId: string, grade: { id: number; nome: string }): Registro {
  return { name: grade.nome, grade_id: grade.id, integracaoLiId: contaId, variationOptions: [] };
}

/* -------------------------------------------------------------------------- */
/*                  The conflict merge (a tier-3 save, ADR 0011)               */
/* -------------------------------------------------------------------------- */

/** The (conta, grade) key of an element, or `null` when it has none. Exact. */
function chaveDoVinculo(entrada: unknown): string | null {
  const n = normalizarEntradaLi(entrada);
  if (!ehObjeto(n)) return null;
  const conta = proprio(n, 'integracaoLiId');
  const grade = proprio(n, 'grade_id');
  return typeof conta === 'string' && typeof grade === 'number'
    ? JSON.stringify([conta, grade])
    : null;
}

/** Same entries, in order — a staged removal counts, a conflict's note does not. */
function mesmasEntradas(a: readonly unknown[], b: readonly unknown[]): boolean {
  return (
    a.length === b.length &&
    a.every((e, i) => {
      const semNota = ehObjeto(e) && marcaDeConflitoLi(e) !== null ? semNotaDeConflito(e) : e;
      return valuesEqual(semNota, b[i]);
    })
  );
}

function semNotaDeConflito(e: Registro): Registro {
  const copia = { ...e };
  delete copia[MARCA_CONFLITO_VINCULO_LI];
  return copia;
}

function comNota(entrada: unknown, nota: ConflitoVinculoLi): unknown {
  const n = normalizarEntradaLi(entrada);
  return ehObjeto(n) ? { ...n, [MARCA_CONFLITO_VINCULO_LI]: nota } : n;
}

function agruparPorChave(lista: readonly unknown[]): Map<string, unknown[]> {
  const porChave = new Map<string, unknown[]>();
  for (const e of lista) {
    const k = chaveDoVinculo(e);
    if (k === null) continue;
    const doGrupo = porChave.get(k) ?? [];
    doGrupo.push(e);
    porChave.set(k, doGrupo);
  }
  return porChave;
}

function comoLista(v: unknown): readonly unknown[] | null {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : null;
}

/**
 * The field's `rebaseOnConflict` merge (ADR 0011 tier 3): the server's list is
 * the base, and every link the operator added, changed or staged for removal —
 * by value against `loaded`, keyed by `(integracaoLiId, grade_id)` — is
 * re-applied on it. Never either side wholesale.
 *
 * Per key: only the operator changed it ⇒ theirs; only the server ⇒ the
 * server's; both, the same way ⇒ the server's; both, differently ⇒ COLLIDED: the
 * server's version is kept, marked `alterado` — or, when the server removed it,
 * the operator's version is shown marked `removido` and dropped on save unless
 * redone. A key held twice on either side is one block, compared whole.
 *
 * Key-less legacy entries (a half-made link) can only be staged for removal
 * here: that removal is re-applied while the server still holds the same entry,
 * and moot when it does not.
 */
export function rebaseVinculosLi({
  loaded,
  server,
  mine,
}: ConflictRebaseInput): ConflictRebaseResult {
  const carregada = comoLista(loaded);
  const doServidor = comoLista(server);
  const minha = comoLista(mine);
  if (doServidor === null || carregada === null || minha === null) {
    // A value that is not a list cannot be merged: keep the server's, and stop.
    return { value: server, collided: true };
  }
  // A `removido` note is already the server's version (absent): not a change.
  const meus = minha.filter((e) => marcaDeConflitoLi(e) !== CONFLITO_VINCULO_LI.removido);
  const L = agruparPorChave(carregada);
  const S = agruparPorChave(doServidor);
  const M = agruparPorChave(meus);
  let collided = false;

  const blocoDaChave = (k: string): unknown[] => {
    const l = L.get(k) ?? [];
    const s = S.get(k) ?? [];
    const m = M.get(k) ?? [];
    if (mesmasEntradas(m, l)) return s;
    if (mesmasEntradas(s, l)) return m;
    if (mesmasEntradas(prepararVinculosLi(m) as unknown[], s)) return s;
    collided = true;
    if (s.length > 0) return s.map((e) => comNota(e, CONFLITO_VINCULO_LI.alterado));
    return m
      .filter((e) => !removidaNoFormularioLi(e))
      .map((e) => comNota(e, CONFLITO_VINCULO_LI.removido));
  };

  const saida: unknown[] = [];
  const tratadas = new Set<string>();
  for (const e of doServidor) {
    const k = chaveDoVinculo(e);
    if (k === null) {
      saida.push(e);
      continue;
    }
    if (tratadas.has(k)) continue;
    tratadas.add(k);
    saida.push(...blocoDaChave(k));
  }
  for (const k of M.keys()) {
    if (tratadas.has(k)) continue;
    tratadas.add(k);
    saida.push(...blocoDaChave(k));
  }

  // Key-less entries: the operator's staged removals, by value.
  const semChaveCarregadas = carregada.filter((e) => chaveDoVinculo(e) === null);
  const usadas = semChaveCarregadas.map(() => false);
  const consumir = (valor: unknown): boolean => {
    const j = semChaveCarregadas.findIndex((c, k) => !usadas[k] && valuesEqual(c, valor));
    if (j < 0) return false;
    usadas[j] = true;
    return true;
  };
  const substituidas = new Set<number>();
  for (const e of meus) {
    if (chaveDoVinculo(e) !== null) continue;
    const valor = normalizarEntradaLi(e);
    const conhecida = consumir(valor);
    if (!removidaNoFormularioLi(e)) {
      if (!conhecida) saida.push(e);
      continue;
    }
    const i = saida.findIndex(
      (s, k) => !substituidas.has(k) && chaveDoVinculo(s) === null && valuesEqual(s, valor),
    );
    if (i >= 0) {
      saida[i] = e;
      substituidas.add(i);
    }
  }

  const value = saida.length === 0 && !Array.isArray(server) ? (server ?? null) : saida;
  return { value, collided };
}
