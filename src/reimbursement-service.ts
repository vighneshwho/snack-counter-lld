import type { ChatService } from "./chat-service.ts";
import type { RefillJob, ReimbursementRecord } from "./domain.ts";
import { HRClaimRejectedError, type HRClaimPayload, type HRService } from "./hr-service.ts";
import type { InMemoryStore } from "./store.ts";

export class ReimbursementService {
  private readonly store: InMemoryStore;
  private readonly hr: HRService;
  private readonly chat?: ChatService;

  constructor(store: InMemoryStore, hr: HRService, chat?: ChatService) {
    this.store = store;
    this.hr = hr;
    this.chat = chat;
  }

  submitClaim(jobId: RefillJob["id"]): Promise<ReimbursementRecord> {
    const ongoing = this.store.ongoingClaimSubmissions.get(jobId);
    if (ongoing) {
      return ongoing;
    }

    const existing = this.store.reimbursements.get(jobId);
    if (existing?.status === "SUBMITTED" || (existing?.status === "FAILED" && !existing.retryable)) {
      return Promise.resolve(existing);
    }

    const job = this.store.refillJobs.get(jobId);
    if (job?.status !== "COMPLETED" || job.assignedVolunteerId === undefined) {
      return Promise.reject(new Error(`Job ${jobId} must be completed by a volunteer to submit a claim`));
    }
    const expense = this.store.purchaseExpenses.get(jobId);
    if (!expense) {
      return Promise.reject(new Error(`Job ${jobId} has no recorded purchase expense`));
    }

    const office = this.store.offices.get(job.officeId);
    const payload: HRClaimPayload = {
      employeeId: job.assignedVolunteerId,
      amountMinor: expense.amountMinor,
      currency: expense.currency,
      description: `Snack refill at ${office?.name ?? job.officeId} (job ${jobId})`,
      receiptImage: expense.receiptReference,
    };

    // Register the Promise before invoking HR so all callers share the same request.
    const submission = Promise.resolve()
      .then(() => this.sendClaim(jobId, payload))
      .finally(() => this.store.ongoingClaimSubmissions.delete(jobId));
    this.store.ongoingClaimSubmissions.set(jobId, submission);
    return submission;
  }

  private async sendClaim(jobId: RefillJob["id"], payload: HRClaimPayload): Promise<ReimbursementRecord> {
    let record: ReimbursementRecord;
    try {
      const claimId = await this.hr.submitClaim(payload);
      record = { jobId, status: "SUBMITTED", claimId };
    } catch (error) {
      const reason = error instanceof Error ? error.message
        : typeof error === "string" ? error
          : "Unknown HR submission error";
      record = {
        jobId,
        status: "FAILED",
        reason,
        // An unconfirmed failure may have happened after HR created the claim.
        retryable: error instanceof HRClaimRejectedError,
      };
    }
    this.store.reimbursements.set(jobId, record);

    if (record.status === "SUBMITTED") {
      this.chat?.send({
        type: "HR_CLAIM_SUBMITTED",
        recipientId: payload.employeeId,
        jobId,
        message: `HR received your reimbursement claim ${record.claimId}.`,
      });
    } else {
      this.chat?.send({
        type: "HR_CLAIM_FAILED",
        recipientId: payload.employeeId,
        jobId,
        message: record.retryable
          ? `HR rejected the claim with “${record.reason}”. You can retry after resolving it.`
          : `HR submission needs manual reconciliation after “${record.reason}”.`,
      });
    }
    return record;
  }
}
