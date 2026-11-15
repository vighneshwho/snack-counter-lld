import { describe, expect, it, vi } from "vitest";
import { AssignmentService } from "../src/assignment-service.ts";
import { BudgetService } from "../src/budget-service.ts";
import { MockChatService } from "../src/chat-service.ts";
import type { PurchaseDetails } from "../src/domain.ts";
import { HRClaimRejectedError, MockHRService } from "../src/hr-service.ts";
import { RefillService } from "../src/refill-service.ts";
import { ReimbursementService } from "../src/reimbursement-service.ts";
import { InMemoryStore } from "../src/store.ts";

const purchase: PurchaseDetails = {
  amountMinor: 52_175,
  currency: "NOK",
  receiptReference: "receipts/oslo-001.jpg",
  purchaseDate: new Date("2026-11-15T12:00:00Z"),
};

function setup() {
  const store = new InMemoryStore();
  store.offices.set("oslo", { id: "oslo", name: "Oslo", currency: "NOK", monthlyBudget: 6_000 });
  for (const id of ["ada", "liv", "nora"]) {
    store.employees.set(id, {
      id,
      name: id,
      homeOfficeId: "oslo",
      isVolunteer: true,
      attendance: { status: "ON_SITE", officeId: "oslo" },
    });
  }
  for (const id of ["biscuits", "chocolate", "nuts"]) {
    store.snackBoxes.set(id, { id, officeId: "oslo", snackType: id, estimatedCostMinor: 40_000 });
  }
  const budget = new BudgetService(store);
  const chat = new MockChatService();
  const hr = new MockHRService();
  const refills = new RefillService(store, budget, chat);
  const assignments = new AssignmentService(store, budget, chat);
  const reimbursements = new ReimbursementService(store, hr, chat);

  function completeRefill() {
    const job = refills.reportEmpty("biscuits", purchase.purchaseDate);
    assignments.offerJob(job.id);
    assignments.acceptOffer(job.id, "ada");
    assignments.startPurchase(job.id, "ada", purchase.purchaseDate);
    return assignments.completeJob(job.id, "ada", purchase);
  }

  return { store, budget, chat, hr, refills, assignments, reimbursements, completeRefill };
}

describe("Mock Chat", () => {
  it("captures assignment, requirements, and completion notifications for the affected volunteers", () => {
    const { refills, assignments, chat } = setup();
    const job = refills.reportEmpty("biscuits", purchase.purchaseDate);
    expect(chat.notifications).toEqual([]);

    assignments.offerJob(job.id);
    refills.reportEmpty("chocolate", purchase.purchaseDate);
    refills.reportEmpty("chocolate", purchase.purchaseDate);
    assignments.declineOffer(job.id, "ada");
    assignments.acceptOffer(job.id, "liv");
    refills.reportEmpty("nuts", purchase.purchaseDate);
    assignments.reassignJob(job.id);
    assignments.acceptOffer(job.id, "nora");
    assignments.startPurchase(job.id, "nora", purchase.purchaseDate);
    assignments.completeJob(job.id, "nora", purchase);

    expect(chat.notifications).toMatchObject([
      { jobId: job.id, recipientId: "ada", type: "JOB_OFFERED" },
      { jobId: job.id, recipientId: "ada", type: "JOB_BOXES_UPDATED", message: expect.stringContaining("biscuits, chocolate") },
      { jobId: job.id, recipientId: "ada", type: "JOB_DECLINED" },
      { jobId: job.id, recipientId: "liv", type: "JOB_OFFERED" },
      { jobId: job.id, recipientId: "liv", type: "JOB_ACCEPTED" },
      { jobId: job.id, recipientId: "liv", type: "JOB_BOXES_UPDATED", message: expect.stringContaining("biscuits, chocolate, nuts") },
      { jobId: job.id, recipientId: "liv", type: "JOB_REASSIGNED" },
      { jobId: job.id, recipientId: "nora", type: "JOB_OFFERED" },
      { jobId: job.id, recipientId: "nora", type: "JOB_ACCEPTED" },
      { jobId: job.id, recipientId: "nora", type: "JOB_COMPLETED" },
    ]);
  });
});

