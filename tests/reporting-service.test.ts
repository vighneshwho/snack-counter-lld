import { describe, expect, it } from "vitest";
import { AssignmentService } from "../src/assignment-service.ts";
import type { Office, PurchaseDetails, PurchaseItem, RefillJob } from "../src/domain.ts";
import { RefillService } from "../src/refill-service.ts";
import { type ExchangeRate, ReportingService } from "../src/reporting-service.ts";
import { InMemoryStore } from "../src/store.ts";

const month = "2026-11";
const november = new Date("2026-11-30T12:00:00Z");
const december = new Date("2026-12-01T12:00:00Z");
const oslo: Office = { id: "oslo", name: "Oslo", currency: "NOK", monthlyBudget: 6_000 };
const bengaluru: Office = { id: "bengaluru", name: "Bengaluru", currency: "INR", monthlyBudget: 15_000 };
const inrToNok: ExchangeRate = { from: "INR", to: "NOK", numerator: 1, denominator: 8 };

function setup() {
  const store = new InMemoryStore();
  for (const office of [oslo, bengaluru]) {
    store.offices.set(office.id, office);
  }
  for (const [id, officeId, snackType] of [
    ["oslo-biscuits", oslo.id, "Biscuits"],
    ["oslo-biscuits-second", oslo.id, "Biscuits"],
    ["oslo-chocolate", oslo.id, "Chocolate"],
    ["bengaluru-biscuits", bengaluru.id, "Biscuits"],
  ]) {
    store.snackBoxes.set(id, { id, officeId, snackType, estimatedCostMinor: 40_000 });
  }

  function completedJob(id: string, office: Office, boxes: string[], completedAt = november): RefillJob {
    const job: RefillJob = {
      id, officeId: office.id, status: "COMPLETED", snackBoxIds: new Set(boxes),
      createdAt: november, completedAt,
    };
    store.refillJobs.set(id, job);
    return job;
  }

  function expense(job: RefillJob, office: Office, amountMinor: number, items?: PurchaseItem[]) {
    store.purchaseExpenses.set(job.id, {
      officeId: office.id,
      month,
      amountMinor,
      currency: office.currency,
      receiptReference: `receipts/${job.id}.jpg`,
      purchaseDate: november,
      overrun: false,
      items,
    });
  }

  return { store, reporting: new ReportingService(store), completedJob, expense };
}

