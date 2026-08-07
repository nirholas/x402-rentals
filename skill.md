# x402-rentals

Self-hosted time-slot rental server payable with x402 micropayments (USDC) — courts, rehearsal rooms, meeting rooms, and equipment sold by the block, directly to AI agents and humans. Browsing the inventory and its calendars is **free**. A **signed, time-limited quote** costs $0.001 and prices a specific item and window (with peak-rate lines). Reserving costs $0.02 and returns the rental with its **access code** — the gate, door, or locker code that actually gets you in — plus the booked window, the pricing breakdown, the terms, a cancel token, and a base64 ICS calendar invite. Every paid call returns its artifact in the 200 response body.

**Base URL**: `https://YOUR-DEPLOYMENT.example.com` (self-hosted — each venue runs its own instance)

**Machine-readable manifest**: `GET /.well-known/x402` (free)

## Model

Time is sold in fixed **blocks** (30 minutes by default, `blockMinutes` in the config). Each item declares `minBlocks` / `maxBlocks`, a `ratePerBlock`, and optionally a higher `peakRatePerBlock` inside `peakHours`. A window must start on the block grid and sit inside the venue's opening hours for that day.

## Endpoints

### GET /inventory — free

Rentable items plus their calendars.

Query params (all optional):
- `item` — item id, restrict to one
- `date` — `YYYY-MM-DD`, one day only
- `days` — integer, days to scan (default 7, capped at `bookingWindowDays`)

Response:
```json
{
  "venue": { "name": "402 Courts & Spaces", "timezone": "America/New_York", "address": "…" },
  "blockMinutes": 30,
  "bookingWindowDays": 14,
  "policy": { "reservePrice": "$0.02", "quotePrice": "$0.001", "freeCancellationHours": 1, "description": "…" },
  "generatedAt": "2026-08-07T18:00:00.000Z",
  "items": [
    {
      "id": "court-1",
      "name": "Tennis Court 1",
      "category": "court",
      "description": "Outdoor hard court with floodlights…",
      "location": "North lot",
      "ratePerBlock": "$0.02",
      "peakRatePerBlock": "$0.03",
      "peakHours": { "from": "17:00", "to": "21:00" },
      "minBlocks": 2, "maxBlocks": 6,
      "accessType": "gate-code",
      "terms": "Court time starts and ends on the block…",
      "calendar": [
        {
          "date": "2026-08-08",
          "open": "06:00", "close": "23:00",
          "busy": [{ "start": "18:00", "end": "19:00" }],
          "freeBlockStarts": ["06:00", "06:30", "…"]
        }
      ]
    }
  ]
}
```

Errors: `404 UNKNOWN_ITEM`.

### GET /quote — $0.001

A signed, time-limited price for one item and window.

Query params: `item` (required), `date` (required, `YYYY-MM-DD`), `start` (required, `HH:MM` on the block grid), and **either** `end` (`HH:MM`) **or** `blocks` (integer).

Response (the purchased artifact — keep it for `POST /reserve`):
```json
{
  "quoteId": "qte_1a2b3c4d5e6f",
  "itemId": "court-1",
  "itemName": "Tennis Court 1",
  "category": "court",
  "location": "North lot",
  "date": "2026-08-08",
  "start": "18:00",
  "end": "19:00",
  "blocks": 2,
  "blockMinutes": 30,
  "lines": [
    { "block": "18:00–18:30", "rate": "$0.03", "peak": true },
    { "block": "18:30–19:00", "rate": "$0.03", "peak": true }
  ],
  "total": "$0.06",
  "totalAtomicUSDC": "60000",
  "currency": "USDC",
  "available": true,
  "reservePrice": "$0.02",
  "terms": "Court time starts and ends on the block…",
  "policy": "A quote is a signed, time-limited price…",
  "issuedAt": "2026-08-07T18:00:00.000Z",
  "expiresAt": "2026-08-07T18:15:00.000Z",
  "signature": "hex HMAC-SHA256 over the canonical quote JSON"
}
```

