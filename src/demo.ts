import type { Office, SnackBox } from "./domain.ts";
import { RefillService } from "./refill-service.ts";
import { InMemoryStore } from "./store.ts";

const store = new InMemoryStore();
const offices: Office[] = [
  { id: "oslo", name: "Oslo", currency: "NOK", monthlyBudget: 6_000 },
  { id: "bengaluru", name: "Bengaluru", currency: "INR", monthlyBudget: 15_000 },
];
const boxes: SnackBox[] = [
  { id: "oslo-biscuits", officeId: "oslo", snackType: "Biscuits" },
  { id: "oslo-chocolate", officeId: "oslo", snackType: "Chocolate" },
  { id: "oslo-crisps", officeId: "oslo", snackType: "Crisps" },
  { id: "bengaluru-biscuits", officeId: "bengaluru", snackType: "Biscuits" },
];

for (const office of offices) {
  store.offices.set(office.id, office);
}
for (const box of boxes) {
  store.snackBoxes.set(box.id, box);
}
const service = new RefillService(store);

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

console.log("Snack counter demo");
console.log("Job status changes are simulated directly in this demo.");
console.log("Snack boxes");
console.table(boxes);

const osloJob = service.reportEmpty("oslo-biscuits");
printSnapshot("1. A report for Oslo's biscuits box creates an OPEN job.");

service.reportEmpty("oslo-biscuits");
printSnapshot("2. The report is repeated. The job still lists the biscuits box once.");

osloJob.status = "OFFERED";
service.reportEmpty("oslo-chocolate");
printSnapshot("3. After the job is marked OFFERED, the chocolate box joins it.");

osloJob.status = "IN_PROGRESS";
service.reportEmpty("oslo-crisps");
printSnapshot("4. Purchasing starts and locks the first job. The crisps box gets a new OPEN job.");

service.reportEmpty("bengaluru-biscuits");
printSnapshot("5. A report for Bengaluru's biscuits box creates a job for Bengaluru.");

osloJob.status = "COMPLETED";
service.reportEmpty("oslo-biscuits");
printSnapshot("6. After the first job completes, Oslo's biscuits box empties again and joins the open job.");
