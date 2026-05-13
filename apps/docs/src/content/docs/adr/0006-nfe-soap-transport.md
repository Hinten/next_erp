---
title: 0006 — NFe SOAP transport
description: SOAP client choice for SEFAZ NFe webservice calls.
---

## Context

SEFAZ NFe webservices are SOAP 1.2 with WSDL definitions per UF (state). The Flutter implementation uses a custom SOAP client. The TS rewrite needs a SOAP client capable of:

- Sending TLS-mutual-authenticated requests (NFe cert at the transport layer in some operations).
- Generating SOAP envelopes that SEFAZ accepts (small differences in `xmlns` ordering have caused 215 / 225 errors).
- Parsing SEFAZ responses (often returns mixed CDATA-wrapped XML).

## Candidates

- `soap` (npm) — the canonical Node SOAP client; mature; supports WSDL fetching, custom HTTP agents (for mTLS), header customization.
- `strong-soap` — fork of `soap` with extra features; investigate if it adds anything we need.
- Hand-rolled HTTP + XML — fallback if the libraries get in the way.

## Decision criteria

1. Submits an NFe sync request to SEFAZ homologação and parses the response.
2. Supports mTLS via Node `https.Agent` (or `undici.Agent` if undici-based).
3. Doesn't fight the namespace requirements SEFAZ enforces.

## Outcome

*To be filled by spike: send an `NFeAutorizacao4.NFeAutorizacaoLote` against SEFAZ-SP homologação and confirm protocol.*

## Status

Open.
