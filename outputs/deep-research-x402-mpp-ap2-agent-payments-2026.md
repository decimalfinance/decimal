# Deep Research: x402, MPP, and AP2 for Agent Payments

Prepared: April 23, 2026

## Scope

This brief focuses on three payment-layer efforts that matter for agent commerce:

- `x402`
- `MPP` (Machine Payments Protocol)
- `AP2` (Agent Payments Protocol)

The goal is not to describe them at a surface level. The goal is to understand:

- what each protocol actually is
- what problem it solves
- how it works mechanically
- who is backing or building on it
- where each one stops being sufficient
- what this implies for a product that wants to make agent billing dead simple for businesses

The source set for this brief is deliberately biased toward official documentation, official specifications, and official launch/blog material.

## Executive Summary

The three systems sit at different layers.

- `x402` is the simplest machine-payment rail. It turns HTTP `402 Payment Required` into a practical API paywall. It is best understood as a direct request-response payment flow for paid endpoints.
- `MPP` is a broader payment-authentication stack for machine payments. It includes a core HTTP payment auth scheme, discovery, payment-method specifications, a JSON-RPC/MCP transport, and a session model for repeated or streaming charges. It is designed to cover both one-shot charges and higher-frequency machine billing.
- `AP2` is not a payment rail in the same sense. It is a trust and authorization framework for agent-led payments. Its core concern is proving that the agent was authorized, that the merchant can trust the request, and that disputes have a cryptographic trail.

The clean mental model is:

- `x402` answers: "How does a paid API request happen over HTTP?"
- `MPP` answers: "How do we standardize machine payment challenges, one-shot charges, sessions, and non-HTTP transports like MCP/JSON-RPC?"
- `AP2` answers: "How can merchants, payment providers, and users trust that an agent was actually allowed to buy this?"

This means the product opportunity is not to build yet another protocol. The product opportunity is to build merchant software that composes these layers:

- use `x402` or `MPP` as the payment/authentication rail
- use `AP2` where higher-trust delegated purchasing matters
- provide business-facing abstractions on top:
  - plans
  - entitlements
  - usage metering
  - payment proofs
  - reconciliation
  - exceptions
  - settlement visibility

## 1. x402

### What x402 is

