import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Checks the claims the README makes about this UI, instead of asserting them in
// prose and hoping.
//
// The README says: contrast passes, focus rings are kept, targets that spend gas
// are at least 44px, motion is dropped for anyone who asked the OS to drop it,
// and the layout survives a phone. Every one of those was WRITTEN and none was
// verified. That is the same "claim stronger than the evidence" pattern this
// project has spent its whole life fixing, so it gets the same treatment.

const BASE = process.env.BASE ?? 'https://lebur.vercel.app';

/// Colour-contrast and structural rules only. Axe's full ruleset includes checks
/// that need a whole-site crawl (landmark uniqueness across pages, for instance)
/// and would fail here for reasons that are not defects.
const scan = (page: Page) =>
  new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();

for (const [name, path] of [['landing', '/'], ['app', '/app']] as const) {
  test(`${name}: no accessibility violations`, async ({ page }) => {
    await page.goto(BASE + path, { waitUntil: 'networkidle' });
    // Chain reads populate the page; scanning before they land tests a skeleton.
    await page.waitForTimeout(3000);
    const { violations } = await scan(page);
    // Report what failed and where, or the failure message is a bare count.
    const summary = violations.map((v) =>
      `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join('\n    ')}`,
    ).join('\n  ');
    expect(summary, `axe found ${violations.length} violation(s)`).toBe('');
  });
}

test('every control that spends gas is at least 44px tall', async ({ page }) => {
  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
  // A wallet action is not a place to make people aim, and a 32px button is the
  // difference between donating and mis-tapping into a page reload.
  const controls = page.locator('button, input, select');
  const n = await controls.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    const el = controls.nth(i);
    if (!(await el.isVisible())) continue;
    const box = await el.boundingBox();
    expect(box!.height, `control ${i} (${await el.innerText().catch(() => '')}) is ${box!.height}px tall`)
      .toBeGreaterThanOrEqual(44);
  }
});

test('keyboard focus stays visible', async ({ page }) => {
  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
  await page.keyboard.press('Tab');
  const focused = page.locator(':focus-visible');
  await expect(focused).toHaveCount(1);
  // Removing the outline and replacing it with nothing is the single most
  // common way a dark theme becomes unusable without a mouse.
  const outline = await focused.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).not.toBe('none');
});

test('the page fits a phone without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  for (const path of ['/', '/app']) {
    await page.goto(BASE + path, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    // A body wider than the viewport is the classic symptom of a fixed-width
    // table or an un-wrapped address string, and it makes the whole page drift.
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${path} overflows horizontally by ${overflow}px at 375px`).toBeLessThanOrEqual(1);
  }
});

test('motion is dropped for anyone who asked the OS to drop it', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
  const durations = await page.evaluate(() =>
    [...document.querySelectorAll('button, a, .card')]
      .map((el) => getComputedStyle(el).transitionDuration));
  expect(durations.every((d) => d === '0s' || d === ''), 'a transition still runs under reduced-motion').toBe(true);
});
