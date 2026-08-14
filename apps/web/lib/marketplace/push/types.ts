import type { IntegracaoTipo } from '@delfrance/schemas';
import type { MercadoLivreClient } from '@/lib/mercado-livre/client';

/**
 * What every produto-scoped marketplace push shares, whatever it is pushing.
 *
 * Two operations sit on this today — "Enviar estoque" (#819) and "Enviar
 * preços" (#804) — and they are the same shape end to end: take the produtos
 * the operator checked, fan out over every channel each one is listed on, and
 * report one row per listing. Only the payload differs, so only the payload is
 * left to the operation: the orchestrator (`run.ts`), the progress dialog
 * (`PushProgressDialog.tsx`) and the provider-map builder below are written
 * once.
 *
 * ⚠️ What is deliberately NOT generalised is the provider contract itself. Each
 * operation keeps its own `types.ts`/`registry.ts` with its own method name
 * (`enviarEstoque` / `enviarPreco`) and its own per-run option
 * (`reenviarComErro` / `baixarPreco`). Collapsing those into one `push(input)`
 * with an opaque `opcao` would buy about sixteen lines and cost every call site
 * its readable name — and the option is not incidental, it is the thing the
 * operator ticks in the dialog.
 */

/** How one listing ended up. Every channel backend answers in these terms. */
export type PushOutcome = 'enviado' | 'pulado' | 'falha' | 'nao-tentado';

/**
 * The part of a result row that is the same for every operation.
 *
 * ⚠️ The unit is the LISTING, not the produto: a produto can carry several live
 * anúncios on ONE conta (the stock sweep's link join deliberately has no
 * `limit(1)` — see #781), so the legacy dialog's one-row-per-(produto,
 * integração) shape would hide a latched sibling completely.
 */
export interface PushRowBase {
  /** Stable React key: `${produtoId}:${integracaoId}:${anuncioId ?? '-'}`. */
  key: string;
  produtoId: string;
  produtoNome: string | null;
  integracaoId: string | null;
  integracaoNome: string | null;
  anuncioId: string | null;
  /** The link doc id — what an inline per-row action needs. */
  linkDocId: string | null;
  outcome: PushOutcome;
  /** Machine code. Null on success. */
  motivo: string | null;
  /** Operator-facing pt-BR text. The BACKEND owns this wording. */
  mensagem: string;
}

/** One selected produto, as the produtos table already holds it. */
export interface PushAlvo {
  produtoId: string;
  produtoNome: string;
  /**
   * The conta ids this produto is linked to. Used ONLY to decide which
   * unsupported channels are worth warning about — never to decide what to
   * send: the channel backend is authoritative about its own links, and this
   * denorm is known to drift (#804 S7).
   */
  integracoesComProduto: readonly string[];
}

/** The account a push targets, resolved by the orchestrator before dispatch. */
export interface PushIntegracao {
  id: string;
  nome: string;
  tipo: IntegracaoTipo;
  ativo: boolean;
}

/** Clients a provider may reach for. One field per channel, added as they land. */
export interface PushDeps {
  /** Null while logged out — a provider returns an error row, never throws. */
  mercadoLivre: MercadoLivreClient | null;
}

/**
 * Make a key generator that never repeats itself within one channel result.
 *
 * ⚠️ `(produtoId, anuncioId)` is NOT unique. It is unique among *drafts* — the
 * backend's `buildPrecoDrafts`/`buildSendTasks` dedupe those — but the SKIP arms
 * do not, and several are emitted inside a per-link or per-child loop. A family
 * with two unpublished link docs yields two `{produtoId: anchor, anuncioId:
 * null}` rows; a User-Products family with two parent links and a child matching
 * neither yields one row per parent link, all identical. Several anúncios per
 * família on one conta is the NORMAL case here — it is the whole reason the row
 * unit is the listing (#781).
 *
 * The consequence is not cosmetic: `key` is both the React list key and the
 * `data-testid` the e2e specs locate rows by, so a collision means React
 * reconciles two distinct outcomes as one row and the test id stops identifying
 * anything. The suffix only appears on an actual repeat, so the common case
 * keeps its readable, stable key.
 */
export function makeRowKeyer(): (
  produtoId: string,
  integracaoId: string,
  anuncioId: string | null,
) => string {
  const vistos = new Map<string, number>();
  return (produtoId, integracaoId, anuncioId) => {
    const base = `${produtoId}:${integracaoId}:${anuncioId ?? '-'}`;
    const n = vistos.get(base) ?? 0;
    vistos.set(base, n + 1);
    return n === 0 ? base : `${base}#${String(n)}`;
  };
}

/** Anything registrable by the `IntegracaoTipo` values it claims. */
export interface TipoClaimer {
  readonly tipos: readonly IntegracaoTipo[];
}

/**
 * Index providers by the tipos they claim. A tipo may be claimed by exactly one
 * provider — two claimants is a wiring bug, so it fails loud at module load
 * rather than silently letting registration order decide.
 *
 * `rotulo` names the operation in that error ("stock push" / "price push"),
 * since the stack trace of a module-load throw is not much help on its own.
 */
export function buildProviderMap<P extends TipoClaimer>(
  providers: readonly P[],
  rotulo: string,
): Partial<Record<IntegracaoTipo, P>> {
  const map: Partial<Record<IntegracaoTipo, P>> = {};
  for (const provider of providers) {
    for (const tipo of provider.tipos) {
      if (map[tipo] !== undefined) {
        throw new Error(`${rotulo} provider conflict for tipo "${String(tipo)}".`);
      }
      map[tipo] = provider;
    }
  }
  return map;
}
