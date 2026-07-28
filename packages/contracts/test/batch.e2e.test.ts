import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { nox, NOX_COMPUTE_ADDRESS, handleGatewayUrl } from '@iexec-nox/nox-hardhat-plugin';
import { createViemHandleClient } from '@iexec-nox/handle';
import { parseEther } from 'viem';
// The oracle IS the expectation. Importing it also runs its own ~13,000-batch check
// suite, so a drift between spec and implementation cannot hide.
import { auction, bid, ask, tok, LADDER, DEMO } from '../../../reference/lebur-reference.mjs';

// A handle client whose input-proof owner is a SPECIFIC trader. `fromExternal` binds
// the proof to (wallet, contract) and the wallet must be the direct msg.sender, and
// the Handle SDK reads the owner from walletClient.getAddresses()[0]. On a hardhat
// node eth_accounts returns ALL accounts, so [0] is always account #0 — shim
// getAddresses to this trader's own account. A browser provider returns only the
// connected account, so a dApp needs no shim.
const traderHandleClient = (wallet: any) =>
  createViemHandleClient(
    { ...wallet, getAddresses: async () => [wallet.account.address] },
    {
      smartContractAddress: NOX_COMPUTE_ADDRESS,
      gatewayUrl: handleGatewayUrl(),
      // All-or-nothing override: filling two of three fields breaks viewACL silently.
      subgraphUrl: 'https://example.com/subgraphs/id/none',
    },
  );

