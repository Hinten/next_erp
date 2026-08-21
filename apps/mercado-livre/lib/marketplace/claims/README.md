# claims — claims & mediations

One ML claim becomes an Incidente on the pedido, plus a chat Conversa and its
Mensagens, at the **byte-exact legacy doc ids** so re-processing a claim the
Flutter app already imported updates those docs instead of forking them
(Step 14 + #768).

⚠️ **The Incidente and the Conversa are gated differently, and that asymmetry is
the design.** The incidente is pedido business history and is written for every
claim; the conversa is a surface an attendant answers in, so it is created and
kept answerable only while a `send_message_to_*` action survives.

⚠️ **Coupled with `chat/` in both directions** — `chat/` imports `claimIds.ts`
and `claimActionability.ts`; this folder imports `chat/mensagemProvisoria.ts`.
That is a property of today's code, not an accident of this layout.

- `claimImport.ts` — the `claims` topic handler. Tier-2 guarded in **ms** on
  `ultimaModificacaoIntegracao`; the gate is `>=`, not `>`.
- `claimMapping.ts` — pure Incidente / Conversa / Mensagem builders.
- `claimIds.ts` — deterministic digest ids. **Also used by `chat/`** for
  questions and post-sale messages.
- `claimCliente.ts` — stamps `idMercadoLivre` on the cliente when absent, so the
  cliente a pre-sale question created and the one the order created converge.
  Fill-only-when-absent; a disagreeing stored id is logged for a human.
- `claimAttachments.ts` — downloads and caches a claim message's attachment.
- `claimActionability.ts` — pure: what the seller can still do on a claim.
