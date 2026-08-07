# Exposing x402-rentals as an MCP tool for Claude

Model Context Protocol (MCP) lets Claude call this rental server as a native
tool. The pattern: an MCP server wraps the paid endpoints with `x402-fetch`, so
every paid tool call pays automatically from the agent's wallet. Browsing the
inventory is free and needs no wallet at all.

The server quotes both rails in every 402 (USDC on Base and USDC on Solana);
`x402-fetch` settles the Base entry. To have the MCP server pay on Solana
instead, swap the wrapper for your own Solana signer — see
[`agent-client.ts`](agent-client.ts) for the exact envelope.

## Minimal MCP server (`mcp-server.ts`)

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { wrapFetchWithPayment } from "x402-fetch";
import { privateKeyToAccount } from "viem/accounts";

const BASE_URL = process.env.RENTALS_URL ?? "http://localhost:4024";
const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
const payFetch = wrapFetchWithPayment(fetch, account);

const server = new McpServer({ name: "rentals", version: "0.1.0" });

server.tool(
  "browse_inventory",
  "List rentable items with their calendars, rates and free blocks (free — no payment)",
  { item: z.string().optional(), date: z.string().optional(), days: z.number().optional() },
  async ({ item, date, days }) => {
    const qs = new URLSearchParams();
    if (item) qs.set("item", item);
    if (date) qs.set("date", date);
    if (days) qs.set("days", String(days));
    const res = await fetch(`${BASE_URL}/inventory?${qs}`);
    return { content: [{ type: "text", text: await res.text() }] };
  },
);

server.tool(
  "get_quote",
  "Price a specific item and window ($0.001 USDC via x402). Returns a signed quote — pass the whole thing to reserve_block to pin the price.",
  {
    item: z.string(),
    date: z.string(),
    start: z.string().describe("HH:MM, on the block grid"),
    blocks: z.number().optional(),
    end: z.string().optional(),
  },
  async ({ item, date, start, blocks, end }) => {
    const qs = new URLSearchParams({ item, date, start });
    if (blocks) qs.set("blocks", String(blocks));
    if (end) qs.set("end", end);
    const res = await payFetch(`${BASE_URL}/quote?${qs}`);
    return { content: [{ type: "text", text: await res.text() }] };
  },
);

server.tool(
  "reserve_block",
  "Reserve a time block for $0.02 USDC via x402. Returns the access code, window, pricing, terms, cancel token and an ICS invite. Pass the `quote` object from get_quote to lock the price.",
  { name: z.string(), quote: z.record(z.any()) },
  async ({ name, quote }) => {
    const res = await payFetch(`${BASE_URL}/reserve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, quote }),
    });
    return { content: [{ type: "text", text: await res.text() }] };
  },
);

server.tool(
  "cancel_rental",
  "Cancel a reservation for free using the cancelToken. Releases the block and revokes the access code.",
  { rentalId: z.string(), cancelToken: z.string() },
  async ({ rentalId, cancelToken }) => {
    const res = await fetch(`${BASE_URL}/cancel/${rentalId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cancelToken }),
    });
    return { content: [{ type: "text", text: await res.text() }] };
  },
);

await server.connect(new StdioServerTransport());
```

Dependencies: `npm i @modelcontextprotocol/sdk x402-fetch viem zod`

Questions: **nichxbt@gmail.com**

## claude_desktop_config.json

```json
{
  "mcpServers": {
    "rentals": {
      "command": "npx",
      "args": ["tsx", "/path/to/mcp-server.ts"],
      "env": {
        "RENTALS_URL": "http://localhost:4024",
        "PRIVATE_KEY": "0x...funded base-sepolia key"
      }
    }
  }
}
```

Claude can then be asked: *"Book us a tennis court for an hour on Saturday
evening"* — it browses the inventory for free, quotes the exact window (paying
$0.001), reports the peak-rate breakdown before committing, reserves it for
$0.02, and hands back the gate code with the calendar invite.

## Two prices, and why the agent should say both

The x402 charge on `POST /reserve` is a flat **$0.02 booking fee**. The `total`
in the quote is what the venue charges for the **time itself**, on its own terms.
An agent should surface both — the quote artifact carries `total`,
`totalAtomicUSDC`, and `reservePrice` so there is no ambiguity about what the
user is agreeing to.

## Spending safety

Give the MCP wallet a small, dedicated balance. `wrapFetchWithPayment` accepts a
`maxValue` (base units) to hard-cap what a single call may spend; combine with
per-session budgets in your agent framework. Because settlement is deferred until
the route returns `2xx`, a taken window never draws down that budget.

Treat `accessCode` as a physical key: it is a bearer credential for the door, so
keep it out of shared transcripts and logs.
