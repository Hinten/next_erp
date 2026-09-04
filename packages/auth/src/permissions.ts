/**
 * Permission bitmask. Encoded as BigInt to support sets > 53 bits.
 * Custom claims store these as strings (`permissions: '0x...'` or decimal).
 *
 * Bits are grouped per domain. New domains take the next free byte.
 */
export const PERM = {
  cliente: {
    read: 1n << 0n,
    write: 1n << 1n,
    delete: 1n << 2n,
  },
  // Endereço — subcollection of cliente. Bits 3-5 share the cliente byte and
  // are already used by `enderecoMeta` in packages/schemas/src/endereco.ts.
  endereco: {
    read: 1n << 3n,
    write: 1n << 4n,
    delete: 1n << 5n,
  },
  produto: {
    read: 1n << 8n,
    write: 1n << 9n,
    delete: 1n << 10n,
  },
  // Categoria — catálogo de produtos. Bits 11-13 share the produto byte and
  // are already used by `categoriaMeta` in packages/schemas/src/categoria.ts.
  categoria: {
    read: 1n << 11n,
    write: 1n << 12n,
    delete: 1n << 13n,
  },
  pedido: {
    read: 1n << 16n,
    write: 1n << 17n,
    delete: 1n << 18n,
  },
  pagamento: {
    read: 1n << 24n,
    write: 1n << 25n,
    delete: 1n << 26n,
  },
  // MetodoPagamento — `metodo_pgto` collection. Bits 27-29 share the
  // pagamento byte; mirrored by `metodoPagamentoMeta` in
  // packages/schemas/src/pagamento.ts.
  metodoPagamento: {
    read: 1n << 27n,
    write: 1n << 28n,
    delete: 1n << 29n,
  },
  nfe: {
    read: 1n << 32n,
    write: 1n << 33n,
    delete: 1n << 34n,
  },
  configuracoes: {
    read: 1n << 40n,
    write: 1n << 41n,
  },
  // Chat / atendimento — Conversa documents (`chat` collection).
  chat: {
    read: 1n << 48n,
    write: 1n << 49n,
    delete: 1n << 50n,
  },
  // Mensagem — `chat/{conversaId}/mensagem` subcollection. Bits 51-53 share
  // the chat byte; mirrored by `mensagemMeta` in
  // packages/schemas/src/conversa.ts. Cargos granting chat access should
  // normally pair both domains.
  mensagem: {
    read: 1n << 51n,
    write: 1n << 52n,
    delete: 1n << 53n,
  },
  // Integracao — canais de venda / integrações (Flutter `integracao`).
  // Already in use by `packages/schemas/src/integracao.ts` since launch;
  // registered here so the next free byte is unambiguous.
  integracao: {
    read: 1n << 56n,
    write: 1n << 57n,
    delete: 1n << 58n,
  },
  // Estoque — depósitos e operações de inventário.
  estoque: {
    read: 1n << 64n,
    write: 1n << 65n,
    delete: 1n << 66n,
  },
  // Fiscal — operações fiscais (CFOPs, configurações tributárias).
  fiscal: {
    read: 1n << 72n,
    write: 1n << 73n,
    delete: 1n << 74n,
  },
  // ImpostoProduto — `produtos/{produtoId}/imposto` subcollection. Bits 75-77
  // share the fiscal byte; mirrored by `impostoProdutoMeta` in
  // packages/schemas/src/impostoProduto.ts.
  impostoProduto: {
    read: 1n << 75n,
    write: 1n << 76n,
    delete: 1n << 77n,
  },
  // Arquivo — file/storage metadata (`arquivos` collection): product images +
  // derivatives, videos, attachments, chat media. Cross-domain, so it gets its
  // own byte. Mirrored by `arquivoMeta` in packages/schemas/src/storage/arquivo.ts.
  // NOTE: the legacy `storage.rules` gates Storage by the old `q1` claim, and
  // migrated users carry claims minted under that layout; this bit is consumed
  // by the Next side (data layer + the future rules phase), not by the live
  // rules yet.
  arquivo: {
    read: 1n << 80n,
    write: 1n << 81n,
    delete: 1n << 82n,
  },
  // Frete — freight integration configs (`int_frete` collection, /logistica
  // screens) and freight actions on pedidos (quote / label / tracking).
  // Mirrored by `intFreteMeta` in packages/schemas/src/intFrete.ts. The old
  // Flutter app gated this with its dedicated 'F0' perm code; the BigInt
  // claim system is independent of those codes, so this is a fresh domain.
  frete: {
    read: 1n << 88n,
    write: 1n << 89n,
    delete: 1n << 90n,
  },
  // ImpostoCategoria — `categorias/{categoriaId}/imposto` subcollection
  // (legacy Flutter wire name). Historically mis-assigned to bits 78-80: bit 80 belongs to
  // arquivo.read, and 78-79 sit in the fiscal byte but were never grantable
  // (absent from this map, the cargo editor and ALL_PERMS), so relocating to
  // byte 12 has no migration cost. Bits 78-79 stay unused; do not reuse them
  // without auditing stored cargo bitmasks first. Mirrored by
  // `impostoCategoriaMeta` in packages/schemas/src/impostoCategoria.ts.
  impostoCategoria: {
    read: 1n << 96n,
    write: 1n << 97n,
    delete: 1n << 98n,
  },
  // RegraImposto — `operacao/{operacaoId}/regras` subcollection (legacy
  // Flutter wire name). Historically mis-assigned to bits 81-83 (81-82 belong to arquivo
  // write/delete); never grantable, relocated alongside impostoCategoria in
  // byte 12. Mirrored by `regraImpostoMeta` in
  // packages/schemas/src/regraImposto.ts.
  regraImposto: {
    read: 1n << 99n,
    write: 1n << 100n,
    delete: 1n << 101n,
  },
  // CMUN — the CEP-faixa → IBGE município table (legacy Flutter `TabelaoCmun`,
  // permCode 'c2'). Byte 13; bits 102-103 are the spare tail of byte 12 and
  // cannot hold a three-bit domain. Reads stay grantable: a collection with no
  // readable rules block is denied outright. ⚠️ The original reason — the legacy
  // Flutter app querying this collection alongside us — is void (no dual run,
  // root `CLAUDE.md` rule 8); the grant is harmless (the table is public CEP →
  // IBGE data) but no longer load-bearing. Writes are `serverOwned` — the
  // ruleset denies every client write regardless of this bit; it exists so the
  // generator has a single PERM bit per action, which `claims-map.ts` requires.
  // Mirrored by `cmunMeta` in packages/schemas/src/cmun.ts.
  cmun: {
    read: 1n << 104n,
    write: 1n << 105n,
    delete: 1n << 106n,
  },
  // IncidenteResolucao — resolving a marketplace incidente ON THE PROVIDER:
  // refund, partial refund, allow-return, open-dispute. Byte 13's remaining
  // triple (107-109 sit entirely inside it, no straddle).
  //
  // ⚠️ **A dedicated domain, deliberately, and it gates NO Firestore path.**
  // These actions move money and are irreversible on the provider's side, while
  // the incidente itself is ordinary pedido business history — so gating them on
  // `pedido.write` would hand a refund button to everyone who can fix a shipping
  // address. There is no `*Meta` referencing these bits and there must not be:
  // they are checked server-side by the channel backend's `verifyCaller`, which
  // reads the `permissions` claim directly, so no ruleset changes when they are
  // added or granted.
  //
  // ⚠️ `read` is not free either — it reaches ML's API on the seller's account
  // and returns buyer-visible claim detail. No `delete`: there is nothing to
  // delete (the provider owns claim state), and `configuracoes` is the existing
  // precedent for a two-action domain.
  //
  // ⚠️ **Fail-closed for cargo-derived claims, NOT for superusers — and the
  // money-moving half is the one that differs.** Two populations:
  //
  //  - **cargo-derived** (`permissionsForUser` → the stored bitmask): genuinely
  //    fail-closed. The bits are new, so no stored mask carries them until a
  //    cargo grants them and claims are re-minted (#173).
  //  - **superusers**: already granted, retroactively, by construction.
  //    `SUPERUSER_MASK` is `(1n << 128n) - 1n` — an all-ones SENTINEL, not an
  //    enumeration of PERM (`packages/schemas/src/usuario.ts:74`) — and
  //    `verifyCaller` does a plain `hasPerm` with no superuser branch. Since
  //    `108n < 128n`, every account already carrying that claim holds
  //    `incidenteResolucao.write` the instant the route lands: no cargo edit, no
  //    re-mint, no #173.
  //
  // `grant-all-perms` sits between the two and shows the distinction: `ALL_PERMS`
  // is DERIVED from `PERM` at mint time, so an e2e user minted before this commit
  // does not hold the bits and one minted after does.
  //
  // ⚠️ So "a new money-moving verb does not arrive switched on" is true for
  // ordinary operators and false for superusers. Whoever ships the route should
  // know which population they are testing with.
  incidenteResolucao: {
    read: 1n << 107n,
    write: 1n << 108n,
  },
  // Webchat — embeddable widget configs (`webchat` collection, /canais/webchat).
  // Byte 14, the next free byte after `incidenteResolucao` (bits 107-108,
  // byte 13). Mirrored by `webchatMeta` in packages/schemas/src/webchat.ts.
  webchat: {
    read: 1n << 112n,
    write: 1n << 113n,
    delete: 1n << 114n,
  },
} as const;

export function hasPerm(grantedClaim: string | undefined, requiredBit: bigint): boolean {
  if (!grantedClaim) return false;
  try {
    return (BigInt(grantedClaim) & requiredBit) === requiredBit;
  } catch (err) {
    if (err instanceof SyntaxError) {
      return false;
    }
    throw err;
  }
}
