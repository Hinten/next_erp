/**
 * The conta's price tabelas, as the price sync reads them (master plan step 13, PR 13-d): the
 * conta's `tabelaNormalOuterRef` and `tabelaPromocionalOuterRef` folded to BARE `listaDePrecos`
 * document ids, and whether a bulk send's tabelas are still the conta's.
 *
 * ## Both stored forms of a ref
 *
 * A conta stores each ref as `documents/listaDePrecos/<id>` or as the bare `listaDePrecos/<id>`
 * across the migrated corpus; both read as the same id, through the shared ref normaliser
 * (`toOuterRefOrNull`, `@delfrance/schemas`) — the depósito reader's rule
 * (`depositoDaContaLi`). Anything that does not name exactly one `listaDePrecos` document (another
 * collection, a nested path, an id Firestore refuses, a number) names NO tabela.
 *
 * ## The bulk check folds "promo == normal" on BOTH sides
 *
 * A bulk send (`reconcile`, `atualizacao`) carries the tabela ids its run priced the conta at
 * (`tarefaPrecoLiSchema`), and its run stores `null` for the promotional one when the conta names
 * none OR names its normal tabela again (`sincPrecoLojaIntegrada`). So {@link mesmasTabelasDoEnvioLi}
 * folds a promotional tabela equal to the normal one to `null` on both sides before comparing:
 * the same pricing, spelled two ways. The send run itself hands the conta's RAW pair to
 * `precoAlvoLi`, so that function's own "promo equals normal" signal is never lost.
 *
 * Here, not in `@delfrance/schemas`: the send run, the trigger and the nightly all live in this
 * app. Pure and total: no clock, no network, no Firestore, no environment; own keys only.
 */
import { idDocumentoEstoqueLiSchema, toOuterRefOrNull } from '@delfrance/schemas';

/** The collection a conta's tabela refs name. */
export const COLECAO_TABELA_PRECO_LI = 'listaDePrecos';

/** The conta's two tabelas, as bare document ids. */
export interface TabelasDaContaLi {
  /** The normal tabela, or `null`: the conta names none (or names it unreadably). */
  readonly normal: string | null;
  /** The promotional tabela AS STORED (it may equal {@link normal}), or `null`. */
  readonly promocional: string | null;
}

/** An OWN property only: an inherited one is not stored data. */
function proprio(o: object, chave: string): unknown {
  return Object.hasOwn(o, chave) ? (o as Readonly<Record<string, unknown>>)[chave] : undefined;
}

/**
 * A tabela ref → its bare id: exactly three segments of the canonical form
 * (`documents/listaDePrecos/<id>`), the collection `listaDePrecos`, and an id Firestore accepts
 * (`idDocumentoEstoqueLiSchema`); otherwise `null`.
 */
function idDaTabelaLi(ref: unknown): string | null {
  const canonica = toOuterRefOrNull(ref);
  if (canonica === null) return null;
  const partes = canonica.split('/');
  const id = partes[2];
  if (partes.length !== 3 || partes[1] !== COLECAO_TABELA_PRECO_LI || id === undefined) {
    return null;
  }
  return idDocumentoEstoqueLiSchema.safeParse(id).success ? id : null;
}

/**
 * The conta's tabelas (module header, "Both stored forms of a ref").
 *
 * Equal (⇒ `'T1'`): `'documents/listaDePrecos/T1'` ≡ `'listaDePrecos/T1'`. Distinct (⇒ `null`):
 * `'documents/outra/T1'`, `'documents/listaDePrecos/T1/sub/x'`, `''`, a number,
 * `'documents/listaDePrecos/__x__'`, and a key the conta only inherits.
 */
export function tabelasDaContaLi(conta: {
  readonly tabelaNormalOuterRef?: unknown;
  readonly tabelaPromocionalOuterRef?: unknown;
}): TabelasDaContaLi {
  return {
    normal: idDaTabelaLi(proprio(conta, 'tabelaNormalOuterRef')),
    promocional: idDaTabelaLi(proprio(conta, 'tabelaPromocionalOuterRef')),
  };
}

/** The promotional tabela with "names the normal one again" folded to `null`. */
function promocionalDobradaLi(normal: string | null, promocional: string | null): string | null {
  return promocional === normal ? null : promocional;
}

/**
 * Are a bulk send's tabelas (as `tarefaPrecoLiSchema` carries them) still the conta's? The normal
 * tabela equal, and the promotional one equal after folding "promo == normal" to `null` on BOTH
 * sides (module header). A conta that names no normal tabela matches nothing.
 *
 * Equal: the task's `{N, null}` against the conta's `{N, N}`; the task's `{N, N}` against the
 * conta's `{N, null}`; a conta storing either ref form. Distinct: another normal tabela; a promo
 * `P` against none; a promo `P` against `Q`; a conta with no normal tabela.
 */
export function mesmasTabelasDoEnvioLi(
  conta: TabelasDaContaLi,
  tarefa: {
    readonly tabelaNormalId?: string | null;
    readonly tabelaPromocionalId?: string | null;
  },
): boolean {
  const normal = tarefa.tabelaNormalId ?? null;
  if (conta.normal === null || normal !== conta.normal) return false;
  return (
    promocionalDobradaLi(conta.normal, conta.promocional) ===
    promocionalDobradaLi(normal, tarefa.tabelaPromocionalId ?? null)
  );
}
