// Deploy Lebur's own Curve StableSwap-NG pool on Ethereum Sepolia.
//   npx hardhat run scripts/deploy-pool.ts --network sepolia
//
// ⚠️ DRY RUN BY DEFAULT. It simulates `deploy_plain_pool` via eth_call, prints the
// pool address the factory would return, and stops. Set BROADCAST=1 to actually send.
// Nothing here spends gas unless you ask for it in as many words.
//
// Why deploy our own instead of borrowing one of the 178 live pools: roughly half have
// `totalSupply == 0`, their coins are bespoke tokens with no faucet (two mint probes
// reverted), and none holds canonical Sepolia USDC. A pool we seeded ourselves is the
// only way the settlement leg does anything observable.
//
// Env: DEPLOYER_PRIVATE_KEY, SEPOLIA_RPC_URL, optionally TOKEN0/TOKEN1 (else fresh
// faucet ERC-20s are deployed), SEED (whole tokens per side, default 100000).
import { network } from 'hardhat';
import { parseEther } from 'viem';
import { ICURVE_FACTORY, POOL_PARAMS } from './curve-config.ts';

const factoryAbi = [
  {
    type: 'function', name: 'deploy_plain_pool', stateMutability: 'nonpayable',
    inputs: [
      { name: '_name', type: 'string' },
      { name: '_symbol', type: 'string' },
      { name: '_coins', type: 'address[]' },
      { name: '_A', type: 'uint256' },
      { name: '_fee', type: 'uint256' },
      { name: '_offpeg_fee_multiplier', type: 'uint256' },
      { name: '_ma_exp_time', type: 'uint256' },
      { name: '_implementation_idx', type: 'uint256' },
      { name: '_asset_types', type: 'uint8[]' },
      { name: '_method_ids', type: 'bytes4[]' },
      { name: '_oracles', type: 'address[]' },
    ],
    outputs: [{ type: 'address' }],
  },
] as const;

const poolAbi = [
  { type: 'function', name: 'add_liquidity', stateMutability: 'nonpayable', inputs: [{ type: 'uint256[]' }, { type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'coins', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'get_dy', stateMutability: 'view', inputs: [{ type: 'int128' }, { type: 'int128' }, { type: 'uint256' }], outputs: [{ type: 'uint256' }] },
] as const;

const BROADCAST = process.env.BROADCAST === '1';
const SEED = parseEther(process.env.SEED ?? '100000');

async function main() {
  const { viem } = await network.connect({ network: 'sepolia', chainType: 'op' });
  const [wallet] = await viem.getWalletClients();
  const pub = await viem.getPublicClient();
  console.log(`deployer ${wallet.account.address}  broadcast=${BROADCAST}`);

  const wait = async (hash: `0x${string}`, label: string) => {
    const rc = await pub.waitForTransactionReceipt({ hash });
    console.log(`  ${label}: ${rc.status} (gas ${rc.gasUsed})`);
    if (rc.status !== 'success') throw new Error(`${label} reverted`);
    return rc;
  };

  // ── the two coins ────────────────────────────────────────────────────────────
  let token0 = process.env.TOKEN0 as `0x${string}` | undefined;
  let token1 = process.env.TOKEN1 as `0x${string}` | undefined;
  if (!token0 || !token1) {
    if (!BROADCAST) {
      console.log('\nno TOKEN0/TOKEN1 set — set them, or run with BROADCAST=1 to mint fresh ones');
      console.log('dry run cannot simulate the pool without concrete coin addresses. stopping.');
      return;
    }
    const a = await viem.deployContract('FaucetERC20', ['Lebur USD A', 'lUSDA', 18]);
    const b = await viem.deployContract('FaucetERC20', ['Lebur USD B', 'lUSDB', 18]);
    token0 = a.address;
    token1 = b.address;
    console.log(`lUSDA ${token0}\nlUSDB ${token1}`);
  }

  // Curve's plain-pool arguments. `_asset_types` 0 = a standard ERC-20 with no rate
  // provider, which is what a plain stablecoin pair is; `_method_ids` and `_oracles`
  // are the empty per-coin slots that go with it.
  const args = [
    'Lebur USDA/USDB',
    'leburUSD',
    [token0, token1],
    POOL_PARAMS.A,
    POOL_PARAMS.fee,
    POOL_PARAMS.offpegFeeMultiplier,
    POOL_PARAMS.maExpTime,
    POOL_PARAMS.implementationIdx,
    [0, 0],
    ['0x00000000', '0x00000000'],
    ['0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000'],
  ] as const;

  // Always simulate first. A failed `deploy_plain_pool` is an expensive way to learn
  // the argument list is wrong, and the ABI is published nowhere for Sepolia.
  const sim = await pub.simulateContract({
    address: ICURVE_FACTORY, abi: factoryAbi, functionName: 'deploy_plain_pool',
    args: args as any, account: wallet.account,
  });
  console.log(`\neth_call OK — factory would return pool ${sim.result}`);

  if (!BROADCAST) {
    console.log('\nDRY RUN. Nothing was sent. Re-run with BROADCAST=1 to deploy and seed.');
    return;
  }

  const hash = await wallet.writeContract(sim.request as any);
  const rc = await wait(hash, 'deploy_plain_pool');
  const poolAddr = sim.result as `0x${string}`;
  console.log(`pool ${poolAddr} (block ${rc.blockNumber})`);

  // ── seed both sides at par ───────────────────────────────────────────────────
  const erc20 = [
    { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] },
    { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  ] as const;
  for (const t of [token0, token1]) {
    await wait(await wallet.writeContract({ address: t, abi: erc20, functionName: 'mint', args: [wallet.account.address, SEED] }), `mint ${t}`);
    await wait(await wallet.writeContract({ address: t, abi: erc20, functionName: 'approve', args: [poolAddr, SEED] }), `approve ${t}`);
  }
  await wait(
    await wallet.writeContract({ address: poolAddr, abi: poolAbi, functionName: 'add_liquidity', args: [[SEED, SEED], 0n] }),
    'add_liquidity',
  );

  // Sanity: the coin ORDER matters, because LeburBatch is constructed with the pool
  // indices. Read them back rather than assuming the factory kept our order.
  const [c0, c1] = await Promise.all([
    pub.readContract({ address: poolAddr, abi: poolAbi, functionName: 'coins', args: [0n] }),
    pub.readContract({ address: poolAddr, abi: poolAbi, functionName: 'coins', args: [1n] }),
  ]);
  const dy = await pub.readContract({ address: poolAddr, abi: poolAbi, functionName: 'get_dy', args: [0n, 1n, parseEther('1')] });
  console.log(`\npool coins: [0]=${c0} [1]=${c1}`);
  console.log(`get_dy(0,1,1e18) = ${dy}  (par would be 1e18 — Curve is flat here, which is the point)`);
  console.log(`\n--- paste into .env ---
TOKEN0=${c0}
TOKEN1=${c1}
CURVE_POOL=${poolAddr}
POOL_I0=0
POOL_I1=1`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
