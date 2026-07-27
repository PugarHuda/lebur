// Lebur reference / oracle for the on-chain encrypted auction. Pure BigInt, no deps.
// Run: node reference/lebur-reference.mjs
//
// This file is the SPECIFICATION. It mirrors LeburBatch.sol op for op — same fixed
// loop bounds, same floor division, same `select` semantics (both branches always
// evaluated, no early exit), same zero-guards, same integer widths. Every expected
// value the Solidity tests assert against is produced here, and every invariant the
// contract's safety rests on (conservation, limit-respect, dust bound, no overflow)
// is asserted here first.
//
// It exists because `hardhat test` needs Docker to boot the Nox offchain stack. This
// runs on plain `node`, so the auction math stays checkable when Docker is down.
import assert from 'node:assert/strict';

const WAD = 10n ** 18n;

// Per-order size cap, clamped under encryption at submit time (`select`, because you
// cannot `require` on an encrypted value). It bounds three things at once: the
// argmax score packing below, the mul in the pro-rata payout, and the gas of a batch.
const MAX_ORDER = 10n ** 24n;      // 1,000,000 tokens at 18dp
const MAX_ORDERS = 8n;
// Both sides of the book are paid out by independent floor divisions, and the coin0
// the askers receive is the very coin0 the bidders spend. Each per-order floor loses
// under a wei, but they lose it on OPPOSITE sides of the ledger: if the askers' share
// happens to round up-ish and the bidders' share down, the aggregate paid out exceeds
// the aggregate collected by up to (#orders) wei — and ERC-7984 would absorb that by
// silently capping whoever claimed last. So each output numerator is shaved by
// MAX_ORDERS wei up front. The shaved wei join the dust buffer.
const DUST_SHAVE = MAX_ORDERS;
// Argmax packing: one euint256 carries (volume, -imbalance) lexicographically so the
// tie-break needs a single `gt` instead of boolean algebra over ebool — Nox has no
// select() on ebool and no bitwise ops, so `a || (b && c)` is not expressible.
const SHIFT = 2n ** 90n;
const IMB_MAX = SHIFT - 1n;

// ---------------------------------------------------------------------------
// Mechanism
// ---------------------------------------------------------------------------
// A uniform-price batch auction that sells coin1 for coin0. Price is quoted as
// coin0 per coin1, WAD-scaled, on a PUBLIC ladder of T ticks, strictly increasing.
//
//   bidder  — escrows coin0, wants coin1. Wants a LOW price. Eligible at tick t
//             iff t <= limitTick  (their limit is a maximum price).
//   asker   — escrows coin1, wants coin0. Wants a HIGH price. Eligible at tick t
//             iff t >= limitTick  (their limit is a minimum price).
//
// Everything about an order is encrypted except that it exists and who owns it:
// size, side and limit tick are all handles. The side never needs an encrypted
// branch downstream, because it is materialised as WHICH TOKEN MOVED at submit time:
// qBuy is the coin0 that actually arrived, qSell the coin1, and one of them is zero.
//
// At every tick t, entirely under encryption:
//   Dq(t)  = Σ eligible bidder coin0                         (non-increasing in t)
//   D1(t)  = Dq(t) * WAD / P[t]        coin1 demanded         (non-increasing in t)
//   S1(t)  = Σ eligible asker coin1    coin1 supplied         (non-decreasing in t)
//   V(t)   = min(D1, S1)               internally crossable coin1
//
// The clearing tick t* maximises V, and among equal V minimises the imbalance
// |D1 - S1| — the rule real call auctions use (maximise executed volume, then
// minimise residual imbalance). Since D1 + S1 == 2V + |D1 - S1|, minimising the
// imbalance at fixed V is the same as minimising D1 + S1, which is one add instead
// of two safeSubs. Remaining ties fall to the lowest tick.
//
// V coin1 crosses INSIDE the contract at P[t*] and never touches a public market.
// The heavy side's excess is the RESIDUAL, the only quantity ever revealed:
//   buys heavy (D1 > S1): R0 = Dq - C0   coin0, swapped coin0->coin1 on Curve
//   sells heavy          : R1 = S1 - V    coin1, swapped coin1->coin0 on Curve
// where C0 = V * P[t*] / WAD is the coin0 the askers are owed at the clearing price.
//
// The Curve leg is one `exchange_received`. Its `_min_dy` is pinned at the clearing
// price, so the blended price an eligible order realises is never worse than the
// P[t*] its limit qualified at. If the pool cannot meet that bound the leg is
// SKIPPED (poolIn = 0) and the auction degrades to a plain pro-rata call auction:
// still limit-respecting, just smaller fills and a bigger refund.

