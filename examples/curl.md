# Raw HTTP walkthrough: 402 → pay → 200

x402 is plain HTTP. Here is the exact wire flow with `curl` against a local
server (`npm run dev` — it ships with working default receive addresses).

## 1. Browsing is free

```bash
curl -s "http://localhost:4024/inventory?days=3" \
  | jq '.items[] | {id, name, ratePerBlock, minBlocks, accessType}'

curl -s "http://localhost:4024/inventory?item=court-1&days=1" \
  | jq '.items[0].calendar[0] | {date, open, close, busy, first: .freeBlockStarts[0:6]}'

curl -s http://localhost:4024/.well-known/x402 | jq
```

`/inventory` costs nothing — the calendar is the shop window. Pricing and
reserving are what you pay for.

## 2. Calling a paid route without payment → HTTP 402

```bash
curl -si "http://localhost:4024/quote?item=court-1&date=2026-08-08&start=18:00&blocks=2"
```

```
HTTP/1.1 402 Payment Required
Content-Type: application/json

{
  "x402Version": 1,
  "error": "X-PAYMENT header is required",
  "accepts": [
    {
      "scheme": "exact",
      "network": "base-sepolia",
      "maxAmountRequired": "1000",
      "resource": "http://localhost:4024/quote",
      "description": "Signed, time-limited price for one item and window…",
      "mimeType": "application/json",
      "payTo": "0x40252CFDF8B20Ed757D61ff157719F33Ec332402",
      "maxTimeoutSeconds": 300,
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "extra": { "name": "USDC", "version": "2" }
    },
    {
      "scheme": "exact",
      "network": "solana",
      "maxAmountRequired": "1000",
      "resource": "http://localhost:4024/quote",
      "description": "Signed, time-limited price for one item and window…",
      "mimeType": "application/json",
      "payTo": "WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW",
      "maxTimeoutSeconds": 300,
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "extra": { "rpcUrl": "https://api.mainnet-beta.solana.com" }
    }
  ]
}
```

Two entries, two rails: **USDC on Base** and **USDC on Solana**. `1000` is
0.001 USDC in atomic units (6 decimals); `POST /reserve` quotes `20000` = $0.02.
Pick one, ignore the other.

```bash
# just the rails:
curl -s "http://localhost:4024/quote?item=court-1&date=2026-08-08&start=18:00&blocks=2" \
  | jq '.accepts[] | {network, payTo, asset, maxAmountRequired}'
```

## 3. Pay: sign the requirement, retry with X-PAYMENT

**Base rail:** the client signs an EIP-3009 `transferWithAuthorization` for the
amount in the `base-sepolia` entry and base64-encodes the signed payload into one
header.

**Solana rail:** the client builds an SPL `transferChecked` of that many USDC
atomic units to the `solana` entry's `payTo`, signs the serialized transaction,
and base64-encodes that envelope into the same header.

Either way it is one header. Doing it by hand is miserable — use the client
instead:

```bash
PRIVATE_KEY=0x... npm run client        # runs examples/agent-client.ts
```

Under the hood it retries:

```
GET /quote?item=court-1&date=2026-08-08&start=18:00&blocks=2
X-PAYMENT: eyJ4NDAyVmVyc2lvbiI6MSwic2NoZW1lIjoiZXhhY3QiLC...
```

## 4. 200 + the quote + settlement receipt

```
HTTP/1.1 200 OK
X-PAYMENT-RESPONSE: eyJzdWNjZXNzIjp0cnVlLCJ0cmFuc2FjdGlvbiI6IjB4YWJjLi4uIiwibmV0d29yayI6ImJhc2Utc2Vwb2xpYSJ9
Content-Type: application/json

{
  "quoteId": "qte_1a2b3c4d5e6f",
  "itemId": "court-1",
  "date": "2026-08-08", "start": "18:00", "end": "19:00", "blocks": 2,
  "lines": [
    { "block": "18:00–18:30", "rate": "$0.03", "peak": true },
    { "block": "18:30–19:00", "rate": "$0.03", "peak": true }
  ],
  "total": "$0.06",
  "totalAtomicUSDC": "60000",
  "available": true,
  "expiresAt": "2026-08-07T18:15:00.000Z",
  "signature": "…"
}
```

`X-PAYMENT-RESPONSE` base64-decodes to the settlement result — `{ success,
transaction, network, payer }`. The `network` field tells you which rail actually
settled. That is your on-chain receipt.

## 5. Reserve with the quote

Echo the whole quote — signature included — so the price is pinned:

```
POST /reserve
X-PAYMENT: eyJ4NDAy…
Content-Type: application/json

{ "name": "Ada Lovelace", "quote": { ...the entire quote response... } }
```

```json
{
  "rentalId": "rnt_1a2b3c4d5e6f",
  "item": { "id": "court-1", "name": "Tennis Court 1", "accessType": "gate-code", "location": "North lot" },
  "accessCode": "280008",
  "accessNote": "Use this gate-code at North lot. It is valid for the booked window only.",
  "window": { "date": "2026-08-08", "start": "18:00", "end": "19:00", "blocks": 2 },
  "pricing": { "total": "$0.06", "totalAtomicUSDC": "60000", "currency": "USDC" },
  "cancelToken": "…",
  "ics": "QkVHSU46VkNBTEVOREFS…",
  "signature": "…"
}
```

Change one character of the quote's `total` and the server answers
`403 BAD_QUOTE_SIGNATURE` — the HMAC covers every field. If the real price moved
since the quote, you get `409 PRICE_CHANGED` instead of a silent overcharge.

Settlement runs *after* the handler succeeds: if the window was taken in the
meantime you get `409 WINDOW_TAKEN` and no money moves.

## 6. Use, look up, cancel

```bash
# the access code again (free, auth by cancelToken):
curl -s "http://localhost:4024/rentals/rnt_XXXX?cancelToken=YOUR_TOKEN" | jq '.accessCode, .start, .end'

# release the block and revoke the code (free):
curl -s -X POST http://localhost:4024/cancel/rnt_XXXX \
  -H 'content-type: application/json' \
  -d '{"cancelToken":"YOUR_TOKEN"}' | jq

# the block is back on the calendar:
curl -s "http://localhost:4024/inventory?item=court-1&date=2026-08-08" \
  | jq '.items[0].calendar[0].busy'
```

## 7. Save the calendar invite

```bash
jq -r .ics rental.json | base64 -d > booking.ics
```
