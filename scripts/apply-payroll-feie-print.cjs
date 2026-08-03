const fs = require("node:fs");
const path = require("node:path");

const appPath = path.resolve(__dirname, "../src/App.jsx");
let source = fs.readFileSync(appPath, "utf8");

function replaceOnce(search, replacement, label) {
  if (source.includes(replacement)) return;
  const index = source.indexOf(search);
  if (index === -1) throw new Error(`Unable to apply payroll print patch: ${label}`);
  source = source.slice(0, index) + replacement + source.slice(index + search.length);
}

replaceOnce(
  'function SalaryPanel({ setGlobalError }) {',
  `function buildPayrollFeieContent(row, month) {
  const lines = [
    "<C><BOLD>薪資單</BOLD></C><BR>",
    \`月份：\${month}<BR>\`,
    \`姓名：\${row.name}<BR>\`,
    \`部門：\${row.department}<BR>\`,
    \`薪資類型：\${row.employeeType === "fullTime" ? "正職" : "時薪"}<BR>\`,
    \`認列總工時：\${row.hours}<BR>\`,
    \`基本薪資：\${row.basePay}<BR>\`,
    \`加班費：\${row.overtimePay}<BR>\`,
    \`增加費用：\${row.additions}<BR>\`,
    \`扣除費用：\${row.deductions}<BR>\`,
    \`<BOLD>應發薪資：\${row.salary}</BOLD><BR>\`,
    "--------------------------------<BR>",
    "打卡明細<BR>",
  ];
  (row.attendanceDetails || []).forEach((record) => {
    lines.push(\`\${record.date || ""} \${record.clockIn || ""}-\${record.clockOut || ""} \${getRecognizedHours(record)}時<BR>\`);
  });
  if ((row.adjustments || []).length) {
    lines.push("--------------------------------<BR>", "加扣項<BR>");
    row.adjustments.forEach((item) => {
      lines.push(\`\${item.type === "addition" ? "+" : "-"}\${Number(item.amount || 0)} \${item.title || ""}\${item.note ? \`（\${item.note}）\` : ""}<BR>\`);
    });
  }
  lines.push("<BR><CUT>");
  return lines.join("");
}

function SalaryPanel({ setGlobalError }) {`,
  "salary printer content builder"
);

replaceOnce(
  '  const [creatingAdjustment, setCreatingAdjustment] = useState(false);',
  '  const [creatingAdjustment, setCreatingAdjustment] = useState(false);\n  const [printingRowId, setPrintingRowId] = useState(null);\n  const [printMessage, setPrintMessage] = useState("");',
  "salary printer state"
);

replaceOnce(
  '  function exportDepartmentPayrollCsv() {',
  `  async function printPayroll(row) {
    setPrintingRowId(row.id);
    setPrintMessage("");
    try {
      const response = await fetch("/api/feie/print", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: buildPayrollFeieContent(row, month) }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.message || \`HTTP \${response.status}\`);
      setPrintMessage(\`\${row.name} 的薪資單已送出列印\`);
    } catch (error) {
      setPrintMessage(\`列印失敗：\${String(error?.message || error)}\`);
    } finally {
      setPrintingRowId(null);
    }
  }

  function exportDepartmentPayrollCsv() {`,
  "salary printer action"
);

replaceOnce(
  '<div className="mb-5 flex flex-wrap justify-end gap-2"><button type="button" onClick={exportDepartmentPayrollCsv}',
  '<div className="mb-3 rounded-2xl bg-neutral-50 p-3 text-sm text-neutral-600">飛鵝列印內容與單一員工薪資單 CSV 相同。印表機帳號由 Vercel 環境變數提供。</div>{printMessage && <div className="mb-3 rounded-2xl bg-blue-50 p-3 text-sm text-blue-700">{printMessage}</div>}<div className="mb-5 flex flex-wrap justify-end gap-2"><button type="button" onClick={exportDepartmentPayrollCsv}',
  "salary printer notice"
);

replaceOnce(
  '<button type="button" onClick={() => exportPayrollDetailCsv(row)} className="rounded-2xl bg-neutral-900 px-4 py-2 text-sm font-bold text-white">匯出薪資單 CSV</button>',
  '<button type="button" onClick={() => printPayroll(row)} disabled={printingRowId === row.id} className="rounded-2xl bg-blue-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{printingRowId === row.id ? "列印送出中..." : "列印薪資單"}</button><button type="button" onClick={() => exportPayrollDetailCsv(row)} className="rounded-2xl bg-neutral-900 px-4 py-2 text-sm font-bold text-white">匯出薪資單 CSV</button>',
  "salary print button"
);

fs.writeFileSync(appPath, source, "utf8");
console.log("Payroll Feie print patch applied.");
