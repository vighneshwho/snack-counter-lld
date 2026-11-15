import {
  isActiveAssignment,
  type AssignmentEvent,
  type Employee,
  type RefillJob,
} from "./domain.ts";
import type { InMemoryStore } from "./store.ts";
import { VolunteerSelectionService } from "./volunteer-selection-service.ts";

export class AssignmentService {
  private readonly store: InMemoryStore;
  private readonly selection: VolunteerSelectionService;

  constructor(store: InMemoryStore) {
    this.store = store;
    this.selection = new VolunteerSelectionService(store);
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
    return this.offerNext(job);
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

  startPurchase(jobId: RefillJob["id"], volunteerId: Employee["id"]): RefillJob {
    const job = this.getJob(jobId);
    if (job.status !== "ASSIGNED" || job.assignedVolunteerId !== volunteerId) {
      throw new Error(`Only the assigned volunteer can start purchasing for an ASSIGNED job: ${jobId}`);
    }
    // RefillService uses IN_PROGRESS to route new boxes to another job.
    job.status = "IN_PROGRESS";
    return job;
  }

  completeJob(jobId: RefillJob["id"], volunteerId: Employee["id"]): RefillJob {
    const job = this.getJob(jobId);
    if (job.status !== "IN_PROGRESS" || job.assignedVolunteerId !== volunteerId) {
      throw new Error(`Only the assigned volunteer can complete an IN_PROGRESS job: ${jobId}`);
    }
    job.status = "COMPLETED";
    job.completedAt = new Date();
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
    return this.offerNext(job);
  }

  private offerNext(job: RefillJob): RefillJob {
    const volunteer = this.selection.selectVolunteer(job);
    job.needsAttention = volunteer === undefined;
    if (volunteer) {
      job.status = "OFFERED";
      job.offeredVolunteerId = volunteer.id;
      this.recordEvent(job, "OFFERED", volunteer.id);
    }
    return job;
  }

  private recordEvent(job: RefillJob, type: AssignmentEvent["type"], volunteerId: Employee["id"]) {
    (job.assignmentHistory ??= []).push({ type, volunteerId, occurredAt: new Date() });
  }
}