`available: false` (with `unavailableReason`) means the window is already taken — the quote still prices it, but reserving will fail.

Errors: `400 INVALID_ITEM|INVALID_DATE|INVALID_START|INVALID_END|INVALID_WINDOW|OFF_GRID`, `404 UNKNOWN_ITEM`, `409 BELOW_MINIMUM|ABOVE_MAXIMUM|CLOSED|OUTSIDE_HOURS|WINDOW_IN_PAST`.

### POST /reserve — $0.02

Body — either echo a signed quote (recommended, locks the price):
```json
{ "name": "Ada Lovelace", "quote": { "...the entire GET /quote response, signature included..." } }
```

…or specify the window directly and let the server price it:
```json
{ "name": "Ada Lovelace", "item": "court-1", "date": "2026-08-08", "start": "18:00", "blocks": 2 }
```

Response (the purchased artifact — `accessCode` is what gets you in):
```json
{
  "rentalId": "rnt_1a2b3c4d5e6f",
  "status": "confirmed",
  "venue": "402 Courts & Spaces",
  "item": { "id": "court-1", "name": "Tennis Court 1", "category": "court", "location": "North lot", "accessType": "gate-code" },
  "accessCode": "280008",
  "accessNote": "Use this gate-code at North lot. It is valid for the booked window only.",
  "window": {
    "date": "2026-08-08", "start": "18:00", "end": "19:00",
    "blocks": 2, "blockMinutes": 30,
    "startsAt": "2026-08-08T18:00:00.000Z", "endsAt": "2026-08-08T19:00:00.000Z"
  },
  "pricing": { "lines": [ … ], "total": "$0.06", "totalAtomicUSDC": "60000", "currency": "USDC" },
  "holder": "Ada Lovelace",
  "terms": { "item": "Court time starts and ends on the block…", "policy": "…", "freeCancellationHours": 1 },
  "cancelToken": "3f9c…32 hex chars",
  "cancelEndpoint": "POST /cancel/rnt_1a2b3c4d5e6f",
  "quoteId": "qte_1a2b3c4d5e6f",
  "ics": "QkVHSU46VkNBTEVOREFS… (base64 .ics file)",
  "createdAt": "2026-08-07T18:00:01.000Z",
  "signature": "hex HMAC-SHA256 over the canonical artifact JSON"
}
```

A quote you echo back is re-verified against its signature and re-priced; a tampered `total` is rejected with `403 BAD_QUOTE_SIGNATURE`, and a genuine price change with `409 PRICE_CHANGED`.

Errors: `400 INVALID_NAME` (plus every `GET /quote` error), `403 BAD_QUOTE_SIGNATURE`, `409 QUOTE_EXPIRED|PRICE_CHANGED|WINDOW_TAKEN`.

### POST /cancel/:id — free (auth: cancelToken)

Body: `{ "cancelToken": "..." }` (or header `X-Cancel-Token`).

Response: signed cancellation record. The block is released immediately and the access code stops working:
```json
{
  "rentalId": "rnt_1a2b3c4d5e6f",
  "status": "cancelled",
  "cancelledAt": "2026-08-07T18:04:00.000Z",
  "blockReleased": true,
  "refundable": true,
  "reason": "cancelled 23.9h before the window — the $0.02 reservation fee is refundable",
  "accessCodeRevoked": true,
  "item": { "id": "court-1", "name": "Tennis Court 1" },
  "window": { "date": "2026-08-08", "start": "18:00", "end": "19:00" },
  "signature": "…"
}
```

Errors: `404 NOT_FOUND`, `403 BAD_CANCEL_TOKEN`, `409 ALREADY_CANCELLED`.

### Free routes

- `GET /inventory` — items + calendars (above)
- `GET /info` — venue profile, hours, block size, quote validity, policy, prices, payment rails
- `GET /rentals/:id?cancelToken=...` — the rental, including its access code
- `GET /health` — liveness
- `GET /.well-known/x402` — this service's payment manifest

## Payment

