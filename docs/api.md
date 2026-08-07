# API reference

Base URL: your deployment (default `http://localhost:4024`). Machine-readable
spec: [`openapi.json`](https://github.com/nirholas/x402-rentals/blob/main/openapi.json).
Browsing is free; pricing and reserving are paid. All prices are in USDC and
payable on **either** rail — Base (EVM) or Solana. Paid routes return
`402 Payment Required` until called with a valid `X-PAYMENT` header; successful
paid responses carry an `X-PAYMENT-RESPONSE` settlement receipt header.

## The block model

Time is sold in fixed blocks (`blockMinutes`, 30 by default). Each item declares
`minBlocks` / `maxBlocks`, a `ratePerBlock`, and optionally a higher
`peakRatePerBlock` inside `peakHours`. A window must start on the block grid and
fit inside the venue's opening hours for that day.

---

## GET /inventory — free

Rentable items plus their calendars.

| Param | Type | Notes |
|---|---|---|
| `item` | string | Item id. Omit for every item. |
| `date` | `YYYY-MM-DD` | Restrict to one day. |
| `days` | integer | Days to scan when no `date` is given (default 7, capped at `bookingWindowDays`). |

**200**

```json
{
  "venue": { "name": "402 Courts & Spaces", "timezone": "America/New_York", "address": "402 Payment Ave" },
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
          "freeBlockStarts": ["06:00", "06:30", "07:00", "…"]
        }
      ]
    }
  ]
}
```

`open`/`close` are `null` on days the venue is closed, and `freeBlockStarts` is
then empty.

**Errors**: `404 UNKNOWN_ITEM`.

---

## GET /quote — $0.001

A signed, time-limited price for one item and window.

| Param | Required | Notes |
|---|---|---|
| `item` | yes | Item id from `/inventory`. |
| `date` | yes | `YYYY-MM-DD`. |
| `start` | yes | `HH:MM`, on the block grid. |
| `end` | one of | `HH:MM`. Supply this **or** `blocks`. |
| `blocks` | one of | Integer number of blocks. |

**200 — the purchased artifact**

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
  "signature": "hex HMAC-SHA256"
}
```

`available: false` (with `unavailableReason`) means the window is already taken —
the quote still prices it, but reserving will fail with `409 WINDOW_TAKEN`.

| Status | Code | Meaning |
|---|---|---|
| 400 | `INVALID_ITEM` / `INVALID_DATE` / `INVALID_START` / `INVALID_END` / `INVALID_WINDOW` | malformed params |
| 400 | `OFF_GRID` | `start` doesn't land on the block grid |
| 402 | — | payment missing/invalid |
| 404 | `UNKNOWN_ITEM` | no such item |
| 409 | `BELOW_MINIMUM` / `ABOVE_MAXIMUM` | outside the item's block limits |
| 409 | `CLOSED` | the venue is shut that day |
| 409 | `OUTSIDE_HOURS` | the window falls outside opening hours |
| 409 | `WINDOW_IN_PAST` | that window has already started |

---

## POST /reserve — $0.02

**Body** — recommended form, echoing a signed quote (pins the price):

```json
{ "name": "Ada Lovelace", "quote": { "...the entire GET /quote response, signature included..." } }
```

Or specify the window directly and let the server price it now:

```json
{ "name": "Ada Lovelace", "item": "court-1", "date": "2026-08-08", "start": "18:00", "blocks": 2 }
```

**200 — the purchased artifact**

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
  "cancelToken": "3f9c…",
  "cancelEndpoint": "POST /cancel/rnt_1a2b3c4d5e6f",
  "quoteId": "qte_1a2b3c4d5e6f",
  "ics": "QkVHSU46VkNBTEVOREFS… (base64 .ics)",
  "createdAt": "2026-08-07T18:00:01.000Z",
  "signature": "hex HMAC-SHA256"
}
```

