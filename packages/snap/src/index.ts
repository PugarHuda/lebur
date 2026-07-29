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

/// THE SNAP DOES NOT ENCRYPT ORDERS, AND CANNOT.
///
/// It used to, and that was broken — badly, and invisibly, because the Snap had
/// never been loaded in a wallet. `Nox.fromExternal` checks that the address which
/// OWNS the input proof is the direct `msg.sender` of the transaction consuming
/// it. An order encrypted by this snap-derived identity and then submitted by the
/// user's EOA fails that check: `InvalidProof`, every time. The page preferred the
/// Snap path when it was installed, so installing the Snap turned a working
/// trader into a broken one — the exact opposite of what it advertised.
///
/// So encryption stays with the EOA, which is the only key that can satisfy
/// `fromExternal`, and this snap owns the VIEWING key instead. That is the half
/// that actually carries the coercion-resistance property: the trader can read
/// their own order, and cannot sign anything that proves it to a briber, because
/// the key is SRP-derived and never leaves the sandbox. What is genuinely lost is
/// "the size never enters page JavaScript" — that was an over-claim, and
/// `fromExternal`'s binding rules it out for any wallet-signed transaction.
///
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
