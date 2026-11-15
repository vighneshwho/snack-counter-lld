import { describe, expect, it } from "vitest";
import { AssignmentService } from "../src/assignment-service.ts";
import { BudgetService } from "../src/budget-service.ts";
import type { Office, PurchaseDetails, RefillJob } from "../src/domain.ts";
import { RefillService } from "../src/refill-service.ts";
import { InMemoryStore } from "../src/store.ts";

const november = new Date("2026-11-30T12:00:00Z");
const december = new Date("2026-12-01T12:00:00Z");
const oslo: Office = { id: "oslo", name: "Oslo", currency: "NOK", monthlyBudget: 6_000 };
const bengaluru: Office = { id: "bengaluru", name: "Bengaluru", currency: "INR", monthlyBudget: 15_000 };
const volunteerId = "ada";

function receipt(amountMinor: number, purchaseDate = november): PurchaseDetails {
  return { amountMinor, currency: "NOK", receiptReference: "receipt-001.jpg", purchaseDate };
}

function setup() {
  const store = new InMemoryStore();
  store.offices.set(oslo.id, oslo);
  store.offices.set(bengaluru.id, bengaluru);
  store.employees.set(volunteerId, {
    id: volunteerId,
    name: "Ada",
    homeOfficeId: oslo.id,
    isVolunteer: true,
    attendance: { status: "ON_SITE", officeId: oslo.id },
  });
  const budget = new BudgetService(store);
  const refills = new RefillService(store, budget);
  const assignments = new AssignmentService(store, budget);

  function addBox(id: string, cost: number, officeId = oslo.id) {
    store.snackBoxes.set(id, { id, officeId, snackType: id, estimatedCostMinor: cost });
  }

  function start(job: RefillJob, asOf = november) {
    assignments.offerJob(job.id);
    assignments.acceptOffer(job.id, volunteerId);
    assignments.startPurchase(job.id, volunteerId, asOf);
  }

  return { store, budget, refills, assignments, addBox, start };
}

