import { accountingMonth, BudgetService, validateAccountingMonth } from "./budget-service.ts";
import type { Currency, Office } from "./domain.ts";
import type { InMemoryStore } from "./store.ts";

export interface ExchangeRate {
  from: Currency;
  to: Currency;
  /** Units of the target currency per unit of the source currency, as a fraction. */
  numerator: number;
  denominator: number;
}

interface OfficeSpending {
  officeId: Office["id"];
  name: string;
  currency: Currency;
  budgetMinor: number;
  spentMinor: number;
  remainingMinor: number;
  completedRefillJobs: number;
}

interface SnackInsight {
  snackType: string;
  refillCount: number;
  recordedQuantities: { unit: string; quantity: number }[];
}

interface ConsolidatedSpending {
  currency: Currency;
  spentMinor: number;
  exchangeRate?: ExchangeRate;
}

export interface MonthlySpendingReport {
  month: string;
  offices: OfficeSpending[];
  completedRefillJobs: number;
  consolidated: ConsolidatedSpending;
  snackInsights: SnackInsight[];
}

export class ReportingService {
  private readonly store: InMemoryStore;
  private readonly budget: BudgetService;

  constructor(store: InMemoryStore) {
    this.store = store;
    this.budget = new BudgetService(store);
  }

  getMonthlyReport(month: string, currency: Currency, exchangeRate?: ExchangeRate): MonthlySpendingReport {
    validateAccountingMonth(month);
    const completedByOffice = new Map<Office["id"], number>();
    const snackStats = new Map<string, { refillCount: number; quantities: Map<string, number> }>();
    let completedRefillJobs = 0;

    function statsFor(snackType: string) {
      const existing = snackStats.get(snackType);
      if (existing) {
        return existing;
      }
      const stats = { refillCount: 0, quantities: new Map<string, number>() };
      snackStats.set(snackType, stats);
      return stats;
    }

    // Completion dates place refills in the month when the boxes were refilled.
    for (const job of this.store.refillJobs.values()) {
      if (job.status !== "COMPLETED" || !job.completedAt || accountingMonth(job.completedAt) !== month) {
        continue;
      }
      completedRefillJobs += 1;
      completedByOffice.set(job.officeId, (completedByOffice.get(job.officeId) ?? 0) + 1);
      for (const boxId of job.snackBoxIds) {
        const box = this.store.snackBoxes.get(boxId);
        if (box) {
          statsFor(box.snackType).refillCount += 1;
        }
      }
    }

    // Quantities follow the purchase month, just like the recorded expense.
    for (const expense of this.store.purchaseExpenses.values()) {
      if (expense.month !== month || !expense.items) {
        continue;
      }
      for (const item of expense.items) {
        const box = this.store.snackBoxes.get(item.snackBoxId);
        if (box) {
          const { quantities } = statsFor(box.snackType);
          quantities.set(item.unit, (quantities.get(item.unit) ?? 0) + item.quantity);
        }
      }
    }

    const offices: OfficeSpending[] = [...this.store.offices.values()].map((office) => {
      const { budgetMinor, spentMinor } = this.budget.readBalance(office.id, month);
      return {
        officeId: office.id,
        name: office.name,
        currency: office.currency,
        budgetMinor,
        spentMinor,
        remainingMinor: budgetMinor - spentMinor,
        completedRefillJobs: completedByOffice.get(office.id) ?? 0,
      };
    });

    return {
      month,
      offices,
      completedRefillJobs,
      consolidated: consolidateSpending(offices, currency, exchangeRate),
      snackInsights: [...snackStats.entries()].map(([snackType, { refillCount, quantities }]) => ({
        snackType,
        refillCount,
        recordedQuantities: [...quantities.entries()].map(([unit, quantity]) => ({ unit, quantity })),
      })),
    };
  }
}

function consolidateSpending(
  offices: OfficeSpending[],
  currency: Currency,
  exchangeRate?: ExchangeRate,
): ConsolidatedSpending {
  let domesticMinor = 0n;
  let foreignMinor = 0n;
  for (const office of offices) {
    if (office.currency === currency) {
      domesticMinor += BigInt(office.spentMinor);
    } else {
      foreignMinor += BigInt(office.spentMinor);
    }
  }

  let totalMinor = domesticMinor;
  if (foreignMinor > 0n) {
    const from = currency === "NOK" ? "INR" : "NOK";
    if (exchangeRate?.from !== from || exchangeRate.to !== currency) {
      throw new Error(`An exchange rate from ${from} to ${currency} is required`);
    }
    if (
      !Number.isSafeInteger(exchangeRate.numerator) || exchangeRate.numerator <= 0 ||
      !Number.isSafeInteger(exchangeRate.denominator) || exchangeRate.denominator <= 0
    ) {
      throw new Error("Exchange rate numerator and denominator must be positive integers");
    }
    const denominator = BigInt(exchangeRate.denominator);
    // Both currencies have 100 minor units. Round the converted aggregate once.
    totalMinor += (foreignMinor * BigInt(exchangeRate.numerator) + denominator / 2n) / denominator;
  }
  if (totalMinor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Consolidated spending exceeds the supported range");
  }
  const result: ConsolidatedSpending = { currency, spentMinor: Number(totalMinor) };
  if (foreignMinor > 0n && exchangeRate) {
    result.exchangeRate = { ...exchangeRate };
  }
  return result;
}