x402 is an open payment standard for charging for HTTP resources using the `402 Payment Required` status code. The official docs position it as a way to let services monetize APIs and content directly over HTTP, without requiring accounts, sessions, or traditional credential setup. It is explicitly aimed at machine-to-machine and agent-to-service commerce.  
Sources: [x402 docs home](https://docs.x402.org/), [Base AI agent payments docs](https://docs.base.org/ai-agents/core-concepts/payments-and-transactions), [Coinbase launch note](https://www.coinbase.com/developer-platform/discover/launches/x402)

### What problem x402 solves

x402 solves the narrow but important problem of turning a paid API or paid web resource into a standard request-response interaction:

- client requests resource
- server says payment is required
- client pays
- server verifies and settles
- server returns the resource

This removes:

- account creation
- API-key provisioning as the only access model
- separate billing setup before first use

It is especially strong for:

- pay-per-request APIs
- tool invocations by agents
- paid MCP tools
- paywalled content
- simple machine-initiated purchases where the price is known before fulfillment

### How x402 works

The official x402 flow is straightforward:

1. Client requests a resource.
2. Server returns `402 Payment Required` with encoded payment requirements.
3. Client picks an accepted payment detail and creates a payment payload.
4. Client retries with the payment payload.
5. Server verifies locally or through a facilitator.
6. Server settles locally or through a facilitator.
7. On success, server returns the requested resource with a payment response/receipt payload.

The most important operational component is the `facilitator`.

The facilitator is optional but strongly recommended. It:

- verifies payment payloads
- settles validated payments onchain
- returns verification and settlement results to the seller

This matters because it means a seller can adopt x402 without running full blockchain verification and settlement logic inside the product server.  
Source: [x402 facilitator docs](https://docs.x402.org/core-concepts/facilitator)

### Networks and assets

x402 is network-agnostic. The official docs list support patterns for:

- EVM networks via CAIP-2 identifiers
- Solana
- Algorand
- Stellar
- Aptos

On Solana, the docs describe SPL / Token-2022 transfer support.  
Source: [x402 network and token support](https://docs.x402.org/core-concepts/network-and-token-support)

### Security and operating details that matter

The Solana flow has an implementation-specific gotcha that is easy to miss but important for any merchant system: duplicate settlement races. The facilitator docs call out that on Solana, repeated submissions of the same payment transaction before confirmation can look successful from RPC, so facilitators must implement short-lived duplicate detection. x402’s SVM helper packages ship a `SettlementCache` for this.  
Source: [x402 facilitator docs](https://docs.x402.org/core-concepts/facilitator)

This is a useful signal: x402 is simple at the API layer, but real merchant use still requires careful settlement semantics.

### Who is building on x402

The official x402 ecosystem page shows that x402 is already attracting a meaningful number of clients, facilitators, gateways, and service providers. Categories on the official ecosystem page include:

- client-side integrations
- services/endpoints
- infrastructure/tooling
- facilitators

Examples listed there include:

- Alchemy
- Browserbase
- thirdweb
- OpenZeppelin
- various Solana and multi-chain facilitators
- paid MCP- and agent-facing tools

That matters because x402 is not only a spec anymore; it has a visible builder ecosystem.  
Source: [x402 ecosystem](https://www.x402.org/ecosystem)

Separately, Coinbase’s launch material presented x402 as an ecosystem effort with support from organizations including AWS, Anthropic, Circle, and NEAR AI.  
Source: [Coinbase x402 launch](https://www.coinbase.com/developer-platform/discover/launches/x402)

### Strengths

- dead-simple mental model
- already maps cleanly to paid APIs
- naturally works for agents
- HTTP-native
- seller integration can be very light
- broad enough to work across chains

### Limits

x402 is not, by itself:

- a subscription lifecycle system
- a usage-billing product
- an entitlement system
- a merchant backoffice
- an agent authorization/trust framework

It is also strongest when price is known upfront. When price emerges during fulfillment, as with streaming or variable-cost tool execution, raw request-response charging becomes less elegant.

## 2. MPP

## 2.1 What MPP is

MPP, the Machine Payments Protocol, is a broader machine-payments stack than x402. Stripe describes it as an open, internet-native way for agents to pay, co-authored by Tempo and Stripe. Stripe productized it so businesses on Stripe can accept payments over MPP through their existing Stripe payment stack.  
Sources: [Stripe MPP launch post](https://stripe.com/blog), [Stripe machine payments docs](https://docs.stripe.com/payments/machine), [paymentauth.org](https://paymentauth.org/)

The important distinction is that "MPP" is not just one page or one challenge flow. The official spec set at `paymentauth.org` includes:

- the `"Payment"` HTTP Authentication Scheme
- payment method specs such as `solana`, `stripe`, `tempo`, etc.
- session intent specs
- discovery
- JSON-RPC and MCP transport

So MPP is better understood as a protocol family around payment-authenticated machine interactions.

## 2.2 The core payment-authentication layer

The core draft defines the `"Payment"` HTTP authentication scheme. It explicitly standardizes semantics for using HTTP 402 as a payment challenge and keeps the framework payment-method agnostic. Payment methods are defined separately, while the core spec defines the auth/challenge pattern.  
Source: [Payment HTTP Authentication Scheme draft](https://paymentauth.org/draft-httpauth-payment-00.html)

This is conceptually similar to x402 in spirit, but broader in scope and more formalized around:

- auth scheme semantics
- method registries
- intent registries
- challenge/credential/receipt structure
- multiple payment options in a single challenge

The spec also defines payment intents as first-class objects. Intents are separately registered and can define semantics such as:

- one-time charge
- session
- other future patterns

This is an important architectural move. It means the protocol is not only "pay before access", but "pay according to a formally named interaction model."

## 2.3 Why MPP exists

MPP is trying to solve a more general machine-payment problem than x402:

- one-shot charges
- repeated requests
- metered billing
- non-HTTP transports
- agent tooling that uses JSON-RPC or MCP

Stripe’s documentation frames this commercially:

- businesses can accept machine payments into Stripe
- payments can settle to Stripe balance and fiat
- microtransactions can go as low as 0.01 USDC
- the seller can use existing Stripe-style reporting and refund flows

This is not just protocol design. It is protocol plus merchant adoption path.  
Source: [Stripe machine payments docs](https://docs.stripe.com/payments/machine)

## 2.4 The session model: why MPP is structurally different

The most important piece for product design is the `session` intent.

The official Tempo session draft defines a session intent as unidirectional streaming payment channels for incremental, voucher-based payments suitable for low-cost metered services. It explicitly uses LLM token streaming as a core example.  
Source: [Tempo Session Intent draft](https://paymentauth.org/draft-tempo-session-00.html)

The session flow is fundamentally different from one request = one payment:

1. Client asks for a metered or streaming resource.
2. Server returns a `session` payment challenge.
3. Client opens a payment channel onchain and deposits funds.
4. Server begins streaming response.
5. Client signs incremental vouchers with increasing cumulative amounts.
6. Server can pause or stop content if available balance is exhausted.
7. Top-ups and close requests happen against the same protected endpoint.

This matters because it solves the problem that x402 alone does not solve elegantly:

- "The final price is not fully known upfront."

The session draft also defines:

- `open`
- `topUp`
- `voucher`
- `close`
- accounting rules
- idempotency rules
- insufficient-balance behavior during streaming
- challenge-to-voucher mapping for disputes, usage accounting, and audit trails

This is a serious protocol-level answer to metered agent billing.  
Source: [Tempo Session Intent draft](https://paymentauth.org/draft-tempo-session-00.html)

## 2.5 MCP / JSON-RPC support

The MPP spec set also includes a JSON-RPC and MCP transport draft. This is highly relevant to agent tooling.

The draft defines how payment challenges, credentials, and receipts are conveyed in:

- JSON-RPC over HTTP
- JSON-RPC over WebSocket
- stdio
- MCP flows for `tools/call`, `resources/read`, and `prompts/get`

The flow is:

1. client sends JSON-RPC request
2. server returns a payment challenge in a structured error
3. client fulfills the challenge
4. client retries with credential metadata

This is one of the strongest signals that MPP is thinking beyond ordinary REST APIs and directly at agent/tooling ecosystems.  
Source: [JSON-RPC & MCP transport draft](https://paymentauth.org/draft-payment-transport-mcp-00.html)

## 2.6 Discovery and method plurality

MPP also includes a discovery draft, but the draft explicitly states that discovery metadata is not the authoritative security source. The 402 challenge remains authoritative.  
Source: [payment discovery draft](https://paymentauth.org/draft-payment-discovery-00.html)

That is the right model: discovery helps clients find supported methods, but the actual challenge is what binds the payment terms.

## 2.7 Who is building on MPP

Today, the clearest official commercial champion is Stripe.

Official Stripe material says:

- MPP is co-authored by Tempo and Stripe
- Stripe merchants can accept payments over MPP
- Stripe’s machine-payments stack supports x402 on Base and Solana, and MPP over Tempo and Stripe card rails

Stripe’s broader agentic-commerce posts also show adjacent infrastructure that matters:

- Shared Payment Tokens (SPTs)
- support for agentic network tokens and BNPL tokens
- integration into merchant-facing Stripe flows

Examples Stripe itself has highlighted around agentic commerce or related adoption include:

- Browserbase
- PostalForm
- Prospect Butcher
- Climate
- Parallel

And for adjacent tokenized agentic checkout, Stripe has explicitly named production businesses such as Etsy and URBN in the context of SPT adoption.  
Sources: [Stripe machine payments docs](https://docs.stripe.com/payments/machine), [Stripe blog](https://stripe.com/blog), [Supporting additional payment methods for agentic commerce](https://stripe.com/blog/supporting-additional-payment-methods-for-agentic-commerce)

## 2.8 Strengths

- covers both one-shot charges and session-based metered billing
- has a formal spec family instead of a single narrow flow
- includes MCP/JSON-RPC transport
- much closer to the needs of agent tool ecosystems
- has an existing commercialization path through Stripe

## 2.9 Limits

MPP still does not solve every layer of agent commerce.

It is strong on payment challenge and settlement mechanics, but it is not automatically:

- a merchant entitlement system
- a subscription management product
- a reconciliation control plane
- an agent authority / user-intent trust framework for delegated commerce

For certain delegated purchases, especially higher-risk ones, you still need a trust/authorization layer. That is where AP2 enters.

## 3. AP2

### What AP2 is

AP2, the Agent Payments Protocol, is an open protocol for agent commerce designed to establish trust, authorization, and accountability in agent-led transactions. Official AP2 docs describe it as an extension point around A2A and MCP, with more integrations in progress. Google’s launch material presents it as a payment-agnostic framework for secure agent-led transactions across many payment methods.  
Sources: [AP2 docs home](https://ap2-protocol.org/), [Google Cloud AP2 launch post](https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol)

### What problem AP2 solves

AP2 exists because current payment systems assume a human is directly interacting with a trusted merchant surface. The AP2 docs say that agent-led payments break that assumption and raise three core problems:

- authorization
- authenticity
- accountability

In plain terms:

- Did the user really authorize this agent to buy this thing?
- Is the merchant seeing the user’s actual intent or just an agent’s flawed interpretation?
- If something goes wrong, who is accountable?

That is a different class of problem than x402 or MPP solve.

### The core AP2 mechanism: Verifiable Digital Credentials

The AP2 system is built around Verifiable Digital Credentials (VDCs). The official docs and spec identify three primary credentials:

- `Intent Mandate`
- `Cart Mandate`
- `Payment Mandate`

Their roles are:

- `Intent Mandate`: captures delegated or human-not-present authorization under defined conditions
- `Cart Mandate`: captures explicit approval of a specific cart in human-present scenarios
- `Payment Mandate`: surfaces AI-agent/payment-context signals to the payment network or issuer

These signed artifacts are intended to provide:

- non-repudiable proof of user intent
- merchant confidence that a request is within scope
- clearer evidence for disputes and accountability

This is the heart of AP2. It is not trying to replace payment rails. It is trying to make agentic payments trustworthy enough for existing payment ecosystems to accept.  
Sources: [AP2 docs home](https://ap2-protocol.org/), [AP2 specification](https://ap2-protocol.org/specification/)

### Human-present vs human-not-present

AP2 is explicitly designed around two transaction modes:

- human present
- human not present

That matters because the protocol distinguishes between:

- "user is here and can confirm the cart right now"
- "user delegated a goal and the agent is acting later"

The Google Cloud launch post frames delegated tasks such as buying tickets when they go on sale as a motivating case for an `Intent Mandate`.  
Source: [Google Cloud AP2 launch post](https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol)

### AP2 and payment-method agnosticism

AP2 is payment-method agnostic by design. The docs say the initial version focuses on common pull payment methods like cards, with roadmap support for push payments such as real-time bank transfers and digital currencies.

This matters because AP2 is trying to sit above specific rails, not compete with them.  
Sources: [AP2 docs home](https://ap2-protocol.org/), [AP2 and x402](https://ap2-protocol.org/topics/ap2-and-x402/)

### AP2 and x402

The AP2 docs explicitly say AP2 and x402 are complementary.

- x402 is treated as an emerging payment method / execution rail
- AP2 provides the trust and interoperable authorization framework around such payments

The official AP2 docs also point to an A2A+x402 implementation and state that AP2 is intended to compose with digital-currency payment methods rather than replace them.  
Source: [AP2 and x402](https://ap2-protocol.org/topics/ap2-and-x402/)

### Who is behind AP2

AP2 has serious institutional weight behind it.

Google Cloud’s launch post explicitly names a broad set of partners and supporters, including:

- Coinbase
- Eigen Labs
- MetaMask
- Mesh
- Mysten Labs
- Mastercard
- Worldpay
- Juspay
- Lightspark
- 1Password
- multiple payment processors and infrastructure providers

That does not mean AP2 is production-standardized across the market yet. It does mean the problem it addresses is recognized by major payments, web3, and infrastructure actors.  
Source: [Google Cloud AP2 launch post](https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol)

### Strengths

- directly addresses the trust gap in delegated agent payments
- compatible with multiple rails
- much more suitable than a raw payment rail for higher-trust commerce
- creates a clean evidence trail around user authorization and merchant decisioning

### Limits

AP2 is not currently the easiest thing to adopt for a simple paid API or low-friction tool purchase.

It is a heavier trust framework. It is more relevant when:

- delegated spend matters
- dispute/chargeback/accountability matters
- merchants need strong proof of authority
- existing payment networks or issuers need new machine-readable context

It is not the shortest path to "let agents pay 1 cent for one tool call."

## 4. Comparison

| Dimension | x402 | MPP | AP2 |
| --- | --- | --- | --- |
| Core job | Paywalled HTTP resources | General machine payment auth and intents | Agent authorization and trust |
| Best for | Pay-per-request APIs, paid MCP tools | Pay-per-request plus metered/session usage | Delegated, higher-trust purchases |
| Primary abstraction | HTTP 402 challenge | Payment auth scheme + payment methods + intents | Mandates and verifiable credentials |
| Metered usage | Weak to moderate without extensions | Strong via session intent | Not a billing primitive by itself |
| MCP / agent-tool transport | Possible, but not first-class in core | First-class via JSON-RPC/MCP transport draft | Indirect, via A2A/MCP composition |
| Settlement role | Yes | Yes | Usually composes with another rail |
| Trust / accountability layer | Minimal | Moderate | Core strength |
| Merchant integration complexity | Low | Moderate | Higher |
| Strategic feel | API paywall rail | Full machine-payment substrate | Agent-commerce trust framework |

## 5. What each one actually solves in practice

### x402

Use x402 if the problem is:

- "I want this endpoint to cost money."
- "I want an agent to pay per call."
- "I want a minimal, crypto-native way to gate access."

### MPP

Use MPP if the problem is:

- "I need repeated or metered machine billing."
- "I want this to work well for JSON-RPC or MCP."
- "I need a protocol family that handles charge and session semantics."

### AP2

Use AP2 if the problem is:

- "A merchant must trust that the agent was really allowed to buy this."
- "There may be disputes or high-value delegated commerce."
- "The payment rail alone is not enough; I need cryptographic evidence of authority and intent."

## 6. What this means for Axoria

### The wrong move

The wrong move would be to build a new payment protocol from scratch.

That is not where the wedge is.

### The more defensible move

The more defensible move is to become the merchant operating layer for agent payments on Solana.

That layer would use protocols instead of replacing them.

### Product implication by protocol

#### If Axoria leans x402-first

Axoria becomes:

- easy merchant integration for paid APIs and paid tools
- hosted paywall + settlement verification
- proofs, reconciliation, exceptions, entitlement control

This is the fastest path to a usable MVP.

#### If Axoria leans MPP-first

Axoria becomes:

- a more complete machine-billing platform
- capable of one-shot payments and metered usage
- especially relevant for tool providers, data APIs, and LLM-adjacent services

This is stronger long term, but the implementation surface is larger.

#### If Axoria leans AP2-first

Axoria becomes:

- an agent trust/control framework for merchants
- more aligned with high-trust delegated commerce
- less aligned with the simple "let agents pay for my API" wedge

This is powerful, but likely too heavy as the first product surface.

### Practical product reading

For an early Axoria product, the most rational sequencing appears to be:

1. `x402`-style one-shot charges for simple paid API/tool access
2. `MPP`-style session or metered billing for repeated usage
3. `AP2` integration where the merchant needs stronger delegated-purchase trust

That sequence keeps the product merchant-software-first instead of protocol-first.

## 7. Problem statement refinement

A good problem statement after this research is not:

> "Agents need a new protocol to pay for things."

That is too shallow and mostly false. Protocol work is already happening.

A better problem statement is:

> "Businesses need a dead-simple way to accept, verify, meter, reconcile, and prove agent payments without having to understand payment protocols, wallets, or trust semantics themselves."

And the sharper variant is:

> "The missing product is not a new rail. The missing product is the merchant operating layer that turns x402/MPP/AP2 capability into simple integration, clear billing state, and auditable settlement."

## 8. Key takeaways

- `x402` is the most practical immediate wedge for paid agent-facing endpoints.
- `MPP` is the strongest protocol family for real machine billing, especially metered or session-based usage.
- `AP2` is about trust and authorization, not raw payment collection.
- The product opportunity is to compose these layers for merchants.
- The merchant does not want to think in protocol primitives.
- The merchant wants:
  - pricing
  - access control
  - usage and settlement visibility
  - reconciliation
  - proofs
  - exceptions
  - easy integration

That is the layer where Axoria can be useful.
