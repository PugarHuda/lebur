// Browser-side Nox integration. Ethereum Sepolia is a built-in default in
// @iexec-nox/handle, so no gateway/subgraph override is needed.
import { createViemHandleClient } from '@iexec-nox/handle';
import type { WalletClient } from 'viem';

let cached: Awaited<ReturnType<typeof createViemHandleClient>> | undefined;

async function client(wallet: WalletClient) {
  if (!cached) cached = await createViemHandleClient(wallet);
  return cached;
}

/// Encrypt the two values an order needs: the escrowed amount, and the packed
/// side+tick code. The gateway encrypts inside its TEE; the proof binds
/// (wallet, batch) so the order MUST be submitted by this same wallet directly —
/// no router, no multicall, or `fromExternal` reverts.
export async function encryptOrder(
  wallet: WalletClient,
  amount: bigint,
  code: bigint,
  batch: `0x${string}`,
) {
  const c = await client(wallet);
  const amt = await c.encryptInput(amount, 'uint256', batch);
  const cod = await c.encryptInput(code, 'uint16', batch);
  return { amt, cod };
}

/// ACL-gated private decrypt (gasless). Lets a trader read their OWN escrow.
/// Retries because a handle exists on-chain immediately but its ciphertext only
/// appears once the single-threaded Runner has processed the event.
export async function decryptMine(
  wallet: WalletClient,
  handle: `0x${string}`,
  onWait?: (i: number, n: number) => void,
) {
  const c = await client(wallet);
  const N = 12;
  for (let i = 1; i <= N; i++) {
    try {
      const { value } = await c.decrypt(handle);
      return value as bigint;
    } catch (err) {
      if (i === N) throw err;
      onWait?.(i, N);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  throw new Error('unreachable');
}
