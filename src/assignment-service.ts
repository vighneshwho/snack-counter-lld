import { accountingMonth, BudgetService } from "./budget-service.ts";
import type { ChatService } from "./chat-service.ts";
import {
  isActiveAssignment,
  type AssignmentEvent,
  type Employee,
  type PurchaseDetails,
  type RefillJob,
} from "./domain.ts";
import type { InMemoryStore } from "./store.ts";
import { VolunteerSelectionService } from "./volunteer-selection-service.ts";

export class AssignmentService {
  private readonly store: InMemoryStore;
  private readonly selection: VolunteerSelectionService;
  private readonly budget: BudgetService;
  private readonly chat?: ChatService;

  constructor(store: InMemoryStore, budget = new BudgetService(store), chat?: ChatService) {
    this.store = store;
    this.selection = new VolunteerSelectionService(store);
    this.budget = budget;
    this.chat = chat;
  }

  /** Reads the latest requirements, including boxes reported after an offer or acceptance. */
  getJob(jobId: RefillJob["id"]): RefillJob {
    const job = this.store.refillJobs.get(jobId);
    if (!job) {
      throw new Error(`Unknown refill job: ${jobId}`);
    }
    return job;
  }

  offerJob(jobId: RefillJob["id"]): RefillJob {
    const job = this.getJob(jobId);
    if (job.status !== "OPEN") {
      throw new Error(`Job ${jobId} must be OPEN to offer it`);
    }
    this.offerNext(job);
    this.notifyOffer(job);
    return job;
  }

  acceptOffer(jobId: RefillJob["id"], volunteerId: Employee["id"]): RefillJob {
    const job = this.getCurrentOffer(jobId, volunteerId);
    // Recheck at acceptance since a volunteer can receive more than one offer.
    for (const otherJob of this.store.refillJobs.values()) {
      if (otherJob.assignedVolunteerId === volunteerId && isActiveAssignment(otherJob.status)) {
        throw new Error(`Volunteer ${volunteerId} already has an active refill assignment`);
      }
    }

    job.status = "ASSIGNED";
    job.assignedVolunteerId = volunteerId;
    delete job.offeredVolunteerId;
    this.recordEvent(job, "ACCEPTED", volunteerId);
    this.chat?.send({
      type: "JOB_ACCEPTED",
      recipientId: volunteerId,
      jobId,
      message: "You accepted the refill job.",
    });
    return job;
  }

  declineOffer(jobId: RefillJob["id"], volunteerId: Employee["id"]): RefillJob {
    const job = this.getCurrentOffer(jobId, volunteerId);
    return this.replaceVolunteer(job, volunteerId, "DECLINED");
  }

  reassignJob(jobId: RefillJob["id"]): RefillJob {
    const job = this.getJob(jobId);
    if (job.status !== "OFFERED" && job.status !== "ASSIGNED") {
      throw new Error(`Job ${jobId} must be OFFERED or ASSIGNED to reassign it`);
    }
    const volunteerId = job.status === "OFFERED" ? job.offeredVolunteerId : job.assignedVolunteerId;
    if (volunteerId === undefined) {
      throw new Error(`Job ${jobId} has no volunteer to replace`);
    }
    return this.replaceVolunteer(job, volunteerId, "REASSIGNED");
  }

  startPurchase(jobId: RefillJob["id"], volunteerId: Employee["id"], asOf: Date = new Date()): RefillJob {
    const job = this.getJob(jobId);
    if (job.status !== "ASSIGNED" || job.assignedVolunteerId !== volunteerId) {
      throw new Error(`Only the assigned volunteer can start purchasing for an ASSIGNED job: ${jobId}`);
    }
    this.budget.reserveForPurchase(job, accountingMonth(asOf));
    // RefillService uses IN_PROGRESS to route new boxes to another job.
    job.status = "IN_PROGRESS";
    return job;
  }

  completeJob(jobId: RefillJob["id"], volunteerId: Employee["id"], details: PurchaseDetails): RefillJob {
    const job = this.getJob(jobId);
    if (job.status !== "IN_PROGRESS" || job.assignedVolunteerId !== volunteerId) {
      throw new Error(`Only the assigned volunteer can complete an IN_PROGRESS job: ${jobId}`);
    }
    this.budget.reconcilePurchase(job, details);
    job.status = "COMPLETED";
    job.completedAt = new Date();
    this.chat?.send({
      type: "JOB_COMPLETED",
      recipientId: volunteerId,
      jobId,
      message: "Your refill is complete and your purchase expense was recorded.",
    });
    return job;
  }

  cancelJob(jobId: RefillJob["id"], asOf: Date = new Date()): RefillJob {
    const job = this.getJob(jobId);
    if (job.status === "IN_PROGRESS" || job.status === "COMPLETED" || job.status === "CANCELLED") {
      throw new Error(`Only jobs awaiting a purchase can be cancelled: ${jobId}`);
    }
    const month = accountingMonth(asOf);
    job.status = "CANCELLED";
    job.needsAttention = false;
    delete job.offeredVolunteerId;
    delete job.assignedVolunteerId;
    this.budget.releaseReservation(job, month);
    return job;
  }

  private getCurrentOffer(jobId: RefillJob["id"], volunteerId: Employee["id"]): RefillJob {
    const job = this.getJob(jobId);
    if (job.status !== "OFFERED" || job.offeredVolunteerId !== volunteerId) {
      throw new Error(`Only the current offer recipient can respond to job ${jobId}`);
    }
    return job;
  }

  private replaceVolunteer(
    job: RefillJob,
    volunteerId: Employee["id"],
    event: "DECLINED" | "REASSIGNED",
  ): RefillJob {
    (job.excludedVolunteerIds ??= new Set()).add(volunteerId);
    this.recordEvent(job, event, volunteerId);
    job.status = "OPEN";
    delete job.offeredVolunteerId;
    delete job.assignedVolunteerId;
    this.offerNext(job);
    this.chat?.send({
      type: event === "DECLINED" ? "JOB_DECLINED" : "JOB_REASSIGNED",
      recipientId: volunteerId,
      jobId: job.id,
      message: event === "DECLINED"
        ? "Your decline was recorded."
        : "You were removed from the refill job during manual reassignment.",
    });
    this.notifyOffer(job);
    return job;
  }

  private offerNext(job: RefillJob): void {
    const volunteer = this.selection.selectVolunteer(job);
    job.needsAttention = volunteer === undefined;
    if (volunteer) {
      job.status = "OFFERED";
      job.offeredVolunteerId = volunteer.id;
      this.recordEvent(job, "OFFERED", volunteer.id);
    }
  }

  private notifyOffer(job: RefillJob): void {
    if (job.offeredVolunteerId !== undefined) {
      this.chat?.send({
        type: "JOB_OFFERED",
        recipientId: job.offeredVolunteerId,
        jobId: job.id,
        message: `You were offered a refill job for these boxes (${[...job.snackBoxIds].join(", ")}).`,
      });
    }
  }

  private recordEvent(job: RefillJob, type: AssignmentEvent["type"], volunteerId: Employee["id"]) {
    (job.assignmentHistory ??= []).push({ type, volunteerId, occurredAt: new Date() });
  }
}