// ---------------------------------------------------------------------------
// The auction, mirroring the encrypted implementation
// ---------------------------------------------------------------------------

/**
 * Phase 1 — `LeburBatch.clear()`. Every line here is an encrypted handle op.
 * @param ladder  bigint[] strictly increasing prices, coin0 per coin1, WAD-scaled
 * @param orders  [{ qBuy, qSell, limitTick }] with at most one of qBuy/qSell non-zero
 */
function clear(ladder, orders) {
  const T = ladder.length;
  const N = orders.length;
  let ops = 0;

  // Fixed-bound scan; no early exit is possible because the winning tick is secret.
  let bestScore = 0n, bestV = 0n, bestP = ladder[0], bestTick = 0, bestDq = 0n, bestS1 = 0n;
  const curve = [];
  for (let t = 0; t < T; t++) {
    let Dq = 0n, S1 = 0n;
    for (let i = 0; i < N; i++) {
      // ge(limitTick, t) + select + add   — bidder eligible at or below its limit
      ops += 3;
      if (orders[i].limitTick >= t) Dq += orders[i].qBuy;
      // le(limitTick, t) + select + add   — asker eligible at or above its limit
      ops += 3;
      if (orders[i].limitTick <= t) S1 += orders[i].qSell;
    }
    // D1 = Dq * WAD / P[t]. P[t] is a PLAINTEXT ladder constant and every entry is
    // > 0 (asserted below), so this div can never hit the saturate-to-MAX zero trap.
    // Only the payout denominators, which are sums of secrets, need a runtime guard.
    ops += 2;
    const D1 = (Dq * WAD) / ladder[t];
    ops += 2; // le + select == min()
    const V = D1 <= S1 ? D1 : S1;
    // score = V in the high bits, (IMB_MAX - (D1+S1)) in the low bits. A single `gt`
    // then implements "more volume wins; equal volume, less imbalance wins".
    ops += 4; // add + safeSub + mul + add
    let score = V * SHIFT + (IMB_MAX - (D1 + S1));
    // A tick where NOTHING crosses scores exactly zero, so it can never win: with no
    // crossing there is no price discovery, and every downstream quantity (the
    // residual, the pool bound, the fills) is derived from the clearing price. Without
    // this the low half alone would decide, and a batch of bids with no ask at all
    // would "clear" at an arbitrary tick and route its whole size to the pool.
    ops += 2; // gt + select
    if (V === 0n) score = 0n;
    // `>` not `>=`, so a fully tied tick keeps the earlier (lower) one.
    ops += 7; // gt + 6 carried selects
    if (score > bestScore) {
      bestScore = score; bestV = V; bestP = ladder[t]; bestTick = t; bestDq = Dq; bestS1 = S1;
    }
    curve.push({ t, P: ladder[t], Dq, D1, S1, V, imb: D1 > S1 ? D1 - S1 : S1 - D1, score });
  }

  // Recomputed once instead of carried through the loop — cheaper by T selects.
  ops += 2;
  const bestD1 = (bestDq * WAD) / bestP;
  // coin0 the askers are owed for V coin1 at the clearing price. mul-then-div keeps
  // the precision; the divisor is the WAD constant, never zero.
  ops += 2;
  const C0 = (bestV * bestP) / WAD;

  ops += 1;
  const buysHeavy = bestD1 > bestS1;
  // safeSub + select on each. Exactly one is non-zero, but BOTH are computed and
  // BOTH are revealed — `buysHeavy` is encrypted, so there is no branch to take.
  // Revealing both leaks nothing extra: publishing a residual publishes its side.
  ops += 3;
  const R0 = buysHeavy ? (bestDq > C0 ? bestDq - C0 : 0n) : 0n;
  ops += 3;
  const R1 = buysHeavy ? 0n : (bestS1 > bestV ? bestS1 - bestV : 0n);

  return { bestScore, bestV, bestP, bestTick, bestDq, bestS1, bestD1, C0, R0, R1, buysHeavy, curve, ops, T, N };
}

