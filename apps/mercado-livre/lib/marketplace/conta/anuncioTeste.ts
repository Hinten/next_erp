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

/** The category name ML's documentation asks test listings to use. */
export const CATEGORIA_TESTE_NOME = 'Outros';

/**
 * The ROOT names that stand in for "Outros" on a site, matched
 * case-insensitively.
 *
 * ⚠️ **MLB has no root called "Outros"**, which is why the documented name alone
 * found nothing and the whole feature silently did nothing — `categoryId` came
 * back null on every call and the descent below never even started. Verified
 * against the live catalogue (2026-08-14, conta Lucas Teste): MLB's roots run
 * "Acessórios para Veículos" … "Serviços" and end in **"Mais Categorias"**, and
 * `Mais Categorias › Outros` is a LEAF one level down — exactly the shape
 * `escolherDescendenteTeste` resolves.
 *
 * `'Outros'` stays first: it is what ML documents, it is what other sites use,
 * and if MLB ever promotes it to a root this keeps working without a change.
 */
export const CATEGORIA_TESTE_RAIZ_NOMES: readonly string[] = ['Outros', 'Mais Categorias'];

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
  // In preference order, so a site that really does expose "Outros" as a root
  // uses it rather than the catch-all.
  for (const nome of CATEGORIA_TESTE_RAIZ_NOMES) {
    const alvo = normalizar(nome);
    const hit = raizes.find((c) => normalizar(c.name ?? '') === alvo);
    if (hit) return hit.id;
  }
  return null;
}

/**
 * How deep the descent below "Outros" may go.
 *
 * Each level costs one `GET /categories/{id}`, so this is the only thing bounding
 * the call count. Six is far past MLB's real depth and still cheap; a tree that
 * needs more is one this feature should decline rather than crawl.
 */
export const PROFUNDIDADE_MAX_CATEGORIA_TESTE = 6;

/**
 * Pick which child to descend into on the way to a leaf.
 *
 * ⚠️ **This is why the whole feature was silently doing nothing.** ML's "Outros"
 * is a ROOT with children, and only a leaf can be published into — so requiring
 * the root itself to be a leaf meant `categoryId` came back `null` on every
 * single call, the form's (correct) null-guard skipped the write, and the
 * operator saw the title change while the category and the whole attribute grid
 * sat still.
 *
 * Prefer a child that is itself named "Outros" — ML nests it that way, and it is
 * the most neutral place a test listing can land. Otherwise take the first child:
 * still inside "Outros", which is the category ML's own documentation asks test
 * listings to use, and the operator sees the resolved path and can change it.
 * Never a hardcoded id.
 */
export function escolherDescendenteTeste(
  filhos: ReadonlyArray<{ id: string; name?: string | null }>,
): string | null {
  if (filhos.length === 0) return null;
  const alvo = normalizar(CATEGORIA_TESTE_NOME);
  const homonimo = filhos.find((c) => normalizar(c.name ?? '') === alvo);
  return (homonimo ?? filhos[0])?.id ?? null;
}

/**
 * Whether this account is one of ML's test users.
 *
 * ML mints them through `POST /users/test_user` and puts no marker on
 * `/users/me`, so the nickname is the only signal available. Deliberately a
 * heuristic used ONLY to warn — never to block, and never to decide anything on
 * the publish path.
 *
 * ⚠️ **`TETE…`, not just `TEST…`.** The repo's own captured test-user order
 * (`orderMLWire.test.ts`, a `tags: ['test_order']` payload) carries
 * `nickname: 'TETE8127263'`, so a `/^TEST/` predicate misses the format ML
 * actually mints. The direction of that failure is what matters: the operator
 * who does exactly what the alert asks — mint a test user, connect it as a
 * second conta — would be told their compliant account is not a test account,
 * and a warning that fires on the correct setup is one people learn to click
 * past, which costs the single case it exists for.
 */
export function isContaDeTeste(nickname: string | null | undefined): boolean {
  return typeof nickname === 'string' && /^TE(ST|TE)/i.test(nickname.trim());
}

function normalizar(s: string): string {
  return s
    .trim()
    .toLocaleLowerCase('pt-BR')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}
