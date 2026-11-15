import { AssignmentService } from "./assignment-service.ts";
import { accountingMonth, BudgetService } from "./budget-service.ts";
import { MockChatService } from "./chat-service.ts";
import type { Attendance, Employee, Office, RefillJob, SnackBox } from "./domain.ts";
import { MockHRService } from "./hr-service.ts";
import { RefillService } from "./refill-service.ts";
import { ReimbursementService } from "./reimbursement-service.ts";
import { InMemoryStore } from "./store.ts";
import { VolunteerSelectionService } from "./volunteer-selection-service.ts";

const store = new InMemoryStore();
const offices: Office[] = [
  { id: "oslo", name: "Oslo", currency: "NOK", monthlyBudget: 6_000 },
  { id: "bengaluru", name: "Bengaluru", currency: "INR", monthlyBudget: 15_000 },
];
const boxes: SnackBox[] = [
  { id: "oslo-biscuits", officeId: "oslo", snackType: "Biscuits", estimatedCostMinor: 35_000 },
  { id: "oslo-chocolate", officeId: "oslo", snackType: "Chocolate", estimatedCostMinor: 42_000 },
  { id: "oslo-nuts", officeId: "oslo", snackType: "Mixed nuts", estimatedCostMinor: 39_000 },
  { id: "oslo-crisps", officeId: "oslo", snackType: "Crisps", estimatedCostMinor: 32_000 },
  { id: "bengaluru-biscuits", officeId: "bengaluru", snackType: "Biscuits", estimatedCostMinor: 300_000 },
  { id: "bengaluru-namkeen", officeId: "bengaluru", snackType: "Namkeen", estimatedCostMinor: 750_000 },
  { id: "bengaluru-chikki", officeId: "bengaluru", snackType: "Chikki", estimatedCostMinor: 500_000 },
  { id: "bengaluru-makhana", officeId: "bengaluru", snackType: "Makhana", estimatedCostMinor: 500_000 },
];
const osloVolunteerNames = [
  "Ingrid Solberg", "Marius Dahl", "Sigrid Hansen", "Jonas Berg", "Nora Larsen",
  "Erik Nilsen", "Astrid Moen", "Henrik Lund", "Liv Johansen", "Anders Strand",
  "Thea Bakke", "Kari Holm", "Emil Aas", "Sofie Vik", "Magnus Lie",
];
const bengaluruVolunteerNames = [
  "Ananya Rao", "Kiran Hegde", "Divya Shetty", "Rahul Bhat", "Meera Iyer",
  "Vikram Gowda", "Priya Menon", "Arjun Kulkarni", "Neha Joshi", "Aditya Pai",
  "Shruti Kamath", "Nikhil Prasad", "Kavya Reddy", "Rohit Narayan", "Sneha Kumar",
  "Varun Desai", "Lakshmi Murthy", "Sanjay Nayak", "Pooja Suresh", "Aditi Krishnan",
];
const nonVolunteers: Employee[] = [
  {
    id: "oslo-ida",
    name: "Ida Kristiansen",
    homeOfficeId: "oslo",
    isVolunteer: false,
    attendance: { status: "ON_SITE", officeId: "oslo" },
  },
  {
    id: "bengaluru-ravi",
    name: "Ravi Shenoy",
    homeOfficeId: "bengaluru",
    isVolunteer: false,
    attendance: { status: "ON_SITE", officeId: "bengaluru" },
  },
  {
    id: "bengaluru-sahana",
    name: "Sahana Nayak",
    homeOfficeId: "bengaluru",
    isVolunteer: false,
    attendance: { status: "REMOTE" },
  },
];

for (const office of offices) {
  store.offices.set(office.id, office);
}
for (const box of boxes) {
  store.snackBoxes.set(box.id, box);
}

function addVolunteers(
  names: string[],
  homeOfficeId: Office["id"],
  visitingOfficeId: Office["id"],
) {
  const onSite: Attendance = { status: "ON_SITE", officeId: homeOfficeId };
  const remote: Attendance = { status: "REMOTE" };
  const attendancePattern: Attendance[] = [
    onSite, remote, onSite, remote, onSite, remote, { status: "HOLIDAY" }, remote, onSite, remote,
  ];

  for (const [index, name] of names.entries()) {
    const id = `${homeOfficeId}-volunteer-${String(index + 1).padStart(2, "0")}`;
    store.employees.set(id, {
      id,
      name,
      homeOfficeId,
      isVolunteer: true,
      attendance: index === 1
        ? { status: "ON_SITE", officeId: visitingOfficeId }
        : { ...attendancePattern[index % attendancePattern.length] },
    });
  }
}

addVolunteers(osloVolunteerNames, "oslo", "bengaluru");
addVolunteers(bengaluruVolunteerNames, "bengaluru", "oslo");
for (const employee of nonVolunteers) {
  store.employees.set(employee.id, employee);
}

