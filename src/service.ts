import { readFileSync, existsSync } from "node:fs";
import { randomInt, randomUUID } from "node:crypto";
import { buildIcsBase64 } from "./ics.js";
import { sign, verify } from "./sign.js";
import { store } from "./store.js";
import type {
  BusyBlock,
  InventoryConfig,
  QuoteLine,
  Rental,
  RentalItem,
} from "./types.js";

const CONFIG_PATH = process.env.INVENTORY_CONFIG ?? "config/inventory.json";

export const config: InventoryConfig = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));

const BLOCK = config.blockMinutes;

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

export class RentalError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

// ---- time helpers ----------------------------------------------------------

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function fromMinutes(mins: number): string {
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

function at(date: string, time: string): Date {
  // Interpreted in the server's local timezone — run the server in the venue's
  // timezone (see config.venue.timezone).
  return new Date(`${date}T${time}:00`);
}

function hoursFor(date: string) {
  return config.hours[WEEKDAYS[new Date(`${date}T12:00:00`).getDay()]] ?? null;
}

/** Money is handled in integer cents-of-a-cent (USDC has 6 decimals). */
function priceToMicros(price: string): number {
  return Math.round(Number(String(price).replace(/[$,\s]/g, "")) * 1e6);
}

function microsToPrice(micros: number): string {
  return `$${(micros / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, ".0")}`;
}

export function findItem(itemId: string): RentalItem | undefined {
  return config.items.find((i) => i.id === itemId);
}

/** Is this block inside the item's peak window? */
function isPeak(item: RentalItem, startMins: number): boolean {
  if (!item.peakHours || !item.peakRatePerBlock) return false;
  return startMins >= toMinutes(item.peakHours.from) && startMins < toMinutes(item.peakHours.to);
}

/** Blocks already taken on an item for a date. */
function busyFor(itemId: string, date: string): BusyBlock[] {
  return store
    .activeForItem(itemId)
    .filter((r) => r.date === date)
    .map((r) => ({ date: r.date, start: r.start, end: r.end, rentalId: r.rentalId }));
}

function overlapsExisting(itemId: string, date: string, startM: number, endM: number): boolean {
  return busyFor(itemId, date).some((b) => startM < toMinutes(b.end) && toMinutes(b.start) < endM);
}

// ---- free GET /inventory ---------------------------------------------------

export interface InventoryQuery {
  item?: string;
  date?: string;
  days?: number;
}

/** The free GET /inventory artifact: rentable items plus their calendars. */
export function getInventory(q: InventoryQuery) {
  const items = q.item ? config.items.filter((i) => i.id === q.item) : config.items;
  if (q.item && items.length === 0)
    throw new RentalError(404, "UNKNOWN_ITEM", `no item "${q.item}" — see GET /inventory`);

  const days = Math.min(q.days ?? 7, config.bookingWindowDays);
  const dates: string[] = [];
  if (q.date) {
    dates.push(q.date);
  } else {
    const today = new Date();
    for (let i = 0; i < days; i++) {
      dates.push(new Date(today.getTime() + i * 86_400_000).toISOString().slice(0, 10));
    }
  }

  return {
    venue: config.venue,
    blockMinutes: BLOCK,
    bookingWindowDays: config.bookingWindowDays,
    policy: config.policy,
    generatedAt: new Date().toISOString(),
    items: items.map((item) => ({
      id: item.id,
      name: item.name,
      category: item.category,
      description: item.description,
      location: item.location,
      ratePerBlock: item.ratePerBlock,
      peakRatePerBlock: item.peakRatePerBlock,
      peakHours: item.peakHours,
      minBlocks: item.minBlocks,
      maxBlocks: item.maxBlocks,
      accessType: item.accessType,
      terms: item.terms,
      calendar: dates.map((date) => {
        const hours = hoursFor(date);
        const busy = busyFor(item.id, date);
        const freeBlocks: string[] = [];
        if (hours) {
          const open = toMinutes(hours.open);
          const close = toMinutes(hours.close);
          for (let t = open; t + BLOCK <= close; t += BLOCK) {
            if (!overlapsExisting(item.id, date, t, t + BLOCK)) freeBlocks.push(fromMinutes(t));
          }
        }
        return {
          date,
          open: hours?.open ?? null,
          close: hours?.close ?? null,
          busy: busy.map((b) => ({ start: b.start, end: b.end })),
          freeBlockStarts: freeBlocks,
        };
      }),
    })),
  };
}

// ---- paid GET /quote -------------------------------------------------------

export interface QuoteQuery {
  item?: string;
  date?: string;
  start?: string;
  /** Either `end` or `blocks` must be supplied. */
  end?: string;
  blocks?: number;
}

/**
 * The paid GET /quote artifact: a signed, time-limited price for one item and
 * window. `POST /reserve` accepts the `quoteId` so the price cannot drift
 * between quoting and reserving.
 */
export function getQuote(q: QuoteQuery) {
  const item = q.item ? findItem(q.item) : undefined;
  if (!q.item) throw new RentalError(400, "INVALID_ITEM", "item is required");
  if (!item)
    throw new RentalError(404, "UNKNOWN_ITEM", `no item "${q.item}" — see GET /inventory`);
  if (!q.date || !/^\d{4}-\d{2}-\d{2}$/.test(q.date))
    throw new RentalError(400, "INVALID_DATE", "date must be YYYY-MM-DD");
  if (!q.start || !/^\d{2}:\d{2}$/.test(q.start))
    throw new RentalError(400, "INVALID_START", "start must be HH:MM (24h)");

  const startM = toMinutes(q.start);
  if (startM % BLOCK !== 0)
    throw new RentalError(
      400,
      "OFF_GRID",
      `start must land on the ${BLOCK}-minute grid (…:00, …:${String(BLOCK).padStart(2, "0")})`,
    );

  let blocks: number;
  if (q.end) {
    if (!/^\d{2}:\d{2}$/.test(q.end))
      throw new RentalError(400, "INVALID_END", "end must be HH:MM (24h)");
    const span = toMinutes(q.end) - startM;
    if (span <= 0 || span % BLOCK !== 0)
      throw new RentalError(400, "INVALID_WINDOW", `end must be a whole number of ${BLOCK}-minute blocks after start`);
    blocks = span / BLOCK;
  } else if (q.blocks) {
    blocks = Math.trunc(q.blocks);
  } else {
    throw new RentalError(400, "INVALID_WINDOW", "supply either end (HH:MM) or blocks (integer)");
  }

  if (blocks < item.minBlocks)
    throw new RentalError(
      409,
      "BELOW_MINIMUM",
      `${item.name} has a ${item.minBlocks}-block minimum (${(item.minBlocks * BLOCK) / 60}h)`,
    );
  if (blocks > item.maxBlocks)
    throw new RentalError(
      409,
      "ABOVE_MAXIMUM",
      `${item.name} allows at most ${item.maxBlocks} blocks (${(item.maxBlocks * BLOCK) / 60}h) per reservation`,
    );

  const endM = startM + blocks * BLOCK;
  const hours = hoursFor(q.date);
  if (!hours)
    throw new RentalError(409, "CLOSED", `${config.venue.name} is closed on ${q.date}`);
  if (startM < toMinutes(hours.open) || endM > toMinutes(hours.close))
    throw new RentalError(
      409,
      "OUTSIDE_HOURS",
      `${q.date} opening hours are ${hours.open}–${hours.close}`,
    );
  if (at(q.date, q.start).getTime() <= Date.now())
    throw new RentalError(409, "WINDOW_IN_PAST", "that window has already started");

  const available = !overlapsExisting(item.id, q.date, startM, endM);

  const lines: QuoteLine[] = [];
  let totalMicros = 0;
  for (let i = 0; i < blocks; i++) {
    const t = startM + i * BLOCK;
    const peak = isPeak(item, t);
    const rate = peak ? item.peakRatePerBlock! : item.ratePerBlock;
    totalMicros += priceToMicros(rate);
    lines.push({ block: `${fromMinutes(t)}–${fromMinutes(t + BLOCK)}`, rate, peak });
  }

  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + config.quoteValidMinutes * 60_000);
  const quote = {
    quoteId: `qte_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    itemId: item.id,
    itemName: item.name,
    category: item.category,
    location: item.location,
    date: q.date,
    start: q.start,
    end: fromMinutes(endM),
    blocks,
    blockMinutes: BLOCK,
    lines,
    total: microsToPrice(totalMicros),
    totalAtomicUSDC: String(totalMicros),
    currency: "USDC",
    available,
    unavailableReason: available ? undefined : "another reservation overlaps that window",
    reservePrice: config.policy.reservePrice,
    terms: item.terms,
    policy: config.policy.description,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  return { ...quote, signature: sign(quote) };
}

/** A quote echoed back by a client, for `POST /reserve`. */
export interface SignedQuote {
  quoteId: string;
  itemId: string;
  date: string;
  start: string;
  end: string;
  blocks: number;
  total: string;
  expiresAt: string;
  signature: string;
  [k: string]: unknown;
}

/**
 * Re-validate a quote a client hands back. The signature covers every field
 * except `signature` itself, so a client cannot lower the price it was quoted.
 */
function checkQuote(q: SignedQuote): void {
  const { signature, ...payload } = q;
  if (!signature || typeof signature !== "string" || !verify(payload, signature))
    throw new RentalError(
      403,
      "BAD_QUOTE_SIGNATURE",
      "quote signature does not match — re-fetch it from GET /quote",
    );
  if (Date.parse(q.expiresAt) < Date.now())
    throw new RentalError(409, "QUOTE_EXPIRED", "that quote has expired — fetch a fresh one");
}

// ---- paid POST /reserve ----------------------------------------------------

/** Human-friendly access code: 6 digits, no ambiguity, easy to key into a pad. */
function makeAccessCode(): string {
  return String(randomInt(100000, 1000000));
}

export interface ReserveRequest {
  item?: string;
  date?: string;
  start?: string;
  end?: string;
  blocks?: number;
  name?: string;
  /** Optionally echo a signed quote from GET /quote to lock the price. */
  quote?: SignedQuote;
  payerWallet?: string;
}

/**
 * The paid POST /reserve artifact: the rental, its access code, the booked
 * window, the ICS invite and the terms — all in the 200 body.
 */
export function reserve(req: ReserveRequest) {
  if (!req.name || typeof req.name !== "string")
    throw new RentalError(400, "INVALID_NAME", "name is required");

  // A supplied quote fixes the item, window and price; otherwise re-quote now.
  let quote;
  if (req.quote) {
    checkQuote(req.quote);
    quote = getQuote({
      item: req.quote.itemId,
      date: req.quote.date,
      start: req.quote.start,
      end: req.quote.end,
    });
    if (quote.total !== req.quote.total)
      throw new RentalError(
        409,
        "PRICE_CHANGED",
        `that window now prices at ${quote.total}, not ${req.quote.total} — fetch a fresh quote`,
      );
  } else {
    quote = getQuote({
      item: req.item,
      date: req.date,
      start: req.start,
      end: req.end,
      blocks: req.blocks,
    });
  }

  const item = findItem(quote.itemId)!;
  if (!quote.available)
    throw new RentalError(
      409,
      "WINDOW_TAKEN",
      `${item.name} is no longer free ${quote.date} ${quote.start}–${quote.end} — call GET /inventory`,
    );

  const rentalId = `rnt_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const cancelToken = sign({ rentalId, purpose: "cancel" }).slice(0, 32);
  const accessCode = makeAccessCode();

  const rental: Rental = {
    rentalId,
    status: "confirmed",
    itemId: item.id,
    itemName: item.name,
    date: quote.date,
    start: quote.start,
    end: quote.end,
    blocks: quote.blocks,
    total: quote.total,
    accessCode,
    holderName: req.name,
    payerWallet: req.payerWallet,
    cancelToken,
    createdAt: new Date().toISOString(),
  };
  store.add(rental);

  const ics = buildIcsBase64({
    uid: `${rentalId}@x402-rentals`,
    start: at(quote.date, quote.start),
    durationMinutes: quote.blocks * BLOCK,
    summary: `${item.name} — ${config.venue.name} (${req.name})`,
    description:
      `Rental ${rentalId}. ${item.accessType} ${accessCode}. ` +
      `${quote.blocks} × ${BLOCK}min = ${quote.total}. ${item.terms}`,
    location: `${config.venue.address} — ${item.location}`,
  });

  const artifact = {
    rentalId,
    status: "confirmed" as const,
    venue: config.venue.name,
    item: {
      id: item.id,
      name: item.name,
      category: item.category,
      location: item.location,
      accessType: item.accessType,
    },
    accessCode,
    accessNote: `Use this ${item.accessType} at ${item.location}. It is valid for the booked window only.`,
    window: {
      date: quote.date,
      start: quote.start,
      end: quote.end,
      blocks: quote.blocks,
      blockMinutes: BLOCK,
      startsAt: at(quote.date, quote.start).toISOString(),
      endsAt: at(quote.date, quote.end).toISOString(),
    },
    pricing: { lines: quote.lines, total: quote.total, totalAtomicUSDC: quote.totalAtomicUSDC, currency: "USDC" },
    holder: req.name,
    terms: {
      item: item.terms,
      policy: config.policy.description,
      freeCancellationHours: config.policy.freeCancellationHours,
    },
    cancelToken,
    cancelEndpoint: `POST /cancel/${rentalId}`,
    quoteId: quote.quoteId,
    ics,
    createdAt: rental.createdAt,
  };
  return { ...artifact, signature: sign(artifact) };
}

/** Roll back a reservation — used when payment settlement fails. */
export function releaseRental(rentalId: string): void {
  store.remove(rentalId);
}

// ---- free routes -----------------------------------------------------------

/** Free POST /cancel/:id — auth by the cancelToken issued at reservation time. */
export function cancel(rentalId: string, cancelToken: string | undefined) {
  const r = store.get(rentalId);
  if (!r) throw new RentalError(404, "NOT_FOUND", `no rental ${rentalId}`);
  if (!cancelToken || cancelToken !== r.cancelToken)
    throw new RentalError(403, "BAD_CANCEL_TOKEN", "cancelToken does not match this rental");
  if (r.status === "cancelled")
    throw new RentalError(409, "ALREADY_CANCELLED", "rental is already cancelled");

  const msUntil = at(r.date, r.start).getTime() - Date.now();
  const inFreeWindow = msUntil >= config.policy.freeCancellationHours * 3_600_000;

  r.status = "cancelled";
  r.cancelledAt = new Date().toISOString();
  store.update(r);

  const record = {
    rentalId,
    status: "cancelled" as const,
    cancelledAt: r.cancelledAt,
    blockReleased: true,
    refundable: inFreeWindow,
    reason: inFreeWindow
      ? `cancelled ${(msUntil / 3_600_000).toFixed(1)}h before the window — the ${config.policy.reservePrice} reservation fee is refundable`
      : `cancelled inside the ${config.policy.freeCancellationHours}h window — the reservation fee is forfeited`,
    accessCodeRevoked: true,
    item: { id: r.itemId, name: r.itemName },
    window: { date: r.date, start: r.start, end: r.end },
  };
  return { ...record, signature: sign(record) };
}

/** Free GET /rentals/:id lookup (requires cancelToken — the access code is in there). */
export function getRental(rentalId: string, cancelToken: string | undefined) {
  const r = store.get(rentalId);
  if (!r) throw new RentalError(404, "NOT_FOUND", `no rental ${rentalId}`);
  if (!cancelToken || cancelToken !== r.cancelToken)
    throw new RentalError(403, "BAD_CANCEL_TOKEN", "cancelToken does not match this rental");
  return r;
}

/** Guard used at startup so a broken config fails loudly, not on first request. */
export function assertConfigLoaded(): void {
  if (!existsSync(CONFIG_PATH))
    throw new Error(`inventory config not found at ${CONFIG_PATH} (set INVENTORY_CONFIG)`);
  if (!config.items?.length) throw new Error(`${CONFIG_PATH} defines no items`);
}