describe("ReimbursementService", () => {
  it("submits the recorded purchase and saves the claim separately from the completed job", async () => {
    const { store, hr, chat, reimbursements, completeRefill } = setup();
    const job = completeRefill();
    expect(job.status).toBe("COMPLETED");
    expect(hr.claims.size).toBe(0);
    expect(store.reimbursements.has(job.id)).toBe(false);

    const claim = await reimbursements.submitClaim(job.id);

    expect(claim).toEqual({ jobId: job.id, status: "SUBMITTED", claimId: "HR-1" });
    expect(store.reimbursements.get(job.id)).toBe(claim);
    expect(hr.claims.get("HR-1")).toEqual({
      employeeId: "ada",
      amountMinor: 52_175,
      currency: "NOK",
      description: `Snack refill at Oslo (job ${job.id})`,
      receiptImage: "receipts/oslo-001.jpg",
    });
    expect(chat.notifications.at(-1)).toMatchObject({
      jobId: job.id, recipientId: "ada", type: "HR_CLAIM_SUBMITTED", message: expect.stringContaining("HR-1"),
    });
  });

  it("returns an existing claim without resubmitting or sending another notification", async () => {
    const { hr, chat, reimbursements, completeRefill } = setup();
    const submission = vi.spyOn(hr, "submitClaim");
    const job = completeRefill();

    const claim = await reimbursements.submitClaim(job.id);
    expect(await reimbursements.submitClaim(job.id)).toBe(claim);
    expect(submission).toHaveBeenCalledTimes(1);
    expect(chat.notifications.filter(({ type }) => type === "HR_CLAIM_SUBMITTED")).toHaveLength(1);
  });

  it("shares an ongoing submission across callers and services using the same store", async () => {
    const { store, hr, chat, reimbursements, completeRefill } = setup();
    const otherService = new ReimbursementService(store, hr, chat);
    const submission = vi.spyOn(hr, "submitClaim");
    const job = completeRefill();

    const first = reimbursements.submitClaim(job.id);
    const second = otherService.submitClaim(job.id);
    expect(second).toBe(first);
    expect(store.reimbursements.has(job.id)).toBe(false);

    const [firstClaim, secondClaim] = await Promise.all([first, second]);
    expect(secondClaim).toBe(firstClaim);
    expect(submission).toHaveBeenCalledTimes(1);
    expect(store.ongoingClaimSubmissions.size).toBe(0);
  });

  it("records a definite failure, preserves the completed refill, and accepts an explicit retry", async () => {
    const { store, budget, hr, chat, reimbursements, completeRefill } = setup();
    const job = completeRefill();
    const expenseBefore = structuredClone(store.purchaseExpenses.get(job.id));
    const jobBefore = structuredClone(job);
    const balanceBefore = budget.getBalance("oslo", "2026-11");
    const submission = vi.spyOn(hr, "submitClaim")
      .mockRejectedValueOnce(new HRClaimRejectedError("HR temporarily rejected the claim"));

    const failed = await reimbursements.submitClaim(job.id);

    expect(failed).toEqual({
      jobId: job.id, status: "FAILED", reason: "HR temporarily rejected the claim", retryable: true,
    });
    expect(store.reimbursements.get(job.id)).toBe(failed);
    expect(store.refillJobs.get(job.id)).toEqual(jobBefore);
    expect(store.purchaseExpenses.get(job.id)).toEqual(expenseBefore);
    expect(budget.getBalance("oslo", "2026-11")).toEqual(balanceBefore);
    expect(store.ongoingClaimSubmissions.size).toBe(0);
    expect(chat.notifications.at(-1)).toMatchObject({
      jobId: job.id, recipientId: "ada", type: "HR_CLAIM_FAILED",
    });
    expect(submission).toHaveBeenCalledTimes(1);

    expect(await reimbursements.submitClaim(job.id)).toEqual({
      jobId: job.id, status: "SUBMITTED", claimId: "HR-1",
    });
    expect(submission).toHaveBeenCalledTimes(2);
    expect(hr.claims.size).toBe(1);
    expect(chat.notifications.at(-1)?.type).toBe("HR_CLAIM_SUBMITTED");
  });

  it("keeps an ambiguous outcome for manual reconciliation even if HR created the claim", async () => {
    const { store, hr, chat, reimbursements, completeRefill } = setup();
    const job = completeRefill();
    const expenseBefore = structuredClone(store.purchaseExpenses.get(job.id));
    const createClaim = hr.submitClaim.bind(hr);
    const submission = vi.spyOn(hr, "submitClaim").mockImplementationOnce(async (payload) => {
      await createClaim(payload);
      throw new Error("Timed out waiting for the HR response");
    });

    const failed = await reimbursements.submitClaim(job.id);

    expect(failed).toEqual({
      jobId: job.id, status: "FAILED", reason: "Timed out waiting for the HR response", retryable: false,
    });
    expect(store.reimbursements.get(job.id)).toBe(failed);
    expect(await reimbursements.submitClaim(job.id)).toBe(failed);
    expect(submission).toHaveBeenCalledTimes(1);
    expect(hr.claims.size).toBe(1);
    expect(job.status).toBe("COMPLETED");
    expect(store.purchaseExpenses.get(job.id)).toEqual(expenseBefore);
    expect(chat.notifications.filter(({ type }) => type === "HR_CLAIM_FAILED")).toHaveLength(1);
  });

  it("rejects jobs without a completed refill and recorded expense before contacting HR", async () => {
    const { store, hr, refills, reimbursements, completeRefill } = setup();
    const job = refills.reportEmpty("biscuits", purchase.purchaseDate);
    await expect(reimbursements.submitClaim(job.id)).rejects.toThrow(/must be completed/);
    completeRefill();
    store.purchaseExpenses.delete(job.id);
    await expect(reimbursements.submitClaim(job.id)).rejects.toThrow(/no recorded purchase expense/);

    expect(hr.claims.size).toBe(0);
    expect(store.reimbursements.has(job.id)).toBe(false);
    expect(store.ongoingClaimSubmissions.size).toBe(0);
  });
});
