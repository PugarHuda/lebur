// Place one real sealed order against a live Sepolia batch — the trader path minus a
// wallet UI. Exercises the LIVE Nox gateway, not the local Runner.
//   npx hardhat run scripts/submit-order.ts --network sepolia
//
// Env: TRADER_PRIVATE_KEY (defaults to DEPLOYER_PRIVATE_KEY), BATCH_ADDRESS,
//      CTOKEN0, CTOKEN1, TOKEN0, TOKEN1, SIDE (bid|ask), AMOUNT (whole tokens),
//      TICK (index into the ladder), VERIFY=1 to poll-decrypt the recorded escrow.
import {
  createWalletClient, createPublicClient, http, getContract, parseEther,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { createViemHandleClient } from '@iexec-nox/handle';
import { LADDER } from './curve-config.ts';

const erc20Abi = [
  { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

const cTokenAbi = [
  { type: 'function', name: 'wrap', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'setOperator', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint48' }], outputs: [] },
  { type: 'function', name: 'confidentialBalanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bytes32' }] },
] as const;

const batchAbi = [
  {
    type: 'function', name: 'submitOrder', stateMutability: 'nonpayable',
    inputs: [{ type: 'bytes32' }, { type: 'bytes' }, { type: 'bytes32' }, { type: 'bytes' }, { type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  { type: 'function', name: 'orders', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bool' }] },
  { type: 'function', name: 'orderCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'submitDeadline', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
] as const;

const SIDE_STRIDE = 8n; // must match LeburBatch.SIDE_STRIDE
const DUST = 1n;

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`set ${k}`);
  return v;
};

export type OrderOpts = {
  key: `0x${string}`;
  batch: `0x${string}`;
  cToken0: `0x${string}`;
  cToken1: `0x${string}`;
  token0: `0x${string}`;
  token1: `0x${string}`;
  isBid: boolean;
  amount: bigint; // 18dp
  tick: number;
  verify?: boolean;
};

export async function submitOrder(o: OrderOpts) {
  const account = privateKeyToAccount(o.key);
  const transport = http(process.env.SEPOLIA_RPC_URL ?? 'https://sepolia.drpc.org');
  const wallet = createWalletClient({ account, chain: sepolia, transport });
  const pub = createPublicClient({ chain: sepolia, transport });

  console.log(
    `${account.address} -> ${o.isBid ? 'BID' : 'ASK'} ${o.amount / 10n ** 18n} @ tick ${o.tick}` +
    ` (${Number(LADDER[o.tick]) / 1e18})`,
  );

  // viem's `write` does NOT await a receipt. Every state-dependent step below reads
  // what the previous one wrote, so every one of them has to be awaited explicitly.
  const wait = async (hash: `0x${string}`, label: string) => {
    const rc = await pub.waitForTransactionReceipt({ hash });
    console.log(`  ${label}: ${rc.status} (gas ${rc.gasUsed})`);
    if (rc.status !== 'success') throw new Error(`${label} reverted`);
  };

  const client = { public: pub, wallet };
  const t0 = getContract({ address: o.token0, abi: erc20Abi, client });
  const t1 = getContract({ address: o.token1, abi: erc20Abi, client });
  const c0 = getContract({ address: o.cToken0, abi: cTokenAbi, client });
  const c1 = getContract({ address: o.cToken1, abi: cTokenAbi, client });
  const b = getContract({ address: o.batch, abi: batchAbi, client });

  // Wrap the side being traded, and a DUST amount of the other. The dust is not
  // cosmetic: ERC-7984 reverts on a transfer from an uninitialised balance handle, and
  // the batcher pulls from BOTH tokens without knowing the side. Holding both is also
  // what keeps the side private — an address that has never held cUSDA is publicly
  // incapable of bidding, so its orders can only be asks.
  const [mineT, mineC] = o.isBid ? [t0, c0] : [t1, c1];
  const [otherT, otherC] = o.isBid ? [t1, c1] : [t0, c0];
  await wait(await mineT.write.mint([account.address, o.amount]), 'mint');
  await wait(await mineT.write.approve([mineC.address, o.amount]), 'approve');
  await wait(await mineC.write.wrap([account.address, o.amount]), 'wrap');

  const ZERO = `0x${'00'.repeat(32)}`;
  if ((await otherC.read.confidentialBalanceOf([account.address])) === ZERO) {
    await wait(await otherT.write.mint([account.address, DUST]), 'mint dust');
    await wait(await otherT.write.approve([otherC.address, DUST]), 'approve dust');
    await wait(await otherC.write.wrap([account.address, DUST]), 'wrap dust');
  }

  const until = await b.read.submitDeadline();
  await wait(await c0.write.setOperator([o.batch, Number(until)]), 'setOperator cUSDA');
  await wait(await c1.write.setOperator([o.batch, Number(until)]), 'setOperator cUSDB');

  // Two gateway encryptions, not three: side and limit tick ride together as
  // `side * 8 + tick` in one euint16. Measured round trip is ~2.3s each, and the
  // Runner is single-threaded, so this is the cheapest thing to economise on.
  const handles = await createViemHandleClient(wallet);
  const code = BigInt((o.isBid ? 1 : 0)) * SIDE_STRIDE + BigInt(o.tick);
  console.log('  encryptInput via live gateway...');
  const t = Date.now();
  const amt = await handles.encryptInput(o.amount, 'uint256', o.batch);
  const cod = await handles.encryptInput(code, 'uint16', o.batch);
  console.log(`  handles ${amt.handle} / ${cod.handle} (${Date.now() - t}ms)`);

  // The proof binds (this wallet, the batch contract), so this call MUST come
  // directly from the trader — no router, no multicall, or fromExternal reverts.
  await wait(
    await b.write.submitOrder([
      amt.handle as `0x${string}`, amt.handleProof,
      cod.handle as `0x${string}`, cod.handleProof,
      account.address, // viewer: decrypt your own recorded escrow, nobody else can
    ]),
    'submitOrder',
  );

  const id = (await b.read.orderCount()) - 1n;
  const rec = await b.read.orders([id]);
  console.log(`  order #${id} recorded: qBuy=${rec[1]} qSell=${rec[2]} tick=${rec[3]}`);
  if (!o.verify) return id;

  // The handle is on-chain instantly; the ciphertext only exists once the remote
  // Runner has processed the event. Poll, never assume.
  console.log('  decrypting own escrow (ACL-gated, gasless)...');
  for (const [label, h] of [['qBuy', rec[1]], ['qSell', rec[2]], ['tick', rec[3]]] as const) {
    for (let i = 1; i <= 30; i++) {
      try {
        const { value } = await handles.decrypt(h as `0x${string}`);
        console.log(`    ${label} = ${value}`);
        break;
      } catch (e) {
        if (i === 30) throw e;
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }
  return id;
}

// Run when invoked directly, whether that is `node scripts/submit-order.ts` or
// `npx hardhat run scripts/submit-order.ts`. Comparing import.meta.url against
// process.argv[1] does NOT work under `hardhat run`: argv[1] is Hardhat's own
// entry point, so the guard silently failed, submitOrder() was never called, and
// the script exited 0 having done nothing at all.
const selfName = import.meta.url.split('/').pop()!;
if (process.argv.some((a) => a?.replace(/\\/g, '/').endsWith(selfName))) {
  submitOrder({
    key: (process.env.TRADER_PRIVATE_KEY ?? env('DEPLOYER_PRIVATE_KEY')) as `0x${string}`,
    batch: env('BATCH_ADDRESS') as `0x${string}`,
    cToken0: env('CTOKEN0') as `0x${string}`,
    cToken1: env('CTOKEN1') as `0x${string}`,
    token0: env('TOKEN0') as `0x${string}`,
    token1: env('TOKEN1') as `0x${string}`,
    isBid: (process.env.SIDE ?? 'bid').toLowerCase() === 'bid',
    amount: parseEther(process.env.AMOUNT ?? '100'),
    tick: Number(process.env.TICK ?? '2'),
    verify: process.env.VERIFY === '1',
  }).catch((e) => { console.error(e); process.exitCode = 1; });
}
