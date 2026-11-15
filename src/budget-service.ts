import type { BudgetEntry, Currency, Office, PurchaseDetails, RefillJob, SnackBox } from "./domain.ts";
import type { InMemoryStore } from "./store.ts";

interface BudgetBalance {
  currency: Currency;
  budgetMinor: number;
  reservedMinor: number;
  spentMinor: number;
  availableMinor: number;
}

export function accountingMonth(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function requireMinorUnits(amount: number): number {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error(`Expected a nonnegative integer amount in minor units: ${amount}`);
  }
  return amount;
}

function validateMonth(month: string): void {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new Error(`Invalid accounting month: ${month}`);
  }
}

export class BudgetService {
  private readonly store: InMemoryStore;

  constructor(store: InMemoryStore) {
    this.store = store;
  }

  getBalance(officeId: Office["id"], month: string): BudgetBalance {
    this.syncMonth(officeId, month);
    return this.calculateBalance(officeId, month);
  }

  syncMonth(officeId: Office["id"], month: string): void {
    validateMonth(month);
    const latest = this.store.latestBudgetMonths.get(officeId);
    if (latest === undefined || month > latest) {
      this.recheckBlockedJobs(officeId, month);
    }
  }

  tryReserveForBox(job: RefillJob, box: SnackBox, month: string): boolean {
    const total = this.estimateJob(job) + requireMinorUnits(box.estimatedCostMinor);
    this.syncMonth(job.officeId, month);
    return this.tryReserve(job, total, month);
  }

  reserveForPurchase(job: RefillJob, month: string): void {
    validateMonth(month);
    const reservation = this.requireReservation(job);
    // Replacing the entry moves the full reservation only after the target month can cover it.
    const funded = reservation.month === month || this.tryReserve(job, reservation.amountMinor, month);
    this.syncMonth(job.officeId, month);
    if (!funded) {
      throw new Error(`Insufficient budget to move refill job ${job.id}'s reservation to ${month}`);
    }
  }

  releaseReservation(job: RefillJob, month: string): void {
    validateMonth(month);
    this.store.budgetReservations.delete(job.id);
    this.recheckBlockedJobs(job.officeId, month);
  }

  reconcilePurchase(job: RefillJob, details: PurchaseDetails): void {
    const { amountMinor, currency, receiptReference, purchaseDate } = details;
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      throw new Error("Purchase amount must be a positive integer in minor units");
    }
    if (typeof receiptReference !== "string" || receiptReference.trim() === "") {
      throw new Error("A receipt reference is required");
    }
    if (!(purchaseDate instanceof Date) || !Number.isFinite(purchaseDate.getTime())) {
      throw new Error("A valid purchase date is required");
    }
    const purchaseMonth = accountingMonth(purchaseDate);
    validateMonth(purchaseMonth);
    const reservation = this.requireReservation(job);
    const balance = this.calculateBalance(job.officeId, purchaseMonth);
    if (currency !== balance.currency) {
      throw new Error(`Purchase currency must match the office currency (${balance.currency})`);
    }
    const reservedThisMonth = reservation.month === purchaseMonth ? reservation.amountMinor : 0;
    const overrun = amountMinor > reservation.amountMinor ||
      amountMinor > balance.availableMinor + reservedThisMonth;

    // Post the actual cost before giving the blocked job a chance to claim any released funds.
    this.store.purchaseExpenses.set(job.id, {
      officeId: job.officeId,
      month: purchaseMonth,
      amountMinor,
      currency,
      receiptReference,
      purchaseDate: new Date(purchaseDate),
      overrun,
    });
    this.store.budgetReservations.delete(job.id);
    const latestAffectedMonth = reservation.month > purchaseMonth ? reservation.month : purchaseMonth;
    this.recheckBlockedJobs(job.officeId, latestAffectedMonth);
  }

  recheckBlockedJobs(officeId: Office["id"], month: string): void {
    validateMonth(month);
    if (!this.store.offices.has(officeId)) {
      throw new Error(`Unknown office: ${officeId}`);
    }
    const latest = this.store.latestBudgetMonths.get(officeId);
    // Historical balances stay queryable. Only the current budget funds the waiting queue.
    if (latest !== undefined && month < latest) {
      return;
    }
    const job = [...this.store.refillJobs.values()].find((job) =>
      job.officeId === officeId && job.status === "BUDGET_BLOCKED",
    );
    if (job && this.tryReserve(job, this.estimateJob(job), month)) {
      job.status = "OPEN";
    }
    this.store.latestBudgetMonths.set(officeId, month);
  }

  private estimateJob(job: RefillJob): number {
    let total = 0;
    for (const boxId of job.snackBoxIds) {
      const box = this.store.snackBoxes.get(boxId);
      if (!box) {
        throw new Error(`Unknown snack box: ${boxId}`);
      }
      total += requireMinorUnits(box.estimatedCostMinor);
    }
    return total;
  }

  private requireReservation(job: RefillJob): BudgetEntry {
    const reservation = this.store.budgetReservations.get(job.id);
    if (!reservation) {
      throw new Error(`Refill job ${job.id} has no budget reservation`);
    }
    return reservation;
  }

  private tryReserve(job: RefillJob, amountMinor: number, month: string): boolean {
    requireMinorUnits(amountMinor);
    const balance = this.calculateBalance(job.officeId, month);
    const current = this.store.budgetReservations.get(job.id);
    // A resize in the same month replaces the amount already committed to this job.
    const alreadyReserved = current?.month === month ? current.amountMinor : 0;
    if (amountMinor - alreadyReserved > balance.availableMinor) {
      return false;
    }
    this.store.budgetReservations.set(job.id, { officeId: job.officeId, month, amountMinor });
    return true;
  }

  private calculateBalance(officeId: Office["id"], month: string): BudgetBalance {
    const office = this.store.offices.get(officeId);
    if (!office) {
      throw new Error(`Unknown office: ${officeId}`);
    }
    const budgetMinor = requireMinorUnits(Math.round(office.monthlyBudget * 100));
    const reservedMinor = this.sumMonth(this.store.budgetReservations, officeId, month);
    const spentMinor = this.sumMonth(this.store.purchaseExpenses, officeId, month);
    return {
      currency: office.currency,
      budgetMinor,
      reservedMinor,
      spentMinor,
      availableMinor: budgetMinor - reservedMinor - spentMinor,
    };
  }

  private sumMonth(entries: ReadonlyMap<string, BudgetEntry>, officeId: string, month: string): number {
    let total = 0;
    for (const entry of entries.values()) {
      if (entry.officeId === officeId && entry.month === month) {
        total += entry.amountMinor;
      }
    }
    return total;
  }
}
