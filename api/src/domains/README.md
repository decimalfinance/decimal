# API Domain Layout

The API is being moved away from a flat `src/` directory toward domain modules.

Current domain boundaries:

- `routes/` contains HTTP validation and response wiring only.
- `squads-treasury.ts` is the current Squads domain service and owns Squads v4 transaction construction, proposal reads, and proposal execution intents.
- `payment-orders.ts`, `collections.ts`, and related files are workflow services.
- `solana.ts` owns chain constants, RPC connections, and raw Solana instruction builders.

New backend work should prefer one of these patterns:

- Add HTTP endpoints in `routes/<domain>.ts`.
- Put business logic in a domain/service module, not inside the route.
- Keep route schemas near the route unless they are reused across domains.
- Return signable transaction intents from services; never sign user transactions inside route handlers.

The next cleanup step should split `squads-treasury.ts` into:

- `domains/squads/treasury-create.ts`
- `domains/squads/config-proposals.ts`
- `domains/squads/vault-proposals.ts`
- `domains/squads/proposal-read-model.ts`
- `domains/squads/permissions.ts`

This commit intentionally keeps the public import path stable while adding the proposal surface, because moving a large live integration and changing product behavior in the same patch would create unnecessary merge risk.
