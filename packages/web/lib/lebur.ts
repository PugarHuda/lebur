// Addresses + minimal ABIs for the Lebur frontend. Values come from .env.local,
// which scripts/deploy-sepolia.ts prints ready to paste.
import { createPublicClient, createWalletClient, custom, http, type WalletClient } from 'viem';
import { sepolia } from 'viem/chains';

export const ADDRESSES = {
  batch: (process.env.NEXT_PUBLIC_BATCH ?? '0x') as `0x${string}`,
  cToken0: (process.env.NEXT_PUBLIC_CTOKEN0 ?? '0x') as `0x${string}`,
  cToken1: (process.env.NEXT_PUBLIC_CTOKEN1 ?? '0x') as `0x${string}`,
  token0: (process.env.NEXT_PUBLIC_TOKEN0 ?? '0x') as `0x${string}`,
  token1: (process.env.NEXT_PUBLIC_TOKEN1 ?? '0x') as `0x${string}`,
  pool: (process.env.NEXT_PUBLIC_POOL ?? '0x') as `0x${string}`,
};

// viem's bundled Sepolia RPC is unreliable; point NEXT_PUBLIC_RPC somewhere real.
export const pub = createPublicClient({
  chain: sepolia,
  transport: http(process.env.NEXT_PUBLIC_RPC),
});

/// Side and limit tick ride together in ONE euint16 as `side * SIDE_STRIDE + tick`,
/// so an order costs two gateway encryptions rather than three. Must match
/// LeburBatch.SIDE_STRIDE.
export const SIDE_STRIDE = 8n;
/// ERC-7984 reverts transferring from an uninitialised balance handle, and the
/// batcher pulls from BOTH tokens without knowing the side, so a trader must hold
/// a little of each. It is also what keeps the side private: an address that has
/// never held cUSDA is publicly incapable of bidding.
export const DUST = 1n;

export const PHASES = ['Accepting orders', 'Cleared', 'Settled'] as const;

export async function connectWallet(onStatus?: (s: string) => void) {
  const eth = (globalThis as any).ethereum;
  if (!eth) throw new Error('No injected wallet found — install MetaMask.');
  const [addr] = (await eth.request({ method: 'eth_requestAccounts' })) as `0x${string}`[];
  const current = (await eth.request({ method: 'eth_chainId' })) as string;
  if (parseInt(current, 16) !== sepolia.id) {
    onStatus?.('wrong network — switching to Sepolia…');
    try {
      await eth.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: `0x${sepolia.id.toString(16)}` }],
      });
    } catch {
      throw new Error(
        `This batch lives on Ethereum Sepolia (${sepolia.id}); your wallet is on chain ` +
        `${parseInt(current, 16)}. Switch networks and try again.`,
      );
    }
  }
  return createWalletClient({ chain: sepolia, transport: custom(eth), account: addr });
}

/// Send a write and WAIT for the receipt — viem's write does not, and every step
/// of the order flow reads state the previous one wrote.
export async function tx(
  w: WalletClient,
  req: Parameters<WalletClient['writeContract']>[0],
  onHash?: (h: `0x${string}`) => void,
) {
  const hash = await w.writeContract(req);
  onHash?.(hash);
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error(`tx reverted: ${hash}`);
  return hash;
}

export const explorerTx = (h: string) => `https://sepolia.etherscan.io/tx/${h}`;
export const explorerAddr = (a: string) => `https://sepolia.etherscan.io/address/${a}`;

export const erc20Abi = [
  { type: 'function', name: 'mint', stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const;

export const cTokenAbi = [
  { type: 'function', name: 'wrap', stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'setOperator', stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint48' }], outputs: [] },
  { type: 'function', name: 'confidentialBalanceOf', stateMutability: 'view',
    inputs: [{ type: 'address' }], outputs: [{ type: 'bytes32' }] },
] as const;

export const batchAbi = [
  { type: 'function', name: 'submitOrder', stateMutability: 'nonpayable',
    inputs: [
      { name: 'encAmount', type: 'bytes32' }, { name: 'amountProof', type: 'bytes' },
      { name: 'encCode', type: 'bytes32' }, { name: 'codeProof', type: 'bytes' },
      { name: 'viewer', type: 'address' },
    ], outputs: [] },
  { type: 'function', name: 'clear', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  // Settlement takes three gateway-signed decryptions and re-verifies each one, so
  // it is safe to expose to anyone — the caller supplies proofs, not numbers.
  { type: 'function', name: 'settle', stateMutability: 'nonpayable',
    inputs: [
      { name: 'tick', type: 'uint16' }, { name: 'tickProof', type: 'bytes' },
      { name: 'proof0', type: 'bytes' }, { name: 'proof1', type: 'bytes' },
    ], outputs: [] },
  { type: 'function', name: 'bestTick', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'unwrapId0', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'unwrapId1', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'payout', stateMutability: 'nonpayable',
    inputs: [{ type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'phase', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'orderCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'submitDeadline', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'tickCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'ladder', stateMutability: 'view',
    inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'clearingTickRevealed', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'clearingPrice', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'residual0Revealed', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'residual1Revealed', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  // The order book. Sizes and limit come back as encrypted handles — only
  // `trader` and `paid` are readable, which is exactly what the payout pass needs.
  { type: 'function', name: 'orders', stateMutability: 'view',
    inputs: [{ type: 'uint256' }],
    outputs: [
      { name: 'trader', type: 'address' },
      { name: 'qBuy', type: 'bytes32' },
      { name: 'qSell', type: 'bytes32' },
      { name: 'limitTick', type: 'bytes32' },
      { name: 'paid', type: 'bool' },
    ] },
  { type: 'function', name: 'poolUsed', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'poolOut', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  // How many numbers this batch has made public, ever. The privacy claim in one integer.
  { type: 'function', name: 'publicFootprint', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  // One deployment, many auctions. Permissionless like every other step, so the
  // page can offer it to whoever is reading. `epoch` doubles as the feature
  // probe: deployments made before these existed simply have no such getter.
  { type: 'function', name: 'epoch', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'startNewBatch', stateMutability: 'nonpayable',
    inputs: [{ name: 'newDeadline', type: 'uint64' }], outputs: [] },
] as const;

/// `startNewBatch` bounds the window to [5 minutes, 30 days]. Ten gives a demo
/// enough room to place two orders without leaving the page parked for an hour.
export const NEW_BATCH_WINDOW_SECS = 10 * 60;
