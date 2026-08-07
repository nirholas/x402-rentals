# Tutorial — from zero to a gate code

This walkthrough takes you from clone to a reserved block with a working access
code, using real x402 payments — **USDC on Base Sepolia or on Solana**, your
choice.

## 1. Install

```bash
git clone https://github.com/nirholas/x402-rentals
cd x402-rentals
npm install
```

Requirements: Node 18+.

## 2. Configure

The server runs unconfigured — `.env.example` ships with the suite's public
receive addresses on both rails, and the startup banner reminds you they're the
defaults. To take the money yourself, copy the template and set both:

```bash
cp .env.example .env
# edit .env →
#   PAY_TO_ADDRESS=0xYourBaseAddress            (EVM rail)
#   SOLANA_PAY_TO_ADDRESS=YourSolanaAddress     (Solana rail)
```

You can also run one rail only: drop an address and that rail is omitted from
every 402 (the server logs which one it skipped).

Describe your real inventory in `config/inventory.json`:

- `venue` — name, description, timezone, address, phone
- `hours` — opening hours per weekday (`null` = closed)
- `blockMinutes` — the length of one bookable block (30 by default)
- `items` — each with `id`, `name`, `category`, `description`, `location`,
  `ratePerBlock`, optional `peakRatePerBlock` + `peakHours`, `minBlocks`,
  `maxBlocks`, `accessType` (`gate-code` / `door-code` / `locker-code`), and
  `terms`
- `bookingWindowDays` — how far ahead people may book
- `quoteValidMinutes` — how long a signed quote stays honourable (15 by default)
- `policy` — the reserve fee, the quote fee, the free-cancellation window, and
  the wording customers see

**Set `SIGNING_SECRET` before you sell anything real.** It signs the quotes, and
the quote signature is what stops a client re-pricing its own reservation.

## 3. Run the server

```bash
npm run dev
```

You'll see the banner with paid routes, prices, and both rails. Sanity checks:

```bash
curl -s http://localhost:4024/health | jq
curl -s "http://localhost:4024/inventory?days=2" | jq '.items[] | {id, name, ratePerBlock, minBlocks}'
curl -s http://localhost:4024/.well-known/x402 | jq
```

Note that `/inventory` needs no payment. Browsing is free.

## 4. Your first 402

Call a paid route without paying:

```bash
curl -si "http://localhost:4024/quote?item=court-1&date=2026-08-08&start=18:00&blocks=2" | head -20
```

You get `HTTP/1.1 402 Payment Required` and a JSON body whose `accepts[]` array
has **two entries** — one per rail:

```bash
curl -s "http://localhost:4024/quote?item=court-1&date=2026-08-08&start=18:00&blocks=2" \
  | jq '.accepts[] | {network, payTo, asset, maxAmountRequired}'
```

```json
{ "network": "base-sepolia", "payTo": "0x40252CFD…", "asset": "0x036CbD53…", "maxAmountRequired": "1000" }
{ "network": "solana",       "payTo": "WwwuGbqH…",  "asset": "EPjFWdd5…",  "maxAmountRequired": "1000" }
```

Each entry states the exact amount (atomic USDC units, 6 decimals), the token
address, the recipient, and the network. This is the whole protocol: the 402 *is*
the price list, and it quotes in two currencies of the same dollar.

## 5. Fund a client wallet

**Base rail (what the bundled client uses):** create a throwaway key (e.g.
`openssl rand -hex 32` prefixed with `0x`, or export one from a test wallet) and
fund it with **Base Sepolia USDC** from <https://faucet.circle.com>. A few cents'
worth is plenty.

**Solana rail:** any wallet holding USDC works — Phantom in the browser demo, or
a keypair in an agent. Set `SOLANA_NETWORK=devnet` to test against devnet USDC
instead of mainnet.

## 6. Quote, then reserve

```bash
PRIVATE_KEY=0xYourFundedKey npm run client
```

`examples/agent-client.ts` will:

1. read the free manifest and inventory,
2. find an item with `minBlocks` consecutive free blocks,
3. pay **$0.001** for `GET /quote` and print the per-block breakdown (peak blocks
   are flagged),
4. pay **$0.02** for `POST /reserve`, echoing the whole signed quote so the price
   is pinned,
