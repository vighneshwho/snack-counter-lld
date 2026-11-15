export type Currency = "NOK" | "INR";

export interface Office {
  id: string;
  name: string;
  currency: Currency;
  /** Budget amount in major units of the office's currency. */
  monthlyBudget: number;
}

export type Attendance =
  | { status: "ON_SITE"; officeId: Office["id"] }
  | { status: "REMOTE" | "HOLIDAY" };

export interface Employee {
  id: string;
  name: string;
  homeOfficeId: Office["id"];
  isVolunteer: boolean;
  attendance?: Attendance;
}

export interface SnackBox {
  id: string;
  officeId: Office["id"];
  snackType: string;
}

export interface EmptyBoxReport {
  id: string;
  snackBoxId: SnackBox["id"];
  refillJobId: RefillJob["id"];
  reportedAt: Date;
}

export type RefillJobStatus =
  | "OPEN"
  | "OFFERED"
  | "ASSIGNED"
  | "IN_PROGRESS"
  | "COMPLETED";

export interface RefillJob {
  id: string;
  officeId: Office["id"];
  snackBoxIds: Set<SnackBox["id"]>;
  status: RefillJobStatus;
  createdAt: Date;
  /** Kept on completed jobs for volunteer selection history. */
  assignedVolunteerId?: Employee["id"];
  completedAt?: Date;
  /** Volunteers who declined or timed out during the current assignment cycle. */
  excludedVolunteerIds?: Set<Employee["id"]>;
}
