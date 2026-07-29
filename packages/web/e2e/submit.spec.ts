import { test, expect } from '@playwright/test';
import { injectWallet } from './wallet';

// The write path, in a real browser, against real Sepolia. This SPENDS GAS, so
// it is opt-in:
//
//   WALLET_KEY=0x… npx playwright test submit.spec
//
// Without WALLET_KEY it skips, because a suite that silently drains a faucet
// wallet on every run is a worse problem than an untested write path.
//
// What it is for: sealing one order is seven transactions and two gateway
// encryptions, and the project's worst bug lived in exactly that sequence. The
// Snap encrypted with its own SRP-derived identity while `submitOrder` was sent
// by the EOA, so `Nox.fromExternal` — which requires the proof's owner to be the
// direct msg.sender — rejected it every time. The page PREFERRED the Snap when
// installed, so installing it broke trading. Nothing caught it because nothing
// ever ran the sequence in a browser.

const KEY = process.env.WALLET_KEY;
const RPC = process.env.NEXT_PUBLIC_RPC ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const BASE = process.env.BASE ?? 'https://lebur.vercel.app';

test.describe('sealing an order with a signing wallet', () => {
  test.skip(!KEY, 'set WALLET_KEY to run — this spends real Sepolia gas');
  // Seven transactions plus two gateway round trips at ~2-3s each.
  test.setTimeout(15 * 60_000);

  test('mints, wraps both sides, authorises and seals an order', async ({ page }) => {
    const address = await injectWallet(page, KEY!, RPC);
    const problems: string[] = [];
    page.on('pageerror', (e) => problems.push(e.message));

    await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' });

    // The status strip is the single place the page reports contract state.
    const status = page.locator('dl.stats');
    await expect(status).toContainText(/Phase/i, { timeout: 30_000 });
    const phase = (await status.textContent())!.match(/(Accepting orders|Cleared|Settled)/)![1];
    test.skip(phase !== 'Accepting orders', `batch is ${phase}; the book is closed`);

    const before = Number((await status.textContent())!.match(/Sealed orders\s*(\d+)/i)![1]);

    // Small, and an ask, so this order sits on the opposite side of the seeded
    // book rather than piling onto it.
    await page.getByLabel('side').selectOption('ask');
    await page.getByLabel('amount').fill('5');

    await page.getByRole('button', { name: 'Submit sealed order' }).click();
    await expect(page.getByText(/sealed order placed/)).toBeVisible({ timeout: 12 * 60_000 });

    // The book grew by exactly one, read back from chain rather than from the
    // status text the click already set.
    await expect(status).toContainText(new RegExp(`sealed orders:\\s*${before + 1}`), { timeout: 60_000 });

    // No Snap in this browser, so the EOA holds the viewing role. The page has to
    // SAY so — this is the assertion that would catch a page which quietly
    // downgraded and still called itself coercion-resistant.
    await expect(page.getByText(/Snap not installed/)).toBeVisible();
    await expect(page.getByText(/not coercion-resistant/)).toBeVisible();

    // And the trader can read back what the contract booked for them — the claim
    // made inspectable, gated by the viewer role granted at submit time.
    await page.getByLabel('order id').fill(String(before));
    await page.getByRole('button', { name: 'Decrypt my order' }).click();
    await expect(page.getByText(/order \d+: (bid|ask)/)).toBeVisible({ timeout: 3 * 60_000 });

    expect(problems, 'no unhandled errors during the write path').toEqual([]);
    console.log(`sealed an order from ${address}`);
  });
});
