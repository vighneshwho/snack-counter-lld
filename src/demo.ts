import type { Attendance, Employee, Office, RefillJob, SnackBox } from "./domain.ts";
import { RefillService } from "./refill-service.ts";
import { InMemoryStore } from "./store.ts";
import { VolunteerSelectionService } from "./volunteer-selection-service.ts";

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

const service = new RefillService(store);
const volunteerSelection = new VolunteerSelectionService(store);

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

const bengaluruJob = service.reportEmpty("bengaluru-biscuits");
printSnapshot("5. A report for Bengaluru's biscuits box creates a job for Bengaluru.");

osloJob.status = "COMPLETED";
service.reportEmpty("oslo-biscuits");
printSnapshot("6. After the first job completes, Oslo's biscuits box empties again and joins the open job.");

const asOf = new Date("2026-11-15T09:00:00Z");
console.log("\n7. Compare volunteers for the Bengaluru job.");
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
console.log("With no recorded volunteer history, employee ID breaks the tie.");
console.log("Selected volunteer:", firstChoice?.name ?? "None");

const bengaluruOnSiteVolunteers = [...store.employees.values()].filter((employee) =>
  employee.isVolunteer &&
  employee.attendance?.status === "ON_SITE" &&
  employee.attendance.officeId === bengaluruJob.officeId,
);

console.log("\n8. Add one recent completion for each on-site Bengaluru volunteer based in Bengaluru.");
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

console.log("\n9. Simulate cycle exclusions for every on-site volunteer in Bengaluru.");
bengaluruJob.excludedVolunteerIds = new Set(bengaluruOnSiteVolunteers.map((employee) => employee.id));
const afterExclusions = volunteerSelection.selectVolunteer(bengaluruJob, asOf);
console.log("Selected volunteer:", afterExclusions?.name ?? "None");
console.log("Bengaluru job status:", bengaluruJob.status);
