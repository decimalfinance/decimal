# Provenance: x402 / MPP / AP2 Research Brief

Prepared: April 23, 2026

This file maps the main claims in `deep-research-x402-mpp-ap2-agent-payments-2026.md` to source material.

## Primary sources used

### x402

- x402 docs home  
  https://docs.x402.org/
- x402 facilitator docs  
  https://docs.x402.org/core-concepts/facilitator
- x402 network and token support  
  https://docs.x402.org/core-concepts/network-and-token-support
- x402 FAQ  
  https://docs.x402.org/faq
- x402 ecosystem  
  https://www.x402.org/ecosystem
- Base docs: payments and transactions for AI agents  
  https://docs.base.org/ai-agents/core-concepts/payments-and-transactions
- Coinbase x402 launch page  
  https://www.coinbase.com/developer-platform/discover/launches/x402

### MPP / PaymentAuth / Stripe machine payments

- Machine Payments Protocol specs index  
  https://paymentauth.org/
- Payment HTTP Authentication Scheme draft  
  https://paymentauth.org/draft-httpauth-payment-00.html
- Solana charge intent draft  
  https://paymentauth.org/draft-solana-charge-00.html
- Tempo session intent draft  
  https://paymentauth.org/draft-tempo-session-00.html
- Payment discovery draft  
  https://paymentauth.org/draft-payment-discovery-00.html
- JSON-RPC & MCP transport draft  
  https://paymentauth.org/draft-payment-transport-mcp-00.html
- Stripe machine payments docs  
  https://docs.stripe.com/payments/machine
- Stripe blog index / MPP launch entry  
  https://stripe.com/blog
- Stripe blog: supporting additional payment methods for agentic commerce  
  https://stripe.com/blog/supporting-additional-payment-methods-for-agentic-commerce

### AP2

- AP2 docs home  
  https://ap2-protocol.org/
- AP2 specification  
  https://ap2-protocol.org/specification/
- AP2 and x402  
  https://ap2-protocol.org/topics/ap2-and-x402/
- Google Cloud launch post for AP2  
  https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol

## Claim map

### x402 is an HTTP-402-based payment standard for APIs/content

Supported by:

- x402 docs home
- Base docs on AI-agent payments
- Coinbase launch page

### x402’s typical flow is request -> 402 challenge -> payment payload -> verify -> settle -> resource

Supported by:

- x402 docs home
- x402 facilitator docs

### x402 facilitators verify payloads and settle onchain for sellers

Supported by:

- x402 facilitator docs
- x402 FAQ

### Solana duplicate-settlement race handling is a real implementation concern in x402

Supported by:

- x402 facilitator docs

### x402 supports multiple chains including Solana and multiple token standards

Supported by:

- x402 network and token support

### x402 already has an active ecosystem of facilitators, infra providers, clients, and paid services

Supported by:

- x402 ecosystem

### MPP is broader than a single rail and consists of a payment-authentication spec family

Supported by:

- paymentauth.org index
- Payment HTTP Authentication Scheme draft

### MPP standardizes a payment auth scheme using HTTP 402 and registered payment methods/intents

Supported by:

- Payment HTTP Authentication Scheme draft

### MPP includes both one-shot charges and session-based flows

Supported by:

- Payment HTTP Authentication Scheme draft
- Tempo session intent draft

### The Tempo session intent is designed for incremental, voucher-based payments suited to metered services

Supported by:

- Tempo session intent draft

### The session model explicitly targets streaming / variable-cost flows like LLM token streaming

Supported by:

- Tempo session intent draft

### MPP also defines JSON-RPC and MCP transport conventions for tool/resource calls

Supported by:

- JSON-RPC & MCP transport draft

### Discovery exists in MPP, but the 402 challenge remains authoritative for security

Supported by:

- payment discovery draft

### Stripe commercially productizes both x402 and MPP under machine payments

Supported by:

- Stripe machine payments docs
- Stripe blog MPP launch entry

### Stripe positions MPP as usable through PaymentIntents API and existing merchant stack

Supported by:

- Stripe blog MPP launch entry
- Stripe machine payments docs

### Stripe’s broader agentic-commerce work includes shared payment tokens and adjacent adoption by businesses like Etsy and URBN

Supported by:

- Stripe blog: supporting additional payment methods for agentic commerce

### AP2 is an authorization/trust/accountability framework for agent-led payments rather than a raw payment rail

Supported by:

- AP2 docs home
- AP2 specification
- Google Cloud AP2 launch post

### AP2 is built around Verifiable Digital Credentials including Intent Mandate, Cart Mandate, and Payment Mandate

Supported by:

- AP2 docs home
- AP2 specification

### AP2 is concerned with authorization, authenticity, and accountability

Supported by:

- AP2 docs home
- Google Cloud AP2 launch post

### AP2 distinguishes between human-present and human-not-present transaction modes

Supported by:

- AP2 docs home
- AP2 specification
- Google Cloud AP2 launch post

### AP2 is payment-method agnostic and aims to support cards first, with push payments/digital currencies on the roadmap

Supported by:

- AP2 docs home
- AP2 specification
- AP2 and x402

### AP2 and x402 are explicitly described by the official docs as complementary

Supported by:

- AP2 and x402

### AP2 has significant institutional support from Google Cloud and a wide set of payments/web3 partners

Supported by:

- Google Cloud AP2 launch post
- AP2 docs home

## Notes on interpretation

The comparative framing in the brief is an interpretive synthesis built from the primary sources above. In particular:

- "x402 = simple request/response paywall rail"
- "MPP = broader machine-billing substrate"
- "AP2 = trust/authorization layer"

These are not single-sentence quotes from any one source. They are the cleanest architectural reading of the official materials.
