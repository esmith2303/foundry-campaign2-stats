/**
 * Coin maths for the shop. Everything is done in copper pieces (cp).
 * dnd5e coins: 1 pp = 10 gp, 1 gp = 2 ep = 10 sp = 100 cp.
 */
export const COIN_CP = { pp: 1000, gp: 100, ep: 50, sp: 10, cp: 1 };
export const DENOMS = ["pp", "gp", "ep", "sp", "cp"];

export function toCp(value, denom = "gp") {
  return Math.max(0, Math.round((Number(value) || 0) * (COIN_CP[denom] ?? 100)));
}

export function cleanWallet(currency = {}) {
  return Object.fromEntries(DENOMS.map(d => [d, Math.max(0, Math.floor(Number(currency?.[d]) || 0))]));
}

export function walletCp(currency) {
  const c = cleanWallet(currency);
  return DENOMS.reduce((t, d) => t + c[d] * COIN_CP[d], 0);
}

/** 8550 → "85 gp 5 sp" (platinum shown as gold, electrum as silver). */
export function formatCp(cp) {
  cp = Math.max(0, Math.round(cp));
  const gp = Math.floor(cp / 100), sp = Math.floor((cp % 100) / 10), c = cp % 10;
  const parts = [gp && `${gp} gp`, sp && `${sp} sp`, c && `${c} cp`].filter(Boolean);
  return parts.length ? parts.join(" ") : "0 gp";
}

/**
 * Pay `costCp` from a wallet. Uses the largest coins first; if an exact amount
 * can't be made, breaks the smallest coin that covers the rest and gives change
 * in gp/sp/cp. Returns the new wallet, or null if they can't afford it.
 */
export function pay(currency, costCp) {
  const c = cleanWallet(currency);
  let rem = Math.max(0, Math.round(costCp));
  if (walletCp(c) < rem) return null;
  for (const d of DENOMS) {
    const use = Math.min(c[d], Math.floor(rem / COIN_CP[d]));
    c[d] -= use;
    rem -= use * COIN_CP[d];
  }
  if (rem > 0) {
    // Every coin left is worth more than `rem`, so break the smallest one
    const d = [...DENOMS].reverse().find(x => c[x] > 0 && COIN_CP[x] > rem);
    c[d] -= 1;
    let change = COIN_CP[d] - rem;
    for (const x of ["gp", "sp", "cp"]) {
      if (COIN_CP[x] >= COIN_CP[d]) continue;
      const n = Math.floor(change / COIN_CP[x]);
      c[x] += n;
      change -= n * COIN_CP[x];
    }
  }
  return c;
}
