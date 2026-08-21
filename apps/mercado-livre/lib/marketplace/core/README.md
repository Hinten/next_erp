# core — shared runtime

The sink every other theme may import. Nothing here knows about a specific
domain flow; if a module is needed by three or more themes, this is where it
belongs.

- `mercadoLivre.ts` — resolves an `integracao` account into a `ChannelContext`
  (newest valid token or a concurrency-safe refresh) plus the plugin channel.
  The entry point almost every route and function starts from.
- `contaCache.ts` — process-scoped cache of the ML `integracao` doc and its
  seller-id lookup. See the `firestore-read-cache` skill.
- `tokenStore.ts` — durable token store over the admin-only
  `integracao/{id}/tokenDuravel` subcollection (the old Flutter wire shape, kept
  because the migrated corpus carries it; "one wins" refresh).
- `respond.ts` — `isMercadoLivreError` guard plus ML-error → HTTP response
  mapping. **27 route files import this** and only one file inside this folder
  does; it is arguably a `lib/http/` concern, left here deliberately.
- `linkRefs.ts` — pure helpers over `produtoMercadoLivre` / `variacaoMercadoLivre`
  link docs and the webhook `resource` string. The most-imported module in the
  folder (12 in-folder importers).
- `arquivoUpload.ts` — thin re-export of `@delfrance/storage/admin`'s
  create-first Arquivo uploader, kept for call-site stability.
- `publishFalhas.ts` — parses ML's rejection `cause[]` into the listing-form
  control that can fix it. Lives here rather than in `anuncios/` because stock,
  price, import and status-sync all consume it.
