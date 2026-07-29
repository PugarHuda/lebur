'use client';
// Landing page. The trader UI moved to /app — this is what a judge hits first.
//
// The batch numbers are READ FROM CHAIN. A landing page that hardcodes its own
// metrics is a screenshot, and the entire claim here is that you can check it.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { formatEther } from 'viem';
import { ADDRESSES, batchAbi, PHASES, pub, explorerAddr } from '../lib/lebur';
import { Ext, Lock } from './icons';

const SETTLED = '0x6a022daacef56e7751828b17a3da3486950008b2' as const;

type Open = { phase: number; orders: bigint; deadline: number };
type Done = { tick: bigint; price: bigint; resid0: bigint; poolOut: bigint; footprint: bigint };

export default function Landing() {
  const [open, setOpen] = useState<Open>();
  const [done, setDone] = useState<Done>();

  useEffect(() => {
    (async () => {
      const live = { address: ADDRESSES.batch, abi: batchAbi } as const;
      const [phase, orders, deadline] = await pub.multicall({
        contracts: [
          { ...live, functionName: 'phase' },
          { ...live, functionName: 'orderCount' },
          { ...live, functionName: 'submitDeadline' },
        ],
        allowFailure: false,
      });
      setOpen({ phase: Number(phase), orders: orders as bigint, deadline: Number(deadline) });

      const s = { address: SETTLED, abi: batchAbi } as const;
      const [tick, price, resid0, poolOut, footprint] = await pub.multicall({
        contracts: [
          { ...s, functionName: 'clearingTickRevealed' },
          { ...s, functionName: 'clearingPrice' },
          { ...s, functionName: 'residual0Revealed' },
          { ...s, functionName: 'poolOut' },
          { ...s, functionName: 'publicFootprint' },
        ],
        allowFailure: false,
      });
      setDone({
        tick: tick as bigint, price: price as bigint, resid0: resid0 as bigint,
        poolOut: poolOut as bigint, footprint: footprint as bigint,
      });
    })().catch(() => { /* landing must render regardless; /app surfaces read errors */ });
  }, []);

  const fmt = (v?: bigint) => (v === undefined ? '—' : Number(formatEther(v)).toLocaleString(undefined, { maximumFractionDigits: 3 }));

  return (
    <main>
      <section className="wrap hero">
        <div className="eyebrow">iExec Nox · unmodified Curve StableSwap-NG</div>
        <h1>Trade at size.<br />Show the pool one number.</h1>
        <p className="lede">
          A large order on a public AMM is visible before it executes — your size, your
          direction, your intent. Lebur seals orders inside a TEE, nets them against each
          other, and settles <strong>only the residual</strong> through a single
          {' '}<span className="mono">exchange_received</span> on a real Curve pool.
        </p>
        <div className="row" style={{ marginTop: 'var(--s5)' }}>
          <Link href="/app"><button>Open the app</button></Link>
          <a href="https://github.com/PugarHuda/lebur" target="_blank" rel="noreferrer">
            <button className="ghost">Read the code <Ext /></button>
          </a>
        </div>
        {open && (
          <p className="dim" style={{ marginTop: 'var(--s4)', fontSize: '0.9rem' }}>
            {PHASES[open.phase]} · {String(open.orders)} sealed orders ·
            {' '}window closes {new Date(open.deadline * 1000).toLocaleDateString()}
          </p>
        )}
      </section>

      <section className="wrap">
        <h2>600 of 1000 never touched the chain</h2>
        <p className="dim narrow">
          A real settled batch on Sepolia: one bid of 1000, one ask of 600. They crossed
          inside the enclave at a single clearing price, and the pool saw one trade
          instead of two counterparties.
        </p>
        <div className="grid">
          <div className="card">
            <div className="dim" style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Clearing price</div>
            <div className="stat">{done ? Number(formatEther(done.price)).toFixed(4) : '—'}</div>
            <div className="dim" style={{ fontSize: '0.85rem' }}>tick {done ? String(done.tick) : '—'}</div>
          </div>
          <div className="card">
            <div className="dim" style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Public footprint</div>
            <div className="stat" style={{ color: 'var(--accent)' }}>{fmt(done?.footprint)}</div>
            <div className="dim" style={{ fontSize: '0.85rem' }}>all the value that ever became visible</div>
          </div>
          <div className="card">
            <div className="dim" style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Curve leg received</div>
            <div className="stat">{fmt(done?.poolOut)}</div>
            <div className="dim" style={{ fontSize: '0.85rem' }}>one <span className="mono">exchange_received</span></div>
          </div>
        </div>
        <p className="dim" style={{ fontSize: '0.85rem' }}>
          Read live from{' '}
          <a href={explorerAddr(SETTLED)} target="_blank" rel="noreferrer" className="mono">
            {SETTLED.slice(0, 10)}… <Ext />
          </a>
          {' '}— not typed into this page.
        </p>
      </section>

      <section className="wrap">
        <h2>Be precise about what leaks</h2>
        <div className="grid">
          <div className="card">
            <h3>Public, by necessity</h3>
            <p className="dim" style={{ margin: 0, fontSize: '0.92rem' }}>
              The clearing price and the aggregate residual. A public pool has to see what
              it is being asked to trade — claiming otherwise would be a lie.
            </p>
          </div>
          <div className="card">
            <h3>Encrypted, forever</h3>
            <p className="dim" style={{ margin: 0, fontSize: '0.92rem' }}>
              Every order&apos;s size, side, limit and fill. Three numbers leave the enclave
              per batch; nothing else ever does.
            </p>
          </div>
          <div className="card">
            <h3>Not a slippage story</h3>
            <p className="dim" style={{ margin: 0, fontSize: '0.92rem' }}>
              Curve is flat at the peg, so the residual settles at roughly par either way.
              The claim is confidentiality and MEV resistance at size — not saved slippage.
            </p>
          </div>
        </div>
      </section>

      <section className="wrap">
        <div className="card">
          <h3><Lock /> No operator, anywhere</h3>
          <p className="dim" style={{ marginBottom: 0, fontSize: '0.92rem' }}>
            <span className="mono">clear</span>, <span className="mono">settle</span>,{' '}
            <span className="mono">payout</span> and <span className="mono">startNewBatch</span>{' '}
            are all permissionless — every one of them is a button in the app. There is no
            privileged role in this system, so there is nobody who can strand your escrow by
            going quiet. The contract is admin over the order handles because it has to
            compute on them, and it exposes no path that decrypts one.
          </p>
        </div>
      </section>

      <section className="wrap" style={{ paddingBottom: 'var(--s7)' }}>
        <div className="row">
          <Link href="/app"><button>Open the app</button></Link>
          <span className="dim" style={{ fontSize: '0.9rem' }}>
            Sepolia testnet · faucet coins built in · no real funds
          </span>
        </div>
      </section>

      <footer>
        <div className="wrap row" style={{ justifyContent: 'space-between' }}>
          <span>Lebur · WTF Hackathon Summer Edition · built on iExec Nox</span>
          <a href={explorerAddr(ADDRESSES.batch)} target="_blank" rel="noreferrer" className="mono">
            batch {ADDRESSES.batch.slice(0, 10)}… <Ext />
          </a>
        </div>
      </footer>
    </main>
  );
}
