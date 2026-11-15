import { describe, expect, it } from "vitest";
import type { Employee, RefillJob } from "../src/domain.ts";
import { InMemoryStore } from "../src/store.ts";
import { VolunteerSelectionService } from "../src/volunteer-selection-service.ts";

const asOf = new Date("2026-11-15T12:00:00Z");

function employee(id: string, overrides: Partial<Employee> = {}): Employee {
  return {
    id,
    name: id,
    homeOfficeId: "oslo",
    isVolunteer: true,
    attendance: { status: "ON_SITE", officeId: "oslo" },
    ...overrides,
  };
}

function job(id: string, overrides: Partial<RefillJob> = {}): RefillJob {
  return {
    id,
    officeId: "oslo",
    snackBoxIds: new Set(),
    status: "OPEN",
    createdAt: new Date("2026-09-01T09:00:00Z"),
    ...overrides,
  };
}

function completedJob(id: string, volunteer: Employee, completedAt: string): RefillJob {
  return job(id, {
    status: "COMPLETED",
    assignedVolunteerId: volunteer.id,
    completedAt: new Date(completedAt),
  });
}

function setup(employees: Employee[], history: RefillJob[] = []) {
  const store = new InMemoryStore();
  for (const employee of employees) {
    store.employees.set(employee.id, employee);
  }
  for (const refill of history) {
    store.refillJobs.set(refill.id, refill);
  }
  const targetJob = job("target");
  store.refillJobs.set(targetJob.id, targetJob);
  const service = new VolunteerSelectionService(store);
  return { store, targetJob, service };
}

describe("VolunteerSelectionService.selectVolunteer", () => {
  it("selects only registered volunteers on-site at the job's office", () => {
    const onSite = employee("z-on-site");
    const { service, store, targetJob } = setup([
      employee("a-non-volunteer", { isVolunteer: false }),
      employee("b-remote", { attendance: { status: "REMOTE" } }),
      employee("c-holiday", { attendance: { status: "HOLIDAY" } }),
      employee("d-away", { attendance: { status: "ON_SITE", officeId: "bengaluru" } }),
      employee("e-unknown", { attendance: undefined }),
      onSite,
    ]);
    const before = structuredClone(store.refillJobs);

    expect(service.selectVolunteer(targetJob, asOf)).toBe(onSite);
    expect(store.refillJobs).toEqual(before);
  });

  it("uses updated attendance to make a visitor eligible at the visited office", () => {
    const visitor = employee("visitor", {
      homeOfficeId: "bengaluru",
      attendance: { status: "REMOTE" },
    });
    const { service, targetJob } = setup([visitor]);

    expect(service.selectVolunteer(targetJob, asOf)).toBeUndefined();
    visitor.attendance = { status: "ON_SITE", officeId: "oslo" };
    expect(service.selectVolunteer(targetJob, asOf)).toBe(visitor);
  });

  it("excludes ASSIGNED and IN_PROGRESS volunteers across offices", () => {
    const assigned = employee("a-assigned");
    const purchasing = employee("b-purchasing");
    const offered = employee("c-offered");
    const { service, targetJob } = setup(
      [assigned, purchasing, offered],
      [
        job("assigned-elsewhere", {
          officeId: "bengaluru",
          status: "ASSIGNED",
          assignedVolunteerId: assigned.id,
        }),
        job("purchasing", { status: "IN_PROGRESS", assignedVolunteerId: purchasing.id }),
        job("offered", { status: "OFFERED", assignedVolunteerId: offered.id }),
      ],
    );

    expect(service.selectVolunteer(targetJob, asOf)).toBe(offered);
  });

  it("prioritizes fewer recent completions even when that volunteer finished more recently", () => {
    const lighterLoad = employee("z-lighter-load");
    const heavierLoad = employee("a-heavier-load");
    const { service, targetJob } = setup(
      [lighterLoad, heavierLoad],
      [
        completedJob("yesterday", lighterLoad, "2026-11-14T09:00:00Z"),
        completedJob("last-week", heavierLoad, "2026-11-08T09:00:00Z"),
        {
          ...completedJob("at-cutoff", heavierLoad, "2026-10-16T12:00:00Z"),
          officeId: "bengaluru",
        },
      ],
    );

    expect(service.selectVolunteer(targetJob, asOf)).toBe(lighterLoad);
  });

  it("uses the oldest last completion when recent counts tie", () => {
    const moreRecent = employee("a-more-recent");
    const longerWait = employee("z-longer-wait");
    const { service, targetJob } = setup(
      [moreRecent, longerWait],
      [
        completedJob("yesterday", moreRecent, "2026-11-14T09:00:00Z"),
        completedJob("three-weeks-ago", longerWait, "2026-10-25T09:00:00Z"),
      ],
    );

    expect(service.selectVolunteer(targetJob, asOf)).toBe(longerWait);
  });

  it("uses all-time history for recency and gives priority to a first-time volunteer", () => {
    const newer = employee("a-newer");
    const older = employee("b-older");
    const firstTimer = employee("z-first-timer", { attendance: { status: "REMOTE" } });
    const { service, targetJob } = setup(
      [newer, older, firstTimer],
      [
        completedJob("september-15", newer, "2026-09-15T09:00:00Z"),
        completedJob("october-2", newer, "2026-10-02T09:00:00Z"),
        completedJob("september-20", older, "2026-09-20T09:00:00Z"),
        completedJob("september-25", older, "2026-09-25T09:00:00Z"),
        completedJob("september-30", older, "2026-09-30T09:00:00Z"),
        completedJob("future", firstTimer, "2026-11-16T09:00:00Z"),
      ],
    );

    expect(service.selectVolunteer(targetJob, asOf)).toBe(older);
    firstTimer.attendance = { status: "ON_SITE", officeId: "oslo" };
    expect(service.selectVolunteer(targetJob, asOf)).toBe(firstTimer);
  });

  it("uses employee ID in ascending order for a final tie", () => {
    const second = employee("b");
    const first = employee("a");
    const { service, targetJob } = setup([second, first]);

    expect(service.selectVolunteer(targetJob, asOf)).toBe(first);
  });

  it("skips volunteers who declined or timed out only for that job's assignment cycle", () => {
    const declined = employee("a-declined");
    const timedOut = employee("b-timed-out");
    const eligible = employee("c-eligible");
    const { service, targetJob } = setup([declined, timedOut, eligible]);
    targetJob.excludedVolunteerIds = new Set([declined.id, timedOut.id]);

    expect(service.selectVolunteer(targetJob, asOf)).toBe(eligible);
    expect(service.selectVolunteer(job("different-job"), asOf)).toBe(declined);
  });

  it("returns undefined without changing the job when no volunteer qualifies", () => {
    const excluded = employee("excluded");
    const { service, store, targetJob } = setup([excluded]);
    targetJob.excludedVolunteerIds = new Set([excluded.id]);
    const before = structuredClone(store.refillJobs);

    expect(service.selectVolunteer(targetJob, asOf)).toBeUndefined();
    expect(store.refillJobs).toEqual(before);
  });
});
