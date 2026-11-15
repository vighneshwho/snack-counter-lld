import { randomUUID } from "node:crypto";
import type { EmptyBoxReport, RefillJob, RefillJobStatus, SnackBox } from "./domain.ts";
import type { InMemoryStore } from "./store.ts";

const collectingStatuses = new Set<RefillJobStatus>(["OPEN", "OFFERED", "ASSIGNED"]);

export class RefillService {
  private readonly store: InMemoryStore;

  constructor(store: InMemoryStore) {
    this.store = store;
  }

  reportEmpty(boxId: SnackBox["id"]): RefillJob {
    const box = this.store.snackBoxes.get(boxId);
    if (!box) {
      throw new Error(`Unknown snack box: ${boxId}`);
    }
    if (!this.store.offices.has(box.officeId)) {
      throw new Error(`Unknown office for snack box ${boxId}: ${box.officeId}`);
    }

    let activeJob: RefillJob | undefined;
    let oldestCollectingJob: RefillJob | undefined;

    for (const job of this.store.refillJobs.values()) {
      if (job.officeId !== box.officeId || job.status === "COMPLETED") {
        continue;
      }
      if (job.snackBoxIds.has(boxId)) {
        activeJob = job;
        break;
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

    const timestamp = Date.now();
    const job: RefillJob = activeJob ?? oldestCollectingJob ?? {
      id: randomUUID(),
      officeId: box.officeId,
      snackBoxIds: new Set(),
      status: "OPEN",
      createdAt: new Date(timestamp),
    };
    const report: EmptyBoxReport = {
      id: randomUUID(),
      snackBoxId: boxId,
      refillJobId: job.id,
      reportedAt: new Date(timestamp),
    };

    // Keep lookup and writes synchronous so another report cannot interleave.
    if (!activeJob) {
      job.snackBoxIds.add(boxId);
      this.store.refillJobs.set(job.id, job);
    }
    this.store.emptyBoxReports.set(report.id, report);
    return job;
  }
}
