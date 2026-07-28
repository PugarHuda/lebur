// Talk to the Lebur MetaMask Snap. All order encryption happens inside the
// Snap's SES sandbox — this page only relays handles, never the size or side.
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

/// Encrypt an order in-sandbox. Returns the two handle/proof pairs submitOrder needs.
export const encryptOrderInSnap = (
  amount: bigint, isBid: boolean, tick: number, batch: `0x${string}`,
) =>
  invoke<{
    amountHandle: `0x${string}`; amountProof: `0x${string}`;
    codeHandle: `0x${string}`; codeProof: `0x${string}`;
  }>('encryptOrder', { amount: amount.toString(), isBid, tick, batch });

/// Decrypt the trader's OWN escrow — shown in a MetaMask dialog, never here.
export const decryptMineInSnap = (handle: `0x${string}`, label?: string) =>
  invoke<{ value: string }>('decryptMine', { handle, label });
