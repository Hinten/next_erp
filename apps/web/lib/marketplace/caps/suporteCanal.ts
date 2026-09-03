import {
  INTEGRACAO_TIPO_LABELS,
  type IntegracaoTipo,
  type MarketplaceCapabilities,
  type Suporte,
  marketplaceCapsOrNull,
} from '@delfrance/schemas';

/**
 * Does this channel support this row action, and — when it does not — WHICH of
 * the reasons applies (#1430).
 *
 * ⚠️ The predicate this replaces was `PROVIDERS[tipo] !== undefined`, written
 * out identically in the three run files. "A provider file exists" is not the
 * question a row action is asking, and it is the exact mistake the `/canais`
 * badge already fixed and documented: *"'has a package' is not 'works'"*
 * (#815, ADR 0015). It also collapses four different situations into one
 * sentence, so the operator got a dead action and no reason.
 *
 * ⚠️ Deliberately takes the provider map as an ARGUMENT rather than importing
 * the registries: every registry imports this module, so reaching back would
 * be a cycle.
 */

/** A produto-scoped row/bulk action that fans out over a produto's channels. */
export type AcaoCanal = 'estoque' | 'preco' | 'anuncioStatus';

/**
 * Why an action cannot run on a channel. Ordered by how permanent it is —
 * {@link vereditoCanal} answers with the first that applies, and each arm is
 * reachable:
 *
 * - `canal-nao-suportado` — the provider CANNOT. Building a backend will not
 *   change it.
 * - `canal-nao-pesquisado` — nobody has checked. Only reachable while
 *   `implementado` is false, because `marketplace.test.ts` already forbids an
 *   implemented channel from carrying a `'desconhecido'`.
 * - `canal-nao-implementado` — the provider can, we have not built the channel.
 * - `canal-sem-provider` — the channel is built and the table says the provider
 *   supports it, but nothing claims the tipo in this screen's registry. That is
 *   a wiring gap, not a capability one; the registries' drift test asserts it is
 *   unreachable today, so this arm exists to be honest if it ever is not.
 */
export type MotivoNaoSuportado =
  | 'nao-marketplace'
  | 'canal-nao-suportado'
  | 'canal-nao-pesquisado'
  | 'canal-nao-implementado'
  | 'canal-sem-provider';

export type VereditoCanal =
  | { readonly suportado: true }
  | { readonly suportado: false; readonly motivo: MotivoNaoSuportado };

const SUPORTADO: VereditoCanal = { suportado: true };

/** What each action asks of a caps row, and how it names itself to an operator. */
interface DescritorAcao {
  readonly suporte: (caps: MarketplaceCapabilities) => Suporte;
  /** Fits both "o Shopee não oferece …" and "… ainda não foi ligado". */
  readonly oQue: string;
}

const ACOES: Record<AcaoCanal, DescritorAcao> = {
  estoque: { suporte: (c) => c.estoque.suporte, oQue: 'envio de estoque' },
  preco: { suporte: (c) => c.enviarPreco, oQue: 'envio de preços' },
  anuncioStatus: { suporte: (c) => c.pausarAnuncio, oQue: 'pausa de anúncios' },
};

/**
 * The precedence itself, as a pure function of the two facts a caps row carries
 * about one capability. `null` means "nothing stands in the way".
 *
 * ⚠️ Exported because it is the only way to EXERCISE the rule. Through the live
 * table today, `'nao'` and `'sim' + !implementado` are both unreachable for
 * these three actions — the one implemented channel answers `'sim'` to all
 * three and every unbuilt one answers `'desconhecido'`. A branch that cannot be
 * reached from the table is a branch nobody has checked, and it becomes
 * reachable the day someone runs Phase 0 on a second channel.
 */
export function motivoDaCapacidade(
  suporte: Suporte,
  implementado: boolean,
): MotivoNaoSuportado | null {
  // Most permanent first: a provider that cannot do it will not start being
  // able to because we shipped a backend.
  if (suporte === 'nao') return 'canal-nao-suportado';
  // Only reachable while `!implementado` — `marketplace.test.ts` forbids an
  // implemented channel from leaving a capability unanswered.
  if (suporte === 'desconhecido') return 'canal-nao-pesquisado';
  if (!implementado) return 'canal-nao-implementado';
  return null;
}

/** The verdict the capability table alone gives, before any registry is consulted. */
function vereditoDasCaps(acao: AcaoCanal, tipo: IntegracaoTipo): VereditoCanal {
  const caps = marketplaceCapsOrNull(tipo);
  if (caps === null) return { suportado: false, motivo: 'nao-marketplace' };

  const motivo = motivoDaCapacidade(ACOES[acao].suporte(caps), caps.implementado);
  return motivo === null ? SUPORTADO : { suportado: false, motivo };
}

/**
 * Does `MARKETPLACE_TIPO_CAPS` alone permit this action on this channel?
 *
 * Exported for the registries' drift test, which asserts this agrees with
 * "a provider claims the tipo" for every tipo. Production code wants
 * {@link vereditoCanal}, which also answers whether the screen is wired.
 */
export function capsPermitem(acao: AcaoCanal, tipo: IntegracaoTipo): boolean {
  return vereditoDasCaps(acao, tipo).suportado;
}

/** The full verdict: what the table says, then whether a provider claims the tipo. */
export function vereditoCanal<P>(
  acao: AcaoCanal,
  tipo: IntegracaoTipo,
  providers: Partial<Record<IntegracaoTipo, P>>,
): VereditoCanal {
  const pelasCaps = vereditoDasCaps(acao, tipo);
  if (!pelasCaps.suportado) return pelasCaps;
  if (providers[tipo] === undefined) return { suportado: false, motivo: 'canal-sem-provider' };
  return SUPORTADO;
}

/**
 * The operator-facing sentence for a refusal. ONE catalogue, so the pre-run
 * warning and the result row cannot drift into disagreeing about the same
 * channel.
 *
 * ⚠️ Every sentence names the conta AND the channel. "Não suportado" alone is
 * not actionable — `registry.test.ts` pins that.
 *
 * ⚠️ The sentence this replaces ended *"use o aplicativo antigo para este
 * canal"*. There is no dual run (root `CLAUDE.md` rule 8): the legacy app is
 * switched OFF at the cutover, so that hint expires. The reason replaces it.
 */
export function mensagemNaoSuportado(
  motivo: MotivoNaoSuportado,
  acao: AcaoCanal,
  nomeDaConta: string,
  tipo: IntegracaoTipo,
): string {
  // `INTEGRACAO_TIPO_LABELS` is a Record over the union, but a tipo read
  // unparsed off Firestore can sit outside it — the same tolerance
  // `marketplaceCapsOrNull` grew.
  const canal = INTEGRACAO_TIPO_LABELS[tipo] ?? 'canal desconhecido';
  const { oQue } = ACOES[acao];
  switch (motivo) {
    case 'nao-marketplace':
      return `${nomeDaConta}: ${canal} não é um canal de marketplace, então não há ${oQue}.`;
    case 'canal-nao-suportado':
      return `${nomeDaConta}: o ${canal} não oferece ${oQue} pela API — não há o que enviar daqui.`;
    case 'canal-nao-pesquisado':
      return `${nomeDaConta}: ainda não foi verificado se o ${canal} oferece ${oQue}.`;
    case 'canal-nao-implementado':
      return `${nomeDaConta}: o ${canal} oferece ${oQue}, mas o canal ainda não foi implementado aqui.`;
    case 'canal-sem-provider':
      return `${nomeDaConta}: o ${canal} já tem backend, mas ${oQue} ainda não foi ligado nesta tela.`;
  }
}
