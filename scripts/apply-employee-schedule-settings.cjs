const fs = require("node:fs");
const path = require("node:path");

const appPath = path.resolve(__dirname, "../src/App.jsx");
let source = fs.readFileSync(appPath, "utf8");

function replaceOnce(search, replacement, label) {
  if (source.includes(replacement)) return;
  const index = source.indexOf(search);
  if (index === -1) throw new Error(`Unable to apply patch: ${label}`);
  source = source.slice(0, index) + replacement + source.slice(index + search.length);
}

function replaceAll(search, replacement, label) {
  if (source.includes(replacement)) return;
  if (!source.includes(search)) throw new Error(`Unable to apply patch: ${label}`);
  source = source.split(search).join(replacement);
}

replaceOnce(
  '    overtimeHourlyWage: Number(form.overtimeHourlyWage || form.hourlyWage || 0),\n    phone:',
  '    overtimeHourlyWage: Number(form.overtimeHourlyWage || form.hourlyWage || 0),\n    includeInSchedule: form.includeInSchedule !== false,\n    scheduleOrder: Number(form.scheduleOrder ?? 9999),\n    phone:',
  "manual employee data fields"
);

replaceAll(
  'employeeType: "hourly", departments: ["烘焙坊"],',
  'employeeType: "hourly", includeInSchedule: true, scheduleOrder: 9999, departments: ["烘焙坊"],',
  "manual employee form defaults"
);

replaceOnce(
  '<Select label="狀態" value={manualEmployeeForm.status} onChange={(v) => setManualEmployeeForm({ ...manualEmployeeForm, status: v })}><option value="pending">待審核</option><option value="active">啟用</option><option value="disabled">停用</option></Select><Select label="權限"',
  '<Select label="狀態" value={manualEmployeeForm.status} onChange={(v) => setManualEmployeeForm({ ...manualEmployeeForm, status: v })}><option value="pending">待審核</option><option value="active">啟用</option><option value="disabled">停用</option></Select><Select label="加入排班" value={manualEmployeeForm.includeInSchedule === false ? "no" : "yes"} onChange={(v) => setManualEmployeeForm({ ...manualEmployeeForm, includeInSchedule: v === "yes" })}><option value="yes">需要排班</option><option value="no">不需排班（仍計薪）</option></Select><Input label="排班順序" type="number" value={String(manualEmployeeForm.scheduleOrder ?? 9999)} onChange={(v) => setManualEmployeeForm({ ...manualEmployeeForm, scheduleOrder: Number(v || 9999) })} /><Select label="權限"',
  "manual employee schedule controls"
);

replaceOnce(
  '<Select label="狀態" value={emp.status || "pending"} onChange={(v) => updateEmployee(emp, { status: v })}><option value="pending">待審核</option><option value="active">啟用</option><option value="disabled">停用</option></Select><Select label="權限"',
  '<Select label="狀態" value={emp.status || "pending"} onChange={(v) => updateEmployee(emp, { status: v })}><option value="pending">待審核</option><option value="active">啟用</option><option value="disabled">停用</option></Select><Select label="加入排班" value={emp.includeInSchedule === false ? "no" : "yes"} onChange={(v) => updateEmployee(emp, { includeInSchedule: v === "yes" })}><option value="yes">需要排班</option><option value="no">不需排班（仍計薪）</option></Select><Input label="排班順序" type="number" value={String(emp.scheduleOrder ?? 9999)} onChange={(v) => updateEmployee(emp, { scheduleOrder: Number(v || 9999) })} /><Select label="權限"',
  "employee edit schedule controls"
);

replaceOnce(
  'const boardEmployees = useMemo(() => filterEmployeesByDepartment(employees, boardDepartment), [employees, boardDepartment]);',
  'const boardEmployees = useMemo(() => filterEmployeesByDepartment(employees, boardDepartment), [employees, boardDepartment]);',
  "board employees compatibility"
);

replaceOnce(
  'async function loadEmployees() { const snap = await safeRun(() => getDocs(query(collection(db, "employees"), where("status", "==", "active"))), "讀取員工清單失敗。", setGlobalError); if (snap) { const list = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((e) => e.role !== "owner").map((emp) => ({ ...emp, departments: getEmployeeDepartments(emp) })); const sorted = sortByFieldAsc(list, "name"); setEmployees(sorted); if (sorted.length) setScheduleForm((prev) => ({ ...prev, employeeId: prev.employeeId || sorted[0].lineUserId })); } }',
  'async function loadEmployees() { const snap = await safeRun(() => getDocs(query(collection(db, "employees"), where("status", "==", "active"))), "讀取員工清單失敗。", setGlobalError); if (snap) { const list = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((e) => e.role !== "owner" && e.includeInSchedule !== false).map((emp) => ({ ...emp, departments: getEmployeeDepartments(emp) })); const sorted = [...list].sort((a, b) => { const orderDiff = Number(a.scheduleOrder ?? 9999) - Number(b.scheduleOrder ?? 9999); return orderDiff || String(a.name || a.displayName || "").localeCompare(String(b.name || b.displayName || ""), "zh-Hant"); }); setEmployees(sorted); if (sorted.length) setScheduleForm((prev) => ({ ...prev, employeeId: prev.employeeId || sorted[0].lineUserId })); } }',
  "schedule employee filtering and ordering"
);

fs.writeFileSync(appPath, source, "utf8");
console.log("Employee schedule settings patch applied.");
