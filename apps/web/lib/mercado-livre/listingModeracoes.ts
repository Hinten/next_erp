/**
 * Route a listing's persisted Mercado Livre MODERATION onto the screen (#1087).
 *
 * `itemsStatusSync` writes `produtoMercadoLivre.moderacoes` — ML's
 * `/moderations/last_moderation` answer, parsed
 * (`apps/mercado-livre/lib/marketplace/moderacoes.ts`) — and the editor subscribes
 * to the link doc live, so a moderação repaints the moment the `items`
 * notification lands and survives a reload. Before this, ML paused a listing for
 * a policy reason and the ERP showed a bare "pausado".
 *
 * ⚠️ A sibling of `listingCausas.ts`, deliberately NOT part of it. A causa is a
 * PAYLOAD validation failure ML answered a write of ours with; a moderação is a
 * POLICY verdict ML reached on its own. They differ in every way that matters
 * here: a causa always carries prose, a moderação may not; a causa is always
 * blocking, a moderação can sit on a listing ML still calls `active`; and a
 * causa's control mapping is resolved server-side against the payload we sent,
 * while a moderação names a content SECTION. One `split*` returning both would
 * have to lie about at least one of those.
 *
 * ⚠️ THE SAME ADDITIVE RULE `listingCausas.ts` records the hard way: what
 * {@link moderacoesPorCampo} resolves to a control is ALSO listed in the strip,
 * never moved out of it. Resolving to a control is not the same as being visible
 * on one — an earlier cut of the causas work kept single-control entries out of
 * the banner and a rejection pinned to an unrendered control displayed NOWHERE.
 * The banner depends on nothing.
 */
import type { MlModeracao, ProdutoMercadoLivreLink } from '@delfrance/schemas';
import { ML_CAUSA_CAMPO } from '@delfrance/schemas';

/**
 * How bad one moderação is, and — the part that matters — how much the UI is
 * ENTITLED to say about it.
 *
 *  - `com-conserto`  — ML gave a reason and a remedy. Fixable.
 *  - `sem-conserto`  — ML gave a reason and NO remedy. Its docs are explicit that
 *    a removed listing answers that way *because there is no way back*, so this
 *    is the one state where the UI may say the anúncio cannot be reactivated.
 *  - `sem-motivo`    — ML named the filter and gave no REASON. It may still have
 *    sent a REMEDY: `motivo` and `remedio` are independent `wordings` lookups and
 *    the backend keeps a REMEDY-only entry on its `nome`.
 *
 * ⚠️ `sem-motivo` must NEVER be rendered as `sem-conserto`. "ML supplied no
 * explanation" is not "this listing cannot be recovered"; conflating them tells
 * the operator to abandon a listing that may be perfectly fixable. That is the
 * whole reason this is a three-way verdict rather than a boolean on `remedio`.
 *
 * ⚠️ And it is a verdict about the ENTRY, not a render gate for its fields. It
 * decides the alert colour and whether the UI may claim the anúncio is finished —
 * nothing else. `remedio` renders whenever it is present, because
 * `sem-motivo` does NOT imply `remedio == null`: gating that field on
 * `com-conserto` discarded the one actionable sentence ML had sent.
 */
export type SeveridadeModeracao = 'sem-conserto' | 'sem-motivo' | 'com-conserto';

export function severidadeModeracao(moderacao: MlModeracao): SeveridadeModeracao {
  // Trim-aware rather than `== null`, so this is right for a raw entry too and
  // not only for one {@link moderacoesDoLink} already normalised. A blank
  // `motivo` classified as `sem-conserto` would render an EMPTY reason under the
  // red "não pode ser reativado" — the exact thing this type exists to prevent.
  if (textoOuNull(moderacao.motivo) == null) return 'sem-motivo';
  return textoOuNull(moderacao.remedio) == null ? 'sem-conserto' : 'com-conserto';
}

/** Alert colour per severity — the WORST entry decides the whole block. */
const COR_POR_SEVERIDADE: Record<SeveridadeModeracao, string> = {
  'sem-conserto': 'red',
  'sem-motivo': 'orange',
  'com-conserto': 'yellow',
};

/** Most severe first — the order {@link corDaModeracao} scans. */
const SEVERIDADE_ORDEM: readonly SeveridadeModeracao[] = [
  'sem-conserto',
  'sem-motivo',
  'com-conserto',
];

/**
 * One colour for the block. Red only when something really is unrecoverable, so
 * the strongest signal on the screen keeps meaning what it says.
 *
 * The per-entry TEXT still carries the truth for each moderação: a fixable entry
 * sitting inside a red block still shows its remedy.
 */
export function corDaModeracao(moderacoes: readonly MlModeracao[]): string {
  const severidades = new Set(moderacoes.map(severidadeModeracao));
  for (const s of SEVERIDADE_ORDEM) {
    if (severidades.has(s)) return COR_POR_SEVERIDADE[s];
  }
  return COR_POR_SEVERIDADE['com-conserto'];
}

