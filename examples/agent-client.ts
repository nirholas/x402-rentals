/**
 * Full agent flow against x402-rentals:
 *   1. read the free manifest + inventory (browsing costs nothing)
 *   2. pick an item and a free window
 *   3. pay $0.001 for a signed quote
 *   4. pay $0.02 to reserve, echoing the quote so the price is pinned
 *   5. print the artifact (access code!) + settlement receipt
 *   6. cancel for free — the block is released and the code revoked
 *
 * Usage:
 *   PRIVATE_KEY=0x... BASE_URL=http://localhost:4024 npx tsx examples/agent-client.ts
 *
 * The wallet needs base-sepolia USDC — faucet: https://faucet.circle.com
 *
 * ── Which rail? ────────────────────────────────────────────────────────────
 * Every 402 from this server carries BOTH rails in `accepts`:
 *   [0] network "base-sepolia" | "base"    USDC via EIP-3009 transferWithAuthorization
 *   [1] network "solana" | "solana-devnet" USDC via SPL transferChecked
 * `x402-fetch` (used below) picks the EVM entry automatically. The Solana
 * alternative is at the bottom of this file.
 */
import { wrapFetchWithPayment, decodeXPaymentResponse } from "x402-fetch";
import { privateKeyToAccount } from "viem/accounts";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4024";
const pk = process.env.PRIVATE_KEY;
if (!pk) {
  console.error("Set PRIVATE_KEY to a funded base-sepolia key (https://faucet.circle.com)");
  process.exit(1);
}

const account = privateKeyToAccount(pk as `0x${string}`);
const payFetch = wrapFetchWithPayment(fetch, account);

function receipt(res: Response): unknown {
  const header = res.headers.get("x-payment-response");
  return header ? decodeXPaymentResponse(header) : null;
}

// 1. free discovery — browsing costs nothing
const manifest = await fetch(`${BASE_URL}/.well-known/x402`).then((r) => r.json());
console.log("Manifest:", manifest.name, "-", manifest.description);
console.log("Rails:", manifest.payment.rails.map((r: { network: string }) => r.network).join(" | "), "\n");

const inventory = await fetch(`${BASE_URL}/inventory?days=7`).then((r) => r.json());
console.log(`${inventory.venue.name} — ${inventory.items.length} rentable items, ${inventory.blockMinutes}min blocks\n`);

// 2. pick the first item with a free window at least minBlocks long
type Day = { date: string; freeBlockStarts: string[] };
type Item = { id: string; name: string; minBlocks: number; ratePerBlock: string; calendar: Day[] };

let chosen: { item: Item; date: string; start: string } | null = null;
outer: for (const item of inventory.items as Item[]) {
  for (const day of item.calendar) {
    // Need `minBlocks` consecutive free starts.
    for (let i = 0; i + item.minBlocks <= day.freeBlockStarts.length; i++) {
      const run = day.freeBlockStarts.slice(i, i + item.minBlocks);
      const consecutive = run.every((t, k) => {
        if (k === 0) return true;
        const prev = run[k - 1];
        const mins = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
        return mins(t) - mins(prev) === inventory.blockMinutes;
      });
      if (consecutive) {
        chosen = { item, date: day.date, start: run[0] };
        break outer;
      }
    }
  }
}
if (!chosen) throw new Error("nothing free in that window — widen the search");
console.log(
  `Quoting ${chosen.item.name} on ${chosen.date} from ${chosen.start} (${chosen.item.minBlocks} blocks)\n`,
);

// 3. paid quote
const quoteUrl =
  `${BASE_URL}/quote?item=${encodeURIComponent(chosen.item.id)}` +
  `&date=${chosen.date}&start=${chosen.start}&blocks=${chosen.item.minBlocks}`;
const quoteRes = await payFetch(quoteUrl);
if (!quoteRes.ok) throw new Error(`quote failed: ${quoteRes.status} ${await quoteRes.text()}`);
const quote = await quoteRes.json();

