// Talk to the Lebur MetaMask Snap.
//
// The Snap holds the VIEWING key, not the encrypting one. `Nox.fromExternal`
// requires the proof's owner to be the transaction's direct `msg.sender`, so only
// the EOA can encrypt an order it is about to submit — see packages/snap/src.
const SNAP_ID = process.env.NEXT_PUBLIC_SNAP_ID ?? 'local:http://localhost:8080';

const eth = () => (globalThis as any).ethereum;

export async function connectSnap() {
  await eth().request({ method: 'wallet_requestSnaps', params: { [SNAP_ID]: {} } });
}

function invoke<T>(method: string, params?: unknown): Promise<T> {
  return eth().request({
    method: 'wallet_invokeSnap',
    params: { snapId: SNAP_ID, request: { method, params } },
  });
}

/// Nox identity the Snap controls, derived from the user's SRP. Granted the
/// viewer role so the trader can read their own escrow and nobody else can.
export const getNoxAddress = () => invoke<{ address: `0x${string}` }>('getNoxAddress');

/// Decrypt the trader's OWN escrow — shown in a MetaMask dialog, never here.
export const decryptMineInSnap = (handle: `0x${string}`, label?: string) =>
  invoke<{ value: string }>('decryptMine', { handle, label });
