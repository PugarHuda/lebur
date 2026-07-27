// Deploy Lebur to Ethereum Sepolia against an existing Curve pool.
//   npx hardhat run scripts/deploy-sepolia.ts --network sepolia
//
// Run scripts/deploy-pool.ts first (it prints exactly the env block this reads).
// Env: DEPLOYER_PRIVATE_KEY, TOKEN0, TOKEN1, CURVE_POOL, POOL_I0, POOL_I1,
//      optionally SUBMIT_WINDOW_SECS (default 1800).
//
// The submit window is a deliberate choice, not a default to accept blindly: short
// enough to record the whole clear -> settle -> payout cycle in one sitting, long
// enough that a judge can still get an order in. A sibling project shipped a round
// whose window expired before anyone could use it.
import { network } from 'hardhat';
import { LADDER } from './curve-config.ts';

const SUBMIT_WINDOW_SECS = Number(process.env.SUBMIT_WINDOW_SECS ?? 1800);

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`set ${k} (run scripts/deploy-pool.ts first)`);
  return v;
};

async function main() {
  const token0 = env('TOKEN0') as `0x${string}`;
  const token1 = env('TOKEN1') as `0x${string}`;
  const pool = env('CURVE_POOL') as `0x${string}`;
  const i0 = Number(process.env.POOL_I0 ?? '0');
  const i1 = Number(process.env.POOL_I1 ?? '1');

  const { viem } = await network.connect({ network: 'sepolia', chainType: 'op' });
  const [wallet] = await viem.getWalletClients();
  const pub = await viem.getPublicClient();
  console.log(`deployer ${wallet.account.address}`);

  const c0 = await viem.deployContract('ConfidentialToken', ['Confidential USDA', 'cUSDA', token0]);
  console.log(`cUSDA ${c0.address}`);
  const c1 = await viem.deployContract('ConfidentialToken', ['Confidential USDB', 'cUSDB', token1]);
  console.log(`cUSDB ${c1.address}`);

  // Anchor the deadline to CHAIN time. `submitOrder` and `clear` both compare against
  // block.timestamp, and the local clock is not the chain's.
  const now = (await pub.getBlock()).timestamp;
  const deadline = now + BigInt(SUBMIT_WINDOW_SECS);

  const batch = await viem.deployContract('LeburBatch', [
    token0, token1, c0.address, c1.address, pool, i0, i1, [...LADDER], deadline,
  ]);
  console.log(`LeburBatch ${batch.address}`);
  console.log(`submit deadline ${new Date(Number(deadline) * 1000).toISOString()}`);
  console.log(`ladder ${LADDER.map((p) => Number(p) / 1e18).join(' / ')}`);

  // The constructor already wrapped zero of each coin for itself, so both of the
  // batcher's confidential balances are initialised. Verify it rather than trust it:
  // if either handle is zero, `clear()` will revert on the unwrap for any book that
  // happens to be one-sided, and that failure would only appear under load.
  const ZERO = `0x${'00'.repeat(32)}`;
  for (const [label, c] of [['cUSDA', c0], ['cUSDB', c1]] as const) {
    const h = await c.read.confidentialBalanceOf([batch.address]);
    console.log(`  ${h === ZERO ? 'FAIL' : 'OK  '} batcher ${label} balance handle initialised`);
    if (h === ZERO) throw new Error(`${label} balance not initialised — clear() would revert`);
  }

  console.log(`\n--- paste into .env ---
BATCH_ADDRESS=${batch.address}
CTOKEN0=${c0.address}
CTOKEN1=${c1.address}
TOKEN0=${token0}
TOKEN1=${token1}
CURVE_POOL=${pool}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
