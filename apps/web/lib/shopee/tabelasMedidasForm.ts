/**
 * The staged-form helpers behind the `/medidas/[id]` Shopee tab (#1526, step 18):
 * read ONE conta's picks out of the tabela's `tabelasMedidasShopee` map, edit
 * them, and hand the map back to the form. Pure — no React, no Firestore.
 *
 * ## The edit is STAGED, and saved by the tabela's own form
 *
 * Every operation here returns a NEW map for the field's `onChange`; nothing is
 * written until the operator clicks "Salvar alterações", where `ObjectView`'s
 * save transaction writes the whole field and #1757's guard raises a conflict
 * if the stored map changed since load (root CLAUDE.md rule 7, tier 3). Removal
 * is a MARK (`DELETE_MARK`, `apps/web/CLAUDE.md` rule 7), dropped only by
 * {@link prepararTabelasShopeeParaSalvar} — the field's `prepareForSave`.
 *
 * ## Raw-preserving, because the corpus is not ours (root CLAUDE.md rule 8)
 *
 * The migrated legacy map carries per-key `null`s, unreadable elements, string
 * ids, duplicate categories. Every operation rebuilds ONLY this conta's array,
 * and copies every other element of it — readable or not — and every other map
 * key VERBATIM. Nothing the operator could not see is ever dropped or
 * "normalised"; a value this module cannot read is returned untouched.
 *
 * ## ONE selection rule (#1369)
 *
 * Which row of a conta is the one a listing gets is `indiceDaEntradaShopee` from
 * `@delfrance/schemas` — the same function publish resolves through. The `papel`
 * of a row, the replace-on-add target and the modal's confirm label all come
 * from it, run over the rows that will SURVIVE the save (readable, not marked)
 * — spelled once, in `linhasAtivas`, and handed to the modal as
 * {@link indiceAtivoDaCategoria}. There is no local "first entry of the
 * category" loop here or in the modal, and none may be added.
 */
import { DELETE_MARK, stripMarkedForDeletion } from '@delfrance/ui';
import {
  ESTADO_LISTA_SHOPEE,
  indiceDaEntradaShopee,
  lerEntradasShopeeDaConta,
  type EntradaTabelaShopee,
  type EstadoListaShopee,
  type LeituraEntradasShopee,
  type LinhaEntradaShopee,
  type MotivoEntradaShopeeIlegivel,
} from '@delfrance/schemas';

/** What a stored row does for publish, as the tab shows it. */
export type PapelDaLinha = 'usada' | 'ignorada-duplicada' | 'ilegivel' | 'sera-removida';
export const PAPEL_DA_LINHA = {
  /** The row publish picks for its category. */
  usada: 'usada',
  /** Readable, but an EARLIER surviving row of the same category wins — publish never sends it. */
  ignoradaDuplicada: 'ignorada-duplicada',
  /** Unreadable — preserved as stored, never used. */
  ilegivel: 'ilegivel',
  /** Marked for removal; dropped when the tabela is saved. */
  seraRemovida: 'sera-removida',
} as const satisfies Record<string, PapelDaLinha>;

/** One STORED element of a conta's list, as the form shows it. */
export interface LinhaTabelaShopeeForm {
  /** RAW position in the FORM's list (marked elements included). */
  readonly indice: number;
  /** The readable entry (exactly its three keys), or `null` when unreadable. */
  readonly entrada: EntradaTabelaShopee | null;
  readonly motivo: MotivoEntradaShopeeIlegivel | null;
  /** The element carries a removal mark — the save will drop it. */
  readonly marcada: boolean;
  /**
   * The element is a plain object, so it can carry a mark (reconcile R-h). A
   * `null` / string / array element is shown "ilegível (mantida)" with no action.
   */
  readonly removivel: boolean;
  readonly papel: PapelDaLinha;
}

