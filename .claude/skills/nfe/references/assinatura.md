# Digital signature (XMLDSig)

NF-e messages are signed with an **XML Digital Signature** in `Enveloped` form,
per `http://www.w3.org/TR/xmldsig-core/`. SEFAZ validates a strict subset.

## What gets signed

| Message                     | Signed element | `Id` attribute                              | `Reference URI` |
| --------------------------- | -------------- | ------------------------------------------- | --------------- |
| NF-e                        | `<infNFe>`     | `NFe` + chave (44)                          | `#NFe<chave>`   |
| Cancelamento / CCe / events | `<infEvento>`  | `ID` + tpEvento + chNFe + nSeqEvento        | `#ID...`        |
| Inutilização                | `<infInut>`    | `ID` + cUF+ano+CNPJ+mod+serie+nNFIni+nNFFin | `#ID...`        |

Each NF-e in a lote is signed **individually**. The `<Signature>` is a sibling
of `<infNFe>`, placed **immediately after it**, inside the `<NFe>` element.

## Algorithms (fixed — do not vary)

| Step                   | Algorithm URI                                           |
| ---------------------- | ------------------------------------------------------- |
| CanonicalizationMethod | `http://www.w3.org/TR/2001/REC-xml-c14n-20010315`       |
| SignatureMethod        | `http://www.w3.org/2000/09/xmldsig#rsa-sha1`            |
| Transform 1            | `http://www.w3.org/2000/09/xmldsig#enveloped-signature` |
| Transform 2            | `http://www.w3.org/TR/2001/REC-xml-c14n-20010315`       |
| DigestMethod           | `http://www.w3.org/2000/09/xmldsig#sha1`                |

The two `<Transform>` elements appear in that order (enveloped, then C14N).

## Structure

```xml
<NFe xmlns="http://www.portalfiscal.inf.br/nfe">
  <infNFe Id="NFe35..." versao="4.00"> ... </infNFe>
  <Signature xmlns="http://www.w3.org/2000/09/xmldsig#">
    <SignedInfo>
      <CanonicalizationMethod Algorithm="...REC-xml-c14n-20010315"/>
      <SignatureMethod Algorithm="...xmldsig#rsa-sha1"/>
      <Reference URI="#NFe35...">
        <Transforms>
          <Transform Algorithm="...xmldsig#enveloped-signature"/>
          <Transform Algorithm="...REC-xml-c14n-20010315"/>
        </Transforms>
        <DigestMethod Algorithm="...xmldsig#sha1"/>
        <DigestValue>...base64 SHA-1...</DigestValue>
      </Reference>
    </SignedInfo>
    <SignatureValue>...</SignatureValue>
    <KeyInfo>
      <X509Data>
        <X509Certificate>...end-entity cert, base64...</X509Certificate>
      </X509Data>
    </KeyInfo>
  </Signature>
</NFe>
```

## KeyInfo rules

- Include **only** `<X509Certificate>` — the signer's end-entity certificate in
  base64. **EndCertOnly**: do not include the CA chain.
- **Must NOT include**: `<X509SubjectName>`, `<X509IssuerSerial>`,
  `<X509IssuerName>`, `<X509SerialNumber>`, `<X509SKI>`.
- **Avoid**: `<KeyValue>`, `<RSAKeyValue>`, `<Modulus>`, `<Exponent>` — SEFAZ
  derives the public key from the certificate.
- Do **not** send a CRL/LCR — SEFAZ builds and validates the revocation chain.

## Certificate

- **ICP-Brasil**, type **A1** (file, `.pfx`/`.p12`) or **A3** (token/card).
- **e-CNPJ**: CNPJ in `OtherName` extension `OID = 2.16.76.1.3.3`.
- **e-CPF**: CPF in `OtherName` extension `OID = 2.16.76.1.3.1`.
- The CNPJ/CPF in the signing certificate must belong to an establishment of
  the NF-e issuer; for e-CPF it must equal the issuer's CPF.
- The cert must have key usage permitting **digital signature**.
- A separate cert (or the same one) is used for the **TLS transport** layer; it
  needs the _Client Authentication_ extended key usage and carries the CNPJ of
  whoever transmits (not necessarily the issuer).

## Common failures

- **Whitespace / formatting between tags** changes the digest → invalid
  signature. Generate the XML with no line breaks, tabs, or indentation.
- Signing `<NFe>` instead of `<infNFe>` → rejection.
- Re-serializing the XML after signing (a parser may reorder attributes or add
  whitespace) breaks the signature. Sign the final byte stream and do not
  touch it afterwards.
- Wrap signing errors in a specific error class (e.g. `NFeSignatureError`) —
  never a generic `catch` (repo rule).
