# categorias — category tree & catalog metadata

Route-facing reads of ML's catalog metadata. Both files are leaves: neither
imports anything else in this folder tree.

- `categoriaAtributos.ts` — pure projection of
  `GET /categories/{id}/attributes` into the listing-editor shape.
- `mlMetadataCache.ts` — process caches for the category tree, attributes,
  listing types and suggestions. See the `firestore-read-cache` skill for the
  TTL-is-the-staleness-bound rule.