| Status | Code | Meaning |
|---|---|---|
| 400 | `INVALID_NAME` | `name` missing |
| 400/404/409 | — | every `GET /quote` error also applies |
| 402 | — | payment missing/invalid |
| 403 | `BAD_QUOTE_SIGNATURE` | the echoed quote was altered |
| 409 | `QUOTE_EXPIRED` | past the quote's `expiresAt` |
| 409 | `PRICE_CHANGED` | the window genuinely re-prices differently now |
| 409 | `WINDOW_TAKEN` | someone reserved it first |

None of the `4xx` cases charge the caller: settlement is deferred until the
handler returns `2xx`.

**Two prices.** The x402 charge is a flat $0.02 booking fee. `pricing.total` is
what the venue bills for the time itself, on its own terms. The artifact states
both.

---

## POST /cancel/:id — free (auth: cancelToken)

**Body**: `{ "cancelToken": "..." }`, or send the header `X-Cancel-Token`.

**200**

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

The block is released immediately and the code stops working. `refundable: false`
when cancelling inside `freeCancellationHours` (1h by default).

**Errors**: `403 BAD_CANCEL_TOKEN`, `404 NOT_FOUND`, `409 ALREADY_CANCELLED`.

---

## Free routes

| Route | Returns |
|---|---|
| `GET /inventory` | items + calendars |
| `GET /rentals/:id?cancelToken=…` | the rental, including its access code |
| `GET /info` | venue profile, hours, block size, quote validity, policy, prices, payment rails |
| `GET /health` | liveness |
| `GET /.well-known/x402` | x402 discovery manifest (resources, prices, schemas, both rails) |

---

## 402 response shape

Paid routes answer an unpaid request with a `402` whose `accepts` array carries
**both payment rails**. Pick one, sign it, retry with `X-PAYMENT`.

```json
{
  "x402Version": 1,
  "error": "X-PAYMENT header is required",
  "accepts": [
    {
      "scheme": "exact",
      "network": "base-sepolia",
      "maxAmountRequired": "20000",
      "resource": "http://localhost:4024/reserve",
      "description": "Reserve a time block…",
      "mimeType": "application/json",
      "payTo": "0x40252CFDF8B20Ed757D61ff157719F33Ec332402",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "maxTimeoutSeconds": 300,
      "extra": { "name": "USDC", "version": "2" }
    },
    {
      "scheme": "exact",
      "network": "solana",
      "maxAmountRequired": "20000",
      "resource": "http://localhost:4024/reserve",
      "description": "Reserve a time block…",
      "mimeType": "application/json",
      "payTo": "WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW",
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "maxTimeoutSeconds": 300,
      "extra": { "rpcUrl": "https://api.mainnet-beta.solana.com" }
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `network` | `base-sepolia`/`base` = EVM rail; `solana`/`solana-devnet` = SVM rail |
| `maxAmountRequired` | price in atomic USDC units (6 decimals) — `20000` = $0.02 |
| `asset` | USDC contract address (EVM) or SPL mint (Solana) |
| `payTo` | merchant receive address on that network |
| `extra` | EVM: the EIP-712 domain to sign against. Solana: the RPC to build against. |

Configure the rails with `NETWORK` / `PAY_TO_ADDRESS` / `FACILITATOR_URL` (EVM)
and `SOLANA_NETWORK` / `SOLANA_PAY_TO_ADDRESS` / `SOLANA_RPC_URL` /
`SOLANA_FACILITATOR_URL` (Solana). Each rail settles through its own facilitator
because no public one handles both chains. Drop an address and that rail is
omitted from every challenge.

## Settlement receipt

A successful paid call returns `X-PAYMENT-RESPONSE`: base64 JSON of
`{ success, transaction, network, payer }`. `network` tells you which rail
settled. Settlement is deferred until the handler returns `2xx` — an error
response (e.g. `409 WINDOW_TAKEN`) never moves funds.

## Contact

**nichxbt@gmail.com** · [issues](https://github.com/nirholas/x402-rentals/issues)
