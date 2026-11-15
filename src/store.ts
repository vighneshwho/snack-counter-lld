import type {
  BudgetEntry,
  Employee,
  EmptyBoxReport,
  Office,
  PurchaseExpense,
  RefillJob,
  ReimbursementRecord,
  SnackBox,
} from "./domain.ts";

export class InMemoryStore {
  readonly offices = new Map<Office["id"], Office>();
  readonly employees = new Map<Employee["id"], Employee>();
  readonly snackBoxes = new Map<SnackBox["id"], SnackBox>();
  readonly emptyBoxReports = new Map<EmptyBoxReport["id"], EmptyBoxReport>();
  readonly refillJobs = new Map<RefillJob["id"], RefillJob>();
  readonly budgetReservations = new Map<RefillJob["id"], BudgetEntry>();
  readonly purchaseExpenses = new Map<RefillJob["id"], PurchaseExpense>();
  readonly latestBudgetMonths = new Map<Office["id"], string>();
  readonly reimbursements = new Map<RefillJob["id"], ReimbursementRecord>();
  /** Shared by reimbursement services using this store and cleared when a request settles. */
  readonly ongoingClaimSubmissions = new Map<RefillJob["id"], Promise<ReimbursementRecord>>();
}
