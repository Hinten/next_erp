---
"@delfrance/nfe-app": patch
---

One live run per NF-e (#1675). While an emit's SOAP call was in flight its nfev4 anchor looked exactly like a #396 crash-window doc, so a second emit — a re-click, a second tab, the reprint path's 30 s deadline, the sweep racing an operator — retransmitted the stored bytes over the live run, and both runs' outcome writes were last-writer-wins (a late 108/656 could overwrite the other run's result; a batch could persist a second chave for one número).

- **Send reservation.** Every claim that is about to call SEFAZ stamps `proximaConsultaEm` at `now + ENVIO_EM_CURSO_MS` (360 s: the 300 s App Hosting ceiling + 60 s) on the doc it sends. A second emit, a batch member, the manual verify and the sweep all leave a reserved doc alone; an emit is answered `200 { reused: true, estado: '1'|'2' }` with no SOAP call. The run's own outcome write releases it; a transport error does not (the reservation expires, after which a crashed run's anchor is retransmitted as before). A re-emit of a paced no-receipt anchor now waits for its pacing too — up to an hour after a 656.
- **The idLote owns the run's writes.** The main sync outcome, the async 103 hand-off, the EPEC event and the pós-EPEC 468 are written only while the doc still carries the run's idLote; a superseded run reports the live doc (`reused: true`) and enqueues nothing.
- **Consult writes are owned by their read.** The manual verify, `consultarPedido` and the sweep's no-nRec consult refuse to write a doc changed since they read it (its `updateTime`) or under a live send.
- **Batch 4b** writes its anchor only while the doc still carries the chunk's idLote — a single emit that claimed the doc in between wins, and the member is dropped from the lote.
- **The pós-EPEC transmission claims the doc** (idLote + reservation) before sending, so an operator emit and the sweep can no longer both transmit it.

No new field, no rules change, no migration. Deploy the App Hosting backend and the `nfe` Functions codebase in the same window.