/**
 * Phase 2 — `settle()`, plaintext. The residual has been revealed (it is the only
 * thing that ever is), unwrapped to a plain ERC-20 and pushed through the pool.
 * @param poolOut  what the pool actually returned, or null to model a pool that
 *                 cannot meet `_min_dy` (leg skipped, residual re-wrapped)
 */
function settle(c, poolOut) {
  // The minimum output for the blended price to stay at or better than the clearing
  // price. Both directions are just the clearing-price conversion of the residual.
  const minOut = c.buysHeavy ? (c.R0 * WAD) / c.bestP : (c.R1 * c.bestP) / WAD;
  // No residual, no swap — never hand the pool a zero-input `exchange_received`.
  const swapped = (c.R0 > 0n || c.R1 > 0n) && poolOut !== null && poolOut >= minOut;
  return {
    minOut,
    swapped,
    dy: swapped && c.buysHeavy ? poolOut : 0n,   // extra coin1 for the bidders
    dx: swapped && !c.buysHeavy ? poolOut : 0n,  // extra coin0 for the askers
    // Input the pool leg consumed; zero when skipped, in which case the residual is
    // re-wrapped and flows back out through the pro-rata refund below.
    poolIn0: swapped && c.buysHeavy ? c.R0 : 0n,
    poolIn1: swapped && !c.buysHeavy ? c.R1 : 0n,
  };
}

/**
 * Phase 3 — `payout(i)`, back under encryption. One pro-rata share per order.
 * No encrypted branch on side: qBuy and qSell are already masked, so the wrong-side
 * term is multiplied by zero. Both terms always evaluate, which is what a `select`
 * would have cost anyway.
 */
function payout(c, s, orders) {
  let ops = 0;
  // eq + select per denominator: `div` SATURATES TO MAX on a zero divisor instead of
  // reverting, so a batch with no eligible bidders (or no eligible askers) would
  // otherwise pay out 2^256-1 in perfect silence.
  ops += 4;
  const denB = c.bestDq === 0n ? 1n : c.bestDq;
  const denS = c.bestS1 === 0n ? 1n : c.bestS1;
  // Outputs are shaved by DUST_SHAVE (see the constant), inputs are not: a bidder
  // must still spend exactly its pro-rata share of what the batch consumed.
  ops += 6;
  const shave = (x) => (x > DUST_SHAVE ? x - DUST_SHAVE : 0n); // safeSub
  const outB = shave(c.bestV + s.dy);   // coin1 split among eligible bidders
  const usedB = c.C0 + s.poolIn0;       // coin0 those bidders actually spend
  const outS = shave(c.C0 + s.dx);      // coin0 split among eligible askers
  const usedS = c.bestV + s.poolIn1;    // coin1 those askers actually deliver

  const rows = orders.map((o) => {
    ops += 2; // ge + select
    const qEb = o.limitTick >= c.bestTick ? o.qBuy : 0n;
    ops += 2; // le + select
    const qEs = o.limitTick <= c.bestTick ? o.qSell : 0n;
    ops += 8; // 4 x (safeMul + div)
    const gotCoin1 = (qEb * outB) / denB;
    const spentCoin0 = (qEb * usedB) / denB;
    const gotCoin0 = (qEs * outS) / denS;
    const spentCoin1 = (qEs * usedS) / denS;
    ops += 4; // 2 x safeSub, 2 x add
    const coin0Out = gotCoin0 + (o.qBuy - spentCoin0); // fill payout + unspent escrow
    const coin1Out = gotCoin1 + (o.qSell - spentCoin1);
    return { qEb, qEs, gotCoin0, gotCoin1, spentCoin0, spentCoin1, coin0Out, coin1Out };
  });
  return { rows, ops, outB, usedB, outS, usedS };
}