/// The handle exists on-chain the instant the transaction confirms, but the ciphertext
/// only exists once the Runner has processed the event. Never decrypt without a retry.
async function decryptWithRetry(client: any, handle: `0x${string}`, tries = 20) {
  for (let i = 1; ; i++) {
    try {
      return (await client.decrypt(handle)).value as bigint;
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

const ZERO_HANDLE = `0x${'00'.repeat(32)}` as const;
const FEE_WAD = 999_900_000_000_000_000n; // 1bp, what StableSwap charges at the peg

// Keep the submit window SHORT and the time travel just past it. A gateway
// handleProof expires after `proofExpirationDuration()`, which defaults to one hour,
// and it is signed against WALL CLOCK while `evm_increaseTime` moves only the CHAIN
// clock — and that drift persists across tests on the shared node. Jumping an hour in
// the first test made every proof in the second one "Proof expired", which reads like
// a broken contract and is really just a clock skew. 60s of window is plenty.
const SUBMIT_WINDOW = 60n;
const TIME_TRAVEL = ['0x3D']; // 61s

/// Nox cost is per-op pipeline latency, so gas is the closest proxy we can measure
/// locally for the live-demo envelope. Printed, not asserted — the EDR node is not
/// Sepolia, and asserting on a gas number is how a suite starts lying.
async function gas(pub: any, hash: `0x${string}`, label: string) {
  const rc = await pub.waitForTransactionReceipt({ hash });
  console.log(`      gas ${String(rc.gasUsed).padStart(9)}  ${label}`);
  return rc.gasUsed as bigint;
}

describe('Lebur confidential uniform-price batch auction', () => {
  it('nets sealed orders, clears at one price, and settles only the residual on the pool', async () => {
    const conn = await nox.connect();
    const { viem } = conn;
    const [op, alice, bob] = await viem.getWalletClients();
    const pub = await viem.getPublicClient();

    // ── coins and their confidential wrappers ────────────────────────────────
    const t0 = await viem.deployContract('FaucetERC20', ['USD A', 'USDA', 18]);
    const t1 = await viem.deployContract('FaucetERC20', ['USD B', 'USDB', 18]);
    const c0 = await viem.deployContract('ConfidentialToken', ['Confidential USDA', 'cUSDA', t0.address]);
    const c1 = await viem.deployContract('ConfidentialToken', ['Confidential USDB', 'cUSDB', t1.address]);

    // Test double for Curve, which lives on Sepolia and not on a fresh EDR node. The
    // auction, the Nox compute and the ERC-7984 escrow below are all real.
    const pool = await viem.deployContract('MockCurvePool', [t0.address, t1.address, FEE_WAD]);
    const seed = parseEther('100000');
    for (const [tok_, amt] of [[t0, seed], [t1, seed]] as const) {
      await tok_.write.mint([op.account.address, amt]);
      await tok_.write.approve([pool.address, amt]);
    }
    await pool.write.add_liquidity([[seed, seed], 0n]);

    // ── the batch ────────────────────────────────────────────────────────────
    const now = (await pub.getBlock()).timestamp;
    const deadline = now + SUBMIT_WINDOW;
    // The constructor wraps zero of each coin for itself, which needs an allowance
    // path to exist; a zero-value transferFrom needs no approval on OZ ERC-20.
    const batch = await viem.deployContract('LeburBatch', [
      t0.address, t1.address, c0.address, c1.address, pool.address,
      0, 1, [...LADDER], deadline,
    ]);

    // Two bids and one ask; the exact book from reference section 1. Alice bids the
    // top of the ladder, Bob bids one tick lower and will end up out of the money,
    // the operator asks at the floor. Demand outruns supply, so the batch is
    // demand-heavy and leaves a coin0 residual for Curve.
    const BOOK = [
      { w: alice, side: 1, amount: tok(1000), tick: 2 }, // bid, max 1.0005
      { w: bob, side: 1, amount: tok(500), tick: 1 },    // bid, max 1.0000
      { w: op, side: 0, amount: tok(600), tick: 0 },     // ask, min 0.9995
    ];
    assert.deepEqual(
      BOOK.map((o) => (o.side === 1 ? bid(o.amount, o.tick) : ask(o.amount, o.tick))),
      DEMO,
      'the on-chain book must be the book the oracle was run against',
    );

    // Every trader wraps BOTH coins. The unused side is dust, but it must exist: an
    // ERC-7984 transfer from an uninitialised balance handle reverts, and the batcher
    // pulls from both tokens without knowing which side an order is on. Holding both
    // is also what keeps the side private — a trader who has never held cUSDA is
    // publicly incapable of bidding.
    const DUST = 1n;
    for (const o of BOOK) {
      const acct = { account: o.w.account };
      const [mine, other] = o.side === 1 ? [[t0, c0], [t1, c1]] : [[t1, c1], [t0, c0]];
      await (mine[0] as any).write.mint([o.w.account.address, o.amount], acct);
      await (mine[0] as any).write.approve([(mine[1] as any).address, o.amount], acct);
      await (mine[1] as any).write.wrap([o.w.account.address, o.amount], acct);
      await (other[0] as any).write.mint([o.w.account.address, DUST], acct);
      await (other[0] as any).write.approve([(other[1] as any).address, DUST], acct);
      await (other[1] as any).write.wrap([o.w.account.address, DUST], acct);
      // Operator on both wrappers so the batcher can pull either side.
      await c0.write.setOperator([batch.address, Number(deadline)], acct);
      await c1.write.setOperator([batch.address, Number(deadline)], acct);
    }

    // Submit. TWO gateway encryptions per order, not three: the side and the limit
    // tick travel packed as `side * 8 + tick` in one euint16, and the contract
    // unpacks with div/sub because Nox has no mod.
    for (const o of BOOK) {
      const client = await traderHandleClient(o.w);
      const amt = await client.encryptInput(o.amount, 'uint256', batch.address);
      const code = await client.encryptInput(BigInt(o.side * 8 + o.tick), 'uint16', batch.address);
      await gas(pub, await batch.write.submitOrder(
        [amt.handle, amt.handleProof, code.handle, code.handleProof, o.w.account.address],
        { account: o.w.account },
      ), 'submitOrder');
    }
    assert.equal(await batch.read.orderCount(), 3n);

    // ── clear ────────────────────────────────────────────────────────────────
    // Chain-relative: EDR genesis time is not wall clock, so travel past the deadline.
    await conn.provider.request({ method: 'evm_increaseTime', params: TIME_TRAVEL });
    await conn.provider.request({ method: 'evm_mine', params: [] });
    await gas(pub, await batch.write.clear(), `clear() T=4 N=3, ~209 encrypted ops`);
    assert.equal(Number(await batch.read.phase()), 1, 'phase == Cleared');

    // ── settle ───────────────────────────────────────────────────────────────
    // Everything below is public: the clearing tick and the two residual handles, and
    // nothing else. Each is a gateway-signed decryption the contract re-verifies.
    const tickHandle = (await batch.read.bestTick()) as `0x${string}`;
    const tickReveal = await nox.publicDecrypt(tickHandle);
    const id0 = (await batch.read.unwrapId0()) as `0x${string}`;
    const id1 = (await batch.read.unwrapId1()) as `0x${string}`;
    const r0Reveal = await nox.publicDecrypt(id0);
    const r1Reveal = await nox.publicDecrypt(id1);

    // bestTick and the residual do not depend on what the pool later returns.
    const expected = auction([...LADDER], DEMO);
    assert.equal(Number(tickReveal.value), expected.c.bestTick, 'clearing tick matches the oracle');
    assert.equal(r0Reveal.value as bigint, expected.c.R0, 'coin0 residual matches the oracle');
    assert.equal(r1Reveal.value as bigint, expected.c.R1, 'coin1 residual matches the oracle');

    await gas(pub, await batch.write.settle([
      Number(tickReveal.value),
      tickReveal.decryptionProof,
      r0Reveal.decryptionProof,
      r1Reveal.decryptionProof,
    ]), 'settle() incl. 2 finalizeUnwrap + exchange_received');
    assert.equal(Number(await batch.read.phase()), 2, 'phase == Settled');
    assert.equal(await batch.read.poolUsed(), true, 'a 1bp pool must clear the _min_dy bound');
    const poolOut = (await batch.read.poolOut()) as bigint;

    // Re-run the oracle with the pool output the pool actually produced.
    const oracle = auction([...LADDER], DEMO, poolOut);
    assert.equal(await batch.read.clearingPrice(), LADDER[oracle.c.bestTick]);
    assert.equal(await batch.read.residual0Revealed(), oracle.c.R0);
    assert.equal(oracle.s.swapped, true, 'oracle agrees the leg should have run');

    // THE HEADLINE: only the residual reached the public pool. Everything else crossed
    // inside the contract at one price and is invisible on-chain.
    const routed = (await batch.read.publicFootprint()) as bigint;
    const gross = oracle.c.bestDq + oracle.c.C0;
    assert.equal(routed, oracle.c.R0 + oracle.c.R1);
    assert.ok(routed * 3n < gross, 'the public pool must see a small fraction of the batch');

    // ── payouts, still confidential ──────────────────────────────────────────
    for (let i = 0; i < BOOK.length; i++) {
      await gas(pub, await batch.write.payout([BigInt(i)]), `payout(${i})`);
    }
    // Idempotent: a second push must be a no-op, not a double payment.
    await batch.write.payout([0n]);

    // Balances stay encrypted. Each trader is a permanent admin on their OWN balance
    // handle (ERC7984Base grants it), so they can decrypt it and nobody else can —
    // which is the property that makes the auction sealed rather than merely delayed.
    for (const [i, o] of BOOK.entries()) {
      const client = await traderHandleClient(o.w);
      const h0 = (await c0.read.confidentialBalanceOf([o.w.account.address])) as `0x${string}`;
      const h1 = (await c1.read.confidentialBalanceOf([o.w.account.address])) as `0x${string}`;
      assert.notEqual(h0, ZERO_HANDLE, `trader ${i} coin0 balance handle exists`);
      assert.notEqual(h1, ZERO_HANDLE, `trader ${i} coin1 balance handle exists`);
      const bal0 = await decryptWithRetry(client, h0);
      const bal1 = await decryptWithRetry(client, h1);
      const row = oracle.p.rows[i];
      // Wrapped escrow left the trader at submit; the payout came back. What remains
      // is the untraded dust of the other side plus the payout.
      const keep0 = o.side === 1 ? 0n : DUST;
      const keep1 = o.side === 1 ? DUST : 0n;
      assert.equal(bal0, keep0 + row.coin0Out, `trader ${i} final coin0`);
      assert.equal(bal1, keep1 + row.coin1Out, `trader ${i} final coin1`);
    }

    // Bob bid below the clearing tick, so he is out of the money and must come out
    // exactly whole — a losing bid is not a donation.
    assert.equal(oracle.p.rows[1].coin0Out, tok(500));
    assert.equal(oracle.p.rows[1].coin1Out, 0n);

    // ── the deployment is reusable ───────────────────────────────────────────
    // Everything above is one auction. A batcher that can only ever run a single
    // batch would have to be redeployed per epoch, and each redeploy is ~3.6M gas.
    assert.equal(await batch.read.paidCount(), BigInt(BOOK.length), 'every order paid');

    const nowTs = (await pub.getBlock()).timestamp;
    await assert.rejects(
      () => batch.write.startNewBatch([nowTs + 10n]),
      /deadline out of range/,
      'a window that closes almost immediately is refused',
    );
    await assert.rejects(
      () => batch.write.startNewBatch([nowTs + 60n * 60n * 24n * 365n]),
      /deadline out of range/,
      'a window that parks the deployment for a year is refused',
    );

    await batch.write.startNewBatch([nowTs + 600n]);
    assert.equal(Number(await batch.read.phase()), 0, 'back to Open');
    assert.equal(await batch.read.epoch(), 1n, 'epoch bumped');
    assert.equal(Number(await batch.read.orderCount()), 0, 'order book cleared');
    assert.equal(await batch.read.paidCount(), 0n);
    // The public mirrors of the previous batch must not leak into the new one —
    // a stale clearing price would misreport an auction that has not happened yet.
    assert.equal(await batch.read.clearingTickRevealed(), 0n);
    assert.equal(await batch.read.residual0Revealed(), 0n);
    assert.equal(await batch.read.poolUsed(), false);
  });

  it('skips the Curve leg when the pool cannot meet the clearing price, and refunds', async () => {
    const conn = await nox.connect();
    const { viem } = conn;
    const [op, alice] = await viem.getWalletClients();
    const pub = await viem.getPublicClient();

    const t0 = await viem.deployContract('FaucetERC20', ['USD A', 'USDA', 18]);
    const t1 = await viem.deployContract('FaucetERC20', ['USD B', 'USDB', 18]);
    const c0 = await viem.deployContract('ConfidentialToken', ['cUSDA', 'cUSDA', t0.address]);
    const c1 = await viem.deployContract('ConfidentialToken', ['cUSDB', 'cUSDB', t1.address]);
    // A pool 5% below par: far under the _min_dy the clearing price demands, so the
    // residual must NOT be sold into it. This is the case a naive implementation gets
    // wrong by dumping the residual at whatever the pool offers.
    const pool = await viem.deployContract('MockCurvePool', [t0.address, t1.address, 950_000_000_000_000_000n]);
    const seed = parseEther('100000');
    for (const tok_ of [t0, t1]) {
      await tok_.write.mint([op.account.address, seed]);
      await tok_.write.approve([pool.address, seed]);
    }
    await pool.write.add_liquidity([[seed, seed], 0n]);

    const now = (await pub.getBlock()).timestamp;
    const deadline = now + SUBMIT_WINDOW;
    const batch = await viem.deployContract('LeburBatch', [
      t0.address, t1.address, c0.address, c1.address, pool.address,
      0, 1, [...LADDER], deadline,
    ]);

    const BOOK = [
      { w: alice, side: 1, amount: tok(1000), tick: 2 },
      { w: op, side: 0, amount: tok(600), tick: 0 },
    ];
    const ORDERS = [bid(tok(1000), 2), ask(tok(600), 0)];
    const DUST = 1n;
    for (const o of BOOK) {
      const acct = { account: o.w.account };
      const [mine, other] = o.side === 1 ? [[t0, c0], [t1, c1]] : [[t1, c1], [t0, c0]];
      await (mine[0] as any).write.mint([o.w.account.address, o.amount], acct);
      await (mine[0] as any).write.approve([(mine[1] as any).address, o.amount], acct);
      await (mine[1] as any).write.wrap([o.w.account.address, o.amount], acct);
      await (other[0] as any).write.mint([o.w.account.address, DUST], acct);
      await (other[0] as any).write.approve([(other[1] as any).address, DUST], acct);
      await (other[1] as any).write.wrap([o.w.account.address, DUST], acct);
      await c0.write.setOperator([batch.address, Number(deadline)], acct);
      await c1.write.setOperator([batch.address, Number(deadline)], acct);
      const client = await traderHandleClient(o.w);
      const amt = await client.encryptInput(o.amount, 'uint256', batch.address);
      const code = await client.encryptInput(BigInt(o.side * 8 + o.tick), 'uint16', batch.address);
      await batch.write.submitOrder(
        [amt.handle, amt.handleProof, code.handle, code.handleProof, o.w.account.address],
        acct,
      );
    }

    await conn.provider.request({ method: 'evm_increaseTime', params: TIME_TRAVEL });
    await conn.provider.request({ method: 'evm_mine', params: [] });
    await batch.write.clear();

    const tickReveal = await nox.publicDecrypt((await batch.read.bestTick()) as `0x${string}`);
    const r0 = await nox.publicDecrypt((await batch.read.unwrapId0()) as `0x${string}`);
    const r1 = await nox.publicDecrypt((await batch.read.unwrapId1()) as `0x${string}`);
    await batch.write.settle([
      Number(tickReveal.value), tickReveal.decryptionProof, r0.decryptionProof, r1.decryptionProof,
    ]);

    assert.equal(await batch.read.poolUsed(), false, 'a pool below _min_dy must be skipped');
    assert.equal(await batch.read.poolOut(), 0n);
    // The residual was unwrapped and then re-wrapped, so nothing plaintext is stranded
    // in the batcher: that re-wrap is what makes the skip path safe rather than a leak.
    assert.equal(await t0.read.balanceOf([batch.address]), 0n, 'no plaintext coin0 stranded');
    assert.equal(await t1.read.balanceOf([batch.address]), 0n, 'no plaintext coin1 stranded');

    const oracle = auction([...LADDER], ORDERS, null as any);
    assert.equal(oracle.s.swapped, false, 'oracle agrees the leg should be skipped');
    for (let i = 0; i < BOOK.length; i++) await batch.write.payout([BigInt(i)]);
    for (const [i, o] of BOOK.entries()) {
      const client = await traderHandleClient(o.w);
      const bal0 = await decryptWithRetry(client, (await c0.read.confidentialBalanceOf([o.w.account.address])) as `0x${string}`);
      const bal1 = await decryptWithRetry(client, (await c1.read.confidentialBalanceOf([o.w.account.address])) as `0x${string}`);
      const keep0 = o.side === 1 ? 0n : DUST;
      const keep1 = o.side === 1 ? DUST : 0n;
      assert.equal(bal0, keep0 + oracle.p.rows[i].coin0Out, `trader ${i} coin0 with the leg skipped`);
      assert.equal(bal1, keep1 + oracle.p.rows[i].coin1Out, `trader ${i} coin1 with the leg skipped`);
    }
    // The bidder is only partly filled now, and gets the unspent coin0 back — the
    // auction degraded to a plain pro-rata call auction instead of taking a bad price.
    assert.ok(oracle.p.rows[0].coin0Out > 0n, 'the unfilled part of the bid is refunded');
    assert.ok(oracle.p.rows[0].coin1Out > 0n, 'the crossed part still filled');
  });
});
