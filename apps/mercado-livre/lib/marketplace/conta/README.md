# conta — OAuth connect, account bootstrap, test users

Everything about _getting and holding an ML account connection_, as opposed to
using one (that is `core/mercadoLivre.ts`).

- `oauthState.ts` — the connect flow's two trust anchors (#821). A thin binding
  over the shared `@delfrance/data/admin/oauth-state`; holds only what is
  per-channel (the `integracao/{id}/oauthState` subcollection and the
  `MERCADO_LIVRE_PKCE_ENABLED` flag). ⚠️ Do not reintroduce logic here.
- `testUsers.ts` — mints ML's seller/buyer **test users** from a throwaway
  bootstrap conta, then revokes it. ML has no sandbox; these are real production
  accounts, capped at 10, and the password is shown once and never reissued —
  which is why the mint/persist ordering is the whole design.
- `testUserStore.ts` — the store over `integracao/{id}/usuariosTeste`
  (admin-only, deliberately outside `ALL_DOMAINS`). Split from `testUsers.ts`
  the way `tokenStore` is from `mercadoLivre`.
- `anuncioTeste.ts` — the title/category/listing-type rules ML mandates for a
  _test listing_. Listing content by shape, test-user tooling by purpose; its
  only in-folder importer is `testUsers.ts`.