/** Run the whole auction and check every invariant the contract's safety rests on. */
function auction(ladder, orders, poolOut = 0n) {
  assert.ok(BigInt(orders.length) <= MAX_ORDERS, 'batch exceeds MAX_ORDERS');
  for (let t = 0; t < ladder.length; t++) {
    assert.ok(ladder[t] > 0n, 'ladder prices must be > 0 (a zero price would saturate div)');
    if (t > 0) assert.ok(ladder[t] > ladder[t - 1], 'ladder must be strictly increasing');
  }
  for (const o of orders) {
    assert.ok(o.qBuy === 0n || o.qSell === 0n, 'an order is a bid or an ask, never both');
    assert.ok(o.qBuy <= MAX_ORDER && o.qSell <= MAX_ORDER, 'order exceeds the encrypted clamp');
    assert.ok(o.limitTick < ladder.length, 'limit tick must index the ladder');
  }
  const c = clear(ladder, orders);
  const s = settle(c, poolOut);
  const p = payout(c, s, orders);

  // -- NO OVERFLOW. The score packing and the pro-rata mul are the two places a
  //    silent euint256 wrap would corrupt the result rather than revert.
  for (const r of c.curve) {
    assert.ok(r.D1 + r.S1 <= IMB_MAX, 'D1+S1 must fit the low half of the packed score');
    assert.ok(r.score < 2n ** 256n, 'packed score must fit euint256');
  }
  const biggestMul = MAX_ORDER * (c.C0 + s.dx + c.bestV + s.dy + 1n);
  assert.ok(biggestMul < 2n ** 256n, 'pro-rata numerator must fit euint256');

  // -- D falls, S rises. The reason argmax min(D,S) has a well-defined peak at all.
  for (let t = 1; t < c.curve.length; t++) {
    assert.ok(c.curve[t].D1 <= c.curve[t - 1].D1, 'demand must be non-increasing in price');
    assert.ok(c.curve[t].S1 >= c.curve[t - 1].S1, 'supply must be non-decreasing in price');
  }
  // -- the packed argmax picks exactly what the stated rule says it should
  const rule = [...c.curve].sort((a, b) =>
    a.V !== b.V ? (b.V > a.V ? 1 : -1) : a.imb !== b.imb ? (a.imb > b.imb ? 1 : -1) : a.t - b.t)[0];
  if (c.curve.length) {
    assert.equal(c.bestV, rule.V, 'carried volume matches max-volume/min-imbalance');
    if (rule.V > 0n) {
      assert.equal(c.bestTick, rule.t, 'carried tick matches max-volume/min-imbalance');
      assert.equal(c.bestP, ladder[c.bestTick], 'carried price matches carried tick');
    }
  }
  // -- exactly one residual, and it is the heavy side's excess
  assert.ok(c.R0 === 0n || c.R1 === 0n, 'only one side can be heavy');

  // -- CONSERVATION. The contract holds escrow confidentially, and an ERC-7984
  //    transfer that exceeds the balance is silently CAPPED rather than reverted, so
  //    over-distribution would surface as a random user shorted, not as an error.
  const esc0 = orders.reduce((a, o) => a + o.qBuy, 0n);  // coin0 escrowed
  const esc1 = orders.reduce((a, o) => a + o.qSell, 0n); // coin1 escrowed
  const avail0 = esc0 - s.poolIn0 + s.dx; // the residual leaves as a plain ERC-20
  const avail1 = esc1 - s.poolIn1 + s.dy; // the pool output comes back wrapped
  const paid0 = p.rows.reduce((a, r) => a + r.coin0Out, 0n);
  const paid1 = p.rows.reduce((a, r) => a + r.coin1Out, 0n);
  assert.ok(paid0 <= avail0, `coin0 over-distributed: ${paid0} > ${avail0}`);
  assert.ok(paid1 <= avail1, `coin1 over-distributed: ${paid1} > ${avail1}`);

  // -- DUST. Four floor divisions per order plus two on the aggregates, so a few wei
  //    per order per asset at most. It STAYS IN THE CONTRACT as a permanent rounding
  //    buffer, deliberately: that buffer is what guarantees the last payout of a
  //    batch is never the one that gets capped a wei short.
  const dust0 = avail0 - paid0;
  const dust1 = avail1 - paid1;
  const bound = BigInt(4 * orders.length + 8) + 2n * DUST_SHAVE;
  assert.ok(dust0 <= bound, `coin0 dust ${dust0} exceeds ${bound}`);
  assert.ok(dust1 <= bound, `coin1 dust ${dust1} exceeds ${bound}`);

  // -- LIMIT RESPECT, stated as an ABSOLUTE wei bound rather than a price ratio.
  //    Every floor division loses at most one wei of the divided quantity, and there
  //    are at most three in any payout path, so an eligible order is within 3 wei of
  //    the exact clearing-price settlement REGARDLESS OF SIZE. A ratio bound would
  //    be the wrong claim: at a 1-wei order size no integer price is representable
  //    at all, and only the absolute statement survives that.
  const TOL = 3n + DUST_SHAVE;
  for (const [i, r] of p.rows.entries()) {
    const lim = ladder[orders[i].limitTick];
    if (r.gotCoin1 > 0n) {
      // a bidder must not pay more coin0 than its limit price asks for that coin1
      assert.ok(r.spentCoin0 <= (r.gotCoin1 * lim) / WAD + TOL,
        `bidder ${i} paid ${r.spentCoin0} for ${r.gotCoin1} above its limit ${lim}`);
    }
    if (r.spentCoin1 > 0n) {
      // an asker must not receive less coin0 than its limit price promises
      assert.ok(r.gotCoin0 + TOL >= (r.spentCoin1 * lim) / WAD,
        `asker ${i} got ${r.gotCoin0} for ${r.spentCoin1} below its limit ${lim}`);
    }
    // -- nobody can lose more than they escrowed
    assert.ok(r.spentCoin0 <= orders[i].qBuy, `order ${i} overspent its coin0 escrow`);
    assert.ok(r.spentCoin1 <= orders[i].qSell, `order ${i} overspent its coin1 escrow`);
  }

  // -- OUT OF THE MONEY MEANS WHOLE. Not filled has to mean fully refunded, or a
  //    losing bid silently becomes a donation.
  for (const [i, r] of p.rows.entries()) {
    const o = orders[i];
    if (o.qBuy > 0n && o.limitTick < c.bestTick) {
      assert.equal(r.coin0Out, o.qBuy, `out-of-the-money bidder ${i} not fully refunded`);
      assert.equal(r.coin1Out, 0n, `out-of-the-money bidder ${i} got coin1`);
    }
    if (o.qSell > 0n && o.limitTick > c.bestTick) {
      assert.equal(r.coin1Out, o.qSell, `out-of-the-money asker ${i} not fully refunded`);
      assert.equal(r.coin0Out, 0n, `out-of-the-money asker ${i} got coin0`);
    }
  }

  return { c, s, p, dust0, dust1, esc0, esc1, avail0, avail1, ops: c.ops + p.ops };
}