/**
 * The moderações worth rendering.
 *
 * ⚠️ Re-applies the gate the backend mapper already applies, and that is not
 * redundant. Every field on `mlModeracaoSchema` is nullable and the shape is
 * `.passthrough()`, so an entry saying nothing at all PARSES — and this reads
 * documents the Flutter app and a legacy corpus can also have touched. An empty
 * entry would render an alert with no content, which is the "red alert saying
 * nothing" the whole feature exists to avoid.
 *
 * ⚠️ It also NORMALISES (see {@link normalizar}), and that is the contract every
 * consumer downstream relies on: after this, a blank string is null, so
 * `motivo == null` and `remedio != null` are correct tests rather than
 * nearly-correct ones. Read the field off a raw link doc and they are not.
 */
export function moderacoesDoLink(link: Pick<ProdutoMercadoLivreLink, 'moderacoes'>): MlModeracao[] {
  const out: MlModeracao[] = [];
  for (const bruta of link.moderacoes ?? []) {
    if (bruta == null) continue;
    const m = normalizar(bruta);
    if (m.motivo == null && m.nome == null) continue;
    out.push(m);
  }
  return out;
}

/**
 * Blank-to-null, once, at the boundary — so every consumer downstream may use a
 * plain `== null` and be right.
 *
 * ⚠️ This exists because the alternative is a trim-aware predicate at each of
 * the six places a field is read, and missing ONE of them is a real defect: a
 * `motivo: '   '` entry would clear the visibility gate on its `nome`, classify
 * as `sem-conserto`, and render an EMPTY reason under the red "não pode ser
 * reativado". Normalising in one place makes that unrepresentable instead of
 * merely unlikely.
 *
 * Today's writer (`mapModeracoes`) already trims and nulls blanks, so nothing on
 * disk should need this — but the module's whole premise is that it reads
 * documents the Flutter app and a legacy corpus also touched, and it would be
 * inconsistent to say that and then trust the strings.
 */
function normalizar(m: MlModeracao): MlModeracao {
  return {
    ...m,
    nome: textoOuNull(m.nome),
    motivo: textoOuNull(m.motivo),
    remedio: textoOuNull(m.remedio),
    secoes: textosNaoVazios(m.secoes),
    evidencias: textosNaoVazios(m.evidencias),
  };
}

/** A trimmed non-empty string, or null. */
function textoOuNull(v: string | null | undefined): string | null {
  const t = typeof v === 'string' ? v.trim() : null;
  return t != null && t.length > 0 ? t : null;
}

function textosNaoVazios(vs: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const v of vs ?? []) {
    const t = textoOuNull(v);
    if (t != null) out.push(t);
  }
  return out;
}

/**
 * ML `evidences[].section_name` → a label an operator reads.
 *
 * Lives here rather than beside the schema — unlike `ESTADO_PUBLICACAO_ML_LABELS`,
 * `secoes` is a free ML string and not a Zod enum with a companion const, so
 * there is no enum for it to be the labels OF. Presentation, so: apps/web.
 */
export const SECAO_LABELS: Record<string, string> = {
  pictures: 'Fotos',
  title: 'Título',
  category: 'Categoria',
  item: 'Anúncio',
};

/**
 * Human label for one section, falling back to the RAW value — the same shape
 * `estadoLabel` uses. ML documents four sections and is free to add a fifth; an
 * unknown one must still tell the operator where to look, not vanish.
 */
export function secaoLabel(secao: string): string {
  return SECAO_LABELS[secao] ?? secao;
}

/** `pictures, title` → `Fotos, Título`, de-duplicated, for the strip's "Onde:". */
export function secoesLabel(secoes: readonly string[]): string {
  return [...new Set(textosNaoVazios(secoes).map(secaoLabel))].join(', ');
}

/**
 * ML section → the listing-form control that can fix it, reusing the ONE control
 * vocabulary `ML_CAUSA_CAMPO` already defines so a moderação and a causa land on
 * the same inputs instead of growing a second channel.
 *
 * `pictures` and `item` are deliberately absent: the photos are managed outside
 * this form and `item` names the whole listing, so neither resolves to a control.
 * That is exactly why the strip cannot depend on this mapping (module docblock).
 */
const SECAO_CAMPO: Record<string, string> = {
  title: ML_CAUSA_CAMPO.title,
  category: ML_CAUSA_CAMPO.categoryId,
};

/**
 * What each control shows for a moderação — merged with the causa map and the
 * pre-flight refusal through `mergeServerErrors`.
 *
 * ⚠️ A `sem-motivo` entry contributes an explicitly FRAMED line
 * (`Moderado pelo Mercado Livre (FILTRO)`) rather than the bare `nome`. The
 * schema forbids storing `nome` as the reason because a raw SCREAMING_SNAKE id
 * reads as ML's own prose; here the framing is what makes it honest — the
 * operator can see it is our sentence, not ML's.
 */
export function moderacoesPorCampo(
  link: Pick<ProdutoMercadoLivreLink, 'moderacoes'>,
): Record<string, string[]> {
  const porCampo: Record<string, string[]> = {};
  for (const moderacao of moderacoesDoLink(link)) {
    const mensagem = moderacao.motivo ?? `Moderado pelo Mercado Livre (${moderacao.nome ?? ''})`;
    for (const secao of new Set(moderacao.secoes)) {
      const campo = SECAO_CAMPO[secao];
      if (campo == null) continue;
      (porCampo[campo] ??= []).push(mensagem);
    }
  }
  return porCampo;
}
