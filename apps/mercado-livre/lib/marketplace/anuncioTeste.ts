/**
 * The data Mercado Livre requires a **test listing** to carry.
 *
 * Every rule here is quoted from ML's own "Realização de testes" page
 * (developers.mercadolivre.com.br/pt_br/realizacao-de-testes, revision
 * 2025-12-30) rather than invented, because getting them wrong means a real
 * listing on a real marketplace:
 *
 *  - «Os anúncios devem ter o título "Item de Teste – Por favor, NÃO OFERTAR!"»
 *  - «Na medida do possível, publique na categoria "Outros"»
 *  - «Não se deve publicar em "gold" nem "gold_premium" para que não apareça na
 *    nossa página de início»
 *  - «O Mercado Livre **não tem um ambiente para teste ou sandbox**»
 *  - «Todas as transações de teste devem ser realizadas entre usuários de
 *    teste… contas pessoais ou de familiares não devem ser, em hipótese alguma,
 *    utilizadas para testes»
 *
 * ⚠️ Read the last two together: there is no sandbox, so a test listing is a
 * **real listing on production**, and ML's rule is that it must not sit on a
 * real seller account. That is why `isContaDeTeste` exists — the UI warns rather
 * than blocks, but it must be able to tell.
 */

/** The exact title ML's documentation requires. Not paraphrasable. */
export const TITULO_ANUNCIO_TESTE = 'Item de Teste – Por favor, NÃO OFERTAR!';

/** Body text, so a human who finds the listing knows why it exists. */
export const DESCRICAO_ANUNCIO_TESTE =
  'Anúncio de teste criado para validar a integração. Não está à venda — por favor, não oferte.';

/** The category name ML asks test listings to use, matched case-insensitively. */
export const CATEGORIA_TESTE_NOME = 'Outros';

/**
 * Listing types that must never carry a test listing.
 *
 * ML names `gold`/`gold_premium` explicitly ("para que não apareça na nossa
 * página de início"). `gold_pro` is Premium — the current top exposure and this
 * repo's default since #968 — so it is excluded for the same reason the rule
 * exists, even though the docs predate the name.
 */
const TIPOS_PROIBIDOS = new Set(['gold', 'gold_premium', 'gold_pro']);

/**
 * Preference order among what a category actually offers. `free` is
 * `listing_exposure: lowest` with `home_page: false`, which is exactly what the
 * rule is protecting.
 */
const TIPOS_PREFERIDOS = ['free', 'bronze', 'silver', 'gold_special'] as const;

/**
 * Pick the lowest-exposure listing type the category offers.
 *
 * Returns `null` when nothing acceptable is available — the caller leaves the
 * field for the operator rather than silently choosing a Premium listing, which
 * is the one outcome this whole function exists to prevent.
 */
export function escolherTipoAnuncioTeste(
  disponiveis: ReadonlyArray<{ id: string }>,
): string | null {
  const ids = new Set(disponiveis.map((t) => t.id));
  for (const preferido of TIPOS_PREFERIDOS) {
    if (ids.has(preferido)) return preferido;
  }
  // Nothing preferred: take anything that is not forbidden, in ML's own order.
  const outro = disponiveis.find((t) => !TIPOS_PROIBIDOS.has(t.id));
  return outro?.id ?? null;
}

/**
 * Find ML's "Outros" category among the site's roots.
 *
 * ⚠️ Matched by NAME, not by a hardcoded id. MLB's "Outros" id is not something
 * this repo can verify offline, and a wrong guess would file a test listing into
 * a real category — accent- and case-insensitive matching against the live root
 * list is both correct and self-maintaining. `null` when ML has no such root, in
 * which case the caller leaves the category empty and the operator picks.
 */
export function encontrarCategoriaTeste(
  raizes: ReadonlyArray<{ id: string; name?: string | null }>,
): string | null {
  const alvo = normalizar(CATEGORIA_TESTE_NOME);
  return raizes.find((c) => normalizar(c.name ?? '') === alvo)?.id ?? null;
}

/**
 * Whether this account is one of ML's test users.
 *
 * ML mints them through `POST /users/test_user` with a `TEST…` nickname and no
 * other marker on `/users/me`, so the nickname is the only signal available.
 * Deliberately a heuristic used ONLY to warn — never to block, and never to
 * decide anything on the publish path.
 */
export function isContaDeTeste(nickname: string | null | undefined): boolean {
  return typeof nickname === 'string' && /^TEST/i.test(nickname.trim());
}

function normalizar(s: string): string {
  return s
    .trim()
    .toLocaleLowerCase('pt-BR')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}