// ---------------------------------------------------------------------------
// 1. The canonical demo batch. These are the numbers the Solidity test asserts.
// ---------------------------------------------------------------------------
const tok = (n) => BigInt(n) * WAD;
const bid = (amount, limitTick) => ({ qBuy: amount, qSell: 0n, limitTick });
const ask = (amount, limitTick) => ({ qBuy: 0n, qSell: amount, limitTick });

// T=4 ladder, a +-0.05%/+0.1% band around par — a plausible stablecoin quote range,
// and the size the live-demo envelope actually allows (T=4/N=3 comfortable,
// T=8/N=5 borderline, because the Nox Runner is single-threaded with no batching).
const LADDER = [
  999_500_000_000_000_000n,   // 0.9995 coin0 per coin1
  1_000_000_000_000_000_000n, // 1.0000
  1_000_500_000_000_000_000n, // 1.0005
  1_001_000_000_000_000_000n, // 1.0010
];

console.log('--- 1. demo batch: 2 bids + 1 ask, T=4 N=3 ---');
const DEMO = [
  bid(tok(1000), 2), // will pay up to 1.0005
  bid(tok(500), 1),  // will pay up to 1.0000
  ask(tok(600), 0),  // will sell at 0.9995 or better
];
const demo = auction(LADDER, DEMO);
for (const r of demo.c.curve) {
  console.log(
    `  t=${r.t} P=${r.P} Dq=${r.Dq / WAD} D1=${r.D1 / WAD} S1=${r.S1 / WAD}` +
    ` V=${r.V / WAD} imbalance=${r.imb / WAD}`,
  );
}
console.log(`  clearing tick=${demo.c.bestTick} P=${demo.c.bestP} V=${demo.c.bestV / WAD} coin1`);
console.log(`  askers owed C0=${demo.c.C0 / WAD} coin0`);
console.log(`  residual: R0=${demo.c.R0 / WAD} coin0, R1=${demo.c.R1} coin1 (buysHeavy=${demo.c.buysHeavy})`);
console.log(`  encrypted ops: ${demo.ops}`);