console.log("=== QUOTE ARTIFACT ===");
console.log(JSON.stringify(quote, null, 2));
console.log("\nPaid receipt:", receipt(quoteRes));
console.log(
  `\n${quote.blocks} blocks ${quote.start}–${quote.end} = ${quote.total}` +
    ` (${quote.lines.filter((l: { peak: boolean }) => l.peak).length} at peak rate)`,
);
console.log(`Quote expires ${quote.expiresAt}, available: ${quote.available}\n`);

// 4. paid reservation — echo the signed quote so the price cannot drift
const reserveRes = await payFetch(`${BASE_URL}/reserve`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-payer-address": account.address },
  body: JSON.stringify({ name: "Agent Ada", quote }),
});
if (!reserveRes.ok) throw new Error(`reserve failed: ${reserveRes.status} ${await reserveRes.text()}`);
const rental = await reserveRes.json();

// 5. the purchased artifact
console.log("=== RENTAL ARTIFACT ===");
console.log(JSON.stringify({ ...rental, ics: `${rental.ics.slice(0, 40)}...` }, null, 2));
console.log("\nX-PAYMENT-RESPONSE settlement receipt:");
console.log(receipt(reserveRes));
console.log(`\n>>> ACCESS CODE: ${rental.accessCode} — ${rental.accessNote}`);
console.log(
  `>>> ${rental.item.name}, ${rental.window.date} ${rental.window.start}–${rental.window.end}, ${rental.pricing.total}`,
);
console.log("\nICS invite decodes to:\n");
console.log(
  Buffer.from(rental.ics, "base64").toString("utf8").split("\r\n").slice(0, 8).join("\n"),
  "...",
);

// A tampered quote is rejected — the signature covers the price.
const tampered = { ...quote, total: "$0.000001" };
const tamperRes = await payFetch(`${BASE_URL}/reserve`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Mallory", quote: tampered }),
});
console.log("\nTampered quote rejected:", tamperRes.status, await tamperRes.text());

// 6. free cancel — releases the block and revokes the code
const cancelRes = await fetch(`${BASE_URL}/cancel/${rental.rentalId}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ cancelToken: rental.cancelToken }),
});
console.log("\n=== CANCELLATION ===");
console.log(JSON.stringify(await cancelRes.json(), null, 2));

// ─────────────────────────────────────────────────────────────────────────────
// Paying on the SOLANA rail instead
// ─────────────────────────────────────────────────────────────────────────────
//
// `x402-fetch` signs the EVM entry. To settle in USDC on Solana, read the same
// 402 body and act on the `solana` entry:
//
//   const res = await fetch(`${BASE_URL}/reserve`, { method: "POST" });
//   const { accepts } = await res.json();
//   const sol = accepts.find((a) => a.network.startsWith("solana"));
//   // sol = { scheme: "exact", network: "solana",
//   //         asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",   // USDC mint
//   //         payTo: "WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW",
//   //         maxAmountRequired: "20000",                              // 0.02 USDC, 6dp
//   //         extra: { rpcUrl: "https://api.mainnet-beta.solana.com" } }
//
// Build an SPL `transferChecked` of `maxAmountRequired` units of `asset` to
// `payTo`, sign it with your Solana keypair, then base64 the x402 envelope into
// `X-PAYMENT` and retry. Verification and settlement happen server-side through
// that rail's facilitator (PayAI for Solana, x402.org for Base).
//
// Browser clients can reuse the checkout helper this server mounts at
// `POST /api/x402-checkout?action=prepare` (build the transaction) and
// `?action=encode` (wrap the signed transaction into the X-PAYMENT envelope).
//
// ── Raw dual-rail 402, for reference ────────────────────────────────────────
//
//   $ curl -s -X POST http://localhost:4024/reserve | jq '.accepts[] | {network, payTo, asset}'
//   { "network": "base-sepolia",
//     "payTo": "0x40252CFDF8B20Ed757D61ff157719F33Ec332402",
//     "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e" }
//   { "network": "solana",
//     "payTo": "WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW",
//     "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }
