import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { nox } from '@iexec-nox/nox-hardhat-plugin';
import { parseEther } from 'viem';
import { LADDER } from '../../../reference/lebur-reference.mjs';

// Guard / phase / validation tests. None of these submits a real order: every case
// here reverts before any encrypted arithmetic runs, so the whole file costs a few
// deploys and no gateway round trips. The mechanism itself lives in batch.e2e.test.ts.
//
// Window stays SHORT and time travel just past it — a handleProof is signed against
// the WALL clock while evm_increaseTime moves only the CHAIN clock, and that drift
// persists across files on the shared node. See batch.e2e.test.ts.
const SUBMIT_WINDOW = 60n;
const TRAVEL = ['0x3D']; // 61s
const FEE_WAD = 999_900_000_000_000_000n;
const ZERO_HANDLE = `0x${'00'.repeat(32)}` as const;

async function fixture(ladder: bigint[] = [...LADDER]) {
  const conn = await nox.connect();
  const { viem } = conn;
  const [op] = await viem.getWalletClients();
  const pub = await viem.getPublicClient();

  const t0 = await viem.deployContract('FaucetERC20', ['USD A', 'USDA', 18]);
  const t1 = await viem.deployContract('FaucetERC20', ['USD B', 'USDB', 18]);
  const c0 = await viem.deployContract('ConfidentialToken', ['Confidential USDA', 'cUSDA', t0.address]);
  const c1 = await viem.deployContract('ConfidentialToken', ['Confidential USDB', 'cUSDB', t1.address]);
  const pool = await viem.deployContract('MockCurvePool', [t0.address, t1.address, FEE_WAD]);

  const now = (await pub.getBlock()).timestamp;
  const deploy = (l: bigint[], deadline = now + SUBMIT_WINDOW) =>
    viem.deployContract('LeburBatch', [
      t0.address, t1.address, c0.address, c1.address, pool.address, 0, 1, l, deadline,
    ]);

  return { conn, viem, pub, op, t0, t1, c0, c1, pool, deploy, now };
}

const travel = async (conn: any) => {
  await conn.provider.request({ method: 'evm_increaseTime', params: TRAVEL });
  await conn.provider.request({ method: 'evm_mine', params: [] });
};

describe('LeburBatch guards', () => {
  // The ladder is the auction's grammar: prices must be non-zero and strictly
  // increasing or the argmax has no well-defined peak and eligibility comparisons
  // stop meaning anything. Cheaper to reject at construction than to discover later.
  it('rejects a malformed price ladder at construction', async () => {
    const { deploy } = await fixture();
    await assert.rejects(() => deploy([]), /BadLadder/, 'empty ladder');
    await assert.rejects(() => deploy([0n]), /BadLadder/, 'zero price');
    await assert.rejects(
      () => deploy([parseEther('1'), parseEther('1')]),
      /BadLadder/,
      'flat ladder is not strictly increasing',
    );
    await assert.rejects(
      () => deploy([parseEther('1.001'), parseEther('1')]),
      /BadLadder/,
      'descending ladder',
    );
  });

  it('accepts a well-formed ladder', async () => {
    const { deploy } = await fixture();
    const batch = await deploy([...LADDER]);
    assert.equal(Number(await batch.read.tickCount()), LADDER.length);
    assert.equal(Number(await batch.read.phase()), 0, 'starts Open');
  });

  it('refuses to clear while orders are still open', async () => {
    const { deploy } = await fixture();
    const batch = await deploy([...LADDER]);
    await assert.rejects(() => batch.write.clear(), /DeadlineNotReached/);
  });

  it('refuses orders once the window has closed', async () => {
    const { deploy, conn, op } = await fixture();
    const batch = await deploy([...LADDER]);
    await travel(conn);
    // The deadline check runs before fromExternal, so dummy handles never get read.
    await assert.rejects(
      () => batch.write.submitOrder([ZERO_HANDLE, '0x', ZERO_HANDLE, '0x', op.account.address]),
      /DeadlinePassed/,
    );
  });

  it('will not pay out before the batch has settled', async () => {
    const { deploy } = await fixture();
    const batch = await deploy([...LADDER]);
    await assert.rejects(() => batch.write.payout([0n]), /WrongPhase/);
  });

  // publicFootprint is the privacy claim as a number, so it must not be readable
  // until it is actually final — a partial answer here would understate what the
  // batch ended up exposing.
  it('will not report a public footprint before settlement', async () => {
    const { deploy } = await fixture();
    const batch = await deploy([...LADDER]);
    await assert.rejects(() => batch.read.publicFootprint(), /WrongPhase/);
  });

  it('clears an empty book without reverting', async () => {
    const { deploy, conn } = await fixture();
    const batch = await deploy([...LADDER]);
    await travel(conn);
    // No orders at all: demand and supply are zero at every tick, so the argmax has
    // nothing to find. It must still terminate and leave a well-defined state rather
    // than trapping the batch in Open forever.
    await batch.write.clear();
    assert.equal(Number(await batch.read.phase()), 1, 'phase == Cleared');
    assert.equal(Number(await batch.read.orderCount()), 0);
  });
});