// The ask (600 coin1, floor 0.9995) is eligible at every tick. Both bids are in the
// money through tick 1, only the larger through tick 2. Supply binds throughout, so
// V is flat at 600 and the IMBALANCE rule is what picks the price: excess demand
// pushes the clearing tick up to 2, the highest price where the full 600 still
// crosses. A naive "lowest tick wins" tie-break would have settled at 0.9995 and
// handed the whole excess-demand surplus to the bidders.
assert.equal(demo.c.bestTick, 2, 'excess demand must clear at the top of the crossing range');
assert.equal(demo.c.bestS1, tok(600), 'the whole ask is available at the clearing tick');
assert.equal(demo.c.bestV, tok(600), 'supply is the binding side');
assert.ok(demo.c.buysHeavy, 'demo batch is demand-heavy');
assert.ok(demo.c.R0 > 0n && demo.c.R1 === 0n, 'demand-heavy batch leaves a coin0 residual');
assert.equal(demo.c.R0, demo.c.bestDq - demo.c.C0, 'residual is exactly the unmatched coin0');
// the losing bidder is out of the money at tick 2 and must come out untouched
assert.equal(demo.p.rows[1].coin0Out, tok(500), 'the 1.0000 bid is refunded in full');
assert.equal(demo.p.rows[1].coin1Out, 0n, 'the 1.0000 bid buys nothing');

// ---------------------------------------------------------------------------
// 2. The netting claim, stated exactly. This is the number for the demo video.
// ---------------------------------------------------------------------------
console.log('\n--- 2. how much of the batch reaches the public pool ---');
{
  // Unbatched, every participant routes its own full size through the pool.
  const gross = demo.c.bestDq + demo.c.C0; // eligible bidder coin0 + the ask's coin0 leg
  const routed = demo.c.R0 + demo.c.R1;
  const pct = (routed * 10_000n) / gross;
  console.log(`  gross notional: ${gross / WAD} coin0-equivalent`);
  console.log(`  routed to Curve: ${routed / WAD}  (${Number(pct) / 100}%)`);
  console.log(`  netted internally at the clearing price: ${(gross - routed) / WAD}`);
  assert.ok(routed < gross, 'batching must reduce what the public pool sees');
  // Honest framing: what shrinks is the PUBLIC FOOTPRINT, not the slippage bill.
  // Curve is flat at the peg, so the residual settles ~1:1 either way. The claim is
  // confidentiality and MEV resistance at institutional size, settling at par.
}

// ---------------------------------------------------------------------------
// 3. Pool behaviour, including a pool that cannot meet the clearing price.
// ---------------------------------------------------------------------------
console.log('\n--- 3. adversarial / degenerate pool outputs ---');
{
  const full = auction(LADDER, DEMO, (demo.c.R0 * WAD) / demo.c.bestP); // pool at par
  assert.ok(full.s.swapped, 'a pool at the clearing price must be used');
  assert.equal(full.s.dy, full.s.minOut);
  const spent = full.p.rows.reduce((a, r) => a + r.spentCoin0, 0n);
  assert.equal(spent, full.c.bestDq, 'with the pool leg, eligible bidders fill in full');
  console.log(`  pool at par: swapped, eligible bidders 100% filled, dy=${full.s.dy / WAD}`);

  const starved = auction(LADDER, DEMO, 0n); // below _min_dy
  assert.equal(starved.s.swapped, false, 'a pool below _min_dy must be skipped');
  assert.equal(starved.s.poolIn0, 0n, 'a skipped leg consumes no residual');
  const refunded = starved.p.rows.reduce((a, r) => a + r.coin0Out, 0n);
  assert.ok(refunded > starved.c.R0, 'skipping the pool refunds the unmatched coin0');
  console.log(`  pool starved: leg skipped, ${refunded / WAD} coin0 returned pro-rata`);

  // Exactly at, and one wei below, the _min_dy boundary.
  const need = (demo.c.R0 * WAD) / demo.c.bestP;
  assert.equal(auction(LADDER, DEMO, need).s.swapped, true, 'exactly _min_dy must swap');
  assert.equal(auction(LADDER, DEMO, need - 1n).s.swapped, false, 'one wei short must not');
  console.log('  _min_dy boundary exact in both directions');

  // A pool returning absurdly more than asked must not break conservation.
  const gift = auction(LADDER, DEMO, tok(1_000_000));
  assert.ok(gift.s.swapped);
  console.log('  pool over-delivering: conservation still holds');
}