const budget = new BudgetService(store);
const chat = new MockChatService();
const hr = new MockHRService();
const service = new RefillService(store, budget, chat);
const volunteerSelection = new VolunteerSelectionService(store);
const assignments = new AssignmentService(store, budget, chat);
const reimbursements = new ReimbursementService(store, hr, chat);
const budgetDate = new Date();
const month = accountingMonth(budgetDate);

function currentOfferRecipient(job: RefillJob): Employee {
  const volunteer = job.offeredVolunteerId === undefined
    ? undefined
    : store.employees.get(job.offeredVolunteerId);
  if (!volunteer) {
    throw new Error(`Expected an offer for demo job ${job.id}`);
  }
  return volunteer;
}

function printSnapshot(message: string) {
  console.log(`\n${message}`);
  console.log("Refill jobs");
  console.table([...store.refillJobs.values()].map((job) => ({
    jobId: job.id,
    office: job.officeId,
    status: job.status,
    boxes: [...job.snackBoxIds].join(", "),
  })));
  console.log(`Recorded reports (${store.emptyBoxReports.size})`);
  console.table([...store.emptyBoxReports.values()].map((report) => ({
    box: report.snackBoxId,
    jobId: report.refillJobId,
  })));
}

function printBudget(officeId: Office["id"], accountingPeriod = month) {
  const balance = budget.getBalance(officeId, accountingPeriod);
  const money = (amount: number) => `${balance.currency} ${(amount / 100).toFixed(2)}`;
  console.log(`${officeId} budget for ${accountingPeriod}`);
  console.table([{
    budget: money(balance.budgetMinor),
    reserved: money(balance.reservedMinor),
    spent: money(balance.spentMinor),
    remaining: money(balance.availableMinor),
  }]);
}

function printExpense(jobId: RefillJob["id"]) {
  const expense = store.purchaseExpenses.get(jobId);
  if (!expense) {
    throw new Error(`Expected a recorded expense for demo job ${jobId}`);
  }
  console.table([{
    amount: `${expense.currency} ${(expense.amountMinor / 100).toFixed(2)}`,
    receipt: expense.receiptReference,
    purchasedOn: expense.purchaseDate.toISOString().slice(0, 10),
    overrun: expense.overrun,
  }]);
}

console.log("Snack counter demo");
console.log("Snack boxes");
console.table(boxes);

const osloJob = service.reportEmpty("oslo-biscuits", budgetDate);
printSnapshot("1. A report for Oslo's biscuits box creates an OPEN job.");
printBudget(osloJob.officeId);

service.reportEmpty("oslo-biscuits", budgetDate);
printSnapshot("2. The report is repeated. The job still lists the biscuits box once.");

assignments.offerJob(osloJob.id);
const firstRecipient = currentOfferRecipient(osloJob);
service.reportEmpty("oslo-chocolate", budgetDate);
printSnapshot(`3. ${firstRecipient.name} receives the offer. The chocolate box joins the same job.`);

assignments.declineOffer(osloJob.id, firstRecipient.id);
const nextRecipient = currentOfferRecipient(osloJob);
assignments.acceptOffer(osloJob.id, nextRecipient.id);
console.log(`\n4. ${firstRecipient.name} declines. ${nextRecipient.name} accepts the same job.`);

nextRecipient.attendance = { status: "REMOTE" };
assignments.reassignJob(osloJob.id);
const shopper = currentOfferRecipient(osloJob);
assignments.acceptOffer(osloJob.id, shopper.id);
service.reportEmpty("oslo-nuts", budgetDate);
console.log(`\n5. ${nextRecipient.name} becomes unavailable before shopping. ${shopper.name} accepts the replacement offer.`);
const assignedJob = assignments.getJob(osloJob.id);
console.log("Latest box list before starting:", [...assignedJob.snackBoxIds].join(", "));

const purchase = assignments.startPurchase(osloJob.id, shopper.id, budgetDate);
console.log(`\n6. ${shopper.name} starts purchasing. Job ${purchase.id} is ${purchase.status}.`);
console.log("Locked shopping list");
console.table(boxes.filter((box) => purchase.snackBoxIds.has(box.id)).map((box) => ({
  boxId: box.id,
  snack: box.snackType,
})));
service.reportEmpty("oslo-crisps", budgetDate);
printSnapshot("7. The crisps box empties during purchasing and gets a new OPEN job.");

const bengaluruJob = service.reportEmpty("bengaluru-biscuits", budgetDate);
printSnapshot("8. A report for Bengaluru's biscuits box creates a job for Bengaluru.");

assignments.completeJob(osloJob.id, shopper.id, {
  amountMinor: 117_250,
  currency: "NOK",
  receiptReference: "demo-receipts/oslo-supermarket.jpg",
  purchaseDate: budgetDate,
});
service.reportEmpty("oslo-biscuits", budgetDate);
printSnapshot(`9. ${shopper.name} completes the refill. A later biscuits report joins Oslo's open job.`);
console.log("Recorded receipt details");
printExpense(osloJob.id);
printBudget(osloJob.officeId);
console.log("Assignment history for the completed job");
console.table(osloJob.assignmentHistory?.map((event) => ({
  event: event.type,
  volunteer: store.employees.get(event.volunteerId)?.name,
  occurredAt: event.occurredAt.toISOString(),
})));