/** A plain object in the Firestore sense: not `null`, not an array, not a primitive. */
function ehObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Whether the save would DROP this element — asked of `stripMarkedForDeletion`
 * itself, so "shown as marked" and "removed on save" are one rule and can never
 * disagree (a second spelling of the mark test is the drift #1369 names).
 */
function seraDescartadoAoSalvar(elemento: unknown): boolean {
  const restantes = stripMarkedForDeletion([elemento]);
  return Array.isArray(restantes) && restantes.length === 0;
}

/** One conta's slot, read: the schemas' read slice plus the raw list it was read from. */
interface ContaLida {
  readonly leitura: LeituraEntradasShopee;
  /** The stored array — only when `leitura.estado` is `lista`. */
  readonly lista: readonly unknown[] | null;
}

function lerConta(mapa: unknown, integracaoId: string): ContaLida {
  const leitura = lerEntradasShopeeDaConta(mapa, integracaoId);
  if (leitura.estado !== ESTADO_LISTA_SHOPEE.lista || !ehObjeto(mapa)) {
    return { leitura, lista: null };
  }
  // `lista` ⇒ an OWN array at that key (the read slice checked it the same way).
  const lista = Object.hasOwn(mapa, integracaoId) ? mapa[integracaoId] : undefined;
  return { leitura, lista: Array.isArray(lista) ? (lista as readonly unknown[]) : null };
}

/** What a stored row IS, before its role is decided. */
type LinhaSemPapel = Omit<LinhaTabelaShopeeForm, 'papel'>;

/** The rows of a read list, without their role: entry, motivo, mark, removability. */
function linhasSemPapel(
  leitura: LeituraEntradasShopee,
  lista: readonly unknown[],
): LinhaSemPapel[] {
  return leitura.linhas.map((linha): LinhaSemPapel => {
    const elemento = lista[linha.indice];
    return {
      indice: linha.indice,
      entrada: linha.entrada,
      motivo: linha.motivo,
      marcada: seraDescartadoAoSalvar(elemento),
      removivel: ehObjeto(elemento),
    };
  });
}

/**
 * The rows that survive the save — readable and NOT marked, what publish will
 * see — as the selector's input. THE one spelling of "active": the roles, the
 * replace-on-add target and the modal's confirm all come through it.
 * `exceto` leaves one raw index out (the row a "Trocar" is about to replace).
 */
function linhasAtivas(
  linhas: readonly Pick<LinhaTabelaShopeeForm, 'indice' | 'entrada' | 'marcada'>[],
  exceto: number | null,
): LinhaEntradaShopee[] {
  const ativas: LinhaEntradaShopee[] = [];
  for (const linha of linhas) {
    if (linha.marcada || linha.entrada === null || linha.indice === exceto) continue;
    ativas.push({ indice: linha.indice, entrada: linha.entrada, motivo: null });
  }
  return ativas;
}

/**
 * The raw `indice` of this conta's ACTIVE row for `categoryId`, or -1 — THE
 * selector (`indiceDaEntradaShopee`) over the rows that survive the save. A
 * row staged for removal no longer counts, so its successor is the one a save
 * would leave in force. With `exceto`, that row is left out: "which OTHER
 * row covers this category" (the modal's warning before a "Trocar").
 */
export function indiceAtivoDaCategoria(
  linhas: readonly Pick<LinhaTabelaShopeeForm, 'indice' | 'entrada' | 'marcada'>[],
  categoryId: number,
  opcoes: { readonly exceto?: number } = {},
): number {
  return indiceDaEntradaShopee(linhasAtivas(linhas, opcoes.exceto ?? null), categoryId);
}

/**
 * This conta's rows, one per STORED element in stored order, each with its
 * role. `linhas` is `[]` unless `estado` is `lista`; for `campo-invalido` /
 * `lista-invalida` the tab offers NO edit (the value is not overwritten).
 */
export function linhasDaConta(
  mapa: unknown,
  integracaoId: string,
): { readonly estado: EstadoListaShopee; readonly linhas: readonly LinhaTabelaShopeeForm[] } {
  const { leitura, lista } = lerConta(mapa, integracaoId);
  if (lista === null) return { estado: leitura.estado, linhas: [] };
  const semPapel = linhasSemPapel(leitura, lista);
  const ativas = linhasAtivas(semPapel, null);
  const linhas = semPapel.map((linha): LinhaTabelaShopeeForm => {
    const papel: PapelDaLinha = linha.marcada
      ? PAPEL_DA_LINHA.seraRemovida
      : linha.entrada === null
        ? PAPEL_DA_LINHA.ilegivel
        : indiceDaEntradaShopee(ativas, linha.entrada.categoryId) === linha.indice
          ? PAPEL_DA_LINHA.usada
          : PAPEL_DA_LINHA.ignoradaDuplicada;
    return { ...linha, papel };
  });
  return { estado: leitura.estado, linhas };
}

/** A fresh copy of the entry with EXACTLY its three keys — a caller's extra key never reaches the map. */
function copiaDaEntrada(nova: EntradaTabelaShopee): EntradaTabelaShopee {
  return { categoryId: nova.categoryId, size_chart_id: nova.size_chart_id, name: nova.name };
}

/**
 * The map with ONLY this conta's list replaced. Every other key is carried by
 * the spread, in place; a computed key is an OWN data property, so even a
 * `'__proto__'` id is stored as data rather than reaching the prototype setter.
 */
function comLista(
  mapa: Record<string, unknown>,
  integracaoId: string,
  lista: readonly unknown[],
): Record<string, unknown> {
  return { ...mapa, [integracaoId]: lista };
}

/**
 * Stage a pick for this conta.
 *
 * - `adicionar`: when a SURVIVING row already covers `nova.categoryId` (the
 *   schemas selector), that row is REPLACED in place (Q6: a second entry for a
 *   category would be dead); otherwise `nova` is appended. A conta with no list
 *   yet — outer `null`, key absent, per-key `null` — gets `[nova]`.
 * - `trocar`: the element at `indice` is replaced, its position kept (so a
 *   first-match winner stays the winner) and any mark cleared.
 *
 * Returns `mapa` UNCHANGED — never a "repaired" value — when there is nothing it
 * may edit: `campo-invalido` / `lista-invalida` (the tab offers no edit there),
 * a `trocar` with no list or an index out of range, or a `trocar` aimed at a
 * non-object element (R-h: shown "ilegível (mantida)", no action).
 */
export function adicionarOuSubstituir(
  mapa: unknown,
  integracaoId: string,
  nova: EntradaTabelaShopee,
  alvo: { readonly tipo: 'adicionar' } | { readonly tipo: 'trocar'; readonly indice: number },
): Record<string, unknown> {
  const { leitura, lista } = lerConta(mapa, integracaoId);
  const entrada = copiaDaEntrada(nova);

  if (lista === null) {
    if (leitura.estado !== ESTADO_LISTA_SHOPEE.semLista || alvo.tipo !== 'adicionar') {
      return inalterado(mapa);
    }
    // `sem-lista`: no map, no key, or a per-key `null`.
    return ehObjeto(mapa) ? comLista(mapa, integracaoId, [entrada]) : { [integracaoId]: [entrada] };
  }
  // `lista` ⇒ `mapa` is a plain object (lerConta).
  const base = mapa as Record<string, unknown>;

  if (alvo.tipo === 'adicionar') {
    const alvoIndice = indiceAtivoDaCategoria(linhasSemPapel(leitura, lista), entrada.categoryId);
    const proxima = lista.slice();
    if (alvoIndice === -1) proxima.push(entrada);
    else proxima[alvoIndice] = entrada;
    return comLista(base, integracaoId, proxima);
  }

  if (!indiceValido(lista, alvo.indice) || !ehObjeto(lista[alvo.indice])) {
    return inalterado(mapa);
  }
  const proxima = lista.slice();
  proxima[alvo.indice] = entrada;
  return comLista(base, integracaoId, proxima);
}

/**
 * Stage (`marcar: true`) or undo (`false`) the removal of the element at
 * `indice`. Marking adds `DELETE_MARK: true` to a COPY of the element; undoing
 * deletes the key from a copy — never `false`, so mark → unmark gives back a
 * value `valuesEqual` to the load and the form is not dirty. Undoing a
 * mark-free element returns `mapa` itself.
 *
 * Returns `mapa` UNCHANGED for anything it may not edit: no list, an index out
 * of range, or a non-object element (it cannot carry a mark — R-h).
 */
export function marcarRemocao(
  mapa: unknown,
  integracaoId: string,
  indice: number,
  marcar: boolean,
): Record<string, unknown> {
  const { lista } = lerConta(mapa, integracaoId);
  if (lista === null || !indiceValido(lista, indice)) return inalterado(mapa);
  const elemento = lista[indice];
  if (!ehObjeto(elemento)) return inalterado(mapa);

  let novo: Record<string, unknown>;
  if (marcar) {
    novo = { ...elemento, [DELETE_MARK]: true };
  } else {
    if (!Object.hasOwn(elemento, DELETE_MARK)) return inalterado(mapa);
    // The key is REMOVED, never set `false`: a stray `_pendingDelete: false`
    // would leave the form dirty after an undo.
    const { [DELETE_MARK]: _marca, ...semMarca } = elemento;
    novo = semMarca;
  }
  const proxima = lista.slice();
  proxima[indice] = novo;
  return comLista(mapa as Record<string, unknown>, integracaoId, proxima);
}

/**
 * `FieldConfig.prepareForSave` for `tabelasMedidasShopee`: every conta's array
 * goes through `stripMarkedForDeletion` (marked elements dropped, the marker
 * stripped from survivors); every other value — a per-key `null`, a non-array —
 * and every unmarked element are carried VERBATIM. A non-object field (`null`,
 * an array, a primitive) is returned as-is.
 */
export function prepararTabelasShopeeParaSalvar(valor: unknown): unknown {
  if (!ehObjeto(valor)) return valor;
  // `Object.fromEntries` defines OWN data properties, so a `'__proto__'` key
  // survives as data instead of reaching the prototype setter.
  return Object.fromEntries(
    Object.entries(valor).map(([chave, lista]) => [
      chave,
      Array.isArray(lista) ? stripMarkedForDeletion(lista) : lista,
    ]),
  );
}

/**
 * How many stored entries sit under map keys that name NO conta in `contaIds`
 * (a deleted integração) — shown, preserved, never editable. An array counts
 * its elements; a per-key `null` counts nothing; any other value counts as one
 * unreadable entry kept as stored. A non-object field counts nothing.
 */
export function entradasDeContasAusentes(mapa: unknown, contaIds: ReadonlySet<string>): number {
  if (!ehObjeto(mapa)) return 0;
  let total = 0;
  for (const [chave, valor] of Object.entries(mapa)) {
    if (contaIds.has(chave) || valor === null || valor === undefined) continue;
    total += Array.isArray(valor) ? valor.length : 1;
  }
  return total;
}

function indiceValido(lista: readonly unknown[], indice: number): boolean {
  return Number.isInteger(indice) && indice >= 0 && indice < lista.length;
}

/**
 * `mapa` handed back untouched. Typed as the map the signature promises: every
 * caller passes the result to the form's `onChange`, and the branches that
 * reach here are exactly the ones where overwriting the stored value with a
 * "repaired" one would destroy data the operator could not see.
 */
function inalterado(mapa: unknown): Record<string, unknown> {
  return mapa as Record<string, unknown>;
}
