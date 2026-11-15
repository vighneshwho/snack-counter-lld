import type {
  Employee,
  EmptyBoxReport,
  Office,
  RefillJob,
  SnackBox,
} from "./domain.ts";

export class InMemoryStore {
  readonly offices = new Map<Office["id"], Office>();
  readonly employees = new Map<Employee["id"], Employee>();
  readonly snackBoxes = new Map<SnackBox["id"], SnackBox>();
  readonly emptyBoxReports = new Map<EmptyBoxReport["id"], EmptyBoxReport>();
  readonly refillJobs = new Map<RefillJob["id"], RefillJob>();
}
