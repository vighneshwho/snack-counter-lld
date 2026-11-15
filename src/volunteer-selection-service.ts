import { isActiveAssignment, type Employee, type RefillJob } from "./domain.ts";
import type { InMemoryStore } from "./store.ts";

const recentRefillWindowMs = 30 * 24 * 60 * 60 * 1000;

interface VolunteerHistory {
  recentRefills: number;
  lastCompletedAt: number;
}

export class VolunteerSelectionService {
  private readonly store: InMemoryStore;

  constructor(store: InMemoryStore) {
    this.store = store;
  }

  /**
   * Finds the best eligible volunteer without updating the job.
   * Supply asOf to evaluate refill history against a fixed date.
   */
  selectVolunteer(job: RefillJob, asOf: Date = new Date()): Employee | undefined {
    const busyVolunteers = new Set<Employee["id"]>();
    const historyByVolunteer = new Map<Employee["id"], VolunteerHistory>();
    const end = asOf.getTime();
    const cutoff = end - recentRefillWindowMs;

    // Scan jobs across both offices so workload and active assignments follow the volunteer.
    for (const refill of this.store.refillJobs.values()) {
      const volunteerId = refill.assignedVolunteerId;
      if (volunteerId === undefined) {
        continue;
      }
      if (isActiveAssignment(refill.status)) {
        busyVolunteers.add(volunteerId);
      }
      if (refill.status === "COMPLETED" && refill.completedAt) {
        const completedAt = refill.completedAt.getTime();
        if (completedAt <= end) {
          const history = historyByVolunteer.get(volunteerId) ?? {
            recentRefills: 0,
            lastCompletedAt: -Infinity,
          };
          // Count completions in the last 30 days. Keep the latest date from all past completions.
          if (completedAt >= cutoff) {
            history.recentRefills += 1;
          }
          history.lastCompletedAt = Math.max(history.lastCompletedAt, completedAt);
          historyByVolunteer.set(volunteerId, history);
        }
      }
    }

    // Current attendance lets visitors qualify. Cycle exclusions apply only to this job.
    const candidates = [...this.store.employees.values()]
      .filter((employee) =>
        employee.isVolunteer &&
        employee.attendance?.status === "ON_SITE" &&
        employee.attendance.officeId === job.officeId &&
        !busyVolunteers.has(employee.id) &&
        !job.excludedVolunteerIds?.has(employee.id),
      )
      .map((employee) => {
        const history = historyByVolunteer.get(employee.id);
        // A first-time volunteer has zero recent refills and sorts before any completion date.
        return {
          employee,
          recentRefills: history?.recentRefills ?? 0,
          lastCompletedAt: history?.lastCompletedAt ?? -Infinity,
        };
      });

    // Compare recent workload, then who has waited longest, then employee ID.
    candidates.sort((a, b) => {
      if (a.recentRefills !== b.recentRefills) {
        return a.recentRefills - b.recentRefills;
      }
      if (a.lastCompletedAt !== b.lastCompletedAt) {
        return a.lastCompletedAt - b.lastCompletedAt;
      }
      if (a.employee.id === b.employee.id) {
        return 0;
      }
      return a.employee.id < b.employee.id ? -1 : 1;
    });

    return candidates[0]?.employee;
  }
}
