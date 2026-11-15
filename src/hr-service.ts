import type { Currency, Employee } from "./domain.ts";

export interface HRClaimPayload {
  employeeId: Employee["id"];
  amountMinor: number;
  currency: Currency;
  description: string;
  /** The stored reference to the receipt image. The mock captures it as provided. */
  receiptImage: string;
}

export interface HRService {
  submitClaim(payload: HRClaimPayload): Promise<string>;
}

/** Use this error only when HR confirms that no claim was created. */
export class HRClaimRejectedError extends Error {}

export class MockHRService implements HRService {
  readonly claims = new Map<string, HRClaimPayload>();
  private nextClaimId = 1;

  async submitClaim(payload: HRClaimPayload): Promise<string> {
    const claimId = `HR-${this.nextClaimId++}`;
    this.claims.set(claimId, { ...payload });
    return claimId;
  }
}
