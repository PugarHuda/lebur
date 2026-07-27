'use client';
// The trader path for a live Lebur batch: place a sealed order, watch the batch
// clear, and see exactly how little of it ever became public.
import { useCallback, useEffect, useState } from 'react';
import { formatEther, parseEther } from 'viem';
import { sepolia } from 'viem/chains';
import {
  ADDRESSES, PHASES, SIDE_STRIDE, DUST, batchAbi, cTokenAbi, erc20Abi,
  connectWallet, explorerAddr, explorerTx, pub, tx,
} from '../lib/lebur';
import { encryptOrder } from '../lib/nox';

type Batch = {
  phase: number; orders: bigint; deadline: number; ladder: bigint[];
  tick?: bigint; price?: bigint; resid0?: bigint; resid1?: bigint;
  poolUsed?: boolean; poolOut?: bigint; footprint?: bigint;
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
      if (phase >= 2) {
        next.footprint = (await pub.readContract({
          ...base, functionName: 'publicFootprint',
        })) as bigint;
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

    setStatus('5/5 encrypting size and limit in the gateway TEE…');
    const code = (isBid ? 1n : 0n) * SIDE_STRIDE + BigInt(tick);
    const { amt: eAmt, cod } = await encryptOrder(w, amt, code, ADDRESSES.batch);

    setStatus('submitting sealed order — calldata carries handles, not your numbers…');
    await send(ADDRESSES.batch, batchAbi, 'submitOrder',
      [eAmt.handle, eAmt.handleProof, cod.handle, cod.handleProof, me], 'submitOrder');
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

  const open = b && b.phase === 0 && Date.now() / 1000 <= b.deadline;
  const card: React.CSSProperties = {
    padding: '14px 16px', borderRadius: 10, background: '#fff',
    border: '1px solid #dde5f0', marginTop: 16,
  };

  return (
    <main style={{ maxWidth: 660, margin: '3rem auto', padding: '0 1rem', fontFamily: 'system-ui' }}>
      <h1 style={{ marginBottom: 4 }}>Lebur</h1>
      <p style={{ color: '#556', marginTop: 0 }}>
        A confidential uniform-price batch auction. Sealed orders net against each
        other inside a TEE; only the clearing price and the aggregate residual ever
        reach the public chain, where they settle in one trade against an{' '}
        <a href={explorerAddr(ADDRESSES.pool)} target="_blank" rel="noreferrer">unmodified Curve pool</a>.
      </p>

      <section style={card}>
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
        <section style={{ ...card, background: '#f2f8f4', borderColor: '#b9dcc6' }}>
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

      <section style={card}>
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
            {busy ? '⏳ working…' : 'Submit sealed order'}
          </button>
          <button disabled={busy || !b || b.phase !== 0 || open} onClick={() => run(clear)}>
            Clear the batch
          </button>
          <button disabled={busy} onClick={() => run(refresh)}>Refresh</button>
        </div>
        {!open && b?.phase === 0 && (
          <p style={{ fontSize: 13, color: '#666', marginBottom: 0 }}>
            Orders are closed — anyone can now clear the batch.
          </p>
        )}
      </section>

      {status && <p style={{ color: '#556' }}>{busy && '⏳ '}{status}</p>}
      {error && (
        <p role="alert" style={{
          padding: '8px 12px', borderRadius: 6, fontSize: 14,
          background: '#fdecea', border: '1px solid #f5aca6',
        }}>{error}</p>
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
