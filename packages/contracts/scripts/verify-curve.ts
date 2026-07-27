// Read-only verification of the Curve seam Lebur settles against. Sends NO
// transactions and spends no gas — every call is eth_call / eth_getCode.
//   npx tsx scripts/verify-curve.ts     (or: node --experimental-strip-types)
//
// Run this before trusting any of the addresses or selectors in ICurve.sol. Curve's
// docs do not document Sepolia at all, so RPC is the only source of truth.
import { createPublicClient, http, keccak256, toHex, getAddress } from 'viem';
import { sepolia } from 'viem/chains';
import { ICURVE_FACTORY, CURVE_BLUEPRINT, MAINNET_FACTORY_CODEHASH } from './curve-config.ts';

const factoryAbi = [
  { type: 'function', name: 'pool_count', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'pool_list', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] },
] as const;

const poolAbi = [
  { type: 'function', name: 'coins', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'balances', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'A', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'get_dy', stateMutability: 'view', inputs: [{ type: 'int128' }, { type: 'int128' }, { type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  {
    type: 'function', name: 'exchange_received', stateMutability: 'nonpayable',
    inputs: [{ type: 'int128' }, { type: 'int128' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

const client = createPublicClient({
  chain: sepolia,
  transport: http(process.env.SEPOLIA_RPC_URL ?? 'https://sepolia.drpc.org'),
});

const ok = (b: boolean) => (b ? 'OK  ' : 'FAIL');

async function main() {
  console.log(`chainId ${await client.getChainId()} (expect 11155111)`);

  // 1. the factory really is upstream Curve, not a fork
  const code = await client.getCode({ address: ICURVE_FACTORY });
  const hash = keccak256(code ?? '0x');
  console.log(`${ok(!!code && code.length > 2)} factory has code (${((code?.length ?? 2) - 2) / 2} bytes)`);
  console.log(`${ok(hash === MAINNET_FACTORY_CODEHASH)} factory codehash == mainnet  ${hash}`);

  const bp = await client.getCode({ address: CURVE_BLUEPRINT });
  console.log(`${ok(!!bp && bp.length > 2)} pool blueprint has code`);

  const count = await client.readContract({ address: ICURVE_FACTORY, abi: factoryAbi, functionName: 'pool_count' });
  console.log(`${ok(count > 0n)} factory pool_count = ${count}`);

  // 2. find a pool with real liquidity and prove the two selectors Lebur depends on
  //    actually exist on it. A Vyper contract with no matching selector reverts in the
  //    dispatcher, so a successful eth_call IS selector proof.
  let probed = 0;
  for (let i = 0n; i < count && probed < 3; i++) {
    const pool = await client.readContract({ address: ICURVE_FACTORY, abi: factoryAbi, functionName: 'pool_list', args: [i] });
    let supply: bigint;
    try {
      supply = await client.readContract({ address: pool, abi: poolAbi, functionName: 'totalSupply' });
    } catch { continue; }
    if (supply === 0n) continue;
    probed++;

    const [c0, c1, b0, b1, A] = await Promise.all([
      client.readContract({ address: pool, abi: poolAbi, functionName: 'coins', args: [0n] }),
      client.readContract({ address: pool, abi: poolAbi, functionName: 'coins', args: [1n] }),
      client.readContract({ address: pool, abi: poolAbi, functionName: 'balances', args: [0n] }),
      client.readContract({ address: pool, abi: poolAbi, functionName: 'balances', args: [1n] }),
      client.readContract({ address: pool, abi: poolAbi, functionName: 'A' }),
    ]);
    console.log(`\npool #${i} ${getAddress(pool)}  A=${A} supply=${supply}`);
    console.log(`  coins ${c0} / ${c1}`);
    console.log(`  balances ${b0} / ${b1}`);

    // get_dy on 1 unit — proves the pricing view and shows how flat the curve is.
    const unit = 10n ** 18n;
    try {
      const dy = await client.readContract({ address: pool, abi: poolAbi, functionName: 'get_dy', args: [0n, 1n, unit] });
      console.log(`  ${ok(true)} get_dy(0,1,1e18) = ${dy}  (par would be 1e18)`);
    } catch (e) {
      console.log(`  ${ok(false)} get_dy reverted: ${(e as Error).message.split('\n')[0]}`);
    }

    // Selector presence, proved DECISIVELY rather than by revert-message guessing.
    // An eth_call to exchange_received reverts either way here (dx=0 trips Curve's
    // own asserts), and viem reports an unknown selector and a failed assert with the
    // same string — so that probe proves nothing. Vyper's dispatcher embeds every
    // method id as a PUSH4 immediate, so searching the deployed runtime bytecode for
    // the 4 bytes is unambiguous: present means the function is reachable.
    const poolCode = (await client.getCode({ address: pool })) ?? '0x';
    for (const sig of [
      'exchange_received(int128,int128,uint256,uint256,address)',
      'get_dy(int128,int128,uint256)',
      'add_liquidity(uint256[],uint256)',
    ]) {
      const s = keccak256(toHex(sig)).slice(2, 10);
      console.log(`  ${ok(poolCode.toLowerCase().includes(s))} selector 0x${s}  ${sig}`);
    }
  }
  if (probed === 0) console.log('\nno pool with non-zero supply found in the scan window');

  // 3. the deploy_plain_pool overload scripts/deploy-pool.ts encodes. Getting the
  //    argument list wrong is the single easiest way to waste a real deployment, and
  //    the ABI is not published anywhere for Sepolia — so check it against bytecode.
  const factoryCode = (await client.getCode({ address: ICURVE_FACTORY })) ?? '0x';
  const candidates = [
    'deploy_plain_pool(string,string,address[],uint256,uint256,uint256,uint256,uint256,uint8[],bytes4[],address[])',
    'deploy_plain_pool(string,string,address[],uint256,uint256,uint256,uint256,uint8[],bytes4[],address[],uint256[])',
    'deploy_plain_pool(string,string,address[],uint256,uint256,uint256,uint256,uint256,uint8[],bytes4[],address[],uint256[])',
  ];
  console.log('');
  for (const sig of candidates) {
    const s = keccak256(toHex(sig)).slice(2, 10);
    console.log(`${ok(factoryCode.toLowerCase().includes(s))} 0x${s}  ${sig}`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
