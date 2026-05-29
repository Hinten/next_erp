# Homologação (SEFAZ test environment)

SEFAZ keeps two environments. **Homologação** (`tpAmb=2`) is for testing;
**Produção** (`tpAmb=1`) issues legally valid documents. Homologação is always
available for every UF, including the SVC environments.

## Rules that differ in homologação

- **`tpAmb=2`** on every message (`enviNFe`, `consReciNFe`, `consSitNFe`,
  events, `inutNFe`). A mismatch between the NF-e's `tpAmb` and the service's
  environment is rejection **252**.
- **Mandatory recipient name** — in homologação the destinatário's `xNome`
  **must** be exactly:

  ```
  NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL
  ```

  (The DANFE also carries a "sem valor fiscal" watermark.) Issuing a homologação
  NF-e with a real recipient name is rejected.
- NF-e issued here have **no fiscal value** — they are throwaway test data and
  the issuer may generate them freely.
- The certificate is real (a valid ICP-Brasil A1/A3); only the *environment*
  is test. The CI uses a dedicated homologação test certificate stored as the
  `NFE_CERT_BASE64` / `NFE_CERT_PASSWORD` secrets (with the `E` — runtime env
  vars, `.env.local`, and GitHub Actions secrets all use the same names).

## Endpoints

- Homologação web-service list:
  `http://hom.nfe.fazenda.gov.br/portal/webServices.aspx`
- Produção web-service list:
  `https://www.nfe.fazenda.gov.br/portal/webServices.aspx`
- The WSDL of any service is its URL + `?WSDL`.
- The endpoint set differs per UF and per `tpEmis` (normal vs SVC). Keep
  homologação and produção URL tables separate (mirror the old Flutter
  `enderecos.dart` / `enderecos_homologacao.dart`).

## Testing discipline

- A homologação round-trip is a real network call to SEFAZ — keep it out of the
  fast unit suite. Run it in the dedicated `ci-nfe.yml` `nfe-homologacao` job,
  in env-gated `*.homologacao.test.ts` files.
- Respect rate limits even in homologação — looping a request still triggers
  `656 Consumo Indevido`.
- A good homologação smoke sequence: `consStatServ` (assert 107) → emit one
  fixture NF-e → poll → assert `cStat=100` → emit the *same* NF-e again →
  assert the duplicidade recovery resolves to the original protocol.

## RTC (NT 2025.002) — cronograma de homologação

A obrigatoriedade dos campos IBS/CBS é faseada por ambiente:

| Data | Homologação | Produção |
|---|---|---|
| Out/2025–Jun/2026 | IBS/CBS facultativos. Se preenchidos, RVs aplicadas. | IBS/CBS facultativos; sem valor jurídico até 01/01/2026; com valor jurídico depois. |
| **01/07/2026** | **IBS/CBS obrigatórios** em todos os emitentes CRT=3. RV UB12-10 entra em vigor. | Ainda facultativos. |
| **03/08/2026** | Obrigatórios desde 01/07. | **IBS/CBS obrigatórios** (CRT=3). RV UB12-10 em produção. |
| **04/01/2027** | Obrigatoriedade estende-se a CRT=1/2/4 e Tributação Monofásica de Combustíveis. | Mesma data. |

Implicação para os testes em homologação:

- **Antes de 01/07/2026** os fixtures podem omitir o Grupo UB sem rejeição.
- **A partir de 01/07/2026** os fixtures precisam emitir Grupo UB + W03,
  ou usar uma cClassTrib que dispense (raras), ou ser de devolução
  referenciando NF-e pré-2026.
- O ambiente de homologação **antecipa em 1 mês** o que vai para
  produção, então é seguro usá-lo para validar prontidão antes da
  data-limite de produção.

Para fixtures de teste de RTC, consultar `rtc-ibs-cbs-is.md §"Notas para
implementação"` e a tabela cClassTrib (Anexo III do NT) no Portal Nacional.
