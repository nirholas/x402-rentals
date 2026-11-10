---
name: rent-time-slots
description: Browse availability, get a signed quote, reserve and cancel time-block rentals (courts, rooms, equipment) paid over x402. Use when an agent needs to book a bookable resource by the block.
---

# x402-rentals time-slot rentals

A rental venue exposes items with block-based rates. Browsing availability is free. A quote is a signed, time-limited price. Reserving returns a signed receipt with an access code and a cancel token.

## Run the server

The repo is a self-hosted Express service. It is not published to npm, so run it from a clone.

```bash
git clone https://github.com/nirholas/x402-rentals && cd x402-rentals
npm install
cp .env.example .env   # optional: the defaults run out of the box
npm run dev            # listens on http://localhost:4024 (override with PORT)
```

Set `PAY_TO_ADDRESS` (Base) and `SOLANA_PAY_TO_ADDRESS` (Solana) in `.env` to receive payments yourself.
Venue, items, hours and rates live in `config/inventory.json` (path overridable with `INVENTORY_CONFIG`). `SIGNING_SECRET` signs quotes and receipts; `DATA_DIR` holds state.
`GET http://localhost:4024/.well-known/x402` lists every route with its price, and `GET /health` is the liveness probe.

## Routes

| Route | Price | Purpose |
|---|---|---|
| `GET /inventory` | free | Items and calendars. Optional query: `item`, `date` (`YYYY-MM-DD`), `days` |
| `GET /quote` | $0.001 | Signed price. Query: `item`, `date`, `start` (`HH:MM`) and either `end` or `blocks` |
| `POST /reserve` | $0.02 | Body `{name, quote}` with the full quote echoed back (locks the price) or `{name, item, date, start, blocks}` |
| `POST /cancel/:id` | free | Body `{cancelToken}` or header `X-Cancel-Token`. Releases the block |
| `GET /rentals/:id`, `GET /info`, `GET /health` | free | Rental record, venue info, liveness |

The full request and response schemas are in `skill.md` at the repo root (the running server also serves it at `GET /skill.md`).

## Paying

Paid routes answer an unpaid request with HTTP 402 and an `accepts` array with one entry per rail (USDC on Base and USDC on Solana). A client picks an entry, signs, and retries with the `X-PAYMENT` header. The 200 body carries the artifact and an `X-PAYMENT-RESPONSE` header carries the settlement receipt. Any x402 client works (`x402-fetch` with `viem` on the EVM rail). Each paid call spends real USDC on whichever network the server is configured for (`NETWORK`, `SOLANA_NETWORK`), so show the user the route, price and network and get a yes before paying.

## Worked example

```bash
curl -s 'http://localhost:4024/inventory?days=3'
curl -s 'http://localhost:4024/inventory?item=court-1&days=1'
```

Pick a free block, then after the user approves each spend, pay `GET /quote?item=court-1&date=2026-08-08&start=18:00&blocks=2` ($0.001) and `POST /reserve` with the quote ($0.02). Keep `cancelToken` from the receipt; `POST /cancel/<rentalId>` with it is free.
