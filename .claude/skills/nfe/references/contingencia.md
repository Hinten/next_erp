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

SVC services (MOC 7.0 Anexo III §2.1.3.4), with their per-nota scoping:

- **Autorização** — only while the SVC is activated for the home SEFAZ.
- **RetAutorização** — "sempre disponível" for lotes sent to the SVC.
- **Cancelamento (110111)** — "sempre disponível **somente para as NF-e
  autorizadas pela própria SVC**". Cancelling a normal-environment NF-e during
  the outage must be held ("represada") for the home SEFAZ afterwards.
- **ConsultaProtocolo** — same scoping: only SVC-authorized NF-e.
- **StatusServico** — always.
- **CC-e and other eventos** — "não será disponibilizado para atendimento pela
  SVC". This restricts the **webservice**, not the nota: authorized documents
  are *"automaticamente compartilhados entre o ambiente normal de autorização
  e o ambiente da SVC (e vice-versa)"*, so an SVC-authorized NF-e **can**
  receive a CC-e — **send it to the home SEFAZ** RecepcaoEvento.
- **Inutilização** — not offered; hold for the home SEFAZ.

SVC status codes: `107` SVC em operação, `113` SVC em desativação, `114` SVC
desabilitada. SVC-authorized NF-e do **not** need re-transmission to the home
SEFAZ (the sharing above is automatic).

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

## NT 2025.001 — atraso na emissão (rule change)

Desde 03/11/2025 (em produção), o limite de "autorização fora de prazo" caiu
de **30 dias** para **7 dias**:

- 0–7 dias `(dhEmi → dhAutorização)` → `cStat=100`
- 7–30 dias → `cStat=150` ("Autorizado fora de prazo") — ainda autoriza, mas
  registra atraso
- **>30 dias** → rejeição **salvo** se emitido em contingência (`tpEmis=2, 4, 5`),
  caso em que ainda aceita com cStat=150.

Implicação para contingência: se SEFAZ origem ficou indisponível por mais
de 7 dias e o cliente não emitiu em contingência, ao retomar o normal
qualquer NF-e fora de prazo vem com cStat=150. Se ficou indisponível por
mais de 30 dias e o cliente emitiu em modo normal (`tpEmis=1`), as NF-e
serão rejeitadas — a contingência **tinha** que ter sido acionada antes
do limite de 30 dias.

## Fonte para esta documentação

MOC 7.0 — Anexo III — Manual de Contingência NF-e (Nov/2020), committed
em `references/sources/moc7/anexo-iii-contingencia.pdf`. NT 2025.001
v1.03 para o atraso de 7 dias.
