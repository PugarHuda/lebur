'use client';
// The dashboard frame: a sidebar that switches the main panel, plus the state
// strip that stays put while you switch.
//
// Views rather than one long scroll, because the panels are alternatives, not
// steps: you donate, or you drive the round forward, or you read the result. In
// a single column the answer sat below the question and you scrolled past what
// you came to read to reach what you came to do.
import type { ReactNode } from 'react';
import Link from 'next/link';
import { Ext } from './icons';

export type View = { id: string; label: string; disabled?: boolean; hint?: string };

export function Shell({
  brand, tagline, views, view, onView, account, chainLabel, stats, address, explorer, children,
}: {
  brand: string;
  tagline: string;
  views: View[];
  view: string;
  onView: (id: string) => void;
  account?: `0x${string}`;
  chainLabel: string;
  stats: ReactNode;
  address: `0x${string}`;
  explorer: (a: string) => string;
  children: ReactNode;
}) {
  return (
    <div className="shell">
      {/* `nav` and `aria-current` so this reads as navigation to a screen reader
          rather than a column of unexplained buttons. */}
      <aside className="side">
        <Link href="/" className="brand" style={{ textDecoration: 'none' }}>
          {brand}
          <small>{tagline}</small>
        </Link>

        <nav className="sidenav" aria-label="Sections">
          {views.map((v) => (
            <button
              key={v.id}
              onClick={() => onView(v.id)}
              disabled={v.disabled}
              aria-current={view === v.id ? 'page' : undefined}
              title={v.hint}
            >
              {v.label}
            </button>
          ))}
        </nav>

        <div className="side-foot">
          <div>{chainLabel}</div>
          <div className="mono">{account ? `${account.slice(0, 6)}…${account.slice(-4)}` : 'not connected'}</div>
          <a href={explorer(address)} target="_blank" rel="noreferrer" className="mono">
            {address.slice(0, 10)}… <Ext />
          </a>
        </div>
      </aside>

      <main className="main">
        {/* Above the view switch on purpose: the contract's state is true
            whichever panel you are looking at, so it must not move with them. */}
        {stats}
        {children}
      </main>
    </div>
  );
}
