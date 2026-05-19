# Contingency & "NF-e pendentes de retorno"

When SEFAZ or the network is unavailable, the issuer cannot get an Autorização
de Uso the normal way. Contingency modes let the goods move anyway. The
emission mode is the `tpEmis` field (B22), and `tpEmis` is part of the chave.

## `tpEmis` values

| tpEmis | Mode | Authorizer | Notes |
|---:|---|---|---|
| 1 | Normal | SEFAZ origem | Standard path |
| 2 | FS-IA (Formulário de Segurança) | SEFAZ origem (later) | Legacy stock only |
| 4 | EPEC | Ambiente Nacional (RFB) | Prior contingency event |
| 5 | FS-DA (Formulário de Segurança DA) | SEFAZ origem (later) | DANFE on secure form |
| 6 | SVC-AN | SEFAZ Virtual Ambiente Nacional | |
| 7 | SVC-RS | SEFAZ Virtual RS | |

Contingency NF-e must carry `dhCont` (start datetime) and `xJust`
(justification) — both also printed on the DANFE.

## SVC — SEFAZ Virtual de Contingência

SVC is activated by the issuer's home SEFAZ when its normal environment is
down. Each state is bound to one SVC (SVC-AN or SVC-RS, per Ato COTEPE 39/2012).
Validation matrix — a `tpEmis` is only accepted by its matching environment:

| tpEmis | Normal | SVC-AN | SVC-RS |
|---:|:--:|:--:|:--:|
| 1, 2, 4, 5 | OK | — | — |
| 6 (SVC-AN) | — | OK | — |
| 7 (SVC-RS) | — | — | OK |

SVC offers Autorização, RetAutorização, Cancelamento, ConsultaProtocolo,
StatusServico. It does **not** offer Inutilização or CCe. SVC status codes:
`107` SVC em operação, `113` SVC em desativação, `114` SVC desabilitada.
SVC-authorized NF-e do **not** need re-transmission to the home SEFAZ.

## EPEC (tpEmis=4)

Evento Prévio de Emissão em Contingência: register a summary event for the NF-e
(`UF/CNPJ/IE`, chave, destinatário, totals) via `RecepcaoEvento` at the
Ambiente Nacional. Once the event is authorized (`protocolo 891...`), the DANFE
may be printed on plain paper. After the outage, the **full NF-e must still be
transmitted** to the home SEFAZ — with the **same chave** as the EPEC.

## NF-e pendentes de retorno (the anti-loss problem)

When a failure occurs, NF-e may have been transmitted with **no result
obtained**. The MOC states plainly:

> "Caso a falha tenha ocorrido na SEFAZ origem, ao retornar à operação normal,
> é possível que as NF-e em processamento sejam perdidas."

**SEFAZ can lose in-flight NF-e.** Each pendente de retorno is in one of:
not received / queued / processing / already processed. After recovery, for
each one:

1. `consSitNFe(chave)` to find its real situation.
2. **Authorized** → keep it; if the operation was instead covered by a
   contingency NF-e, **cancel** the authorized one.
3. **Not authorized / not found** → **inutilizar** that número (it will never
   be used) — see `eventos.md`.

### Renumbering rule (important, easy to get wrong)

- A NF-e **emitted in contingency** that gets **rejected** → regenerate with the
  **same número and série** (provided tax variables, parties and dates are
  unchanged).
- A NF-e emitted **normally** (`tpEmis=1`) whose result you never obtained and
  you decide to reissue in contingency → it must get a **new número**. Reusing
  the número risks a duplicidade if the original was actually authorized.

The vertical-slice implementation only does `tpEmis=1`; contingency modes are a
later phase, but the **pendente-de-retorno recovery loop** (poll + `consSitNFe`)
is built from day one because lost NF-e happen even in normal emission.
