import { describe, expect, it } from "vitest";
import type { Office, RefillJob, SnackBox } from "../src/domain.ts";
import { RefillService } from "../src/refill-service.ts";
import { InMemoryStore } from "../src/store.ts";

const oslo: Office = { id: "oslo", name: "Oslo", currency: "NOK", monthlyBudget: 6_000 };
const bengaluru: Office = {
  id: "bengaluru",
  name: "Bengaluru",
  currency: "INR",
  monthlyBudget: 15_000,
};
const biscuits: SnackBox = {
  id: "biscuits", officeId: oslo.id, snackType: "Biscuits", estimatedCostMinor: 45_000,
};
const chocolate: SnackBox = {
  id: "chocolate", officeId: oslo.id, snackType: "Chocolate", estimatedCostMinor: 50_000,
};
const crisps: SnackBox = {
  id: "crisps", officeId: bengaluru.id, snackType: "Crisps", estimatedCostMinor: 120_000,
};

function setup() {
  const store = new InMemoryStore();
  store.offices.set(oslo.id, oslo);
  store.offices.set(bengaluru.id, bengaluru);
  for (const box of [biscuits, chocolate, crisps]) {
    store.snackBoxes.set(box.id, box);
  }
  return { store, service: new RefillService(store) };
}

describe("RefillService.reportEmpty", () => {
  it("creates an OPEN job and records the report", () => {
    const { store, service } = setup();

    const job = service.reportEmpty(biscuits.id);

    expect(store.refillJobs.get(job.id)).toBe(job);
    expect(job).toMatchObject({ status: "OPEN", officeId: oslo.id, createdAt: expect.any(Date) });
    expect(job.snackBoxIds).toEqual(new Set([biscuits.id]));
    expect([...store.emptyBoxReports.values()]).toEqual([
      {
        id: expect.any(String),
        snackBoxId: biscuits.id,
        refillJobId: job.id,
        reportedAt: expect.any(Date),
      },
    ]);
  });

  it("records near-simultaneous reports against a single job and requirement", async () => {
    const { store, service } = setup();

    const [firstJob, secondJob] = await Promise.all([
      Promise.resolve().then(() => service.reportEmpty(biscuits.id)),
      Promise.resolve().then(() => service.reportEmpty(biscuits.id)),
    ]);

    expect(secondJob).toBe(firstJob);
    expect(store.refillJobs.size).toBe(1);
    expect(firstJob.snackBoxIds).toEqual(new Set([biscuits.id]));
    expect([...store.emptyBoxReports.values()]).toMatchObject([
      { snackBoxId: biscuits.id, refillJobId: firstJob.id },
      { snackBoxId: biscuits.id, refillJobId: firstJob.id },
    ]);
  });

  it.each(["OPEN", "OFFERED", "ASSIGNED"] as const)(
    "adds a new box to a job in state %s",
    (status) => {
      const { store, service } = setup();
      const job = service.reportEmpty(biscuits.id);
      job.status = status;

      expect(service.reportEmpty(chocolate.id)).toBe(job);
      expect(job.status).toBe(status);
      expect(job.snackBoxIds).toEqual(new Set([biscuits.id, chocolate.id]));
      expect(store.refillJobs.size).toBe(1);
      expect([...store.emptyBoxReports.values()]).toContainEqual(
        expect.objectContaining({ snackBoxId: chocolate.id, refillJobId: job.id }),
      );
    },
  );

  it("keeps jobs separate by office", () => {
    const { store, service } = setup();

    const osloJob = service.reportEmpty(biscuits.id);
    const bengaluruJob = service.reportEmpty(crisps.id);

    expect(store.refillJobs.size).toBe(2);
    expect(osloJob.officeId).toBe(oslo.id);
    expect(osloJob.snackBoxIds).toEqual(new Set([biscuits.id]));
    expect(bengaluruJob.officeId).toBe(bengaluru.id);
    expect(bengaluruJob.snackBoxIds).toEqual(new Set([crisps.id]));
  });

  it("keeps an in-progress job's boxes locked and routes duplicates back to it", () => {
    const { store, service } = setup();
    const lockedJob: RefillJob = {
      id: "locked",
      officeId: oslo.id,
      snackBoxIds: new Set([biscuits.id]),
      status: "IN_PROGRESS",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    };
    store.refillJobs.set(lockedJob.id, lockedJob);

    const openJob = service.reportEmpty(chocolate.id);
    // Put the collecting job first so the duplicate check must search past it.
    store.refillJobs.delete(lockedJob.id);
    store.refillJobs.set(lockedJob.id, lockedJob);

    expect(openJob.status).toBe("OPEN");
    expect(openJob.snackBoxIds).toEqual(new Set([chocolate.id]));
    expect(service.reportEmpty(biscuits.id)).toBe(lockedJob);
    expect(lockedJob.snackBoxIds).toEqual(new Set([biscuits.id]));
    expect(openJob.snackBoxIds).toEqual(new Set([chocolate.id]));
    expect(store.refillJobs.size).toBe(2);
    expect([...store.emptyBoxReports.values()]).toMatchObject([
      { snackBoxId: chocolate.id, refillJobId: openJob.id },
      { snackBoxId: biscuits.id, refillJobId: lockedJob.id },
    ]);
  });

  it("allows the same box to be reported again after its job is completed", () => {
    const { store, service } = setup();
    const completedJob = service.reportEmpty(biscuits.id);
    completedJob.status = "COMPLETED";

    const newJob = service.reportEmpty(biscuits.id);

    expect(newJob.id).not.toBe(completedJob.id);
    expect(newJob.status).toBe("OPEN");
    expect(newJob.snackBoxIds).toEqual(new Set([biscuits.id]));
    expect(store.refillJobs.size).toBe(2);
    expect([...store.emptyBoxReports.values()]).toMatchObject([
      { snackBoxId: biscuits.id, refillJobId: completedJob.id },
      { snackBoxId: biscuits.id, refillJobId: newJob.id },
    ]);
  });

  it("chooses the oldest eligible job, breaking timestamp ties by insertion order", () => {
    const { store, service } = setup();
    const oldestTimestamp = new Date("2026-01-01T09:00:00Z");
    const newer: RefillJob = {
      id: "newer",
      officeId: oslo.id,
      snackBoxIds: new Set(),
      status: "OPEN",
      createdAt: new Date("2026-01-01T10:00:00Z"),
    };
    const oldest: RefillJob = {
      ...newer,
      id: "oldest",
      status: "ASSIGNED",
      snackBoxIds: new Set(),
      createdAt: oldestTimestamp,
    };
    const tied: RefillJob = { ...oldest, id: "tied", snackBoxIds: new Set() };
    for (const job of [newer, oldest, tied]) {
      store.refillJobs.set(job.id, job);
    }

    expect(service.reportEmpty(biscuits.id)).toBe(oldest);
    expect(oldest.snackBoxIds).toEqual(new Set([biscuits.id]));
    expect(newer.snackBoxIds.size).toBe(0);
    expect(tied.snackBoxIds.size).toBe(0);
  });

  it("rejects an unknown box ID without writing a job or report", () => {
    const { store, service } = setup();

    expect(() => service.reportEmpty("unknown")).toThrow("Unknown snack box");
    expect(store.refillJobs.size).toBe(0);
    expect(store.emptyBoxReports.size).toBe(0);
  });

  it("rejects a box with an unknown office without writing a job or report", () => {
    const { store, service } = setup();
    store.offices.delete(oslo.id);

    expect(() => service.reportEmpty(biscuits.id)).toThrow("Unknown office for snack box");
    expect(store.refillJobs.size).toBe(0);
    expect(store.emptyBoxReports.size).toBe(0);
  });
});