describe("Refill budget management", () => {
  it("tracks monthly budgets and reservations separately in each office's currency", () => {
    const { budget, refills, addBox } = setup();
    addBox("oslo-biscuits", 600_000);
    addBox("bengaluru-biscuits", 400_000, bengaluru.id);

    expect(refills.reportEmpty("oslo-biscuits", november).status).toBe("OPEN");
    expect(refills.reportEmpty("bengaluru-biscuits", november).status).toBe("OPEN");
    expect(budget.getBalance(oslo.id, "2026-11")).toEqual({
      currency: "NOK", budgetMinor: 600_000, reservedMinor: 600_000, spentMinor: 0, availableMinor: 0,
    });
    expect(budget.getBalance(bengaluru.id, "2026-11")).toEqual({
      currency: "INR", budgetMinor: 1_500_000, reservedMinor: 400_000, spentMinor: 0, availableMinor: 1_100_000,
    });
  });

  it("reserves a new job and increases the same reservation as an offered or assigned job grows", () => {
    const { refills, assignments, store, addBox } = setup();
    addBox("biscuits", 100_000);
    addBox("chocolate", 150_000);
    addBox("nuts", 50_000);
    const job = refills.reportEmpty("biscuits", november);
    expect(store.budgetReservations.get(job.id)?.amountMinor).toBe(100_000);

    assignments.offerJob(job.id);
    expect(refills.reportEmpty("chocolate", november)).toBe(job);
    expect(store.budgetReservations.get(job.id)?.amountMinor).toBe(250_000);

    assignments.acceptOffer(job.id, volunteerId);
    expect(refills.reportEmpty("nuts", november)).toBe(job);
    expect(store.budgetReservations.get(job.id)).toEqual({
      officeId: oslo.id, month: "2026-11", amountMinor: 300_000,
    });
    expect(store.budgetReservations.size).toBe(1);
  });

  it("groups unfunded boxes by office and preserves all duplicate reports without new reservations", () => {
    const { refills, store, addBox } = setup();
    addBox("biscuits", 550_000);
    addBox("chocolate", 55_000);
    addBox("nuts", 65_000);
    addBox("bengaluru-crisps", 1_600_000, bengaluru.id);
    const funded = refills.reportEmpty("biscuits", november);
    const blocked = refills.reportEmpty("chocolate", november);

    expect(refills.reportEmpty("nuts", november)).toBe(blocked);
    expect(refills.reportEmpty("chocolate", november)).toBe(blocked);
    expect(refills.reportEmpty("biscuits", november)).toBe(funded);
    const blockedInBengaluru = refills.reportEmpty("bengaluru-crisps", november);
    expect(blockedInBengaluru.status).toBe("BUDGET_BLOCKED");
    expect(blockedInBengaluru.id).not.toBe(blocked.id);

    expect(funded.snackBoxIds).toEqual(new Set(["biscuits"]));
    expect(blocked).toMatchObject({
      status: "BUDGET_BLOCKED", snackBoxIds: new Set(["chocolate", "nuts"]),
    });
    expect(store.refillJobs.size).toBe(3);
    expect(store.budgetReservations.size).toBe(1);
    expect(store.budgetReservations.get(funded.id)?.amountMinor).toBe(550_000);
    expect([...store.emptyBoxReports.values()].map((report) => report.refillJobId)).toEqual([
      funded.id, blocked.id, blocked.id, blocked.id, funded.id, blockedInBengaluru.id,
    ]);
  });

  it("cannot offer, accept, or start a blocked job and requires a reservation before purchase", () => {
    const { refills, assignments, store, addBox } = setup();
    addBox("biscuits", 600_000);
    addBox("chocolate", 60_000);
    const funded = refills.reportEmpty("biscuits", november);
    const blocked = refills.reportEmpty("chocolate", november);

    expect(() => assignments.offerJob(blocked.id)).toThrow(/must be OPEN/);
    expect(() => assignments.acceptOffer(blocked.id, volunteerId)).toThrow(/current offer recipient/);
    expect(() => assignments.startPurchase(blocked.id, volunteerId, november)).toThrow(/ASSIGNED job/);
    expect(blocked.status).toBe("BUDGET_BLOCKED");

    assignments.offerJob(funded.id);
    assignments.acceptOffer(funded.id, volunteerId);
    store.budgetReservations.delete(funded.id);
    expect(() => assignments.startPurchase(funded.id, volunteerId, november)).toThrow(/no budget reservation/);
    expect(funded.status).toBe("ASSIGNED");
  });

  it("preserves the reservation through declines and manual reassignment", () => {
    const { refills, assignments, store, addBox } = setup();
    store.employees.set("liv", { ...store.employees.get(volunteerId)!, id: "liv", name: "Liv" });
    addBox("biscuits", 100_000);
    const job = refills.reportEmpty("biscuits", november);
    const original = store.budgetReservations.get(job.id);

    assignments.offerJob(job.id);
    assignments.declineOffer(job.id, volunteerId);
    expect(store.budgetReservations.get(job.id)).toEqual(original);
    assignments.acceptOffer(job.id, "liv");
    assignments.reassignJob(job.id);
    expect(store.budgetReservations.get(job.id)).toEqual(original);
    expect(job).toMatchObject({ status: "OPEN", needsAttention: true });
  });

  it("cancels an unstarted job and uses the released budget to fund the entire blocked job", () => {
    const { refills, assignments, store, addBox } = setup();
    addBox("biscuits", 600_000);
    addBox("chocolate", 40_000);
    addBox("nuts", 50_000);
    const funded = refills.reportEmpty("biscuits", november);
    const blocked = refills.reportEmpty("chocolate", november);
    expect(refills.reportEmpty("nuts", november)).toBe(blocked);

    expect(assignments.cancelJob(funded.id, november).status).toBe("CANCELLED");
    expect(store.budgetReservations.has(funded.id)).toBe(false);
    expect(blocked.status).toBe("OPEN");
    expect(store.budgetReservations.get(blocked.id)?.amountMinor).toBe(90_000);
    expect(assignments.offerJob(blocked.id).status).toBe("OFFERED");
    expect(refills.reportEmpty("biscuits", november).id).not.toBe(funded.id);
  });

  it("reconciles a cheaper purchase and funds the blocked job from the savings", () => {
    const { refills, assignments, start, budget, store, addBox } = setup();
    addBox("biscuits", 600_000);
    addBox("nuts", 60_000);
    const funded = refills.reportEmpty("biscuits", november);
    const blocked = refills.reportEmpty("nuts", november);
    start(funded);

    const details = receipt(540_000);
    assignments.completeJob(funded.id, volunteerId, details);

    expect(funded.status).toBe("COMPLETED");
    expect(store.budgetReservations.has(funded.id)).toBe(false);
    expect(store.purchaseExpenses.get(funded.id)).toEqual({
      ...details, officeId: oslo.id, month: "2026-11", overrun: false,
    });
    expect(blocked.status).toBe("OPEN");
    expect(budget.getBalance(oslo.id, "2026-11")).toMatchObject({
      reservedMinor: 60_000, spentMinor: 540_000, availableMinor: 0,
    });
  });

  it("leaves all boxes blocked when released funds can cover only some of them", () => {
    const { refills, assignments, start, budget, store, addBox } = setup();
    addBox("biscuits", 600_000);
    addBox("nuts", 60_000);
    addBox("chocolate", 20_000);
    const funded = refills.reportEmpty("biscuits", november);
    const blocked = refills.reportEmpty("nuts", november);
    refills.reportEmpty("chocolate", november);
    start(funded);

    assignments.completeJob(funded.id, volunteerId, receipt(540_000));
    budget.recheckBlockedJobs(oslo.id, "2026-11");

    expect(blocked.status).toBe("BUDGET_BLOCKED");
    expect(blocked.snackBoxIds).toEqual(new Set(["nuts", "chocolate"]));
    expect(store.budgetReservations.size).toBe(0);
    expect(budget.getBalance(oslo.id, "2026-11").availableMinor).toBe(60_000);
  });

  it("activates the new month's budget lazily without touching last month's reservation", () => {
    const { refills, budget, store, addBox } = setup();
    addBox("biscuits", 600_000);
    addBox("nuts", 200_000);
    const funded = refills.reportEmpty("biscuits", november);
    const blocked = refills.reportEmpty("nuts", november);

    expect(refills.reportEmpty("nuts", december)).toBe(blocked);
    expect(blocked.status).toBe("OPEN");
    expect(store.budgetReservations.get(blocked.id)?.month).toBe("2026-12");
    expect(store.budgetReservations.get(funded.id)?.month).toBe("2026-11");
    expect(budget.getBalance(oslo.id, "2026-12").availableMinor).toBe(400_000);
    expect(budget.getBalance(oslo.id, "2026-11").availableMinor).toBe(0);
  });

  it("moves the full reservation to the current month when adding to a prior month's job", () => {
    const { refills, budget, store, addBox } = setup();
    addBox("biscuits", 300_000);
    addBox("nuts", 200_000);
    const job = refills.reportEmpty("biscuits", november);

    expect(refills.reportEmpty("nuts", december)).toBe(job);
    expect(store.budgetReservations.get(job.id)).toMatchObject({
      month: "2026-12", amountMinor: 500_000,
    });
    expect(budget.getBalance(oslo.id, "2026-11").availableMinor).toBe(600_000);
    expect(budget.getBalance(oslo.id, "2026-12").availableMinor).toBe(100_000);
  });

  it("starts a same-month purchase using its existing reservation even when the budget is fully reserved", () => {
    const { refills, start, budget, store, addBox } = setup();
    addBox("biscuits", 600_000);
    const job = refills.reportEmpty("biscuits", november);
    const originalReservation = store.budgetReservations.get(job.id);

    start(job);

    expect(job.status).toBe("IN_PROGRESS");
    expect(store.budgetReservations.get(job.id)).toBe(originalReservation);
    expect(budget.getBalance(oslo.id, "2026-11")).toMatchObject({
      reservedMinor: 600_000, availableMinor: 0,
    });
  });

  it("moves a reservation at purchase start before rechecking the waiting queue for the new month", () => {
    const { refills, start, budget, store, addBox } = setup();
    addBox("biscuits", 400_000);
    addBox("nuts", 250_000);
    const job = refills.reportEmpty("biscuits", november);
    const waiting = refills.reportEmpty("nuts", november);

    start(job, december);

    expect(job.status).toBe("IN_PROGRESS");
    expect(waiting.status).toBe("BUDGET_BLOCKED");
    expect(store.budgetReservations.size).toBe(1);
    expect(store.budgetReservations.get(job.id)).toEqual({
      officeId: oslo.id, month: "2026-12", amountMinor: 400_000,
    });
    expect(budget.getBalance(oslo.id, "2026-11").reservedMinor).toBe(0);
    expect(budget.getBalance(oslo.id, "2026-12")).toMatchObject({
      reservedMinor: 400_000, availableMinor: 200_000,
    });
  });

  it("keeps the job assigned and its prior reservation intact if the new month cannot cover it", () => {
    const { refills, assignments, budget, store, addBox } = setup();
    addBox("biscuits", 400_000);
    addBox("nuts", 250_000);
    const job = refills.reportEmpty("biscuits", november);
    const waiting = refills.reportEmpty("nuts", november);
    assignments.offerJob(job.id);
    assignments.acceptOffer(job.id, volunteerId);
    budget.recheckBlockedJobs(oslo.id, "2026-12");
    expect(waiting.status).toBe("OPEN");

    expect(() => assignments.startPurchase(job.id, volunteerId, december)).toThrow(/Insufficient budget/);
    expect(job).toMatchObject({ status: "ASSIGNED", assignedVolunteerId: volunteerId });
    expect(store.budgetReservations.get(job.id)).toMatchObject({
      month: "2026-11", amountMinor: 400_000,
    });
    expect(budget.getBalance(oslo.id, "2026-11").reservedMinor).toBe(400_000);
    expect(budget.getBalance(oslo.id, "2026-12").reservedMinor).toBe(250_000);

    assignments.cancelJob(waiting.id, december);
    expect(assignments.startPurchase(job.id, volunteerId, december).status).toBe("IN_PROGRESS");
    expect(budget.getBalance(oslo.id, "2026-11").reservedMinor).toBe(0);
    expect(budget.getBalance(oslo.id, "2026-12").reservedMinor).toBe(400_000);
  });

  it("releases a previous month's reservation and posts the actual purchase in the new month", () => {
    const { refills, assignments, start, budget, store, addBox } = setup();
    addBox("biscuits", 580_000);
    addBox("nuts", 100_000);
    const funded = refills.reportEmpty("biscuits", november);
    const blocked = refills.reportEmpty("nuts", november);
    start(funded);

    assignments.completeJob(funded.id, volunteerId, receipt(580_000, december));

    expect(store.purchaseExpenses.get(funded.id)).toMatchObject({
      month: "2026-12", amountMinor: 580_000, purchaseDate: december, overrun: false,
    });
    expect(budget.getBalance(oslo.id, "2026-11")).toMatchObject({
      reservedMinor: 0, spentMinor: 0, availableMinor: 600_000,
    });
    expect(budget.getBalance(oslo.id, "2026-12")).toMatchObject({
      reservedMinor: 0, spentMinor: 580_000, availableMinor: 20_000,
    });
    expect(blocked.status).toBe("BUDGET_BLOCKED");
  });

  it("records the full overrun and protects the original receipt against duplicate completion", () => {
    const { refills, assignments, start, budget, store, addBox } = setup();
    addBox("biscuits", 600_000);
    const funded = refills.reportEmpty("biscuits", november);
    start(funded);

    expect(() => assignments.cancelJob(funded.id, november)).toThrow(/awaiting a purchase/);
    assignments.completeJob(funded.id, volunteerId, receipt(660_000));
    const otherReceipt = { ...receipt(550_000), receiptReference: "second-receipt.jpg" };
    expect(() => assignments.completeJob(funded.id, volunteerId, otherReceipt)).toThrow(/IN_PROGRESS job/);
    expect(store.purchaseExpenses.size).toBe(1);
    expect(store.purchaseExpenses.get(funded.id)).toMatchObject({
      amountMinor: 660_000, receiptReference: "receipt-001.jpg", overrun: true,
    });
    expect(budget.getBalance(oslo.id, "2026-11")).toMatchObject({
      reservedMinor: 0, spentMinor: 660_000, availableMinor: -60_000,
    });
  });

  it.each([0, -1, 12.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid purchase amount (%s) without changing spending or the job",
    (amount) => {
      const { refills, assignments, start, store, addBox } = setup();
      addBox("biscuits", 100_000);
      const job = refills.reportEmpty("biscuits", november);
      start(job);
      const reservation = store.budgetReservations.get(job.id);

      expect(() => assignments.completeJob(job.id, volunteerId, receipt(amount))).toThrow(/Purchase amount/);
      expect(job.status).toBe("IN_PROGRESS");
      expect(store.budgetReservations.get(job.id)).toBe(reservation);
      expect(store.purchaseExpenses.size).toBe(0);
    },
  );

  it("rejects a purchase in another currency and allows retry with the office currency", () => {
    const { refills, assignments, start, store, addBox } = setup();
    addBox("biscuits", 100_000);
    const job = refills.reportEmpty("biscuits", november);
    start(job);
    const details = receipt(100_000);

    expect(() => assignments.completeJob(job.id, volunteerId, { ...details, currency: "INR" }))
      .toThrow(/must match the office currency/);
    expect(job.status).toBe("IN_PROGRESS");
    expect(store.budgetReservations.get(job.id)?.amountMinor).toBe(100_000);
    expect(store.purchaseExpenses.size).toBe(0);

    expect(assignments.completeJob(job.id, volunteerId, details).status).toBe("COMPLETED");
    expect(store.purchaseExpenses.get(job.id)?.currency).toBe("NOK");
  });

  it("requires a receipt reference and valid purchase date before changing the ledger", () => {
    const { refills, assignments, start, store, addBox } = setup();
    addBox("biscuits", 100_000);
    const job = refills.reportEmpty("biscuits", november);
    start(job);
    const details = receipt(100_000);

    expect(() => assignments.completeJob(job.id, volunteerId, { ...details, receiptReference: " " }))
      .toThrow(/receipt reference/);
    expect(() => assignments.completeJob(job.id, volunteerId, { ...details, purchaseDate: new Date(NaN) }))
      .toThrow(/purchase date/);
    expect(job.status).toBe("IN_PROGRESS");
    expect(store.budgetReservations.get(job.id)?.amountMinor).toBe(100_000);
    expect(store.purchaseExpenses.size).toBe(0);
  });

  it("flags spending above the job's estimate even if it fits the monthly budget", () => {
    const { refills, assignments, start, budget, store, addBox } = setup();
    addBox("biscuits", 100_000);
    const job = refills.reportEmpty("biscuits", november);
    start(job);

    assignments.completeJob(job.id, volunteerId, receipt(125_000));

    expect(store.purchaseExpenses.get(job.id)).toMatchObject({ amountMinor: 125_000, overrun: true });
    expect(budget.getBalance(oslo.id, "2026-11")).toMatchObject({
      reservedMinor: 0, spentMinor: 125_000, availableMinor: 475_000,
    });
  });

  it("flags an expense that exceeds the receipt month's available budget even within its estimate", () => {
    const { refills, assignments, start, budget, store, addBox } = setup();
    addBox("biscuits", 400_000);
    addBox("nuts", 300_000);
    const job = refills.reportEmpty("biscuits", november);
    start(job);
    refills.reportEmpty("nuts", december);

    assignments.completeJob(job.id, volunteerId, receipt(400_000, december));

    expect(store.purchaseExpenses.get(job.id)).toMatchObject({
      month: "2026-12", amountMinor: 400_000, overrun: true,
    });
    expect(budget.getBalance(oslo.id, "2026-12")).toMatchObject({
      reservedMinor: 300_000, spentMinor: 400_000, availableMinor: -100_000,
    });
  });

  it("keeps near-simultaneous reservations within the budget across service instances", async () => {
    const { refills, store, budget, addBox } = setup();
    const otherRefills = new RefillService(store);
    addBox("biscuits", 400_000);
    addBox("nuts", 400_000);
    addBox("chocolate", 400_000);

    const [first, second, third] = await Promise.all([
      Promise.resolve().then(() => refills.reportEmpty("biscuits", november)),
      Promise.resolve().then(() => otherRefills.reportEmpty("nuts", november)),
      Promise.resolve().then(() => refills.reportEmpty("chocolate", november)),
    ]);

    expect(first.status).toBe("OPEN");
    expect(second.status).toBe("BUDGET_BLOCKED");
    expect(second).toBe(third);
    expect(store.budgetReservations.size).toBe(1);
    expect(budget.getBalance(oslo.id, "2026-11").reservedMinor).toBe(400_000);
  });
});
