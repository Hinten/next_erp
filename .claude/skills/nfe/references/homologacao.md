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
  `NF_CERT_BASE64` / `NF_CERT_PASSWORD` secrets.

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
