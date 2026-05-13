# packages/integrations/

Domain integration packages land here in **Phase 5**: NFe, Mercado Pago, Mercado Livre, Shopee, Amazon SP-API, Magalu, Loja Integrada, Facebook, WhatsApp Cloud API, Melhor Envio.

Each is its own workspace package matching `packages/integrations/<channel>/package.json`. They implement the contracts from `@delfrance/core/plugins` and are registered at app boot via the plugin registry.

## Layout (planned)

```
packages/integrations/
├── nfe/                       (built on xml-crypto + soap + XSD types from spike)
├── mercado-livre/             (OAuth + REST client)
├── shopee/
├── amazon-sp-api/             (wraps `amazon-sp-api` npm)
├── magalu/
├── loja-integrada/
├── facebook/
├── mercado-pago/              (wraps `mercadopago` SDK)
├── freight-br/                (Melhor Envio etc.)
└── whatsapp-cloud-api/
```

Until Phase 5, this directory is intentionally empty.