// ---------------------------------------------------------------------------
// 4. Zero-guards and degenerate batches — the div-by-zero saturation trap.
// ---------------------------------------------------------------------------
console.log('\n--- 4. degenerate batches ---');
{
  const empty = auction(LADDER, []);
  assert.equal(empty.c.bestV, 0n);
  assert.equal(empty.c.R0, 0n);
  assert.equal(empty.c.R1, 0n);
  console.log('  empty batch: V=0, no residual, no div-by-zero');

  const bidsOnly = auction(LADDER, [bid(tok(100), 3), bid(tok(50), 0)]);
  assert.equal(bidsOnly.c.bestV, 0n, 'nothing crosses without an ask');
  assert.equal(bidsOnly.c.R0, 0n, 'no crossing means no residual to swap');
  assert.equal(
    bidsOnly.p.rows.reduce((a, r) => a + r.coin0Out, 0n), tok(150),
    'a batch with no asks refunds every bidder in full',
  );
  assert.equal(bidsOnly.p.rows.reduce((a, r) => a + r.coin1Out, 0n), 0n);
  console.log('  bids only: everyone refunded in full, denominator guard held');

  const asksOnly = auction(LADDER, [ask(tok(70), 0)]);
  assert.equal(asksOnly.c.bestV, 0n);
  assert.equal(
    asksOnly.p.rows.reduce((a, r) => a + r.coin1Out, 0n), tok(70),
    'a batch with no bids refunds every asker in full',
  );
  console.log('  asks only: everyone refunded in full');

  // Disjoint limits: the bidder tops out below the asker's floor, nothing crosses.
  const noCross = auction(LADDER, [bid(tok(100), 0), ask(tok(100), 3)]);
  assert.equal(noCross.c.bestV, 0n, 'disjoint limits must not cross');
  assert.equal(noCross.p.rows[0].coin0Out, tok(100));
  assert.equal(noCross.p.rows[1].coin1Out, tok(100));
  console.log('  disjoint limits: no cross, both refunded');

  // 1-wei orders — the smallest thing floor division can mangle, and the case that
  // rules out any ratio-based limit claim. The asker delivers a wei and is paid
  // floor(1 * 0.9995) == 0 for it. Inherent: no integer price exists at that size.
  const tiny = auction(LADDER, [bid(1n, 3), ask(1n, 0)]);
  console.log(`  1-wei bid vs 1-wei ask: V=${tiny.c.bestV}, dust=(${tiny.dust0},${tiny.dust1})`);

  // Cap clamp: an order at exactly MAX_ORDER must still be exact everywhere.
  const capped = auction(LADDER, [bid(MAX_ORDER, 3), ask(MAX_ORDER, 0)]);
  assert.ok(capped.c.bestV > 0n, 'a max-size batch must still cross');
  console.log(`  MAX_ORDER batch: V=${capped.c.bestV / WAD}, no overflow`);
}

