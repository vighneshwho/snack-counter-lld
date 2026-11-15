import { randomUUID } from "node:crypto";
import { accountingMonth, BudgetService } from "./budget-service.ts";
import type { ChatService } from "./chat-service.ts";
import type { EmptyBoxReport, RefillJob, RefillJobStatus, SnackBox } from "./domain.ts";
import type { InMemoryStore } from "./store.ts";

const collectingStatuses = new Set<RefillJobStatus>(["OPEN", "OFFERED", "ASSIGNED"]);

export class RefillService {
  private readonly store: InMemoryStore;
  private readonly budget: BudgetService;
  private readonly chat?: ChatService;

  constructor(store: InMemoryStore, budget = new BudgetService(store), chat?: ChatService) {
    this.store = store;
    this.budget = budget;
    this.chat = chat;
  }

  reportEmpty(boxId: SnackBox["id"], asOf: Date = new Date()): RefillJob {
    const box = this.store.snackBoxes.get(boxId);
    if (!box) {
      throw new Error(`Unknown snack box: ${boxId}`);
    }
    if (!this.store.offices.has(box.officeId)) {
      throw new Error(`Unknown office for snack box ${boxId}: ${box.officeId}`);
    }
    const month = accountingMonth(asOf);
    this.budget.syncMonth(box.officeId, month);

    let activeJob: RefillJob | undefined;
    let oldestCollectingJob: RefillJob | undefined;
    let blockedJob: RefillJob | undefined;

    for (const job of this.store.refillJobs.values()) {
      if (job.officeId !== box.officeId || job.status === "COMPLETED" || job.status === "CANCELLED") {
        continue;
      }
      if (job.snackBoxIds.has(boxId)) {
        activeJob = job;
        break;
      }
      if (job.status === "BUDGET_BLOCKED") {
        blockedJob = job;
      }
      // For equal timestamps, Map iteration order favors the first stored job.
      if (
        collectingStatuses.has(job.status) &&
        (!oldestCollectingJob ||
          job.createdAt.getTime() < oldestCollectingJob.createdAt.getTime())
      ) {
        oldestCollectingJob = job;
      }
    }

    let job = activeJob;
    // Keep the reservation, box membership, and report writes synchronous.
    if (!job) {
      const candidate = oldestCollectingJob ?? this.createJob(box, "OPEN", asOf);
      job = this.budget.tryReserveForBox(candidate, box, month)
        ? candidate
        : blockedJob ?? this.createJob(box, "BUDGET_BLOCKED", asOf);
      job.snackBoxIds.add(boxId);
      this.store.refillJobs.set(job.id, job);
    }
    const report: EmptyBoxReport = {
      id: randomUUID(),
      snackBoxId: boxId,
      refillJobId: job.id,
      reportedAt: new Date(asOf),
    };
    this.store.emptyBoxReports.set(report.id, report);

    if (!activeJob && this.chat) {
      const recipientId = job.status === "OFFERED" ? job.offeredVolunteerId
        : job.status === "ASSIGNED" ? job.assignedVolunteerId
          : undefined;
      if (recipientId !== undefined) {
        this.chat.send({
          type: "JOB_BOXES_UPDATED",
          recipientId,
          jobId: job.id,
          message: `The latest box list for your refill is ${[...job.snackBoxIds].join(", ")}.`,
        });
      }
    }
    return job;
  }

  private createJob(box: SnackBox, status: "OPEN" | "BUDGET_BLOCKED", asOf: Date): RefillJob {
    return {
      id: randomUUID(),
      officeId: box.officeId,
      snackBoxIds: new Set(),
      status,
      createdAt: new Date(asOf),
    };
  }
}