**Pay in USDC on Base or Solana — your client picks the rail.** Every paid route
answers an unpaid request with a `402` whose `accepts` array carries both rails;
choose the one your wallet can settle and ignore the other.

- Protocol: [x402](https://x402.org) (HTTP 402 Payment Required), `x402Version: 1`, scheme `exact`
- **EVM rail** — network `base-sepolia` (default; `NETWORK=base` for mainnet), asset USDC
  (`0x036CbD53842c5426634e7929541eC2318f3dCF7e` on base-sepolia), payTo
  `0x40252CFDF8B20Ed757D61ff157719F33Ec332402`
- **Solana rail** — network `solana` (`SOLANA_NETWORK=devnet` for `solana-devnet`), asset USDC
  (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`), payTo
  `WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW`
- Facilitators (one per rail): EVM `https://x402.org/facilitator` (`FACILITATOR_URL`), Solana `https://facilitator.payai.network` (`SOLANA_FACILITATOR_URL`)
- Flow: call the route → receive `402` + `accepts[]` → sign the USDC payment for one rail
  (EVM: EIP-3009 `transferWithAuthorization`; Solana: SPL `transferChecked`) → retry with the
  `X-PAYMENT` header → receive `200` + the artifact in the body + an
  `X-PAYMENT-RESPONSE` settlement receipt naming the rail and transaction.
- Clients: `x402-fetch` (EVM), `@three-ws/x402-payment-modal` (browser, both rails),
  or any x402-compatible client.
- Settlement happens only when the route returns `2xx`. A window taken between your quote
  and your reservation returns `409 WINDOW_TAKEN` and costs you nothing.

**Note on the two prices.** The x402 charge for `POST /reserve` is a flat $0.02
booking fee, separate from the rental `total` in the quote. The `total` is what
the venue bills for the time itself, on its own terms — the artifact states both
so there is no ambiguity.

Example 402 body:

```json
{
  "x402Version": 1,
  "error": "X-PAYMENT header is required",
  "accepts": [
    { "scheme": "exact", "network": "base-sepolia", "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "payTo": "0x40252CFDF8B20Ed757D61ff157719F33Ec332402", "maxAmountRequired": "20000",
      "resource": "https://YOUR-DEPLOYMENT.example.com/reserve", "mimeType": "application/json",
      "maxTimeoutSeconds": 300, "description": "Reserve a time block…" },
    { "scheme": "exact", "network": "solana", "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "payTo": "WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW", "maxAmountRequired": "20000",
      "resource": "https://YOUR-DEPLOYMENT.example.com/reserve", "mimeType": "application/json",
      "maxTimeoutSeconds": 300, "description": "Reserve a time block…" }
  ]
}
```

## Reservation guidance for agents

- `GET /inventory` is free — read it first to find items and open blocks, then pay $0.001 only for the window you actually want priced.
- Echo the whole quote (including `signature`) into `POST /reserve`. It pins the price and gives you a clean `409 PRICE_CHANGED` instead of a silent surprise.
- Quotes expire after `quoteValidMinutes` (15 by default). On `409 QUOTE_EXPIRED`, re-quote.
- On `409 WINDOW_TAKEN`, re-read `/inventory` rather than retrying the same window.
- Reserving is **not idempotent**: two `POST /reserve` calls book two windows. Record `rentalId` before retrying a network failure.
- `accessCode` is a bearer credential for physical access — treat it like a door key, and don't log it into shared transcripts.

## Verifying signatures

`signature` fields are HMAC-SHA256 (hex) over the canonical JSON (sorted keys, `signature` excluded) using the server's `SIGNING_SECRET`. The quote signature is load-bearing: the server re-verifies it on `POST /reserve`, so a client cannot lower the price it was quoted. Verify with the exported `verify()` in `src/sign.ts` if you share the secret, or treat the signature as a tamper-evidence tag issued by the venue.

## Contact

Questions, integration help, or a bug: **nichxbt@gmail.com** ·
[github.com/nirholas/x402-rentals](https://github.com/nirholas/x402-rentals)
