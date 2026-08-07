# For AI agents

x402-rentals is built agent-first: no signup, no API key, no OAuth dance.
Browsing the inventory is free, so an agent can plan for nothing; it only spends
when it wants a firm price, and again when it commits.

## Discovery

Two machine-readable entry points, both free:

1. **`GET /.well-known/x402`** — the x402 manifest: both paid resources, their
   prices, both `accepts` rails, output schemas, plus every free route. This is
   the format indexed by [x402scan.com](https://x402scan.com), the x402 Bazaar,
   and [agentic.market](https://agentic.market).
2. **[`skill.md`](https://github.com/nirholas/x402-rentals/blob/main/skill.md)**
   (repo root) — a prose+schema skill file (the agentres.dev pattern) an LLM can
   read directly to learn endpoints, prices, request shapes, and error codes.

Recommended agent bootstrap: fetch `/.well-known/x402`, feed `skill.md` into
context, read `GET /inventory` (free) to find items and open blocks, then pay.

## Protocol version

This service speaks **x402 v1**. Every challenge is
`{ x402Version: 1, error, accepts: [...] }`, and each `accepts[]` entry carries
`outputSchema.input` (how to call the route) and `outputSchema.output` (what
comes back), generated from `openapi.json` so the two can never drift.

Discovery audits flag v1 as the older wire format; that is expected. x402 **v2**
— payment options under `extensions.bazaar.schema` and CAIP-2 network ids — is a
planned upgrade for agentcash compatibility. It is not adopted yet because the
v2 challenge shape would break the v1 `x402-fetch` clients this repo ships as
working examples.

## The three-step shape

This service deliberately separates browsing, pricing, and committing:

| Step | Route | Cost | Why |
|---|---|---|---|
| Browse | `GET /inventory` | free | See what exists and what's open. Never spend to look. |
| Price | `GET /quote` | $0.001 | Get a **signed, time-limited** total for one exact window, with peak blocks itemised. |
| Commit | `POST /reserve` | $0.02 | Claim the window; get the access code back. |

Echo the whole quote (including `signature`) into `POST /reserve`. The server
re-verifies it and re-prices the window: a tampered `total` is rejected with
`403 BAD_QUOTE_SIGNATURE`, and a genuine change with `409 PRICE_CHANGED`. That
turns "the price moved" from a silent overcharge into an explicit error your
agent can surface.

## Two payment rails

Each paid route answers an unpaid request with a `402` whose `accepts` array
holds **both** rails. Your agent picks whichever it can settle:

| Rail | `network` | Asset | payTo | How the client signs |
|---|---|---|---|---|
| EVM | `base-sepolia` (default) / `base` | USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | `0x40252CFDF8B20Ed757D61ff157719F33Ec332402` | EIP-3009 `transferWithAuthorization` — pure client-side signature |
| Solana | `solana` (default) / `solana-devnet` | USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | `WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW` | SPL `transferChecked`, signed as a serialized transaction |

Each rail is verified and settled by its own facilitator — no public facilitator
settles both chains, so the EVM rail defaults to `https://x402.org/facilitator`
and the Solana rail to `https://facilitator.payai.network` (both overridable).
The `X-PAYMENT-RESPONSE` receipt names the rail the payment actually settled on.
Ignore the entry you can't pay; the server does not care which one you choose.

Settlement is deferred until the handler returns `2xx`, so a reservation that
fails (`409 WINDOW_TAKEN`) costs your agent nothing.

## Paying

Any x402 client works. With `x402-fetch` (EVM rail):

```ts
import { wrapFetchWithPayment, decodeXPaymentResponse } from "x402-fetch";
import { privateKeyToAccount } from "viem/accounts";

const payFetch = wrapFetchWithPayment(fetch, privateKeyToAccount(KEY));

const quote = await payFetch(
  `${BASE}/quote?item=court-1&date=2026-08-08&start=18:00&blocks=2`,
).then((r) => r.json());

const res = await payFetch(`${BASE}/reserve`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Agent Ada", quote }),   // echo it whole
});
const rental = await res.json();                        // accessCode is in here
const receipt = decodeXPaymentResponse(res.headers.get("x-payment-response")!);
```

The client handles the 402 → sign → retry loop automatically. Cap per-call spend
with the `maxValue` argument.

On the **Solana rail**, pick the `accepts[]` entry whose `network` starts with
`solana`, build an SPL `transferChecked` to its `payTo` for `maxAmountRequired`
atomic units of the `asset` mint (USDC, 6 decimals), sign it, and send the base64
x402 envelope in `X-PAYMENT`. Browser agents can reuse the checkout helper this
server mounts at `POST /api/x402-checkout?action=prepare` (build) and
`?action=encode` (wrap) — see
[`examples/agent-client.ts`](https://github.com/nirholas/x402-rentals/blob/main/examples/agent-client.ts).

## Two prices — say both to your user

The x402 charge on `POST /reserve` is a flat **$0.02 booking fee**. The `total`
in the quote is what the venue bills for the **time itself**, on its own terms.
The quote carries `total`, `totalAtomicUSDC` and `reservePrice` precisely so an
agent can state both before committing a user's money.

## What you get back (and should persist)

| Field | Why it matters |
|---|---|
| `rentalId` | canonical reference |
| `accessCode` | **the product** — a bearer credential for physical access; keep it out of shared logs |
| `window` | when the code works: `date`, `start`, `end`, plus ISO `startsAt`/`endsAt` |
| `pricing` | the frozen breakdown, for the user's records |
| `terms` | item rules + venue policy, so a dispute has an agreed text |
| `cancelToken` | required to cancel or to re-read the access code |
| `ics` | base64 calendar invite — attach to the user's calendar |
| `signature` | venue HMAC over the artifact — dispute evidence |
| `X-PAYMENT-RESPONSE` header | settlement receipt (tx hash/signature + network) — your proof of payment, on either rail |

## Reservation policy for agents

- Read `GET /inventory` (free) immediately before quoting; the calendar moves.
- A window must start on the block grid and satisfy the item's `minBlocks` /
  `maxBlocks`. `409 BELOW_MINIMUM` and `400 OFF_GRID` are the usual first
  mistakes.
- Quotes expire after `quoteValidMinutes` (15 by default). On
  `409 QUOTE_EXPIRED`, re-quote — do not retry the reservation.
- On `409 WINDOW_TAKEN`, re-read `/inventory` rather than retrying the same
  window.
- Idempotency: reserving twice books two windows. Record `rentalId` before
  retrying a network failure.
- Cancel as soon as plans change: the block is released immediately, and outside
  `freeCancellationHours` the reserve fee is marked refundable.

## MCP integration

Expose the service as Claude tools (`browse_inventory`, `get_quote`,
`reserve_block`, `cancel_rental`) with the wrapper in
[`examples/mcp-tool.md`](https://github.com/nirholas/x402-rentals/blob/main/examples/mcp-tool.md),
including a `claude_desktop_config.json` snippet.

## Listing your deployment

Running a public instance? Get discovered:

- **x402scan.com** — indexes services exposing `/.well-known/x402`; submit your
  base URL.
- **x402 Bazaar** — the facilitator-side discovery list; keep the manifest's
  resource descriptions and output schemas accurate so listings are useful.
- **agentic.market** — agent-service marketplace; list the base URL and point at
  `skill.md`.

Keep the manifest served over HTTPS at your public origin — indexers and agents
will refuse plaintext payment endpoints.

## Contact

**nichxbt@gmail.com**
