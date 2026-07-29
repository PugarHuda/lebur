// Drive a live Sepolia batch from sealed book to paid-out: clear -> reveal -> settle
// on Curve -> payouts. Every step is permissionless; this script has no privileges
// the traders do not, it just pays the gas.
//   npx hardhat run scripts/run-batch.ts --network sepolia
//
// Env: DEPLOYER_PRIVATE_KEY, BATCH_ADDRESS. Optional: SKIP_CLEAR=1 to resume a batch
// that already cleared, DRY=1 to print the state and stop without sending anything.
import { createWalletClient, createPublicClient, http, getContract } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { createViemHandleClient } from '@iexec-nox/handle';
import { freshChainTime } from './chain-time.ts';

const batchAbi = [
  { type: 'function', name: 'clear', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  {
    type: 'function', name: 'settle', stateMutability: 'nonpayable',
    inputs: [{ type: 'uint16' }, { type: 'bytes' }, { type: 'bytes' }, { type: 'bytes' }], outputs: [],
  },
  { type: 'function', name: 'payout', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'phase', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'orderCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'submitDeadline', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'bestTick', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'unwrapId0', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'unwrapId1', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'clearingPrice', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'clearingTickRevealed', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'residual0Revealed', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'residual1Revealed', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'poolOut', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'poolUsed', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
] as const;

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`set ${k}`);
  return v;
};

const fmt = (x: bigint) => `${Number(x) / 1e18}`;

async function main() {
  const account = privateKeyToAccount(env('DEPLOYER_PRIVATE_KEY') as `0x${string}`);
  const transport = http(process.env.SEPOLIA_RPC_URL ?? 'https://sepolia.drpc.org');
  const wallet = createWalletClient({ account, chain: sepolia, transport });
  const pub = createPublicClient({ chain: sepolia, transport });
  const b = getContract({
    address: env('BATCH_ADDRESS') as `0x${string}`, abi: batchAbi, client: { public: pub, wallet },
  });

  const wait = async (hash: `0x${string}`, label: string) => {
    const rc = await pub.waitForTransactionReceipt({ hash });
    console.log(`  ${label}: ${rc.status} (gas ${rc.gasUsed})`);
    if (rc.status !== 'success') throw new Error(`${label} reverted`);
    return rc;
  };

  const n = await b.read.orderCount();
  const deadline = await b.read.submitDeadline();
  // Fresh, not just `latest` — a stale block makes a closed submit window look
  // open (clear() then reverts) and an open one look closed (this script then
  // refuses a batch that is in fact ready).
  const chainNow = await freshChainTime(pub);
  console.log(`batch ${b.address}  orders=${n}  phase=${await b.read.phase()}`);
  console.log(`deadline ${new Date(Number(deadline) * 1000).toISOString()}  chain now ${new Date(Number(chainNow) * 1000).toISOString()}`);
  if (process.env.DRY === '1') return;

  // ── 1. clear, entirely under encryption ──────────────────────────────────────
  if (Number(await b.read.phase()) === 0 && process.env.SKIP_CLEAR !== '1') {
    if (chainNow <= deadline) throw new Error('submit window still open — clear() would revert');
    console.log(`\nclear(): ~T*(6N+17)+11 encrypted ops for N=${n}. The Runner is`
      + ' single-threaded, so this is the slow one.');
    const rc = await wait(await b.write.clear(), 'clear');
    console.log(`  ${rc.gasUsed} gas for the whole encrypted ladder scan`);
  }

  // ── 2. reveal exactly three numbers, and settle ──────────────────────────────
  if (Number(await b.read.phase()) === 1) {
    const handles = await createViemHandleClient(wallet);
    // These three public decrypts are the ENTIRE information leak of the mechanism:
    // where the book crossed, and how much net flow could not be matched internally.
    // Every individual order stays sealed forever.
    const grab = async (label: string, h: `0x${string}`) => {
      for (let i = 1; ; i++) {
        try {
          const r = await handles.publicDecrypt(h);
          console.log(`  ${label} = ${r.value}`);
          return r;
        } catch (e) {
          // The handle exists on-chain instantly; the ciphertext only exists once the
          // remote Runner has processed the event.
          if (i >= 30) throw e;
          await new Promise((res) => setTimeout(res, 5000));
        }
      }
    };
    console.log('\npublicDecrypt of the three revealed values...');
    const tick = await grab('clearing tick', await b.read.bestTick());
    const r0 = await grab('coin0 residual', await b.read.unwrapId0());
    const r1 = await grab('coin1 residual', await b.read.unwrapId1());

    console.log('settle(): finalizeUnwrap x2, then one exchange_received on Curve');
    await wait(
      await b.write.settle([
        Number(tick.value), tick.decryptionProof, r0.decryptionProof, r1.decryptionProof,
      ]),
      'settle',
    );
  }

  // ── 3. pay everyone, still confidential ──────────────────────────────────────
  if (Number(await b.read.phase()) === 2) {
    for (let i = 0n; i < n; i++) await wait(await b.write.payout([i]), `payout #${i}`);
  }

  const [tick, price, res0, res1, out, used] = await Promise.all([
    b.read.clearingTickRevealed(), b.read.clearingPrice(),
    b.read.residual0Revealed(), b.read.residual1Revealed(),
    b.read.poolOut(), b.read.poolUsed(),
  ]);
  console.log(`\n--- batch result (everything below is ALL that is public) ---`);
  console.log(`clearing tick   ${tick}  price ${fmt(price)} coin0 per coin1`);
  console.log(`residual coin0  ${fmt(res0)}`);
  console.log(`residual coin1  ${fmt(res1)}`);
  console.log(`Curve leg       ${used ? `used, received ${fmt(out)}` : 'SKIPPED (pool could not meet the clearing price)'}`);
  console.log(`\nEvery order's size, side, limit and fill remain encrypted. Only the`);
  console.log(`aggregate above ever touched the public chain.`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