// ---------------------------------------------------------------------------
// 5. Exhaustive sweep. Every batch shape up to N=4 over the T=4 ladder crossed with
//    every pool behaviour. This is what proves the invariants; the examples above
//    only illustrate them.
// ---------------------------------------------------------------------------
console.log('\n--- 5. exhaustive sweep ---');
{
  const SIZES = [1n, 7n, tok(1), tok(333) + 7n, tok(10_000), MAX_ORDER];
  let cases = 0, crossed = 0, buyHeavy = 0, sellHeavy = 0, skipped = 0, swapped = 0;
  let maxOps = 0, maxDust = 0n;
  const probe = (orders) => {
    // Exercise the _min_dy boundary from both sides plus pathological pool outputs.
    const c0 = clear(LADDER, orders);
    const need = c0.buysHeavy ? (c0.R0 * WAD) / c0.bestP : (c0.R1 * c0.bestP) / WAD;
    for (const po of [need, need > 0n ? need - 1n : 0n, 0n, 1n, tok(1), MAX_ORDER]) {
      const r = auction(LADDER, orders, po);
      cases++;
      if (r.c.bestV > 0n) crossed++;
      if (r.c.R0 > 0n) buyHeavy++;
      if (r.c.R1 > 0n) sellHeavy++;
      if (r.s.swapped) swapped++; else skipped++;
      if (r.ops > maxOps) maxOps = r.ops;
      const d = r.dust0 > r.dust1 ? r.dust0 : r.dust1;
      if (d > maxDust) maxDust = d;
    }
  };

  // 5a. EXHAUSTIVE over every one-bid/one-ask book: both limit ticks x both sizes.
  //     That is the entire crossing / no-crossing / heavy-side space at N=2.
  for (let bt = 0; bt < LADDER.length; bt++)
    for (let at = 0; at < LADDER.length; at++)
      for (const bs of SIZES)
        for (const as of SIZES) probe([bid(bs, bt), ask(as, at)]);

  // 5b. EXHAUSTIVE over the limit-tick cube for two-bid/one-ask and one-bid/two-ask
  //     books — the shapes where PRO-RATA actually splits something two ways, which
  //     is where the floor-division conservation bug lived.
  for (let t1 = 0; t1 < LADDER.length; t1++)
    for (let t2 = 0; t2 < LADDER.length; t2++)
      for (let t3 = 0; t3 < LADDER.length; t3++) {
        probe([bid(tok(1000), t1), bid(tok(333) + 7n, t2), ask(tok(600), t3)]);
        probe([bid(tok(1000), t1), ask(tok(400) + 1n, t2), ask(tok(250), t3)]);
      }

  // 5c. Randomised shapes up to MAX_ORDERS. Deterministic, no PRNG dependency.
  for (let k = 0; k < 1500; k++) {
    let h = (k * 2654435761) & 0x7fffffff;
    const next = (m) => { h = (h * 1103515245 + 12345) & 0x7fffffff; return h % m; };
    const n = 1 + next(Number(MAX_ORDERS));
    const orders = [];
    for (let i = 0; i < n; i++) {
      const amt = SIZES[next(SIZES.length)];
      const lt = next(LADDER.length);
      orders.push(next(2) === 0 ? bid(amt, lt) : ask(amt, lt));
    }
    probe(orders);
  }

  console.log(`  ${cases} batches checked: ${crossed} crossed, ${buyHeavy} demand-heavy,` +
    ` ${sellHeavy} supply-heavy, ${swapped} settled on the pool, ${skipped} leg skipped`);
  console.log(`  worst dust observed: ${maxDust} wei   worst ops: ${maxOps}`);
  assert.ok(crossed > 1000, 'sweep must actually cross most of the time');
  assert.ok(buyHeavy > 100 && sellHeavy > 100, 'sweep must reach both heavy sides');
  assert.ok(swapped > 100 && skipped > 100, 'sweep must reach both pool paths');
  assert.ok(maxDust <= 40n, 'dust must stay in the wei range');
}

// ---------------------------------------------------------------------------
// 6. Op budget. Nox is TEE, not FHE — the cost is per-op pipeline latency on a
//    single-threaded Runner, so the op count IS the live-demo envelope.
// ---------------------------------------------------------------------------
console.log('\n--- 6. op budget ---');
{
  const CLEAR = (T, N) => T * (6 * N + 17) + 11; // tick loop + argmax + residuals
  const PAY = (N) => 10 + 16 * N;                 // denominator guards + shave + per-order
  const wideLadder = (T) => {
    const l = [...LADDER];
    while (l.length < T) l.push(l[l.length - 1] + 500_000_000_000_000n);
    return l.slice(0, T);
  };
  for (const [T, N] of [[4, 3], [4, 5], [8, 5], [8, 8]]) {
    const shape = [];
    for (let i = 0; i < N; i++) shape.push(i % 2 === 0 ? bid(tok(100), T - 1) : ask(tok(80), 0));
    const m = auction(wideLadder(T), shape);
    console.log(`  T=${T} N=${N}: clear≈${CLEAR(T, N)} + payouts≈${PAY(N)} =` +
      ` ${CLEAR(T, N) + PAY(N)} ops   (measured ${m.ops})`);
    assert.equal(m.ops, CLEAR(T, N) + PAY(N), `op formula must match the measured count for T=${T} N=${N}`);
  }
  // Calibration: the sibling project measured a 164-op encrypted sqrt at 2.05M gas
  // on live Sepolia, gateway encryptInput ~2.3s. T=4/N=3 clear() is ~1.2 of those.
  console.log(`  reference point: 164 encrypted ops == 2.05M gas measured on live Sepolia`);
}

console.log('\nALL REFERENCE CHECKS PASSED');

// Exported so `test/batch.e2e.test.ts` asserts against THIS oracle rather than a
// hand-copied twin of it — a duplicated expectation that silently drifts is worse
// than no oracle at all. Importing runs every check above, so a test run also
// re-validates the spec.
export { auction, clear, settle, payout, bid, ask, tok, LADDER, DEMO, WAD, MAX_ORDER, DUST_SHAVE };
