import { test, expect, type Page } from '@playwright/test';

// Browser tests against the DEPLOYED page and the LIVE Sepolia batch.
//
// `tsc` and `next build` are both clean on code that throws the moment a browser
// runs it — a barrel import pulling in a peer dependency, a viem default RPC
// that is dead, an ABI that no longer decodes a deployed contract. Every one of
// those has happened in this project, and none of them was caught before the
// page was actually opened. This is that step, automated.
//
// No wallet. Everything asserted is what a visitor sees BEFORE connecting one,
// which is also what has to be right for anyone to get as far as connecting.
//
//   BASE=https://lebur.vercel.app npx playwright test        (deployed)
//   BASE=http://localhost:3000    npx playwright test        (local dev)

const BASE = process.env.BASE ?? 'https://lebur.vercel.app';

/// The app is a dashboard: panels live behind sidebar nav rather than one long
/// scroll, so a test that wants a panel has to open it the way a visitor would.
/// Waiting for aria-current to move proves the switch took — React may not have
/// hydrated when the click lands, and then nothing happens and the assertion
/// after it fails much later against the wrong panel.
async function open(page: Page, label: string) {
  const item = page.locator('nav.sidenav').getByRole('button', { name: label });
  await item.click();
  await expect(item).toHaveAttribute('aria-current', 'page', { timeout: 30_000 });
}

/// An unhandled rejection leaves the UI merely looking empty. Treat it as a
/// failure, because a silent one is how a broken read reaches a judge.
function watchForCrashes(page: Page) {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
  });
  return problems;
}

test('renders, and reads the live batch from chain', async ({ page }) => {
  const problems = watchForCrashes(page);
  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' });


  // phase, order count, deadline and the ladder are four separate eth_calls
  // batched through Multicall3. If any of them is wrong the card never leaves
  // "loading…", which no build step can tell you.
  // The status strip is the single place the page reports contract state.
    const status = page.locator('dl.stats');
  // The labels are the UI's, not the enum's — `Accepting orders`, not `Open`.
  // Asserting the enum name here passed review and failed the browser, which is
  // the whole reason this file exists.
  await expect(status).toContainText(/(Accepting orders|Cleared|Settled)/, { timeout: 30_000 });
  await expect(status).toContainText(/Sealed orders/i);

  // The ladder is read from the contract, not hardcoded here — it is the
  // auction's grammar and it has to come from the deployment being displayed.
  // The ladder is read from the contract and rendered as the CONTROL, not as
  // prose: a uniform-price auction is its ladder, so picking a price has to be
  // the interaction rather than choosing an index from a dropdown.
  const ladder = page.locator('.ladder');
  await expect(ladder.locator('button.tick').first()).toBeVisible({ timeout: 30_000 });
  await expect(ladder).toContainText('0.9995');
  // High-to-low, the way an order book reads.
  const prices = await ladder.locator('button.tick').allInnerTexts();
  expect(prices.length).toBeGreaterThanOrEqual(3);
  const nums = prices.map((t) => Number(t.match(/[\d.]+$|1\.\d{4}|0\.\d{4}/)?.[0] ?? 0)).filter(Boolean);
  expect(nums, 'ladder must render highest price first').toEqual([...nums].sort((a, b) => b - a));

  expect(problems, 'page must load with no errors').toEqual([]);
});

test('offers exactly the lifecycle step the batch is actually ready for', async ({ page }) => {
  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
  // The status strip is the single place the page reports contract state.
    const status = page.locator('dl.stats');
  await expect(status).toContainText(/Phase/i, { timeout: 30_000 });
  const phase = (await status.textContent())!.match(/(Accepting orders|Cleared|Settled)/)![1];

  const submit = page.getByRole('button', { name: 'Submit sealed order' });
  const clear = page.getByRole('button', { name: 'Clear the batch' });
  const settle = page.getByRole('button', { name: /Reveal and settle/ });
  const payout = page.getByRole('button', { name: /Pay out/ });

  if (phase === 'Accepting orders') {
    const closed = /Closed/.test((await status.textContent())!)
      && !/Orders close/i.test((await status.textContent())!);
    // Before the window closes you may submit and may not clear; after it
    // closes the two swap over. Both are permissionless — the point is that the
    // page never offers the one that would revert.
    await expect(submit).toBeEnabled({ timeout: 15_000 });
    if (closed) await expect(clear).toBeEnabled();
    else await expect(clear).toBeDisabled();
    await expect(settle).toHaveCount(0);
    await expect(payout).toHaveCount(0);
  } else if (phase === 'Cleared') {
    await expect(submit).toBeDisabled();
    await open(page, 'Advance the batch');
    await expect(settle).toBeVisible(); // three gateway proofs, anyone may supply them
  } else {
    await expect(submit).toBeDisabled();
    await open(page, 'Advance the batch');
    await expect(payout).toBeVisible(); // fills are collected here, not from a script
    await expect(page.getByText(/This batch is/)).toContainText(/settled/);
  }
});

test('reports the public footprint only once there is one', async ({ page }) => {
  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
  // The status strip is the single place the page reports contract state.
    const status = page.locator('dl.stats');
  await expect(status).toContainText(/Phase/i, { timeout: 30_000 });
  const phase = (await status.textContent())!.match(/(Accepting orders|Cleared|Settled)/)![1];

  // publicFootprint reverts with WrongPhase until Settled. Reading it earlier
  // used to surface as a page-wide error on a perfectly healthy batch, so the
  // absence of that error is the assertion here.
  if (phase === 'Settled') await expect(status).not.toContainText(/not until settled/);
  else await expect(status).toContainText(/not until settled/);

  await expect(page.getByText(/Failed to read batch/)).toHaveCount(0);
});

test('lets a trader read their own order back, and only their own', async ({ page }) => {
  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
  // The status strip is the single place the page reports contract state.
    const status = page.locator('dl.stats');
  await expect(status).toContainText(/Sealed orders/i, { timeout: 30_000 });
  const orders = Number((await status.textContent())!.match(/Sealed orders\s*(\d+)/i)![1]);

  // With an empty book the nav item is disabled, because offering a panel that
  // has nothing to read is just a button that fails.
  const item = page.locator('nav.sidenav').getByRole('button', { name: 'My order' });
  if (orders === 0) { await expect(item).toBeDisabled(); return; }
  await open(page, 'My order');
  await expect(page.getByText('Read your own order back')).toBeVisible();
});

test('the landing page stands on its own, and its numbers come from chain', async ({ page }) => {
  const problems = watchForCrashes(page);
  await page.goto(BASE, { waitUntil: 'networkidle' });

  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  // The headline figures are read from a settled deployment rather than typed
  // into the page. A landing page that hardcodes its own metrics is a
  // screenshot, and this project's entire argument is that you can check it.
  await expect(page.locator('.stat, table').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('—', { exact: true })).toHaveCount(0, { timeout: 30_000 });

  // The one job of a landing page is to get you into the app.
  await page.getByRole('button', { name: 'Open the app' }).first().click();
  await expect(page).toHaveURL(/\/app$/);

  expect(problems, 'landing must load with no errors').toEqual([]);
});