5. print the artifact — rental id, **access code**, window, pricing, terms,
   cancel token — plus the decoded `X-PAYMENT-RESPONSE` settlement receipt, which
   names the rail and the transaction,
6. try to reserve with a tampered quote and show it rejected,
7. cancel for free and show the block returning to the calendar.

## 7. Reading the artifacts

**The quote** is a promise you can hold the server to:

- `lines` — one entry per block, with `peak: true` where the higher rate applied.
- `total` / `totalAtomicUSDC` — the price of the *time*, in dollars and in USDC
  base units.
- `available` — whether the window is still free right now.
- `expiresAt` — after this, `POST /reserve` answers `409 QUOTE_EXPIRED`.
- `signature` — HMAC-SHA256 over the canonical quote. **Echo the quote whole**;
  the server re-verifies it, so a client that edits `total` gets
  `403 BAD_QUOTE_SIGNATURE` rather than a discount.

**The rental** is what you actually bought:

- `accessCode` — the gate/door/locker code. This is the product; treat it like a
  key.
- `window` — `date`, `start`, `end`, `blocks`, plus ISO `startsAt`/`endsAt`.
- `pricing` — the same lines and total, frozen at reservation time.
- `terms` — the item's rules and the venue policy, so there is no dispute later.
- `cancelToken` — bearer credential for cancelling and for looking the rental up.
- `ics` — base64 `.ics`; `Buffer.from(ics, "base64")` and save to import into any
  calendar.

## 8. Cancelling

```bash
curl -s -X POST http://localhost:4024/cancel/rnt_XXXX \
  -H 'content-type: application/json' \
  -d '{"cancelToken":"YOUR_TOKEN"}' | jq '{blockReleased, refundable, accessCodeRevoked, reason}'

# the block is back on the calendar:
curl -s "http://localhost:4024/inventory?item=court-1&date=2026-08-08" \
  | jq '.items[0].calendar[0].busy'
```

Cancelling outside `freeCancellationHours` marks the reserve fee refundable;
inside it, forfeited. Either way the block is released immediately and the access
code stops working.

## 9. The human checkout

Open <http://localhost:4024> — a booking-grid page using the drop-in
`@three-ws/x402-payment-modal`. Pick an item, a date and a length; tap a free
block; buy the signed quote and see the per-block breakdown before committing;
reserve from a browser wallet — **Phantom / Solflare / Backpack on Solana, or
MetaMask on Base** — and the gate code appears on screen. The modal reads the
dual-rail 402 and offers the wallets it detects; SIWX re-entry means a regular
signs in instead of reconnecting, and spending caps bound what the page can
charge.

The Solana browser path needs one server route (Phantom signs serialized
transactions, so the SPL transfer has to be built server-side). `src/checkout.ts`
mounts it at `/api/x402-checkout`; if its optional peer deps are missing the
banner says `Solana browser checkout: disabled` and the Base path still works.
Agent clients build their own transaction and never touch that route.

## 10. Going to mainnet

1. Set `NETWORK=base` (the Solana rail already defaults to mainnet — set
   `SOLANA_NETWORK=devnet` if you want it on devnet instead).
2. Point `FACILITATOR_URL` at a production facilitator for Base (e.g. Coinbase
   Developer Platform's x402 facilitator). The Solana rail settles through
   `SOLANA_FACILITATOR_URL`, which defaults to PayAI's
   (`https://facilitator.payai.network`) — no public facilitator handles both
   chains.
3. Replace the public Solana RPC: set `SOLANA_RPC_URL` to a dedicated endpoint
   (Helius / Triton / QuickNode). The default is rate-limited and will fail
   under load.
4. Set a strong `SIGNING_SECRET` — it is what makes your quotes binding.
5. Use real merchant wallets for `PAY_TO_ADDRESS` **and**
   `SOLANA_PAY_TO_ADDRESS`.
6. Wire `accessCode` to whatever actually opens the door. The server generates
   and revokes codes; issuing them to your lock hardware is the integration you
   own.
7. Deploy behind HTTPS (agents will refuse to pay plaintext endpoints) and keep
   `data/` on a persistent volume.

Prices stay in dollar strings (`$0.02`) — the paywall converts to atomic USDC on
whichever network the client picks.
