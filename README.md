# x402-rentals

**Rent it by the block, get the code back** — a self-hosted rental server for
courts, rehearsal rooms, meeting rooms, and equipment, payable with
[x402](https://x402.org) micropayments. Browsing the calendar is **free**. $0.001
buys a **signed, time-limited quote** for an exact window; $0.02 reserves it and
returns the gate, door, or locker code — plus the window, the pricing breakdown,
the terms, and a calendar invite — in the same HTTP response.

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![x402](https://img.shields.io/badge/payments-x402%20%C2%B7%20USDC-0052ff.svg)](https://x402.org)
[![rails](https://img.shields.io/badge/rails-Base%20%2B%20Solana-14f195.svg)](#how-x402-works)
[![Docs](https://img.shields.io/badge/docs-GitHub%20Pages-0052ff.svg)](https://nirholas.github.io/x402-rentals/)

## Why x402 for this

Renting a court for an hour is a $10 transaction wrapped in a $0 relationship:
nobody wants an account, a card on file, or a booking platform's cut for that.
x402 makes the transaction the whole relationship — a wallet pays, gets a signed
price, pays again, and walks away with a code that opens the gate. Splitting
**quote** from **reserve** matters for agents in particular: an agent can obtain a
binding, itemised price (peak blocks flagged) and show it to a human *before*
committing, and the signature means the server can't quietly re-price between the
two calls.

## Quickstart

```bash
git clone https://github.com/nirholas/x402-rentals
cd x402-rentals && npm install

# your venue, hours, items, rates and terms live in config/inventory.json
npm run dev
```

The server ships with the suite's public receive addresses so it runs out of the
box. Set `PAY_TO_ADDRESS` (Base) and `SOLANA_PAY_TO_ADDRESS` (Solana) in `.env`
to receive the payments yourself.

Then, in another terminal, run the full agent flow (browse → quote → reserve →
cancel):

```bash
PRIVATE_KEY=0xFundedBaseSepoliaKey npm run client
```

Fund the client wallet with testnet USDC at
[faucet.circle.com](https://faucet.circle.com). Open <http://localhost:4024> for
the human checkout demo.

## API

| Route | Price | What you get back |
|---|---|---|
| `GET /inventory` | free | Rentable items + calendars: rates, peak hours, min/max blocks, access type, terms, busy windows, free block starts |
| `GET /quote` | $0.001 | Signed, time-limited price: per-block `lines` with peak flags, `total` + `totalAtomicUSDC`, `available`, `terms`, `expiresAt`, HMAC `signature` |
| `POST /reserve` | $0.02 | `{rentalId, accessCode, accessNote, window, pricing, terms, cancelToken, quoteId, ics (base64 invite), signature}` |
| `POST /cancel/:id` | free (auth: `cancelToken`) | Signed cancellation — block released, access code revoked |
| `GET /rentals/:id` | free (auth: `cancelToken`) | The rental, including its access code |
| `GET /info`, `GET /health`, `GET /.well-known/x402` | free | Venue profile / liveness / machine-readable payment manifest |

Full reference: [docs/api.md](docs/api.md) · [openapi.json](openapi.json)

## The block model

Time is sold in fixed blocks (30 minutes by default, `blockMinutes` in the
config). Each item declares `minBlocks` / `maxBlocks`, a `ratePerBlock`, and
optionally a higher `peakRatePerBlock` inside `peakHours`. A window must start on
the block grid and sit inside the venue's opening hours for that day — the quote
tells you exactly which blocks priced at which rate:

```json
"lines": [
  { "block": "18:00–18:30", "rate": "$0.03", "peak": true },
  { "block": "18:30–19:00", "rate": "$0.03", "peak": true }
],
"total": "$0.06"
```

## Signed quotes

The quote's `signature` is HMAC-SHA256 over its canonical JSON. Echo the whole
quote back into `POST /reserve` and the server re-verifies it *and* re-prices the
window:

- altered `total` → `403 BAD_QUOTE_SIGNATURE`
- genuine price change → `409 PRICE_CHANGED`
- past `expiresAt` → `409 QUOTE_EXPIRED`

So a client cannot lower the price it was quoted, and a venue cannot silently
raise it. Reserving without a quote is allowed too — the server just prices the
window at request time.

## How x402 works

**Pay in USDC on Base or Solana — your client picks the rail.**

1. Client calls a paid route with no payment → server answers **`402 Payment
   Required`** with an `accepts[]` array holding **both rails**: USDC on Base
   (`base-sepolia` by default) and USDC on Solana, each with amount, token
   address, and recipient.
2. Client picks one and signs — EVM: an EIP-3009 `transferWithAuthorization`;
   Solana: an SPL `transferChecked` — then retries with the **`X-PAYMENT`**
   header.
3. The facilitator for that rail **verifies and settles** on the chosen chain —
   x402.org's for Base, PayAI's for Solana (each overridable by env; no public
   facilitator settles both).
4. Server responds **`200`** with the purchased artifact in the body and a
   settlement receipt in **`X-PAYMENT-RESPONSE`**.

Settlement is deliberately last: the payment only settles when the route returns
`2xx`, so a window taken between the client's quote and its reservation returns
`409 WINDOW_TAKEN` and never charges the payer.

No API keys, no invoices, no minimums — each request pays for itself. Raw
wire-level walkthrough: [examples/curl.md](examples/curl.md).

**Two prices, stated plainly.** The x402 charge on `POST /reserve` is a flat
$0.02 booking fee. The `total` in the quote is what the venue bills for the time
itself, on its own terms. Both appear in the artifact so there is no ambiguity.

## Real backend / configuration

This server sells **real inventory you configure** — there are no fixtures and no
external API keys:

- `config/inventory.json` — your venue profile, opening hours, block size,
  rentable items (rates, peak windows, block limits, access type, terms), booking
  window, quote validity, and policy.
- Reservations persist to `data/rentals.json` (file-based, no database).
- `SIGNING_SECRET` — set in production; it signs quotes, rentals, cancellations
  and cancel tokens. The quote signature is load-bearing, not decorative.
- `PUBLIC_BASE_URL` — set behind a proxy so 402 `resource` URLs are correct.
- Payment addresses: `PAY_TO_ADDRESS` (Base) and `SOLANA_PAY_TO_ADDRESS`
  (Solana). Both default to the suite's public receive addresses so the demo runs
  unconfigured — the server prints a reminder while the defaults are active.
- Facilitators are per-rail: `FACILITATOR_URL` (EVM, default x402.org) and
  `SOLANA_FACILITATOR_URL` (Solana, default PayAI). No public facilitator settles
  both chains.
- Mainnet: `NETWORK=base` + a production EVM `FACILITATOR_URL`. Solana defaults
  to mainnet; `SOLANA_NETWORK=devnet` switches it. Use a dedicated
  `SOLANA_RPC_URL` in production.

**Access codes are generated and revoked here; issuing them to your actual lock
hardware is the integration you own.** The server is the source of truth for who
holds which code for which window.

All variables: [.env.example](.env.example)

## Human checkout

`public/index.html` is a booking-grid checkout: pick an item, date, and length;
tap a free block; buy the signed quote and read the per-block breakdown before
committing; reserve with the drop-in
[`@three-ws/x402-payment-modal`](https://www.npmjs.com/package/@three-ws/x402-payment-modal)
(loaded from CDN) and the gate code appears on screen. The modal reads the
dual-rail 402 and offers **Phantom/Solflare/Backpack on Solana or MetaMask on
Base** automatically. It also brings **SIWX wallet re-entry** (a wallet that
already paid signs back in instead of reconnecting) and **client-side spending
caps** (per-call / hourly / daily), so a regular doesn't re-approve every
booking.

The Solana browser path needs one small server route — Phantom signs serialized
transactions, so the SPL transfer has to be built somewhere. `src/checkout.ts`
mounts the package's own Express adapter at `/api/x402-checkout`; if the optional
peer deps aren't installed, that path degrades and the Base path keeps working.
Agent clients build their own transaction and never touch it.

## For AI agents

- **[skill.md](skill.md)** — agent-facing service description (endpoints, prices,
  schemas, both payment rails).
- **[/.well-known/x402](public/.well-known/x402)** — machine-readable manifest
  served by the app; indexable by [x402scan.com](https://x402scan.com), the x402
  Bazaar, and [agentic.market](https://agentic.market). Deploy publicly and
  submit your base URL to be discovered.
- **MCP**: wrap the endpoints as Claude tools in ~90 lines — see
  [examples/mcp-tool.md](examples/mcp-tool.md).
- **Client**: [examples/agent-client.ts](examples/agent-client.ts) is the
  complete browse-quote-reserve-cancel loop via `x402-fetch`, including a
  tampered-quote rejection, with the Solana alternative documented inline.
- Agent guide: [docs/agents.md](docs/agents.md)

## Docs

Site: **<https://nirholas.github.io/x402-rentals/>** · [Tutorial](docs/tutorial.md)
· [API reference](docs/api.md) · [For agents](docs/agents.md)

Part of the [x402 Suite](https://github.com/nirholas/x402-suite).

## Support

Questions, integration help, or a bug report: **nichxbt@gmail.com** — or open an
[issue](https://github.com/nirholas/x402-rentals/issues).

## License

[Apache-2.0](LICENSE)
