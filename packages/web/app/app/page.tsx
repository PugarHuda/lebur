'use client';
// The trader path for a live Lebur batch: place a sealed order, watch the batch
// clear, and see exactly how little of it ever became public.
import { useCallback, useEffect, useState } from 'react';
import { formatEther, parseEther } from 'viem';
import { sepolia } from 'viem/chains';
import {
  ADDRESSES, PHASES, SIDE_STRIDE, DUST, batchAbi, cTokenAbi, erc20Abi,
  connectWallet, explorerAddr, explorerTx, pub, tx, NEW_BATCH_WINDOW_SECS,
} from '../../lib/lebur';
import { encryptOrder, publicDecryptHandle, decryptMine } from '../../lib/nox';
import { connectSnap, getNoxAddress } from '../../lib/snap';
import Link from 'next/link';
import { Alert, Ext, Lock, Spinner } from '../icons';

type Batch = {
  phase: number; orders: bigint; deadline: number; ladder: bigint[];
  tick?: bigint; price?: bigint; resid0?: bigint; resid1?: bigint;
  poolUsed?: boolean; poolOut?: bigint; footprint?: bigint;
  // Whether this deployment can be reset for another auction, probed rather
  // than assumed — see refresh().
  resettable?: boolean; epoch?: bigint;
  // Order ids that have settled but not yet been paid their fill.
  unpaid?: number[];
};