describe("ReportingService", () => {
  it("reports actual expenses in local currencies and consolidates with a supplied rate", () => {
    const { store, reporting, completedJob, expense } = setup();
    const submitted = completedJob("submitted", oslo, ["oslo-biscuits"]);
    const failed = completedJob("failed", oslo, ["oslo-chocolate"]);
    const unsubmitted = completedJob("unsubmitted", bengaluru, ["bengaluru-biscuits"]);
    expense(submitted, oslo, 70_000);
    expense(failed, oslo, 50_000);
    expense(unsubmitted, bengaluru, 100_004);
    store.reimbursements.set(submitted.id, { jobId: submitted.id, status: "SUBMITTED", claimId: "HR-1" });
    store.reimbursements.set(failed.id, { jobId: failed.id, status: "FAILED", reason: "Timeout", retryable: false });
    store.budgetReservations.set("reserved", { officeId: oslo.id, month, amountMinor: 20_000 });

    const report = reporting.getMonthlyReport(month, "NOK", inrToNok);

    expect(report.offices).toEqual([
      {
        officeId: "oslo", name: "Oslo", currency: "NOK", budgetMinor: 600_000,
        spentMinor: 120_000, remainingMinor: 480_000, completedRefillJobs: 2,
      },
      {
        officeId: "bengaluru", name: "Bengaluru", currency: "INR", budgetMinor: 1_500_000,
        spentMinor: 100_004, remainingMinor: 1_399_996, completedRefillJobs: 1,
      },
    ]);
    expect(report.completedRefillJobs).toBe(3);
    expect(report.consolidated).toEqual({
      currency: "NOK", spentMinor: 132_501, exchangeRate: inrToNok,
    });
  });

  it("counts refilled boxes by completion month and aggregates recorded quantities by purchase month and unit", () => {
    const { reporting, completedJob, expense } = setup();
    const osloJob = completedJob("oslo-job", oslo, ["oslo-biscuits", "oslo-biscuits-second", "oslo-chocolate"]);
    const bengaluruJob = completedJob("bengaluru-job", bengaluru, ["bengaluru-biscuits"], december);
    expense(osloJob, oslo, 50_000, [
      { snackBoxId: "oslo-biscuits", quantity: 4, unit: "packs" },
      { snackBoxId: "oslo-biscuits", quantity: 0.25, unit: "kg" },
      { snackBoxId: "oslo-biscuits-second", quantity: 3, unit: "packs" },
    ]);
    expense(bengaluruJob, bengaluru, 150_000, [
      { snackBoxId: "bengaluru-biscuits", quantity: 2, unit: "packs" },
    ]);

    const novemberReport = reporting.getMonthlyReport(month, "NOK", inrToNok);
    const decemberReport = reporting.getMonthlyReport("2026-12", "NOK");

    expect(novemberReport.completedRefillJobs).toBe(1);
    expect(novemberReport.offices[1]).toMatchObject({ spentMinor: 150_000, completedRefillJobs: 0 });
    expect(novemberReport.snackInsights).toEqual([
      { snackType: "Biscuits", refillCount: 2, recordedQuantities: [
        { unit: "packs", quantity: 9 }, { unit: "kg", quantity: 0.25 },
      ] },
      { snackType: "Chocolate", refillCount: 1, recordedQuantities: [] },
    ]);
    expect(decemberReport.completedRefillJobs).toBe(1);
    expect(decemberReport.consolidated.spentMinor).toBe(0);
    expect(decemberReport.snackInsights).toEqual([
      { snackType: "Biscuits", refillCount: 1, recordedQuantities: [] },
    ]);
  });

  it("requires a rate in the selected direction when the report has foreign spending", () => {
    const { reporting, completedJob, expense } = setup();
    expense(completedJob("job", oslo, ["oslo-biscuits"]), oslo, 40_000);

    expect(reporting.getMonthlyReport(month, "NOK").consolidated).toEqual({
      currency: "NOK", spentMinor: 40_000,
    });
    expect(() => reporting.getMonthlyReport(month, "INR")).toThrow(/exchange rate from NOK to INR/);
    expect(() => reporting.getMonthlyReport(month, "INR", inrToNok)).toThrow(/exchange rate from NOK to INR/);
    expect(() => reporting.getMonthlyReport(month, "INR", {
      from: "NOK", to: "INR", numerator: 8, denominator: 0,
    })).toThrow(/positive integers/);
    expect(reporting.getMonthlyReport(month, "INR", {
      from: "NOK", to: "INR", numerator: 8, denominator: 1,
    }).consolidated.spentMinor).toBe(320_000);
  });

  it("reads a new month without funding blocked jobs or advancing the budget month", () => {
    const { store, reporting } = setup();
    const job: RefillJob = {
      id: "waiting", officeId: oslo.id, status: "BUDGET_BLOCKED",
      snackBoxIds: new Set(["oslo-biscuits"]), createdAt: november,
    };
    store.refillJobs.set(job.id, job);
    store.latestBudgetMonths.set(oslo.id, month);

    const report = reporting.getMonthlyReport("2026-12", "INR");

    expect(report.completedRefillJobs).toBe(0);
    expect(report.snackInsights).toEqual([]);
    expect(report.consolidated).toEqual({ currency: "INR", spentMinor: 0 });
    expect(job.status).toBe("BUDGET_BLOCKED");
    expect(store.budgetReservations.size).toBe(0);
    expect(store.latestBudgetMonths.get(oslo.id)).toBe(month);
    expect(() => reporting.getMonthlyReport("2026-13", "INR")).toThrow(/Invalid accounting month/);
  });

  it("stores supplied item quantities when a job completes and rejects items for other boxes", () => {
    const { store, reporting } = setup();
    store.employees.set("ada", {
      id: "ada", name: "Ada", homeOfficeId: oslo.id, isVolunteer: true,
      attendance: { status: "ON_SITE", officeId: oslo.id },
    });
    const refills = new RefillService(store);
    const assignments = new AssignmentService(store);
    const job = refills.reportEmpty("oslo-biscuits", november);
    assignments.offerJob(job.id);
    assignments.acceptOffer(job.id, "ada");
    assignments.startPurchase(job.id, "ada", november);
    const receipt: PurchaseDetails = {
      amountMinor: 50_000, currency: "NOK", receiptReference: "receipt.jpg", purchaseDate: november,
      items: [{ snackBoxId: "oslo-chocolate", quantity: 2, unit: "packs" }],
    };

    expect(() => assignments.completeJob(job.id, "ada", receipt)).toThrow(/box in the refill job/);
    expect(job.status).toBe("IN_PROGRESS");
    expect(store.budgetReservations.has(job.id)).toBe(true);
    expect(store.purchaseExpenses.has(job.id)).toBe(false);

    receipt.items = [{ snackBoxId: "oslo-biscuits", quantity: 2, unit: "packs" }];
    assignments.completeJob(job.id, "ada", receipt);
    receipt.items[0].quantity = 99;

    expect(store.purchaseExpenses.get(job.id)?.items?.[0].quantity).toBe(2);
    expect(reporting.getMonthlyReport(month, "NOK").snackInsights).toContainEqual(
      expect.objectContaining({ snackType: "Biscuits", recordedQuantities: [{ unit: "packs", quantity: 2 }] }),
    );
  });
});
