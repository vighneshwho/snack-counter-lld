# Snack Counter Automation

A small TypeScript implementation of the snack refill workflow for Oslo and Bengaluru. It runs in memory with mock chat and HR services. The goal is to demonstrate the business rules and their edge cases, not build a deployable product.

## Run

Requires Node.js 24 and npm.

```bash
npm install
npm run demo
npm test
npm run typecheck
```

The demo uses 15 Oslo volunteers, 20 Bengaluru volunteers and a few non-volunteers. The tests use smaller datasets.

## Design

**Reporting and grouping.** I assumed that each snack type has an identifiable box. `reportEmpty(boxId)` simulates an event from a machine or internal reporting tool; the input hardware/UI is outside this exercise. Every event is recorded, but repeated reports for a box already awaiting refill don't create another shopping requirement. Reports are grouped into a refill job for the same office, so one volunteer can restock several boxes in one trip. A job keeps accepting boxes while `OPEN`, `OFFERED` or `ASSIGNED`. Its contents are locked at `IN_PROGRESS`, when the volunteer actually starts shopping.

**Assignment.** Jobs move through `OPEN → OFFERED → ASSIGNED → IN_PROGRESS → COMPLETED`, with `BUDGET_BLOCKED` and `CANCELLED` as additional cases. Only the current offer recipient can accept, and a volunteer cannot hold two active assignments. Declining an offer passes the same job to another eligible volunteer. Selection uses the latest attendance status, allowing cross-office visitors but excluding people working remotely or on holiday. To spread the work, it prefers fewer completed refills in the past 30 days, then whoever last refilled longest ago; employee ID breaks ties. Assignment history records offers, acceptances, declines and reassignments.

I chose **manual reassignment** when an offer goes unanswered or an assigned volunteer can no longer help. It keeps the implementation simple and avoids automatically sending a second person shopping while the first may have started. The trade-off is that a forgotten job needs someone to intervene. Jobs already `IN_PROGRESS` cannot be reassigned automatically.

**Budget and completion.** Oslo's monthly budget is 6,000 NOK and Bengaluru's is 15,000 INR. Each box has an estimated refill cost. When it joins a job, `BudgetService` reserves that estimate and updates the reservation as boxes are added. If the office cannot cover it, the job is blocked. Before shopping starts, a reservation crossing into a new month is rechecked against the new month's budget. On completion, the volunteer supplies the actual amount, currency, date and receipt reference. The reservation is replaced by actual spending, and any overrun is retained and flagged. Money uses integer minor units. A visiting volunteer's expense belongs to the office being restocked, not their home office.

**HR and notifications.** Completion records the expense independently of reimbursement. `ReimbursementService` submits the employee ID, amount, currency, description and receipt reference to `MockHRService`; it saves the claim ID or submission failure. Calls for the same job reuse an existing successful result or share an in-flight request. Definite failures can be retried; uncertain ones need manual reconciliation. HR handles approval (typically 1–10 days), payroll-currency conversion and payment. The given API cannot tell us when somebody has actually been paid. `MockChatService` simply records the notifications that would go to employees.

**Reporting.** `ReportingService` shows each office's monthly actual spending, budget, unspent amount and completed jobs. It also calculates a consolidated total using a supplied exchange rate rather than adding NOK and INR directly. Refill counts by snack type and optional purchased quantities give rough consumption insights, not an exact count of snacks eaten. Reported *unspent* budget excludes purchases; funds available for new jobs must also subtract active reservations.

## Implementation choices and limits

`InMemoryStore` holds offices, employees, boxes, empty-box reports, jobs and assignment history, reservations, expenses and reimbursement records. `RefillService`, `VolunteerSelectionService`, `AssignmentService`, `BudgetService`, `ReimbursementService` and `ReportingService` each own their corresponding rules. The demo calls them directly, without an API or frontend.

I deliberately left out a database, real chat/HR integrations, a reporting UI, automatic expiry, attendance/calendar sync, physical sensors, receipt OCR, automatic ordering and reimbursement tracking beyond submission. These would add infrastructure without improving the core exercise. In production I'd use durable storage, database transactions and constraints for cross-instance concurrency, authenticated access, secure receipt storage, reminders and escalation for abandoned jobs, and an HR reconciliation mechanism. Accounting months use UTC `YYYY-MM` rather than office-local timezones as a further simplification.
