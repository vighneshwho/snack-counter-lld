import { describe, expect, it } from "vitest";
import { AssignmentService } from "../src/assignment-service.ts";
import type { Employee, Office } from "../src/domain.ts";
import { RefillService } from "../src/refill-service.ts";
import { InMemoryStore } from "../src/store.ts";

const oslo: Office = { id: "oslo", name: "Oslo", currency: "NOK", monthlyBudget: 6_000 };

function volunteer(id: string): Employee {
  return {
    id,
    name: id,
    homeOfficeId: oslo.id,
    isVolunteer: true,
    attendance: { status: "ON_SITE", officeId: oslo.id },
  };
}

function setup(volunteerIds = ["ada", "liv", "nora"]) {
  const store = new InMemoryStore();
  store.offices.set(oslo.id, oslo);
  for (const id of ["biscuits", "chocolate", "nuts", "crisps"]) {
    store.snackBoxes.set(id, { id, officeId: oslo.id, snackType: id, estimatedCostMinor: 40_000 });
  }
  for (const id of volunteerIds) {
    store.employees.set(id, volunteer(id));
  }
  const refills = new RefillService(store);
  const assignments = new AssignmentService(store);
  const job = refills.reportEmpty("biscuits");
  return { store, refills, assignments, job };
}

describe("AssignmentService", () => {
  it("offers, accepts, starts, and completes a refill with assignment history", () => {
    const { assignments, job } = setup();

    expect(assignments.offerJob(job.id)).toMatchObject({
      status: "OFFERED", offeredVolunteerId: "ada", needsAttention: false,
    });
    expect(assignments.acceptOffer(job.id, "ada")).toMatchObject({
      status: "ASSIGNED", assignedVolunteerId: "ada",
    });
    expect(job.offeredVolunteerId).toBeUndefined();
    expect(assignments.startPurchase(job.id, "ada").status).toBe("IN_PROGRESS");
    expect(assignments.completeJob(job.id, "ada")).toMatchObject({
      status: "COMPLETED", assignedVolunteerId: "ada", completedAt: expect.any(Date),
    });
    expect(job.assignmentHistory).toEqual([
      { type: "OFFERED", volunteerId: "ada", occurredAt: expect.any(Date) },
      { type: "ACCEPTED", volunteerId: "ada", occurredAt: expect.any(Date) },
    ]);
  });

  it("records declines and reoffers the same job through the eligible volunteers", () => {
    const { assignments, store, job } = setup();
    assignments.offerJob(job.id);

    expect(assignments.declineOffer(job.id, "ada")).toBe(job);
    expect(job).toMatchObject({ status: "OFFERED", offeredVolunteerId: "liv" });
    expect(assignments.declineOffer(job.id, "liv")).toBe(job);
    expect(job).toMatchObject({ status: "OFFERED", offeredVolunteerId: "nora" });
    expect(job.excludedVolunteerIds).toEqual(new Set(["ada", "liv"]));
    expect(job.assignmentHistory).toMatchObject([
      { type: "OFFERED", volunteerId: "ada" },
      { type: "DECLINED", volunteerId: "ada" },
      { type: "OFFERED", volunteerId: "liv" },
      { type: "DECLINED", volunteerId: "liv" },
      { type: "OFFERED", volunteerId: "nora" },
    ]);
    expect(store.refillJobs.size).toBe(1);
    expect(job.snackBoxIds).toEqual(new Set(["biscuits"]));
  });

  it("needs attention after the last volunteer declines and can be retried with a new volunteer", () => {
    const { assignments, store, job } = setup(["ada"]);
    assignments.offerJob(job.id);

    expect(assignments.declineOffer(job.id, "ada")).toMatchObject({
      status: "OPEN", needsAttention: true,
    });
    expect(job.offeredVolunteerId).toBeUndefined();
    expect(assignments.offerJob(job.id)).toMatchObject({ status: "OPEN", needsAttention: true });
    expect(job.assignmentHistory).toHaveLength(2);

    store.employees.set("liv", volunteer("liv"));
    expect(assignments.offerJob(job.id)).toMatchObject({
      status: "OFFERED", offeredVolunteerId: "liv", needsAttention: false,
    });
  });

  it("marks a new job for attention if nobody can be offered the job", () => {
    const { assignments, job } = setup([]);

    expect(assignments.offerJob(job.id)).toMatchObject({ status: "OPEN", needsAttention: true });
    expect(job.offeredVolunteerId).toBeUndefined();
    expect(job.assignmentHistory).toBeUndefined();
  });

  it("manually replaces an assignee before purchasing and rejects actions by the former assignee", () => {
    const { assignments, store, job } = setup();
    assignments.offerJob(job.id);
    assignments.acceptOffer(job.id, "ada");

    expect(assignments.reassignJob(job.id)).toBe(job);
    expect(job).toMatchObject({ status: "OFFERED", offeredVolunteerId: "liv" });
    expect(job.assignedVolunteerId).toBeUndefined();
    expect(job.excludedVolunteerIds).toEqual(new Set(["ada"]));
    expect(job.assignmentHistory).toMatchObject([
      { type: "OFFERED", volunteerId: "ada" },
      { type: "ACCEPTED", volunteerId: "ada" },
      { type: "REASSIGNED", volunteerId: "ada" },
      { type: "OFFERED", volunteerId: "liv" },
    ]);
    expect(() => assignments.startPurchase(job.id, "ada")).toThrow(/assigned volunteer/);
    expect(assignments.acceptOffer(job.id, "liv").assignedVolunteerId).toBe("liv");
    expect(store.refillJobs.size).toBe(1);
  });

  it("can replace a pending offer manually and mark the job for attention", () => {
    const { assignments, job } = setup(["ada"]);
    assignments.offerJob(job.id);

    expect(assignments.reassignJob(job.id)).toMatchObject({ status: "OPEN", needsAttention: true });
    expect(job.offeredVolunteerId).toBeUndefined();
    expect(job.excludedVolunteerIds).toEqual(new Set(["ada"]));
    expect(job.assignmentHistory?.at(-1)).toMatchObject({ type: "REASSIGNED", volunteerId: "ada" });
    expect(() => assignments.acceptOffer(job.id, "ada")).toThrow(/current offer recipient/);
  });

  it("rejects wrong volunteers and out-of-order actions without leaving partial changes", () => {
    const { assignments, job } = setup();
    expect(() => assignments.offerJob("missing")).toThrow(/Unknown refill job/);
    expect(() => assignments.reassignJob(job.id)).toThrow(/OFFERED or ASSIGNED/);
    assignments.offerJob(job.id);
    const offered = structuredClone(job);

    expect(() => assignments.offerJob(job.id)).toThrow(/must be OPEN/);
    expect(() => assignments.acceptOffer(job.id, "liv")).toThrow(/current offer recipient/);
    expect(() => assignments.declineOffer(job.id, "liv")).toThrow(/current offer recipient/);
    expect(() => assignments.startPurchase(job.id, "ada")).toThrow(/ASSIGNED job/);
    expect(job).toEqual(offered);

    assignments.acceptOffer(job.id, "ada");
    expect(() => assignments.declineOffer(job.id, "ada")).toThrow(/current offer recipient/);
    expect(() => assignments.startPurchase(job.id, "liv")).toThrow(/assigned volunteer/);
    expect(() => assignments.completeJob(job.id, "ada")).toThrow(/IN_PROGRESS job/);
    assignments.startPurchase(job.id, "ada");
    const purchasing = structuredClone(job);
    expect(() => assignments.reassignJob(job.id)).toThrow(/OFFERED or ASSIGNED/);
    expect(() => assignments.completeJob(job.id, "liv")).toThrow(/assigned volunteer/);
    expect(job).toEqual(purchasing);
    assignments.completeJob(job.id, "ada");
    expect(() => assignments.reassignJob(job.id)).toThrow(/OFFERED or ASSIGNED/);
    expect(() => assignments.completeJob(job.id, "ada")).toThrow(/IN_PROGRESS job/);
  });

  it("accepts a contested job only once when responses are queued together", async () => {
    const { assignments, job } = setup();
    assignments.offerJob(job.id);

    const responses = await Promise.allSettled(
      ["liv", "ada", "ada"].map((id) =>
        Promise.resolve().then(() => assignments.acceptOffer(job.id, id)),
      ),
    );

    expect(responses.map((response) => response.status)).toEqual([
      "rejected", "fulfilled", "rejected",
    ]);
    expect(job.assignedVolunteerId).toBe("ada");
    expect(job.assignmentHistory?.filter((event) => event.type === "ACCEPTED")).toHaveLength(1);
  });

  it("prevents accepting two outstanding offers while either assignment is active", async () => {
    const { assignments, store, job } = setup(["ada"]);
    const otherJob = { ...job, id: "other-job", snackBoxIds: new Set(["chocolate"]) };
    store.refillJobs.set(otherJob.id, otherJob);
    assignments.offerJob(job.id);
    assignments.offerJob(otherJob.id);

    const responses = await Promise.allSettled(
      [job, otherJob].map(({ id }) =>
        Promise.resolve().then(() => assignments.acceptOffer(id, "ada")),
      ),
    );

    expect(responses.map((response) => response.status)).toEqual(["fulfilled", "rejected"]);
    expect(otherJob).toMatchObject({ status: "OFFERED", offeredVolunteerId: "ada" });
    expect(otherJob.assignmentHistory).toHaveLength(1);
    assignments.startPurchase(job.id, "ada");
    expect(() => assignments.acceptOffer(otherJob.id, "ada")).toThrow(/active refill assignment/);
    assignments.completeJob(job.id, "ada");
    expect(assignments.acceptOffer(otherJob.id, "ada").status).toBe("ASSIGNED");
  });

  it("shows updated requirements before purchasing and locks boxes when purchasing starts", () => {
    const { assignments, refills, job } = setup();
    assignments.offerJob(job.id);
    expect(refills.reportEmpty("chocolate")).toBe(job);
    expect(assignments.getJob(job.id).snackBoxIds).toEqual(new Set(["biscuits", "chocolate"]));

    assignments.acceptOffer(job.id, "ada");
    expect(refills.reportEmpty("nuts")).toBe(job);
    const requirements = new Set(["biscuits", "chocolate", "nuts"]);
    expect(assignments.getJob(job.id).snackBoxIds).toEqual(requirements);
    expect(assignments.startPurchase(job.id, "ada").snackBoxIds).toEqual(requirements);

    const followUp = refills.reportEmpty("crisps");
    expect(followUp).toMatchObject({ status: "OPEN", snackBoxIds: new Set(["crisps"]) });
    expect(followUp.id).not.toBe(job.id);
    expect(refills.reportEmpty("biscuits")).toBe(job);
    expect(job.snackBoxIds).toEqual(requirements);
    expect(() => assignments.reassignJob(job.id)).toThrow(/OFFERED or ASSIGNED/);
  });
});
