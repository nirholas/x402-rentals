import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Rental } from "./types.js";

/**
 * File-backed persistence. Reservations live in data/rentals.json so a restart
 * never double-books a block. No database required.
 */

const DATA_DIR = process.env.DATA_DIR ?? "data";
const RENTALS_FILE = `${DATA_DIR}/rentals.json`;

function load<T>(file: string, fallback: T): T {
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    // corrupt file — start fresh rather than crash
  }
  return fallback;
}

function save(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}

export class Store {
  private rentals: Rental[] = load<Rental[]>(RENTALS_FILE, []);

  all(): Rental[] {
    return this.rentals;
  }

  active(): Rental[] {
    return this.rentals.filter((r) => r.status === "confirmed");
  }

  activeForItem(itemId: string): Rental[] {
    return this.rentals.filter((r) => r.status === "confirmed" && r.itemId === itemId);
  }

  get(rentalId: string): Rental | undefined {
    return this.rentals.find((r) => r.rentalId === rentalId);
  }

  add(r: Rental): void {
    this.rentals.push(r);
    save(RENTALS_FILE, this.rentals);
  }

  update(r: Rental): void {
    const i = this.rentals.findIndex((x) => x.rentalId === r.rentalId);
    if (i >= 0) this.rentals[i] = r;
    save(RENTALS_FILE, this.rentals);
  }

  /** Used to roll back a reservation when payment settlement fails. */
  remove(rentalId: string): void {
    this.rentals = this.rentals.filter((r) => r.rentalId !== rentalId);
    save(RENTALS_FILE, this.rentals);
  }
}

export const store = new Store();
