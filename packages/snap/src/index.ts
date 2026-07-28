// Lebur MetaMask Snap. Order encryption happens INSIDE the SES sandbox:
// RSA keygen, ECDH/HKDF/AES-GCM, gateway fetch — the size, side and limit of an
// order, and the ephemeral key protecting them, never reach a web page.
//
// Verified in the day-0 spike (see the sibling Lirih project's feedback.md):
//  - crypto.subtle IS available in the Snap SES sandbox (default endowment).
//  - @iexec-nox/handle uses only WebCrypto + fetch (no node:/Buffer/DOM).
//  - eth_signTypedData_v4 from the user's EOA is BLOCKED for snaps
//    (BLOCKED_RPC_METHODS), so the Nox identity is a snap-owned key derived from
//    snap_getEntropy and granted the Nox viewer role instead.
import type { OnRpcRequestHandler, Json } from '@metamask/snaps-sdk';
import { panel, text, heading, copyable, divider } from '@metamask/snaps-sdk';
import { createEthersHandleClient } from '@iexec-nox/handle';
import { Wallet } from 'ethers';

/// Side and limit tick ride together in one euint16 as `side * SIDE_STRIDE + tick`,
/// so an order costs two gateway encryptions rather than three. Must match
/// LeburBatch.SIDE_STRIDE.
const SIDE_STRIDE = 8n;

/// Snap-owned signer derived deterministically from the user's SRP. This address
/// is the trader's Nox identity; the batch grants it the viewer role.
async function snapSigner() {
  const entropy = await snap.request({
    method: 'snap_getEntropy',
    params: { version: 1, salt: 'lebur-nox-v1' },
  });
  return new Wallet(entropy as string);
}

async function client() {
  // The handle client only needs signTypedData for gateway auth, which the
  // snap-derived Wallet does locally — no MetaMask confirmation, so it is not
  // caught by the blocked-methods restriction.
  return createEthersHandleClient(await snapSigner());
}

export const onRpcRequest: OnRpcRequestHandler = async ({ request }) => {
  switch (request.method) {
    // Encrypt an order in-sandbox -> the two {handle, proof} pairs the page submits
    // to LeburBatch.submitOrder. The amount and the packed side+tick never leave here.
    case 'encryptOrder': {
      const { amount, isBid, tick, batch } = request.params as {
        amount: string; isBid: boolean; tick: number; batch: `0x${string}`;
      };
      const c = await client();
      const code = (isBid ? 1n : 0n) * SIDE_STRIDE + BigInt(tick);
      const amt = await c.encryptInput(BigInt(amount), 'uint256', batch);
      const cod = await c.encryptInput(code, 'uint16', batch);
      return {
        amountHandle: String(amt.handle), amountProof: String(amt.handleProof),
        codeHandle: String(cod.handle), codeProof: String(cod.handleProof),
      } as Json;
    }

    // Decrypt the trader's OWN escrow and show it inside MetaMask. They learn their
    // own number but cannot prove it to anyone — proving would mean exposing an
    // SRP-derived key.
    case 'decryptMine': {
      const { handle, label } = request.params as { handle: `0x${string}`; label?: string };
      const c = await client();
      // The handle exists on-chain the instant the tx confirms, but the ciphertext
      // only exists once the single-threaded Runner has processed the event, so an
      // early failure is expected rather than exceptional.
      const decrypt = async () => {
        for (let i = 1; i <= 12; i++) {
          try {
            return await c.decrypt(handle);
          } catch (err) {
            if (i === 12) throw err;
            await new Promise((r) => setTimeout(r, 5000));
          }
        }
        throw new Error('unreachable');
      };
      const { value } = await decrypt();
      await snap.request({
        method: 'snap_dialog',
        params: {
          type: 'alert',
          content: panel([
            heading(label ?? 'Your sealed order'),
            text('Only you can see this. It never left your wallet.'),
            copyable(`${value}`),
            divider(),
            text('The auction settles on the aggregate. Your size, side and limit stay encrypted.'),
          ]),
        },
      });
      return { value: value.toString() } as Json;
    }

    // The Nox identity address the page grants the viewer role to.
    case 'getNoxAddress': {
      return { address: (await snapSigner()).address } as Json;
    }

    default:
      throw new Error(`Method not found: ${request.method}`);
  }
};
