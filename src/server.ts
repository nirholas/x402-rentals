import "dotenv/config";
import express from "express";
import { CHECKOUT_PATH, mountSolanaCheckout } from "./checkout.js";
import {
  EVM_NETWORK,
  EVM_PAY_TO,
  SOLANA_NETWORK,
  SOLANA_PAY_TO,
  USING_DEFAULT_PAY_TO,
  paywall,
  railSummary,
  type RouteMap,
} from "./payments.js";
import { ROUTE_SCHEMAS } from "./schemas.js";
import {
  RentalError,
  assertConfigLoaded,
  cancel,
  config,
  getInventory,
  getQuote,
  getRental,
  releaseRental,
  reserve,
} from "./service.js";

const PORT = Number(process.env.PORT || 4024);

assertConfigLoaded();

export const PRICES = {
  quote: "$0.001",
  reserve: "$0.02",
} as const;

/** Paid routes. Anything not listed here is free — /inventory included. */
const routes: RouteMap = {
  "GET /quote": {
    price: PRICES.quote,
    description:
      "Signed, time-limited price for one item and window: per-block lines, peak flags, total in USDC, availability and terms",
    // Request/response schemas mirror openapi.json — see src/schemas.ts.
    ...ROUTE_SCHEMAS["GET /quote"],
  },
  "POST /reserve": {
    price: PRICES.reserve,
    description:
      "Reserve a time block. Returns rentalId, the access code for the door/gate/locker, the booked window, pricing, terms, a cancel token and a base64 ICS calendar invite",
    ...ROUTE_SCHEMAS["POST /reserve"],
  },
};

const app = express();
app.use(express.json());
// A malformed JSON body must not pre-empt the paywall. The x402 discovery spec
// requires a probe to reach the 402 challenge *before* body validation rejects
// the request, so a parse failure drops the body and falls through instead of
// answering 400. The route handler still rejects it once payment verifies, and
// a 4xx from the handler never settles — so a bad body is never charged for.
app.use(
  (
    err: unknown,
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ): void => {
    if (err instanceof SyntaxError && "body" in err) {
      req.body = {};
      next();
      return;
    }
    next(err);
  },
);
// Solana browser checkout for public/index.html (EVM needs no server help).
const solanaCheckout = await mountSolanaCheckout(app);
app.use(paywall(routes, { baseUrl: process.env.PUBLIC_BASE_URL }));
app.use(
  express.static("public", {
    setHeaders: (res, p) => {
      if (p.endsWith("/.well-known/x402")) res.setHeader("Content-Type", "application/json");
    },
  }),
);

// ---- free routes -----------------------------------------------------------

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "x402-rentals", venue: config.venue.name });
});

/** Free by design (spec): browsing the inventory is free, the quote is paid. */
app.get("/inventory", (req, res) => {
  try {
    res.json(
      getInventory({
        item: typeof req.query.item === "string" ? req.query.item : undefined,
        date: typeof req.query.date === "string" ? req.query.date : undefined,
        days: req.query.days ? Number(req.query.days) : undefined,
      }),
    );
  } catch (err) {
    handleError(err, res);
  }
});

app.get("/info", (_req, res) => {
  res.json({
    venue: config.venue,
    hours: config.hours,
    blockMinutes: config.blockMinutes,
    bookingWindowDays: config.bookingWindowDays,
    quoteValidMinutes: config.quoteValidMinutes,
    policy: config.policy,
    prices: PRICES,
    payment: {
      rails: [
        { rail: "evm", network: EVM_NETWORK, asset: "USDC", payTo: EVM_PAY_TO },
        { rail: "solana", network: SOLANA_NETWORK, asset: "USDC", payTo: SOLANA_PAY_TO },
      ],
    },
  });
});

// ---- paid routes (payment enforced by the paywall above) -------------------

app.get("/quote", (req, res) => {
  try {
    res.json(
      getQuote({
        item: typeof req.query.item === "string" ? req.query.item : undefined,
        date: typeof req.query.date === "string" ? req.query.date : undefined,
        start: typeof req.query.start === "string" ? req.query.start : undefined,
        end: typeof req.query.end === "string" ? req.query.end : undefined,
        blocks: req.query.blocks ? Number(req.query.blocks) : undefined,
      }),
    );
  } catch (err) {
    handleError(err, res);
  }
});

app.post("/reserve", (req, res) => {
  try {
    const payer = req.header("x-payer-address") ?? res.locals.x402?.payer ?? req.body?.payerWallet;
    const artifact = reserve({ ...req.body, payerWallet: payer });
    // If settlement fails after this point, free the block again.
    res.locals.x402Rollback = () => releaseRental(artifact.rentalId);
    res.json(artifact);
  } catch (err) {
    handleError(err, res);
  }
});

// ---- free, authenticated by cancelToken ------------------------------------

app.post("/cancel/:id", (req, res) => {
  try {
    const token = req.body?.cancelToken ?? req.header("x-cancel-token") ?? undefined;
    res.json(cancel(req.params.id, token));
  } catch (err) {
    handleError(err, res);
  }
});

app.get("/rentals/:id", (req, res) => {
  try {
    const token =
      (typeof req.query.cancelToken === "string" ? req.query.cancelToken : undefined) ??
      req.header("x-cancel-token") ??
      undefined;
    res.json(getRental(req.params.id, token));
  } catch (err) {
    handleError(err, res);
  }
});

function handleError(err: unknown, res: express.Response): void {
  if (err instanceof RentalError) {
    res.status(err.status).json({ error: err.code, message: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "INTERNAL", message: "unexpected error" });
}

app.listen(PORT, () => {
  console.log(`\n  x402-rentals — ${config.venue.name}`);
  console.log(`  http://localhost:${PORT}\n`);
  console.log("  Paid routes — pay in USDC on Base or Solana, your client picks the rail:");
  console.log(`    GET  /quote             ${PRICES.quote}   (signed, ${config.quoteValidMinutes}min validity)`);
  console.log(`    POST /reserve           ${PRICES.reserve}    (access code + ICS)`);
  console.log("  Free routes:");
  console.log("    GET  /inventory  /info  /health  /rentals/:id");
  console.log("    POST /cancel/:id        (auth: cancelToken)");
  console.log("");
  for (const line of railSummary()) console.log(`  ${line}`);
  console.log(
    `  Solana browser checkout: ${solanaCheckout ? `mounted at ${CHECKOUT_PATH}` : "disabled"}`,
  );
  if (USING_DEFAULT_PAY_TO) {
    console.log(
      "  NOTE: using suite default payTo — set PAY_TO_ADDRESS / SOLANA_PAY_TO_ADDRESS to receive funds yourself",
    );
  }
  console.log(`  Manifest: http://localhost:${PORT}/.well-known/x402`);
  console.log(`  Demo:     http://localhost:${PORT}/\n`);
});
