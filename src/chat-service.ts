import type { Employee, RefillJob } from "./domain.ts";

export interface ChatNotification {
  type:
    | "JOB_OFFERED"
    | "JOB_ACCEPTED"
    | "JOB_DECLINED"
    | "JOB_REASSIGNED"
    | "JOB_BOXES_UPDATED"
    | "JOB_COMPLETED"
    | "HR_CLAIM_SUBMITTED"
    | "HR_CLAIM_FAILED";
  jobId: RefillJob["id"];
  recipientId: Employee["id"];
  message: string;
}

export interface ChatService {
  send(notification: ChatNotification): void;
}

export class MockChatService implements ChatService {
  readonly notifications: ChatNotification[] = [];

  send(notification: ChatNotification): void {
    this.notifications.push({ ...notification });
  }
}