export default function Home() {
  const [b, setB] = useState<Batch>();
  const [side, setSide] = useState<'bid' | 'ask'>('bid');
  const [amount, setAmount] = useState('100');
  const [tick, setTick] = useState('2');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [hashes, setHashes] = useState<{ label: string; hash: `0x${string}` }[]>([]);
  const [sealMode, setSealMode] = useState<'snap' | 'page'>();
  const [myOrderId, setMyOrderId] = useState('0');
  const [mine, setMine] = useState('');

  const track = (label: string) => (hash: `0x${string}`) =>
    setHashes((h) => [...h, { label, hash }]);

  const refresh = useCallback(async () => {
    if (!ADDRESSES.batch || ADDRESSES.batch === '0x') {
      setError('NEXT_PUBLIC_BATCH is not set — see packages/web/.env.local');
      return;
    }
    try {
      // Batch through Multicall3, which is already deployed on Sepolia and known to
      // viem — no contract change, and it works against batches already live. The
      // sequential version issued N+6 eth_calls per refresh, which is both slow and
      // how this project got rate-limited by a public RPC provider mid-deploy.
      const base = { address: ADDRESSES.batch, abi: batchAbi } as const;
      const [phaseRaw, tickCount, orders, deadline] = await pub.multicall({
        contracts: [
          { ...base, functionName: 'phase' },
          { ...base, functionName: 'tickCount' },
          { ...base, functionName: 'orderCount' },
          { ...base, functionName: 'submitDeadline' },
        ],
        allowFailure: false,
      });
      const phase = Number(phaseRaw);
      const ladder = (await pub.multicall({
        contracts: Array.from({ length: Number(tickCount) }, (_, i) => ({
          ...base, functionName: 'ladder' as const, args: [BigInt(i)],
        })),
        allowFailure: false,
      })) as bigint[];

      const next: Batch = { phase, orders: orders as bigint, deadline: Number(deadline), ladder };

      if (phase >= 1) {
        const [tick, price, resid0, resid1, poolUsed, poolOut] = await pub.multicall({
          contracts: [
            { ...base, functionName: 'clearingTickRevealed' },
            { ...base, functionName: 'clearingPrice' },
            { ...base, functionName: 'residual0Revealed' },
            { ...base, functionName: 'residual1Revealed' },
            { ...base, functionName: 'poolUsed' },
            { ...base, functionName: 'poolOut' },
          ],
          allowFailure: false,
        });
        Object.assign(next, {
          tick: tick as bigint, price: price as bigint,
          resid0: resid0 as bigint, resid1: resid1 as bigint,
          poolUsed: poolUsed as boolean, poolOut: poolOut as bigint,
        });
      }
      // Reverts with WrongPhase until Settled — reading it earlier would surface
      // as a page-wide error on a perfectly healthy batch. Kept out of the batched
      // calls above for the same reason: allowFailure:false would fail them all.
      // `epoch` is the feature probe for startNewBatch: deployments predating it
      // have no such getter, and allowFailure keeps that a fact rather than an
      // error. Never assume the configured address runs this branch's code.
      if (phase >= 2) {
        const [footprint, epoch] = await pub.multicall({
          contracts: [
            { ...base, functionName: 'publicFootprint' },
            { ...base, functionName: 'epoch' },
          ],
          allowFailure: true,
        });
        if (footprint.status === 'success') next.footprint = footprint.result as bigint;
        next.resettable = epoch.status === 'success';
        if (epoch.status === 'success') next.epoch = epoch.result as bigint;

        // Which orders are still owed their fill. Only `trader` and `paid` are
        // readable in this tuple; the sizes come back as encrypted handles.
        const n = Number(orders);
        const book = n === 0 ? [] : await pub.multicall({
          contracts: Array.from({ length: n }, (_, i) => ({
            ...base, functionName: 'orders' as const, args: [BigInt(i)],
          })),
          allowFailure: false,
        });
        next.unpaid = (book as unknown as any[][])
          .map((o, i) => (o[4] ? -1 : i))
          .filter((i) => i >= 0);
      }
      setB(next);
      setError('');
    } catch (e) {
      setError(`Failed to read batch ${ADDRESSES.batch}: ${(e as Error).message.split('\n')[0]}`);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError('');
    try { await fn(); } catch (e) {
      const m = (e as Error)?.message ?? String(e);
      setError(/User rejected|denied/i.test(m) ? 'Cancelled in wallet.' : m.split('\n')[0]);
      setStatus('');
    } finally { setBusy(false); }
  }

  async function submit() {
    const w = await connectWallet(setStatus);
    const me = w.account!.address;
    const isBid = side === 'bid';
    const amt = parseEther(amount);
    const [t, c] = isBid ? [ADDRESSES.token0, ADDRESSES.cToken0] : [ADDRESSES.token1, ADDRESSES.cToken1];
    const [ot, oc] = isBid ? [ADDRESSES.token1, ADDRESSES.cToken1] : [ADDRESSES.token0, ADDRESSES.cToken0];
    const send = (address: `0x${string}`, abi: any, functionName: string, args: any[], label: string) =>
      tx(w, { address, abi, functionName, args, chain: sepolia, account: me } as any, track(label));

    setStatus('1/5 minting test tokens…');
    await send(t, erc20Abi, 'mint', [me, amt], 'mint');
    setStatus('2/5 approving the wrapper…');
    await send(t, erc20Abi, 'approve', [c, amt], 'approve');
    setStatus('3/5 wrapping into a confidential balance…');
    await send(c, cTokenAbi, 'wrap', [me, amt], 'wrap');

    // Hold a little of the OTHER coin too. ERC-7984 reverts on transfers from an
    // uninitialised balance handle and the batcher pulls both sides blind — and an
    // address that has never held the other coin is publicly incapable of taking
    // that side, which would leak the direction of every order it places.
    const ZERO = `0x${'00'.repeat(32)}`;
    const held = await pub.readContract({
      address: oc, abi: cTokenAbi, functionName: 'confidentialBalanceOf', args: [me],
    });
    if (held === ZERO) {
      setStatus('4/5 wrapping dust of the other coin (keeps your side private)…');
      await send(ot, erc20Abi, 'mint', [me, DUST], 'mint dust');
      await send(ot, erc20Abi, 'approve', [oc, DUST], 'approve dust');
      await send(oc, cTokenAbi, 'wrap', [me, DUST], 'wrap dust');
    }

    const until = await pub.readContract({ address: ADDRESSES.batch, abi: batchAbi, functionName: 'submitDeadline' });
    await send(ADDRESSES.cToken0, cTokenAbi, 'setOperator', [ADDRESSES.batch, Number(until)], 'setOperator cUSDA');
    await send(ADDRESSES.cToken1, cTokenAbi, 'setOperator', [ADDRESSES.batch, Number(until)], 'setOperator cUSDB');

    // The EOA encrypts, ALWAYS. `Nox.fromExternal` checks that the owner of the
    // input proof is the direct msg.sender of the transaction consuming it, and
    // this transaction is sent by the EOA — so a proof owned by any other identity
    // is rejected with InvalidProof.
    //
    // This page used to prefer the Snap for encryption, which meant installing the
    // Snap made every order revert. It went unnoticed because the Snap had never
    // been loaded in a wallet: it built, it passed SES evaluation, and nothing
    // else exercised the one call that could not work.
    //
    // What the Snap is for is the VIEWER role, and that is the half that carries
    // the actual property: the viewing key is SRP-derived, lives in the sandbox,
    // and cannot be used to sign a proof of what you traded. Without it the EOA
    // holds that role and CAN prove your order to a briber.
    let viewer = me;
    let mode: 'snap' | 'page' = 'page';
    try {
      await connectSnap();
      viewer = (await getNoxAddress()).address;
      mode = 'snap';
    } catch { /* no Snap — the EOA views its own order, and can prove it. Said so below. */ }
    setSealMode(mode);

    setStatus('5/5 encrypting size and limit inside the gateway TEE…');
    const code = (isBid ? 1n : 0n) * SIDE_STRIDE + BigInt(tick);
    const { amt: eAmt, cod } = await encryptOrder(w, amt, code, ADDRESSES.batch);
    const handles = {
      amountHandle: eAmt.handle as `0x${string}`, amountProof: eAmt.handleProof as `0x${string}`,
      codeHandle: cod.handle as `0x${string}`, codeProof: cod.handleProof as `0x${string}`,
    };

    setStatus('submitting sealed order — calldata carries handles, not your numbers…');
    await send(ADDRESSES.batch, batchAbi, 'submitOrder',
      [handles.amountHandle, handles.amountProof, handles.codeHandle, handles.codeProof, viewer],
      'submitOrder');
    setStatus('sealed order placed. Nobody can see its size, side or limit.');
    await refresh();
  }

  async function clear() {
    const w = await connectWallet(setStatus);
    setStatus('clearing — scanning the whole price ladder under encryption…');
    await tx(w, {
      address: ADDRESSES.batch, abi: batchAbi, functionName: 'clear',
      chain: sepolia, account: w.account!.address,
    } as any, track('clear'));
    setStatus('cleared.');
    await refresh();
  }

  /// Reveal the clearing tick and both residuals, then settle on Curve.
  ///
  /// Three gateway-signed decryptions, and the contract re-verifies every one of
  /// them — so this is permissionless without being trusting: the caller hands
  /// over proofs, never numbers, and a caller who lies is rejected on-chain. This
  /// used to be the one step of the lifecycle that existed only in a script,
  /// which left the browser able to seal and clear a batch but not finish it.
  async function settleBatch() {
    const w = await connectWallet(setStatus);
    const base = { address: ADDRESSES.batch, abi: batchAbi } as const;
    const [tickH, id0, id1] = await pub.multicall({
      contracts: [
        { ...base, functionName: 'bestTick' },
        { ...base, functionName: 'unwrapId0' },
        { ...base, functionName: 'unwrapId1' },
      ],
      allowFailure: false,
    });

    const wait = (what: string) => (i: number, n: number) =>
      setStatus(`waiting for the Runner to publish the ${what} ciphertext… (${i}/${n})`);
    setStatus('asking the gateway to decrypt the clearing tick…');
    const tick = await publicDecryptHandle(w, tickH as `0x${string}`, wait('clearing tick'));
    setStatus('decrypting the two residuals — the only amounts this batch ever publishes…');
    const r0 = await publicDecryptHandle(w, id0 as `0x${string}`, wait('coin0 residual'));
    const r1 = await publicDecryptHandle(w, id1 as `0x${string}`, wait('coin1 residual'));

    setStatus('settling — one exchange_received against the real Curve pool…');
    await tx(w, {
      ...base, functionName: 'settle',
      args: [Number(tick.value), tick.decryptionProof, r0.decryptionProof, r1.decryptionProof],
      chain: sepolia, account: w.account!.address,
    } as any, track('settle'));
    setStatus('settled — collect the fills below.');
    await refresh();
  }

  /// Read back what the contract booked for one of YOUR orders. Gasless, and
  /// gated by the viewer role granted at submit time, so it works for your own
  /// orders and fails for everyone else's. This is the claim made inspectable:
  /// the number is on-chain the whole time and only you can turn it into a
  /// number, which is a different thing from it being hidden until someone
  /// chooses to publish it.
  async function decryptMyOrder() {
    const id = Number(myOrderId);
    const w = await connectWallet(setStatus);
    const o = (await pub.readContract({
      address: ADDRESSES.batch, abi: batchAbi, functionName: 'orders', args: [BigInt(id)],
    })) as unknown as any[];
    if (o[0].toLowerCase() !== w.account!.address.toLowerCase()) {
      throw new Error(`order ${id} belongs to ${o[0]}, not you — you can only decrypt your own.`);
    }
    const wait = (i: number, n: number) => setStatus(`waiting for the ciphertext… (${i}/${n})`);
    setStatus('decrypting your sealed order…');
    // A bid escrows coin0 and an ask coin1, so exactly one of these is non-zero —
    // which is why the side never had to be stored in the clear.
    const [qBuy, qSell] = [
      await decryptMine(w, o[1] as `0x${string}`, wait),
      await decryptMine(w, o[2] as `0x${string}`, wait),
    ];
    const bid = qBuy > 0n;
    setMine(`order ${id}: ${bid ? 'bid' : 'ask'} ${formatEther(bid ? qBuy : qSell)} ${bid ? 'lUSDA' : 'lUSDB'}`);
    setStatus('');
  }

  /// Deliver every unpaid order its fill plus whatever escrow it did not spend.
  ///
  /// Permissionless and idempotent on-chain: anyone can push anyone's payout,
  /// and the recipient was fixed at submit time, so there is nothing to trust
  /// here and nothing a stranger can redirect. Exposing it matters — without
  /// this button a trader who sealed an order on this page had no way to
  /// COLLECT it short of running `scripts/run-batch.ts` from a checkout, which
  /// makes the end-to-end path end one step short of the trader's own balance.
  async function payAll() {
    const ids = b?.unpaid ?? [];
    if (ids.length === 0) { setStatus('every order in this batch is already paid.'); return; }
    const w = await connectWallet(setStatus);
    for (const [k, id] of ids.entries()) {
      setStatus(`paying out order ${id} (${k + 1} of ${ids.length}) — fill and refund, both confidential…`);
      await tx(w, {
        address: ADDRESSES.batch, abi: batchAbi, functionName: 'payout',
        args: [BigInt(id)], chain: sepolia, account: w.account!.address,
      } as any, track(`payout ${id}`));
    }
    setStatus('all orders paid — every fill and refund moved as a confidential transfer.');
    await refresh();
  }

  /// Re-arm a settled deployment for another auction. Permissionless on-chain,
  /// exactly like clear/settle/payout — which is the point of exposing it here
  /// rather than in a script. A settled batch is a read-only artefact; this is
  /// what turns the page back into something a visitor can actually use.
  ///
  /// The contract refuses the reset until every order of the previous batch has
  /// been paid, so an unpaid trader's escrow can never be wiped by a stranger
  /// pressing this. If it reverts, that is what it is telling you.
  async function newBatch() {
    const w = await connectWallet(setStatus);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + NEW_BATCH_WINDOW_SECS);
    setStatus('opening a new batch — orders reopen for ten minutes…');
    await tx(w, {
      address: ADDRESSES.batch, abi: batchAbi, functionName: 'startNewBatch',
      args: [deadline], chain: sepolia, account: w.account!.address,
    } as any, track('startNewBatch'));
    setStatus('new batch open — place a sealed order.');
    await refresh();
  }

  const open = b && b.phase === 0 && Date.now() / 1000 <= b.deadline;

  return (
    <main className="wrap" style={{ paddingTop: 'var(--s6)', paddingBottom: 'var(--s8)' }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 'var(--s5)' }}>
        <Link href="/" className="mono dim" style={{ textDecoration: 'none' }}>← Lebur</Link>
        <span className="pill">Ethereum Sepolia</span>
      </div>
      <h2 style={{ marginBottom: 'var(--s3)' }}>Sealed order book</h2>
      <p className="dim narrow" style={{ fontSize: '0.95rem' }}>
        A confidential uniform-price batch auction. Sealed orders net against each
        other inside a TEE; only the clearing price and the aggregate residual ever
        reach the public chain, where they settle in one trade against an{' '}
        <a href={explorerAddr(ADDRESSES.pool)} target="_blank" rel="noreferrer">unmodified Curve pool</a>.
      </p>

      <section className="card">
        <b>Batch status</b>
        {!b ? <p style={{ color: '#889' }}>loading…</p> : (
          <ul style={{ margin: '8px 0 0', paddingLeft: 18, lineHeight: 1.7 }}>
            <li>phase: <b>{PHASES[b.phase] ?? b.phase}</b></li>
            <li>sealed orders: <b>{String(b.orders)}</b> — sizes, sides and limits all encrypted</li>
            <li>
              orders close: {new Date(b.deadline * 1000).toLocaleString()}{' '}
              {open ? '' : <b>(closed)</b>}
            </li>
            <li>price ladder: {b.ladder.map((p) => (Number(p) / 1e18).toFixed(4)).join(' · ')}</li>
            {b.footprint !== undefined && (
              <li>
                <b>public footprint: {formatEther(b.footprint)}</b> — the total value
                that ever reached the public chain, against {String(b.orders)} sealed
                orders whose sizes remain encrypted
              </li>
            )}
          </ul>
        )}
      </section>

      {b && b.phase >= 1 && (
        <section className="card">
          <b>Cleared</b>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18, lineHeight: 1.7 }}>
            <li>clearing tick <b>{String(b.tick)}</b> at price <b>{b.price ? (Number(b.price) / 1e18).toFixed(4) : '—'}</b></li>
            <li>residual to the public pool: {formatEther(b.resid0 ?? 0n)} / {formatEther(b.resid1 ?? 0n)}</li>
            <li>Curve leg used: <b>{b.poolUsed ? 'yes' : 'no'}</b>{b.poolUsed && b.poolOut ? ` — received ${formatEther(b.poolOut)}` : ''}</li>
          </ul>
          <p style={{ fontSize: 13, color: '#456', marginBottom: 0 }}>
            Everything else — every order&apos;s size, side, limit and fill — stays
            encrypted forever.
          </p>
        </section>
      )}

      <section className="card">
        <b>Place a sealed order</b>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
          <label>
            side{' '}
            <select value={side} onChange={(e) => setSide(e.target.value as 'bid' | 'ask')}>
              <option value="bid">bid (pay lUSDA, want lUSDB)</option>
              <option value="ask">ask (sell lUSDB, want lUSDA)</option>
            </select>
          </label>
          <label>amount <input size={8} value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
          <label>
            limit tick{' '}
            <select value={tick} onChange={(e) => setTick(e.target.value)}>
              {(b?.ladder ?? []).map((p, i) => (
                <option key={i} value={i}>{i} — {(Number(p) / 1e18).toFixed(4)}</option>
              ))}
            </select>
          </label>
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <button disabled={busy || !open} onClick={() => run(submit)}>
            {busy ? 'working…' : 'Submit sealed order'}
          </button>
          <button className="ghost" disabled={busy || !b || b.phase !== 0 || open} onClick={() => run(clear)}>
            Clear the batch
          </button>
          <button className="ghost" disabled={busy} onClick={() => run(refresh)}>Refresh</button>
        </div>
        {!open && b?.phase === 0 && (
          <p style={{ fontSize: 13, color: '#666', marginBottom: 0 }}>
            Orders are closed — anyone can now clear the batch.
          </p>
        )}
        {b?.phase === 1 && (
          <p style={{ fontSize: 13, color: '#666', marginBottom: 0 }}>
            This batch has cleared. Settling it is the next step, and anyone can do
            it — see the panel below.
          </p>
        )}
        {b?.phase === 2 && (
          <p style={{ fontSize: 13, color: '#666', marginBottom: 0 }}>
            This batch is <b>settled</b>, so it takes no new orders — the numbers
            above are its final, permanent record.{' '}
            {b.resettable
              ? 'Anyone can open a fresh one on this same deployment with the button below, then place a sealed order against it.'
              : 'This deployment predates startNewBatch, so it cannot be re-armed; deploy a fresh batcher with scripts/deploy-sepolia.ts and paste its block into packages/web/.env.local to trade.'}
          </p>
        )}
      </section>

      {b?.phase === 1 && (
        <section className="card">
          <b>Settle the batch — anyone can do this</b>
          <p style={{ fontSize: 13, color: '#456', margin: '6px 0 10px' }}>
            Reveals the clearing tick and both residuals — the only three numbers this
            batch ever publishes — and pushes the residual through one
            {' '}<code>exchange_received</code> against the real Curve pool. Each
            number arrives as a gateway signature that the contract verifies itself,
            so whoever presses this hands over proofs rather than figures, and cannot
            influence a single one of them.
          </p>
          <button disabled={busy} onClick={() => run(settleBatch)}>
            {busy ? 'working…' : 'Reveal and settle'}
          </button>
        </section>
      )}

      {b && b.orders > 0n && (
        <section className="card">
          <b>Read your own order back</b>
          <p style={{ fontSize: 13, color: '#456', margin: '6px 0 10px' }}>
            Gasless, and gated by the viewer role granted when the order was sealed:
            it works for your orders and fails for everyone else&apos;s. The size sits
            on-chain the entire time — what makes it private is that only you can turn
            it into a number.
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <label>order id <input size={4} value={myOrderId} onChange={(e) => setMyOrderId(e.target.value)} /></label>
            <button disabled={busy} onClick={() => run(decryptMyOrder)}>Decrypt my order</button>
          </div>
          {mine && <p style={{ marginTop: 10, fontSize: 14 }}><b>{mine}</b></p>}
        </section>
      )}

      {b?.phase === 2 && b.unpaid !== undefined && (
        <section className="card">
          <b>Collect the fills — anyone can push any order&apos;s payout</b>
          <p style={{ fontSize: 13, color: '#456', margin: '6px 0 10px' }}>
            Each order gets its pro-rata fill at the clearing price plus a refund of
            whatever escrow it did not spend, both moved as confidential transfers —
            the amounts stay encrypted even as they are paid. The recipient was fixed
            when the order was sealed, so pushing someone else&apos;s payout can only
            ever pay <i>them</i>.{' '}
            {b.unpaid.length === 0
              ? 'All orders in this batch are paid.'
              : `${b.unpaid.length} of ${String(b.orders)} still awaiting payout.`}
          </p>
          <button disabled={busy || b.unpaid.length === 0} onClick={() => run(payAll)}>
            {busy ? 'working…' : `Pay out ${b.unpaid.length || 'all'} order${b.unpaid.length === 1 ? '' : 's'}`}
          </button>
        </section>
      )}

      {b?.phase === 2 && b.resettable && (
        <section className="card">
          <b>One deployment, many auctions — anyone can start the next one</b>
          <p style={{ fontSize: 13, color: '#456', margin: '6px 0 10px' }}>
            Resetting is permissionless, like every other step here: there is no
            operator in this system to ask. The contract refuses while any order of
            the settled batch is still unpaid, so nobody can wipe an escrow you have
            not collected yet. Epoch {String(b.epoch ?? 0n)} closes; the next opens
            for ten minutes.
          </p>
          <button disabled={busy || (b.unpaid?.length ?? 0) > 0} onClick={() => run(newBatch)}>
            {busy ? 'working…' : 'Start a new batch'}
          </button>
          {(b.unpaid?.length ?? 0) > 0 && (
            <span style={{ marginLeft: 10, fontSize: 13, color: '#666' }}>
              pay out the {b.unpaid!.length} remaining order
              {b.unpaid!.length === 1 ? '' : 's'} first
            </span>
          )}
        </section>
      )}

      {status && <p className="dim row" style={{ fontSize: '0.9rem' }}>{busy && <Spinner />}{status}</p>}
      {error && (
        <div role="alert" className="note note-err"><Alert /> {error}</div>
      )}
      {sealMode && (
        <div className={`note ${sealMode === 'snap' ? 'note-ok' : 'note-warn'}`} style={{ marginTop: 'var(--s4)' }}>
          {sealMode === 'snap'
            ? <><Lock /> <strong>Coercion-resistant.</strong> The viewing key for this order is derived from your SRP and lives inside the MetaMask Snap sandbox. You can read your own order; you cannot sign anything that proves it to anyone else.</>
            : <><Alert /> <strong>Snap not installed.</strong> Your EOA holds the viewing role. The order is still sealed on-chain and invisible to everyone else, but that key CAN be used to prove what you traded, so this order is not coercion-resistant. Install the Snap for the full guarantee.</>}
        </div>
      )}
      {hashes.length > 0 && (
        <ul style={{ fontSize: 13, paddingLeft: 18 }}>
          {hashes.map(({ label, hash }) => (
            <li key={hash}>
              {label}: <a href={explorerTx(hash)} target="_blank" rel="noreferrer">{hash.slice(0, 10)}…</a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
