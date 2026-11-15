import { describe, expect, it } from "vitest";
import type {
  Employee,
  EmptyBoxReport,
  Office,
  RefillJob,
  SnackBox,
} from "../src/domain.ts";
import { InMemoryStore } from "../src/store.ts";

const oslo: Office = {
  id: "oslo",
  name: "Oslo",
  currency: "NOK",
  monthlyBudget: 6_000,
};
const employee: Employee = {
  id: "employee-1",
  name: "Ada",
  homeOfficeId: oslo.id,
  isVolunteer: false,
};
const snackBox: SnackBox = {
  id: "box-1",
  officeId: oslo.id,
  snackType: "Biscuits",
};
const reportedAt = new Date("2026-01-12T09:00:00Z");
const report: EmptyBoxReport = {
  id: "report-1",
  snackBoxId: snackBox.id,
  refillJobId: "job-1",
  reportedAt,
};

describe("InMemoryStore", () => {
  it("stores and retrieves all five record types by ID", () => {
    const store = new InMemoryStore();
    const job: RefillJob = {
      id: report.refillJobId,
      officeId: oslo.id,
      snackBoxIds: new Set([snackBox.id]),
      status: "OPEN",
      createdAt: reportedAt,
    };

    store.offices.set(oslo.id, oslo);
    store.employees.set(employee.id, employee);
    store.snackBoxes.set(snackBox.id, snackBox);
    store.emptyBoxReports.set(report.id, report);
    store.refillJobs.set(job.id, job);

    expect(store.offices.get(oslo.id)).toEqual(oslo);
    expect(store.employees.get(employee.id)).toEqual(employee);
    expect(store.snackBoxes.get(snackBox.id)).toEqual(snackBox);
    expect(store.emptyBoxReports.get(report.id)).toEqual(report);
    expect(store.refillJobs.get(job.id)).toEqual(job);
  });

  it("creates empty maps that are independent for each store", () => {
    const first = new InMemoryStore();
    const second = new InMemoryStore();

    first.offices.set(oslo.id, oslo);

    expect(second.offices.size).toBe(0);
    expect(second.employees.size).toBe(0);
    expect(second.snackBoxes.size).toBe(0);
    expect(second.emptyBoxReports.size).toBe(0);
    expect(second.refillJobs.size).toBe(0);
    expect(first.employees).not.toBe(second.employees);
    expect(first.snackBoxes).not.toBe(second.snackBoxes);
    expect(first.emptyBoxReports).not.toBe(second.emptyBoxReports);
    expect(first.refillJobs).not.toBe(second.refillJobs);
  });

  it("keeps separate reports for a box and stores its ID once per job", () => {
    const store = new InMemoryStore();
    const secondReport: EmptyBoxReport = {
      ...report,
      id: "report-2",
      reportedAt: new Date("2026-01-12T09:05:00Z"),
    };
    const job: RefillJob = {
      id: report.refillJobId,
      officeId: oslo.id,
      snackBoxIds: new Set([report.snackBoxId, secondReport.snackBoxId]),
      status: "OPEN",
      createdAt: reportedAt,
    };

    store.emptyBoxReports.set(report.id, report);
    store.emptyBoxReports.set(secondReport.id, secondReport);
    store.refillJobs.set(job.id, job);

    expect(store.emptyBoxReports.size).toBe(2);
    expect(store.emptyBoxReports.get(report.id)).toEqual(report);
    expect(store.emptyBoxReports.get(secondReport.id)).toEqual(secondReport);
    expect(store.refillJobs.get(job.id)?.snackBoxIds).toEqual(
      new Set([snackBox.id]),
    );
  });
});
