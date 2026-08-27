# chat — questions, post-sale messages, outbound

Two inbound threads (pre-sale _perguntas_ and post-sale _mensagens_) landing in
the unified inbox, plus the outbound send path. The two inbound halves are
deliberately symmetric — `questionMapping.ts` and `orderMessageMapping.ts`
mirror each other, which is why the `orderMessage*` files live here rather than
in `pedidos/` despite the filename prefix.

⚠️ **Coupled with `claims/` in both directions** — see that folder's README.

**Perguntas (pre-sale)**

- `questionImport.ts` — the `questions` topic handler.
- `questionIds.ts` — byte-exact legacy ids for question conversas/mensagens.
- `questionMapping.ts` — pure conversa/mensagem builders.

**Mensagens (post-sale)**

- `orderMessageImport.ts` — the `messages` topic handler. Tier-2 guarded in
  **ms**; the watermark is `max(newest message, conversation_status.status_date)`,
  not the message time alone.
- `orderMessageIds.ts` — byte-exact legacy ids for post-sale threads.
- `orderMessageMapping.ts` — pure builders (ms timestamps). Also owns
  `postSaleRecipientUserId`, the OUTBOUND recipient derivation — which is the
  concrete reason this "pure builders" module is shared by both directions.
- `orderMessageAttachments.ts` — the `mlped` sibling of
  `claims/claimAttachments.ts`.

**Outbound**

- `chatOutbound.ts` — answering a pergunta, replying on a post-sale thread, or
  responding on a claim. ⚠️ **HTTP, not a Firestore trigger, and that is the
  design**: ML refusals are terminal and operator-actionable, so a refusal is a
  409 the composer renders verbatim. ⚠️ **Send first, write second** — a mensagem
  written before the ML call leaves a phantom reply when ML refuses.
  ⚠️ **The post-sale recipient is derived per thread, never a constant** — ML's
  agent rollout is progressive, so the agent is right on a migrated thread and the
  real buyer id on one it has not migrated, and the two mistakes fail differently
  (a hard 400 vs a 200 that reaches nobody). Nothing resolves ⇒ 409, never a guess.
- `mensagemProvisoria.ts` — the provisional outbound bubble and its
  de-duplication once ML echoes the message back.
