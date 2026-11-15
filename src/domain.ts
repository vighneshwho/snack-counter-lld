export type Currency = "NOK" | "INR";

export interface Office {
  id: string;
  name: string;
  currency: Currency;
  /** Budget amount in major units of the office's currency. */
  monthlyBudget: number;
}

export interface Employee {
  id: string;
  name: string;
  homeOfficeId: Office["id"];
  isVolunteer: boolean;
}

export interface SnackBox {
  id: string;
  officeId: Office["id"];
  snackType: string;
}

export interface EmptyBoxReport {
  id: string;
  snackBoxId: SnackBox["id"];
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
}
