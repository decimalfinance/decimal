import { Router } from 'express';
import { config } from '../config.js';
import { asyncRoute } from '../infra/route-helpers.js';

export const solanaRpcRouter = Router();

// The JSON-RPC methods the browser legitimately needs for client-side signing,
// submission, and confirmation polling. Everything else is rejected so this
// proxy can't be turned into an open, keyed RPC node.
const ALLOWED_RPC_METHODS = new Set([
  'sendTransaction',
  'simulateTransaction',
  'getSignatureStatuses',
  'getLatestBlockhash',
  'isBlockhashValid',
  'getFeeForMessage',
  'getAccountInfo',
  'getMultipleAccounts',
  'getBalance',
  'getTokenAccountBalance',
  'getMinimumBalanceForRentExemption',
  'getEpochInfo',
  'getSlot',
  'getBlockHeight',
  'getRecentPrioritizationFees',
  'getVersion',
  'getHealth',
]);

function methodOf(call: unknown): string | null {
  if (call && typeof call === 'object' && typeof (call as { method?: unknown }).method === 'string') {
    return (call as { method: string }).method;
  }
  return null;
}

// Authenticated Solana RPC proxy. The frontend points its web3.js Connection at
// this endpoint instead of an RPC node, so the backend's paid RPC key never
// reaches the browser. requireAuth (mounted upstream) gates it to logged-in
// users; the method allowlist bounds what it can do. Forwards to the backend's
// own (paid) RPC server-side.
solanaRpcRouter.post('/solana/rpc', asyncRoute(async (req, res) => {
  const payload = req.body;
  const calls = Array.isArray(payload) ? payload : [payload];
  for (const call of calls) {
    const method = methodOf(call);
    if (!method || !ALLOWED_RPC_METHODS.has(method)) {
      res.status(400).json({
        jsonrpc: '2.0',
        id: (call && typeof call === 'object' ? (call as { id?: unknown }).id : null) ?? null,
        error: { code: -32601, message: `RPC method not permitted via proxy: ${String(method)}` },
      });
      return;
    }
  }

  let status: number;
  let body: string;
  try {
    const upstream = await fetch(config.solanaRpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    status = upstream.status;
    body = await upstream.text();
  } catch {
    res.status(502).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32603, message: 'Upstream RPC unavailable.' },
    });
    return;
  }
  res.status(status).type('application/json').send(body);
}));