const asOf = new Date("2026-11-15T09:00:00Z");
console.log("\n10. Compare volunteers for the Bengaluru job.");
console.log(
  `Roster includes ${osloVolunteerNames.length} Oslo volunteers, ` +
  `${bengaluruVolunteerNames.length} Bengaluru volunteers, and ${nonVolunteers.length} non-volunteers.`,
);
console.table([...store.employees.values()].map((employee) => ({
  name: employee.name,
  volunteer: employee.isVolunteer,
  homeOffice: employee.homeOfficeId,
  attendance: employee.attendance?.status,
  currentOffice: employee.attendance?.status === "ON_SITE" ? employee.attendance.officeId : "",
})));
const firstChoice = volunteerSelection.selectVolunteer(bengaluruJob, asOf);
console.log("The Bengaluru candidates have equal refill history. Employee ID breaks the tie.");
console.log("Selected volunteer:", firstChoice?.name ?? "None");

const bengaluruOnSiteVolunteers = [...store.employees.values()].filter((employee) =>
  employee.isVolunteer &&
  employee.attendance?.status === "ON_SITE" &&
  employee.attendance.officeId === bengaluruJob.officeId,
);

console.log("\n11. Add one recent completion for each on-site Bengaluru volunteer based in Bengaluru.");
for (const volunteer of bengaluruOnSiteVolunteers) {
  if (volunteer.homeOfficeId === bengaluruJob.officeId) {
    const completedRefill: RefillJob = {
      id: `demo-completed-${volunteer.id}`,
      officeId: bengaluruJob.officeId,
      snackBoxIds: new Set(["bengaluru-biscuits"]),
      status: "COMPLETED",
      assignedVolunteerId: volunteer.id,
      createdAt: new Date("2026-11-03T09:00:00Z"),
      completedAt: new Date("2026-11-03T10:00:00Z"),
    };
    store.refillJobs.set(completedRefill.id, completedRefill);
  }
}
const afterHistory = volunteerSelection.selectVolunteer(bengaluruJob, asOf);
console.log("Selected volunteer:", afterHistory?.name ?? "None");
console.log("The visitor from Oslo has the lightest recent refill workload.");

console.log("\n12. Simulate cycle exclusions for every on-site volunteer in Bengaluru.");
bengaluruJob.excludedVolunteerIds = new Set(bengaluruOnSiteVolunteers.map((employee) => employee.id));
const afterExclusions = assignments.offerJob(bengaluruJob.id);
console.log("Bengaluru job status:", afterExclusions.status);
console.log("Needs attention:", afterExclusions.needsAttention);

console.log("\n13. Namkeen fits the Bengaluru reservation. Chikki and makhana join one blocked job.");
service.reportEmpty("bengaluru-namkeen", budgetDate);
const blockedJob = service.reportEmpty("bengaluru-chikki", budgetDate);
service.reportEmpty("bengaluru-makhana", budgetDate);
console.log("Job status:", blockedJob.status, "Boxes:", [...blockedJob.snackBoxIds].join(", "));
printBudget(bengaluruJob.officeId);

console.log("\n14. Cancelling the original Bengaluru job frees enough budget for both blocked boxes.");
assignments.cancelJob(bengaluruJob.id, budgetDate);
console.log("Previously blocked job status:", blockedJob.status);
printBudget(blockedJob.officeId);

assignments.offerJob(blockedJob.id);
const bengaluruShopper = currentOfferRecipient(blockedJob);
assignments.acceptOffer(blockedJob.id, bengaluruShopper.id);
assignments.startPurchase(blockedJob.id, bengaluruShopper.id, budgetDate);
assignments.completeJob(blockedJob.id, bengaluruShopper.id, {
  amountMinor: 974_550,
  currency: "INR",
  receiptReference: "demo-receipts/bengaluru-wholesale.jpg",
  purchaseDate: budgetDate,
});
console.log(`\n15. ${bengaluruShopper.name} submits the receipt. The actual expense replaces the reservation.`);
printExpense(blockedJob.id);
printBudget(blockedJob.officeId);

const nextMonth = new Date(budgetDate);
nextMonth.setUTCDate(1);
nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
console.log("\n16. The next month opens with its full budget. This month's expense stays on record.");
printBudget(blockedJob.officeId, accountingMonth(nextMonth));
printBudget(blockedJob.officeId);

console.log("\n17. Submit the completed Oslo and Bengaluru refills to mock HR.");
const claims = await Promise.all([
  reimbursements.submitClaim(osloJob.id),
  reimbursements.submitClaim(blockedJob.id),
]);
console.table(claims);

console.log("Mock chat outbox");
for (const notification of chat.notifications) {
  const recipient = store.employees.get(notification.recipientId)?.name ?? notification.recipientId;
  console.log(`[${notification.type}] ${recipient} — ${notification.message}`);
}
