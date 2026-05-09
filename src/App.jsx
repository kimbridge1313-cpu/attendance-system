import React, { useEffect, useMemo, useState } from "react";
import { initializeApp } from "firebase/app";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  limit,
  getDocs,
  serverTimestamp,
} from "firebase/firestore";
import liff from "@line/liff";

/**
 * Attendance LIFF + Firebase Firestore Frontend
 * --------------------------------------------------
 * 修正版：
 * 1. 修正 TypeError: Failed to fetch 時錯誤訊息過於模糊的問題。
 * 2. LIFF 初始化失敗時顯示明確診斷清單，不再白畫面。
 * 3. Firestore 讀寫失敗時只顯示錯誤提示，不讓整個 App crash。
 * 4. 保留：員工管理 CRUD、打卡紀錄 CRUD、補卡 CRUD、排班、薪資月報。
 */

// ===== 🔥 上線設定區（只需要改這裡） =====
// 先用 true 測前端與 Firebase；確認畫面正常後，再改 false 接 LIFF
const DEV_MODE = true;
const LIFF_ID = "2009896295-aplNwbiH";
const OWNER_LINE_USER_IDS = ["U0d01ce43203dbcf0d3a94436b60eb232"];

// 👉 你的 Vercel 正式網址，必須跟 LINE LIFF Endpoint URL 完全一致
// 例：const APP_BASE_URL = "https://attendance-system.vercel.app";
const APP_BASE_URL = typeof window !== "undefined" ? window.location.origin : "";
// ======================================

const firebaseConfig = {
  apiKey: "AIzaSyAbfvJlElGLgI1lX7fsdEeV3VS8Gk0o3YA",
  authDomain: "attendance-app-c95ff.firebaseapp.com",
  projectId: "attendance-app-c95ff",
  storageBucket: "attendance-app-c95ff.firebasestorage.app",
  messagingSenderId: "1069052716411",
  appId: "1069052716411:web:83129a080b3bd62bbdc9de",
};

const DEPARTMENTS = ["烘焙坊", "超市"];
const DEFAULT_GRACE_MINUTES = 10;
const DEV_LOGIN_AS = "owner";
const DEV_PROFILES = {
  owner: { userId: OWNER_LINE_USER_IDS[0] || "DEV_OWNER_USER_ID", displayName: "開發測試老闆", pictureUrl: "" },
  newEmployee: { userId: "DEV_NEW_EMPLOYEE_USER_ID", displayName: "新員工測試帳號", pictureUrl: "" },
  employee: { userId: "DEV_EMPLOYEE_USER_ID", displayName: "已審核員工測試帳號", pictureUrl: "" },
};
const DEV_PROFILE = DEV_PROFILES[DEV_LOGIN_AS] || DEV_PROFILES.owner;

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const todayString = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};
const currentTimeString = () => {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
};
const getMonthString = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
};
const toMinutes = (hhmm) => {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
};
const minutesBetween = (startHHMM, endHHMM) => {
  const start = toMinutes(startHHMM);
  const end = toMinutes(endHHMM);
  if (start === null || end === null) return 0;
  return Math.max(0, end - start);
};
const formatHours = (minutes) => Math.round((minutes / 60) * 100) / 100;
const timestampMillis = (value) => {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value.seconds) return value.seconds * 1000;
  return 0;
};
const sortByFieldAsc = (items, field) => [...items].sort((a, b) => String(a[field] || "").localeCompare(String(b[field] || "")));
const sortByCreatedAtDesc = (items) => [...items].sort((a, b) => timestampMillis(b.createdAt) - timestampMillis(a.createdAt));

const getEmployeeDepartments = (employee) => {
  if (Array.isArray(employee?.departments) && employee.departments.length) return employee.departments;
  if (employee?.department) return [employee.department];
  return ["烘焙坊"];
};
const employeeCanWorkDepartment = (employee, department) => getEmployeeDepartments(employee).includes(department);
const filterEmployeesByDepartment = (employees, department) => department === "全部" ? employees : employees.filter((emp) => employeeCanWorkDepartment(emp, department));

const isNetworkFetchError = (err) => {
  const text = String(err?.message || err || "").toLowerCase();
  return text.includes("failed to fetch") || text.includes("networkerror") || text.includes("load failed") || text.includes("network request failed");
};
const isOfflineError = (err) => {
  const text = String(err?.message || err || "").toLowerCase();
  return text.includes("client is offline") || text.includes("offline") || text.includes("unavailable") || text.includes("failed to get document") || isNetworkFetchError(err);
};

function getFirebaseFriendlyError(err, fallback = "操作失敗。") {
  const raw = String(err?.message || err || "");
  const lower = raw.toLowerCase();
  if (isNetworkFetchError(err)) {
    return [
      "網路請求失敗：Failed to fetch。",
      "請依序檢查：",
      "1. 目前網址是否為 HTTPS 的 Vercel 正式網址。",
      "2. Firebase Firestore 是否已建立並啟用。",
      "3. Firestore Rules 是否暫時允許 read / write 測試。",
      "4. 瀏覽器是否阻擋第三方 Cookie、追蹤防護或外掛阻擋 Firebase / LINE 網域。",
      "5. 若是在 LINE 內開啟，請也用外部瀏覽器測一次。",
      `原始錯誤：${raw || "Failed to fetch"}`,
    ].join("\n");
  }
  if (isOfflineError(err)) return "Firebase 目前連線失敗：client is offline。請確認網路、Firebase 專案設定、Firestore Rules，然後重新整理。";
  if (lower.includes("requires an index") || lower.includes("failed-precondition")) return "Firestore 查詢需要建立複合索引。這版已盡量改成前端排序。\n原始錯誤：" + raw;
  if (lower.includes("permission-denied") || lower.includes("missing or insufficient permissions")) return "Firestore 權限不足。請確認 Firestore Rules 目前允許測試讀寫。";
  return `${fallback}\n原始錯誤：${raw || "未知錯誤"}`;
}

function getLiffErrorMessage(err) {
  const raw = String(err?.message || err || "");
  const lower = raw.toLowerCase();
  if (lower.includes("channel not found")) return "LIFF 初始化失敗：channel not found。請確認 LIFF_ID 是否正確、Channel 是否啟用、LIFF App 是否存在。";
  if (isNetworkFetchError(err)) {
    return [
      "LIFF 初始化失敗：Failed to fetch。",
      "請先檢查 LINE Developers Console：",
      "1. LIFF Endpoint URL 是否完全等於 APP_BASE_URL / 目前 Vercel 網址，例如 https://xxx.vercel.app。",
      "2. LIFF ID 是否填對。",
      "3. Channel 是否為已啟用狀態。",
      "4. 手機 LINE 內與外部瀏覽器都測一次。",
      `目前 LIFF_ID：${LIFF_ID}`,
      `目前網址：${window.location.href}`,
      `APP_BASE_URL：${APP_BASE_URL}`,
      `原始錯誤：${raw}`,
    ].join("\n");
  }
  return getFirebaseFriendlyError(err, "LIFF 初始化失敗。請確認 LIFF ID、Endpoint URL 與網路狀態。");
}

async function safeRun(fn, fallback, onError) {
  try {
    return await fn();
  } catch (err) {
    console.error(err);
    onError?.(getFirebaseFriendlyError(err, fallback));
    return null;
  }
}

function buildManualEmployeeData(form, now = Date.now()) {
  const departments = Array.isArray(form.departments) && form.departments.length ? form.departments : ["烘焙坊"];
  const lineUserId = form.lineUserId?.trim() || `MANUAL_${now}`;
  return {
    id: lineUserId,
    lineUserId,
    name: form.name.trim(),
    displayName: form.displayName?.trim() || form.name.trim(),
    pictureUrl: "",
    role: form.role || "employee",
    status: form.status || "active",
    department: departments[0],
    departments,
    hourlyWage: Number(form.hourlyWage || 0),
    phone: form.phone?.trim() || "",
    note: form.note?.trim() || "主管手動新增",
  };
}

const getAttendanceStatusText = (status) => {
  if (status === "normal") return "正常";
  if (status === "late") return "遲到";
  if (status === "earlyLeave") return "早退";
  if (status === "lateAndEarlyLeave") return "遲到＋早退";
  if (status === "noSchedule") return "無排班打卡";
  if (status === "manualCorrection") return "補卡修正";
  return "尚未判斷";
};
function statusText(status) {
  if (status === "pending") return "待審核";
  if (status === "approved") return "已通過";
  if (status === "rejected") return "已退回";
  return status || "未知";
}

function getMonthWeekDates(month, weekIndex) {
  const [year, monthNumber] = month.split("-").map(Number);
  const firstDay = new Date(year, monthNumber - 1, 1);
  const mondayOffset = firstDay.getDay() === 0 ? -6 : 1 - firstDay.getDay();
  const monday = new Date(firstDay);
  monday.setDate(firstDay.getDate() + mondayOffset + (Number(weekIndex) - 1) * 7);
  const labels = ["一", "二", "三", "四", "五", "六", "日"];
  return Array.from({ length: 7 }).map((_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return { date: `${yyyy}-${mm}-${dd}`, mmdd: `${Number(mm)}/${Number(dd)}`, weekday: labels[i] };
  });
}

function evaluateAttendance({ schedule, clockIn, clockOut }) {
  if (!schedule) return { attendanceStatus: "noSchedule", lateMinutes: 0, earlyLeaveMinutes: 0 };
  const scheduledStart = toMinutes(schedule.startTime);
  const scheduledEnd = toMinutes(schedule.endTime);
  const actualStart = toMinutes(clockIn);
  const actualEnd = toMinutes(clockOut);
  const grace = Number(schedule.graceMinutes ?? DEFAULT_GRACE_MINUTES);
  let lateMinutes = 0;
  let earlyLeaveMinutes = 0;
  if (scheduledStart !== null && actualStart !== null && actualStart > scheduledStart + grace) lateMinutes = actualStart - scheduledStart;
  if (scheduledEnd !== null && actualEnd !== null && actualEnd < scheduledEnd) earlyLeaveMinutes = scheduledEnd - actualEnd;
  let attendanceStatus = "normal";
  if (lateMinutes > 0 && earlyLeaveMinutes > 0) attendanceStatus = "lateAndEarlyLeave";
  else if (lateMinutes > 0) attendanceStatus = "late";
  else if (earlyLeaveMinutes > 0) attendanceStatus = "earlyLeave";
  return { attendanceStatus, lateMinutes, earlyLeaveMinutes };
}

function runSelfTests() {
  console.assert(minutesBetween("09:00", "18:00") === 540, "minutesBetween should calculate same-day work minutes");
  console.assert(minutesBetween("18:00", "09:00") === 0, "minutesBetween should not return negative minutes");
  console.assert(formatHours(485) === 8.08, "formatHours should keep two decimal places");
  console.assert(/^\d{4}-\d{2}-\d{2}$/.test(todayString()), "todayString should be YYYY-MM-DD");
  console.assert(evaluateAttendance({ schedule: null, clockIn: "09:00", clockOut: "18:00" }).attendanceStatus === "noSchedule", "no schedule should be flagged");
  console.assert(evaluateAttendance({ schedule: { startTime: "09:00", endTime: "18:00", graceMinutes: 10 }, clockIn: "09:20", clockOut: "18:00" }).attendanceStatus === "late", "late should be flagged");
  console.assert(getEmployeeDepartments({ department: "超市" })[0] === "超市", "legacy single department should still work");
  console.assert(employeeCanWorkDepartment({ departments: ["烘焙坊", "超市"] }, "超市") === true, "multi-department employee should work in supported department");
  console.assert(filterEmployeesByDepartment([{ departments: ["烘焙坊"] }, { departments: ["超市"] }], "超市").length === 1, "department board filter should work");
  console.assert(buildManualEmployeeData({ name: "測試員工", departments: ["超市"], hourlyWage: "190" }, 1).lineUserId === "MANUAL_1", "manual ID should be deterministic");
  console.assert(getMonthWeekDates("2026-04", 4).length === 7, "month week selector should return 7 days");
  console.assert(isNetworkFetchError({ message: "TypeError: Failed to fetch" }) === true, "failed fetch should be detected");
  console.assert(isOfflineError({ message: "Failed to get document because the client is offline." }) === true, "offline errors should be detected");
}
runSelfTests();

const isFirebaseConfigReady = () => Boolean(firebaseConfig.apiKey && firebaseConfig.projectId && !firebaseConfig.apiKey.includes("請貼上"));
const isLiffReady = () => Boolean(LIFF_ID && !LIFF_ID.includes("請貼上"));

function App() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [profile, setProfile] = useState(null);
  const [employee, setEmployee] = useState(null);
  const [todayRecord, setTodayRecord] = useState(null);
  const [todaySchedule, setTodaySchedule] = useState(null);
  const [activeTab, setActiveTab] = useState("clock");

  const isManager = useMemo(() => profile?.userId && (OWNER_LINE_USER_IDS.includes(profile.userId) || employee?.role === "owner" || employee?.role === "manager"), [profile, employee]);

  useEffect(() => { boot(); }, []);

  async function boot() {
    setLoading(true);
    setError("");

    if (!isFirebaseConfigReady()) {
      setError("Firebase 尚未設定。請先把 firebaseConfig 換成 Firebase 專案設定。");
      setLoading(false);
      return;
    }

    let lineProfile = null;
    if (DEV_MODE) {
      lineProfile = DEV_PROFILE;
    } else {
      if (!isLiffReady()) {
        setError("LIFF_ID 尚未設定。請貼上 LIFF ID，或先把 DEV_MODE 設為 true 測試。");
        setLoading(false);
        return;
      }
      try {
        await liff.init({ liffId: LIFF_ID });
      } catch (err) {
        console.error(err);
        setError(getLiffErrorMessage(err));
        setLoading(false);
        return;
      }
      if (!liff.isLoggedIn()) {
        try {
          liff.login({ redirectUri: APP_BASE_URL });
        } catch (err) {
          console.error(err);
          setError(getLiffErrorMessage(err));
          setLoading(false);
        }
        return;
      }
      lineProfile = await safeRun(() => liff.getProfile(), "取得 LINE 身分失敗。", setError);
    }

    if (!lineProfile) { setLoading(false); return; }
    setProfile(lineProfile);

    const employeeRef = doc(db, "employees", lineProfile.userId);
    const employeeSnap = await safeRun(() => getDoc(employeeRef), "讀取員工資料失敗。", setError);

    if (!employeeSnap && DEV_MODE) {
      setEmployee({
        id: lineProfile.userId,
        lineUserId: lineProfile.userId,
        name: lineProfile.displayName || "開發測試帳號",
        displayName: lineProfile.displayName || "",
        pictureUrl: "",
        role: DEV_LOGIN_AS === "owner" ? "owner" : "employee",
        status: DEV_LOGIN_AS === "newEmployee" ? "pending" : "active",
        department: DEV_LOGIN_AS === "owner" ? "管理" : "烘焙坊",
        departments: DEV_LOGIN_AS === "owner" ? ["烘焙坊", "超市"] : ["烘焙坊"],
        hourlyWage: DEV_LOGIN_AS === "owner" ? 0 : 190,
        phone: "",
        note: "Firebase 離線時的 DEV fallback，不會寫入資料庫。",
      });
      setLoading(false);
      return;
    }

    if (employeeSnap?.exists()) {
      const employeeData = { id: employeeSnap.id, ...employeeSnap.data() };
      setEmployee(employeeData);
      await Promise.all([loadTodayRecord(lineProfile.userId), loadTodaySchedule(lineProfile.userId)]);
      setLoading(false);
      return;
    }

    if (OWNER_LINE_USER_IDS.includes(lineProfile.userId)) {
      const ownerData = {
        lineUserId: lineProfile.userId,
        name: lineProfile.displayName || "老闆",
        displayName: lineProfile.displayName || "",
        pictureUrl: lineProfile.pictureUrl || "",
        role: "owner",
        status: "active",
        department: "管理",
        departments: ["烘焙坊", "超市"],
        hourlyWage: 0,
        phone: "",
        note: "系統建立者",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      const written = await safeRun(() => setDoc(employeeRef, ownerData), "建立老闆資料失敗。", setError);
      if (written !== null) setEmployee({ id: lineProfile.userId, ...ownerData });
    } else {
      setEmployee(null);
    }

    setLoading(false);
  }

  async function loadTodayRecord(userId) {
    const date = todayString();
    const snap = await safeRun(() => getDocs(query(collection(db, "attendanceRecords"), where("employeeId", "==", userId), where("date", "==", date), limit(10))), "讀取今日打卡失敗。", setError);
    if (!snap) return;
    setTodayRecord(sortByCreatedAtDesc(snap.docs.map((item) => ({ id: item.id, ...item.data() })))[0] || null);
  }

  async function loadTodaySchedule(userId) {
    const date = todayString();
    const snap = await safeRun(() => getDocs(query(collection(db, "schedules"), where("employeeId", "==", userId), where("date", "==", date), limit(10))), "讀取今日班表失敗。", setError);
    if (!snap) return;
    setTodaySchedule(sortByFieldAsc(snap.docs.map((item) => ({ id: item.id, ...item.data() })), "startTime")[0] || null);
  }

  async function applyJoin(form) {
    if (!profile?.userId) return;
    const data = {
      lineUserId: profile.userId,
      name: form.name.trim(),
      displayName: profile.displayName || "",
      pictureUrl: profile.pictureUrl || "",
      role: "employee",
      status: "pending",
      department: form.department,
      departments: [form.department],
      hourlyWage: 0,
      phone: form.phone.trim(),
      note: form.note.trim(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    const ok = await safeRun(() => setDoc(doc(db, "employees", profile.userId), data), "送出加入申請失敗。", setError);
    if (ok !== null) setEmployee({ id: profile.userId, ...data });
  }

  async function clockIn() {
    if (!profile || !employee) return;
    const date = todayString();
    const time = currentTimeString();
    const check = evaluateAttendance({ schedule: todaySchedule, clockIn: time, clockOut: "" });
    const data = {
      employeeId: profile.userId,
      employeeName: employee.name || profile.displayName,
      department: todaySchedule?.department || employee.department || "未設定",
      date,
      month: date.slice(0, 7),
      scheduleId: todaySchedule?.id || null,
      scheduledStart: todaySchedule?.startTime || "",
      scheduledEnd: todaySchedule?.endTime || "",
      clockIn: time,
      clockOut: "",
      clockInAt: serverTimestamp(),
      clockOutAt: null,
      workMinutes: 0,
      workHours: 0,
      attendanceStatus: check.attendanceStatus,
      lateMinutes: check.lateMinutes,
      earlyLeaveMinutes: 0,
      source: "normal",
      status: "open",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    const ref = await safeRun(() => addDoc(collection(db, "attendanceRecords"), data), "上班打卡失敗。", setError);
    if (ref) setTodayRecord({ id: ref.id, ...data });
  }

  async function clockOut() {
    if (!todayRecord?.id) return;
    const time = currentTimeString();
    const workMinutes = minutesBetween(todayRecord.clockIn, time);
    const check = evaluateAttendance({ schedule: todaySchedule, clockIn: todayRecord.clockIn, clockOut: time });
    const updateData = {
      clockOut: time,
      clockOutAt: serverTimestamp(),
      workMinutes,
      workHours: formatHours(workMinutes),
      attendanceStatus: check.attendanceStatus,
      lateMinutes: check.lateMinutes,
      earlyLeaveMinutes: check.earlyLeaveMinutes,
      status: "completed",
      updatedAt: serverTimestamp(),
    };
    const ok = await safeRun(() => updateDoc(doc(db, "attendanceRecords", todayRecord.id), updateData), "下班打卡失敗。", setError);
    if (ok !== null) setTodayRecord({ ...todayRecord, ...updateData });
  }

  if (loading) return <FullPage message="系統載入中..." />;
  if (!profile) return <ErrorPage message={error || "尚未取得 LINE / DEV 身分。"} onRetry={boot} />;
  if (!employee) return <JoinPage profile={profile} onSubmit={applyJoin} error={error} />;
  if (employee.status === "pending") return <FullPage message="你的加入申請已送出，請等待主管審核。" />;
  if (employee.status === "disabled") return <FullPage message="你的帳號已被停用，請聯絡主管。" tone="error" />;

  return (
    <div className="min-h-screen bg-neutral-100 text-neutral-900">
      <header className="sticky top-0 z-10 border-b bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div>
            <h1 className="text-lg font-bold">員工打卡系統</h1>
            <p className="text-xs text-neutral-500">Firebase Firestore 版{DEV_MODE ? `｜開發測試模式：${DEV_LOGIN_AS}` : ""}</p>
          </div>
          <div className="text-right text-sm">
            <div className="font-medium">{employee.name}</div>
            <div className="text-xs text-neutral-500">{getEmployeeDepartments(employee).join("、")}｜{employee.role}</div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-5">
        {error && <div className="mb-4 whitespace-pre-line rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}
        {DEV_MODE && <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">目前是 DEV_MODE，身份：<b>{DEV_LOGIN_AS}</b>。</div>}
        <nav className="mb-5 grid grid-cols-2 gap-2 md:grid-cols-6">
          <TabButton active={activeTab === "clock"} onClick={() => setActiveTab("clock")}>打卡</TabButton>
          <TabButton active={activeTab === "correction"} onClick={() => setActiveTab("correction")}>補卡</TabButton>
          <TabButton active={activeTab === "myStats"} onClick={() => setActiveTab("myStats")}>我的統計</TabButton>
          {isManager && <TabButton active={activeTab === "admin"} onClick={() => setActiveTab("admin")}>主管後台</TabButton>}
          {isManager && <TabButton active={activeTab === "schedule"} onClick={() => setActiveTab("schedule")}>排班</TabButton>}
          {isManager && <TabButton active={activeTab === "salary"} onClick={() => setActiveTab("salary")}>薪資月報</TabButton>}
        </nav>
        {activeTab === "clock" && <ClockPanel employee={employee} todayRecord={todayRecord} todaySchedule={todaySchedule} onClockIn={clockIn} onClockOut={clockOut} onReload={() => Promise.all([loadTodayRecord(profile.userId), loadTodaySchedule(profile.userId)])} />}
        {activeTab === "correction" && <CorrectionPanel employee={employee} profile={profile} setGlobalError={setError} />}
        {activeTab === "myStats" && <MyStatsPanel employee={employee} setGlobalError={setError} />}
        {activeTab === "admin" && isManager && <AdminPanel currentUser={employee} setGlobalError={setError} />}
        {activeTab === "schedule" && isManager && <SchedulePanel setGlobalError={setError} />}
        {activeTab === "salary" && isManager && <SalaryPanel setGlobalError={setError} />}
      </main>
    </div>
  );
}

function FullPage({ message, tone = "normal" }) {
  return <div className="flex min-h-screen items-center justify-center bg-neutral-100 p-6"><div className={`w-full max-w-md whitespace-pre-line rounded-3xl bg-white p-6 text-center shadow ${tone === "error" ? "text-red-600" : "text-neutral-800"}`}><div className="text-lg font-bold">{message}</div></div></div>;
}
function ErrorPage({ message, onRetry }) {
  return <div className="flex min-h-screen items-center justify-center bg-neutral-100 p-6"><div className="w-full max-w-xl rounded-3xl bg-white p-6 shadow"><h1 className="text-xl font-bold text-red-600">系統初始化失敗</h1><p className="mt-4 whitespace-pre-line text-sm leading-7 text-neutral-700">{message}</p><button onClick={onRetry} className="mt-5 rounded-2xl bg-neutral-900 px-4 py-3 text-sm font-bold text-white">重新檢查</button></div></div>;
}
function TabButton({ active, onClick, children }) {
  return <button onClick={onClick} className={`rounded-2xl px-4 py-3 text-sm font-semibold shadow-sm transition ${active ? "bg-neutral-900 text-white" : "bg-white text-neutral-700"}`}>{children}</button>;
}
function Card({ title, subtitle, children }) {
  return <section className="rounded-3xl bg-white p-5 shadow-sm"><div className="mb-4"><h2 className="text-lg font-bold">{title}</h2>{subtitle && <p className="mt-1 text-sm text-neutral-500">{subtitle}</p>}</div>{children}</section>;
}
function Input({ label, value, onChange, type = "text" }) {
  return <label className="block"><span className="mb-1 block text-sm font-medium text-neutral-700">{label}</span><input type={type} value={value} onChange={(e) => onChange(e.target.value)} className="w-full rounded-2xl border border-neutral-200 px-4 py-3 outline-none focus:border-neutral-900" /></label>;
}
function Select({ label, value, onChange, children }) {
  return <label className="block"><span className="mb-1 block text-sm font-medium text-neutral-700">{label}</span><select value={value} onChange={(e) => onChange(e.target.value)} className="w-full rounded-2xl border border-neutral-200 px-4 py-3 outline-none focus:border-neutral-900">{children}</select></label>;
}
function InfoBox({ label, value }) {
  return <div className="rounded-2xl bg-neutral-100 p-4"><div className="text-sm text-neutral-500">{label}</div><div className="mt-1 text-xl font-bold">{value}</div></div>;
}
function DepartmentCheckboxes({ label, value, onChange }) {
  const selected = Array.isArray(value) ? value : [];
  const toggle = (department) => {
    const next = selected.includes(department) ? selected.filter((item) => item !== department) : [...selected, department];
    onChange(next.length ? next : [department]);
  };
  return <div><span className="mb-1 block text-sm font-medium text-neutral-700">{label}</span><div className="flex flex-wrap gap-2 rounded-2xl border border-neutral-200 p-2">{DEPARTMENTS.map((department) => <button key={department} type="button" onClick={() => toggle(department)} className={`rounded-xl px-3 py-2 text-sm font-bold ${selected.includes(department) ? "bg-neutral-900 text-white" : "bg-neutral-100 text-neutral-600"}`}>{department}</button>)}</div></div>;
}
function SimpleList({ items, empty, render }) { return !items.length ? <div className="rounded-2xl bg-neutral-100 p-4 text-sm text-neutral-500">{empty}</div> : <div className="space-y-3">{items.map((item) => <React.Fragment key={item.id}>{render(item)}</React.Fragment>)}</div>; }

function JoinPage({ profile, onSubmit, error }) {
  const [form, setForm] = useState({ name: profile.displayName || "", department: "烘焙坊", phone: "", note: "" });
  const [saving, setSaving] = useState(false);
  async function submit(e) { e.preventDefault(); if (!form.name.trim()) return alert("請填寫姓名"); setSaving(true); try { await onSubmit(form); } finally { setSaving(false); } }
  return <div className="min-h-screen bg-neutral-100 p-4"><div className="mx-auto max-w-md rounded-3xl bg-white p-6 shadow"><h1 className="text-xl font-bold">申請加入員工系統</h1><p className="mt-2 text-sm text-neutral-500">第一次使用需要主管審核後才能打卡。</p>{error && <div className="mt-4 whitespace-pre-line rounded-2xl bg-red-50 p-3 text-sm text-red-700">{error}</div>}<form onSubmit={submit} className="mt-5 space-y-4"><Input label="員工姓名" value={form.name} onChange={(v) => setForm({ ...form, name: v })} /><Select label="部門" value={form.department} onChange={(v) => setForm({ ...form, department: v })}>{DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}</Select><Input label="電話" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} /><Input label="備註" value={form.note} onChange={(v) => setForm({ ...form, note: v })} /><button disabled={saving} className="w-full rounded-2xl bg-neutral-900 px-4 py-3 font-bold text-white disabled:opacity-50">{saving ? "送出中..." : "送出申請"}</button></form></div></div>;
}

function ClockPanel({ employee, todayRecord, todaySchedule, onClockIn, onClockOut, onReload }) {
  const canClockIn = !todayRecord;
  const canClockOut = todayRecord && !todayRecord.clockOut;
  const isCompleted = todayRecord?.clockIn && todayRecord?.clockOut;
  return <div className="space-y-5"><Card title="今日班表" subtitle={`今天日期：${todayString()}`}>{todaySchedule ? <div className="grid gap-4 md:grid-cols-4"><InfoBox label="部門" value={todaySchedule.department || employee.department || "未設定"} /><InfoBox label="上班時間" value={todaySchedule.startTime} /><InfoBox label="下班時間" value={todaySchedule.endTime} /><InfoBox label="寬限分鐘" value={`${todaySchedule.graceMinutes ?? DEFAULT_GRACE_MINUTES} 分`} /></div> : <div className="rounded-2xl bg-amber-50 p-4 text-sm text-amber-900">今天尚未排班。若仍打卡，系統會標記為「無排班打卡」。</div>}</Card><Card title="今日打卡"><div className="grid gap-4 md:grid-cols-4"><InfoBox label="上班打卡" value={todayRecord?.clockIn || "尚未打卡"} /><InfoBox label="下班打卡" value={todayRecord?.clockOut || "尚未打卡"} /><InfoBox label="今日工時" value={isCompleted ? `${todayRecord.workHours || 0} 小時` : "尚未完成"} /><InfoBox label="狀態" value={todayRecord ? getAttendanceStatusText(todayRecord.attendanceStatus) : "尚未打卡"} /></div>{todayRecord && todayRecord.attendanceStatus !== "normal" && <div className="mt-4 rounded-2xl bg-red-50 p-4 text-sm text-red-700">{getAttendanceStatusText(todayRecord.attendanceStatus)}{todayRecord.lateMinutes > 0 ? `｜遲到 ${todayRecord.lateMinutes} 分` : ""}{todayRecord.earlyLeaveMinutes > 0 ? `｜早退 ${todayRecord.earlyLeaveMinutes} 分` : ""}</div>}<div className="mt-5 grid gap-3 md:grid-cols-2"><button disabled={!canClockIn} onClick={onClockIn} className="rounded-2xl bg-neutral-900 px-4 py-4 font-bold text-white disabled:bg-neutral-300">上班打卡</button><button disabled={!canClockOut} onClick={onClockOut} className="rounded-2xl bg-neutral-900 px-4 py-4 font-bold text-white disabled:bg-neutral-300">下班打卡</button></div><button onClick={onReload} className="mt-3 text-sm text-neutral-500 underline">重新整理今日狀態</button></Card></div>;
}

function CorrectionPanel({ employee, profile, setGlobalError }) {
  const [form, setForm] = useState({ type: "clockIn", date: todayString(), time: "09:00", reason: "" });
  const [saving, setSaving] = useState(false);
  const [items, setItems] = useState([]);
  useEffect(() => { loadMine(); }, []);
  async function loadMine() {
    const snap = await safeRun(() => getDocs(query(collection(db, "correctionRequests"), where("employeeId", "==", profile.userId), limit(50))), "讀取補卡紀錄失敗。", setGlobalError);
    if (snap) setItems(sortByCreatedAtDesc(snap.docs.map((d) => ({ id: d.id, ...d.data() }))).slice(0, 20));
  }
  async function submit(e) {
    e.preventDefault();
    if (!form.reason.trim()) return alert("請填寫補卡原因");
    setSaving(true);
    const ok = await safeRun(() => addDoc(collection(db, "correctionRequests"), { employeeId: profile.userId, employeeName: employee.name, department: employee.department || "未設定", type: form.type, date: form.date, time: form.time, reason: form.reason.trim(), status: "pending", reviewedBy: null, reviewedAt: null, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }), "送出補卡申請失敗。", setGlobalError);
    if (ok) { setForm({ type: "clockIn", date: todayString(), time: "09:00", reason: "" }); await loadMine(); }
    setSaving(false);
  }
  return <div className="grid gap-5 md:grid-cols-2"><Card title="補卡申請"><form onSubmit={submit} className="space-y-4"><Select label="補卡類型" value={form.type} onChange={(v) => setForm({ ...form, type: v })}><option value="clockIn">補上班卡</option><option value="clockOut">補下班卡</option></Select><Input label="日期" type="date" value={form.date} onChange={(v) => setForm({ ...form, date: v })} /><Input label="時間" type="time" value={form.time} onChange={(v) => setForm({ ...form, time: v })} /><Input label="原因" value={form.reason} onChange={(v) => setForm({ ...form, reason: v })} /><button disabled={saving} className="w-full rounded-2xl bg-neutral-900 px-4 py-3 font-bold text-white disabled:opacity-50">{saving ? "送出中..." : "送出補卡申請"}</button></form></Card><Card title="我的補卡紀錄"><SimpleList items={items} empty="目前沒有補卡紀錄" render={(item) => <div className="rounded-2xl border p-3"><div className="font-bold">{item.date} {item.time}｜{item.type === "clockIn" ? "上班" : "下班"}</div><div className="text-sm text-neutral-500">狀態：{statusText(item.status)}</div><div className="text-sm text-neutral-500">原因：{item.reason}</div></div>} /></Card></div>;
}

function MyStatsPanel({ employee, setGlobalError }) {
  const [month, setMonth] = useState(getMonthString());
  const [records, setRecords] = useState([]);
  useEffect(() => { load(); }, [month]);
  async function load() {
    const snap = await safeRun(() => getDocs(query(collection(db, "attendanceRecords"), where("employeeId", "==", employee.lineUserId), where("month", "==", month))), "讀取月統計失敗。", setGlobalError);
    if (snap) setRecords(sortByFieldAsc(snap.docs.map((d) => ({ id: d.id, ...d.data() })), "date"));
  }
  const totalMinutes = records.reduce((sum, r) => sum + Number(r.workMinutes || 0), 0);
  const salary = formatHours(totalMinutes) * Number(employee.hourlyWage || 0);
  return <Card title="我的月統計"><div className="mb-4 max-w-xs"><Input label="月份" type="month" value={month} onChange={setMonth} /></div><div className="grid gap-4 md:grid-cols-3"><InfoBox label="總分鐘" value={`${totalMinutes} 分`} /><InfoBox label="總工時" value={`${formatHours(totalMinutes)} 小時`} /><InfoBox label="預估薪資" value={`$${Math.round(salary).toLocaleString()}`} /></div><RecordTable records={records} /></Card>;
}

function AdminPanel({ currentUser, setGlobalError }) {
  const [employees, setEmployees] = useState([]);
  const [corrections, setCorrections] = useState([]);
  const [todayRecords, setTodayRecords] = useState([]);
  const [creatingEmployee, setCreatingEmployee] = useState(false);
  const [editingEmployeeId, setEditingEmployeeId] = useState(null);
  const [creatingAttendance, setCreatingAttendance] = useState(false);
  const [editingAttendanceId, setEditingAttendanceId] = useState(null);
  const [creatingCorrection, setCreatingCorrection] = useState(false);
  const [editingCorrectionId, setEditingCorrectionId] = useState(null);
  const [manualEmployeeForm, setManualEmployeeForm] = useState({ lineUserId: "", name: "", displayName: "", phone: "", role: "employee", status: "active", departments: ["烘焙坊"], hourlyWage: 190, note: "" });
  const [attendanceForm, setAttendanceForm] = useState({ employeeId: "", date: todayString(), clockIn: "09:00", clockOut: "18:00", department: "烘焙坊", source: "manual", note: "" });
  const [correctionForm, setCorrectionForm] = useState({ employeeId: "", type: "clockIn", date: todayString(), time: "09:00", reason: "主管手動新增", status: "pending" });
  useEffect(() => { loadAll(); }, []);
  async function loadAll() {
    const employeeSnap = await safeRun(() => getDocs(collection(db, "employees")), "讀取員工資料失敗。", setGlobalError);
    if (employeeSnap) {
      const rows = sortByCreatedAtDesc(employeeSnap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setEmployees(rows);
      const firstActive = rows.find((emp) => emp.status === "active" && emp.role !== "owner") || rows[0];
      if (firstActive) {
        setAttendanceForm((prev) => ({ ...prev, employeeId: prev.employeeId || firstActive.lineUserId || firstActive.id, department: prev.department || getEmployeeDepartments(firstActive)[0] }));
        setCorrectionForm((prev) => ({ ...prev, employeeId: prev.employeeId || firstActive.lineUserId || firstActive.id }));
      }
    }
    const correctionSnap = await safeRun(() => getDocs(query(collection(db, "correctionRequests"), limit(100))), "讀取補卡資料失敗。", setGlobalError);
    if (correctionSnap) setCorrections(sortByCreatedAtDesc(correctionSnap.docs.map((d) => ({ id: d.id, ...d.data() }))));
    const todaySnap = await safeRun(() => getDocs(query(collection(db, "attendanceRecords"), where("date", "==", todayString()), limit(100))), "讀取今日打卡紀錄失敗。", setGlobalError);
    if (todaySnap) setTodayRecords(sortByCreatedAtDesc(todaySnap.docs.map((d) => ({ id: d.id, ...d.data() }))));
  }
  async function updateEmployee(emp, patch) { const ok = await safeRun(() => updateDoc(doc(db, "employees", emp.id), { ...patch, updatedAt: serverTimestamp() }), "更新員工資料失敗。", setGlobalError); if (ok !== null) await loadAll(); }
  async function deleteEmployee(emp) { if (!window.confirm(`確定刪除員工「${emp.name || emp.displayName || emp.id}」？\n注意：這不會自動刪除他的既有打卡紀錄。`)) return; const ok = await safeRun(() => deleteDoc(doc(db, "employees", emp.id)), "刪除員工失敗。", setGlobalError); if (ok !== null) await loadAll(); }
  async function createManualEmployee(e) { e.preventDefault(); if (!manualEmployeeForm.name.trim()) return alert("請填寫員工姓名"); const data = buildManualEmployeeData(manualEmployeeForm); const ok = await safeRun(() => setDoc(doc(db, "employees", data.lineUserId), { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true }), "建立員工資料失敗。", setGlobalError); if (ok !== null) { setManualEmployeeForm({ lineUserId: "", name: "", displayName: "", phone: "", role: "employee", status: "active", departments: ["烘焙坊"], hourlyWage: 190, note: "" }); setCreatingEmployee(false); await loadAll(); } }
  function getEmployeeByLineId(employeeId) { return employees.find((emp) => (emp.lineUserId || emp.id) === employeeId); }
  function buildAttendancePayload(form) { const emp = getEmployeeByLineId(form.employeeId); const employeeName = emp?.name || emp?.displayName || "未命名員工"; const workMinutes = form.clockIn && form.clockOut ? minutesBetween(form.clockIn, form.clockOut) : 0; return { employeeId: form.employeeId, employeeName, department: form.department || emp?.department || getEmployeeDepartments(emp)[0] || "未設定", date: form.date, month: form.date.slice(0, 7), clockIn: form.clockIn || "", clockOut: form.clockOut || "", workMinutes, workHours: formatHours(workMinutes), attendanceStatus: "manualCorrection", lateMinutes: 0, earlyLeaveMinutes: 0, source: form.source || "manual", status: form.clockIn && form.clockOut ? "completed" : "open", note: form.note || "主管手動建立/修改", updatedAt: serverTimestamp() }; }
  async function createAttendanceRecord(e) { e.preventDefault(); if (!attendanceForm.employeeId) return alert("請選擇員工"); if (!attendanceForm.date) return alert("請選擇日期"); const payload = buildAttendancePayload(attendanceForm); const ok = await safeRun(() => addDoc(collection(db, "attendanceRecords"), { ...payload, createdAt: serverTimestamp() }), "新增打卡紀錄失敗。", setGlobalError); if (ok !== null) { setCreatingAttendance(false); await loadAll(); } }
  async function updateAttendanceRecord(record, patch) { const next = { ...record, ...patch }; const workMinutes = next.clockIn && next.clockOut ? minutesBetween(next.clockIn, next.clockOut) : 0; const updatePayload = { ...patch, month: next.date ? next.date.slice(0, 7) : record.month, workMinutes, workHours: formatHours(workMinutes), status: next.clockIn && next.clockOut ? "completed" : "open", updatedAt: serverTimestamp() }; const ok = await safeRun(() => updateDoc(doc(db, "attendanceRecords", record.id), updatePayload), "修改打卡紀錄失敗。", setGlobalError); if (ok !== null) await loadAll(); }
  async function deleteAttendanceRecord(record) { if (!window.confirm(`確定刪除 ${record.employeeName} ${record.date} 的打卡紀錄？`)) return; const ok = await safeRun(() => deleteDoc(doc(db, "attendanceRecords", record.id)), "刪除打卡紀錄失敗。", setGlobalError); if (ok !== null) await loadAll(); }
  function buildCorrectionPayload(form) { const emp = getEmployeeByLineId(form.employeeId); return { employeeId: form.employeeId, employeeName: emp?.name || emp?.displayName || "未命名員工", department: emp?.department || getEmployeeDepartments(emp)[0] || "未設定", type: form.type, date: form.date, time: form.time, reason: form.reason || "主管手動新增", status: form.status || "pending", reviewedBy: form.status === "pending" ? null : currentUser.name, reviewedAt: form.status === "pending" ? null : serverTimestamp(), updatedAt: serverTimestamp() }; }
  async function createCorrectionRequest(e) { e.preventDefault(); if (!correctionForm.employeeId) return alert("請選擇員工"); const payload = buildCorrectionPayload(correctionForm); const ok = await safeRun(() => addDoc(collection(db, "correctionRequests"), { ...payload, createdAt: serverTimestamp() }), "新增補卡資料失敗。", setGlobalError); if (ok !== null) { setCreatingCorrection(false); await loadAll(); } }
  async function updateCorrectionRequest(item, patch) { const payload = { ...patch, updatedAt: serverTimestamp(), ...(patch.status && patch.status !== "pending" ? { reviewedBy: currentUser.name, reviewedAt: serverTimestamp() } : {}) }; const ok = await safeRun(() => updateDoc(doc(db, "correctionRequests", item.id), payload), "修改補卡資料失敗。", setGlobalError); if (ok !== null) await loadAll(); }
  async function deleteCorrectionRequest(item) { if (!window.confirm(`確定刪除 ${item.employeeName} ${item.date} 的補卡申請？`)) return; const ok = await safeRun(() => deleteDoc(doc(db, "correctionRequests", item.id)), "刪除補卡資料失敗。", setGlobalError); if (ok !== null) await loadAll(); }
  async function reviewCorrection(item, approved) { const update = approved ? { status: "approved" } : { status: "rejected" }; const ok = await safeRun(() => updateDoc(doc(db, "correctionRequests", item.id), { ...update, reviewedBy: currentUser.name, reviewedAt: serverTimestamp(), updatedAt: serverTimestamp() }), "更新補卡審核失敗。", setGlobalError); if (ok !== null) await loadAll(); }
  const activeEmployees = employees.filter((emp) => emp.status !== "disabled");
  return <div className="space-y-5"><Card title="員工管理" subtitle="預設顯示員工摘要，點擊修改後才展開詳細資料。"><div className="mb-5 rounded-3xl border border-neutral-200 bg-neutral-50 p-4"><div className="mb-3 flex items-center justify-between gap-3"><div><h3 className="font-bold">手動新增員工</h3><p className="mt-1 text-xs text-neutral-500">LINE ID 可先留空，系統會產生 MANUAL ID。</p></div><button type="button" onClick={() => setCreatingEmployee(!creatingEmployee)} className="rounded-2xl bg-neutral-900 px-4 py-2 text-sm font-bold text-white">{creatingEmployee ? "收合" : "新增員工"}</button></div>{creatingEmployee && <form onSubmit={createManualEmployee} className="grid gap-3 md:grid-cols-3"><Input label="員工姓名" value={manualEmployeeForm.name} onChange={(v) => setManualEmployeeForm({ ...manualEmployeeForm, name: v })} /><Input label="LINE User ID / 員工ID（可先留空）" value={manualEmployeeForm.lineUserId} onChange={(v) => setManualEmployeeForm({ ...manualEmployeeForm, lineUserId: v })} /><Input label="電話" value={manualEmployeeForm.phone} onChange={(v) => setManualEmployeeForm({ ...manualEmployeeForm, phone: v })} /><Select label="狀態" value={manualEmployeeForm.status} onChange={(v) => setManualEmployeeForm({ ...manualEmployeeForm, status: v })}><option value="pending">待審核</option><option value="active">啟用</option><option value="disabled">停用</option></Select><Select label="權限" value={manualEmployeeForm.role} onChange={(v) => setManualEmployeeForm({ ...manualEmployeeForm, role: v })}><option value="employee">員工</option><option value="manager">管理員</option><option value="owner">老闆</option></Select><Input label="時薪" type="number" value={String(manualEmployeeForm.hourlyWage)} onChange={(v) => setManualEmployeeForm({ ...manualEmployeeForm, hourlyWage: Number(v || 0) })} /><div className="md:col-span-2"><DepartmentCheckboxes label="可支援部門" value={manualEmployeeForm.departments} onChange={(departments) => setManualEmployeeForm({ ...manualEmployeeForm, departments })} /></div><Input label="備註" value={manualEmployeeForm.note} onChange={(v) => setManualEmployeeForm({ ...manualEmployeeForm, note: v })} /><button className="rounded-2xl bg-blue-600 px-4 py-3 font-bold text-white md:col-span-3">建立員工資料</button></form>}</div><div className="space-y-3">{employees.map((emp) => { const isEditing = editingEmployeeId === emp.id; const statusLabel = emp.status === "active" ? "啟用" : emp.status === "pending" ? "待審核" : emp.status === "disabled" ? "停用" : emp.status || "未知"; const roleLabel = emp.role === "owner" ? "老闆" : emp.role === "manager" ? "管理員" : "員工"; return <div key={emp.id} className="rounded-2xl border bg-white p-3"><div className="grid gap-3 md:grid-cols-[1.5fr_1fr_1fr_1fr_auto_auto] md:items-center"><div><div className="font-bold">{emp.name || emp.displayName || "未命名員工"}</div><div className="break-all text-xs text-neutral-500">{emp.lineUserId || emp.id}</div></div><div className="text-sm"><span className={`rounded-full px-3 py-1 font-bold ${emp.status === "active" ? "bg-green-50 text-green-700" : emp.status === "disabled" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700"}`}>{statusLabel}</span></div><div className="text-sm text-neutral-600">{roleLabel}</div><div className="text-sm text-neutral-600">{getEmployeeDepartments(emp).join("、")}｜${Number(emp.hourlyWage || 0)}/hr</div><button type="button" onClick={() => setEditingEmployeeId(isEditing ? null : emp.id)} className="rounded-xl bg-neutral-900 px-4 py-2 text-sm font-bold text-white">{isEditing ? "收合" : "修改"}</button><button type="button" onClick={() => deleteEmployee(emp)} className="rounded-xl bg-red-50 px-4 py-2 text-sm font-bold text-red-700">刪除</button></div>{isEditing && <div className="mt-4 grid gap-3 border-t pt-4 md:grid-cols-4"><Input label="姓名" value={emp.name || ""} onChange={(v) => updateEmployee(emp, { name: v })} /><Input label="電話" value={emp.phone || ""} onChange={(v) => updateEmployee(emp, { phone: v })} /><Select label="狀態" value={emp.status || "pending"} onChange={(v) => updateEmployee(emp, { status: v })}><option value="pending">待審核</option><option value="active">啟用</option><option value="disabled">停用</option></Select><Select label="權限" value={emp.role || "employee"} onChange={(v) => updateEmployee(emp, { role: v })}><option value="employee">員工</option><option value="manager">管理員</option><option value="owner">老闆</option></Select><div className="md:col-span-2"><DepartmentCheckboxes label="可支援部門" value={getEmployeeDepartments(emp)} onChange={(departments) => updateEmployee(emp, { departments, department: departments[0] || "烘焙坊" })} /></div><Input label="時薪" type="number" value={String(emp.hourlyWage || 0)} onChange={(v) => updateEmployee(emp, { hourlyWage: Number(v || 0) })} /><Input label="備註" value={emp.note || ""} onChange={(v) => updateEmployee(emp, { note: v })} /></div>}</div>; })}</div></Card><Card title="打卡紀錄管理" subtitle="主管可手動新增、修改、刪除打卡紀錄。"><div className="mb-4 flex justify-end"><button type="button" onClick={() => setCreatingAttendance(!creatingAttendance)} className="rounded-2xl bg-neutral-900 px-4 py-2 text-sm font-bold text-white">{creatingAttendance ? "收合新增" : "新增打卡紀錄"}</button></div>{creatingAttendance && <form onSubmit={createAttendanceRecord} className="mb-5 grid gap-3 rounded-2xl bg-neutral-50 p-4 md:grid-cols-4"><Select label="員工" value={attendanceForm.employeeId} onChange={(v) => { const emp = getEmployeeByLineId(v); setAttendanceForm({ ...attendanceForm, employeeId: v, department: emp?.department || getEmployeeDepartments(emp)[0] || "烘焙坊" }); }}>{activeEmployees.map((emp) => <option key={emp.id} value={emp.lineUserId || emp.id}>{emp.name || emp.displayName}</option>)}</Select><Select label="部門" value={attendanceForm.department} onChange={(v) => setAttendanceForm({ ...attendanceForm, department: v })}>{DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}</Select><Input label="日期" type="date" value={attendanceForm.date} onChange={(v) => setAttendanceForm({ ...attendanceForm, date: v })} /><Input label="上班" type="time" value={attendanceForm.clockIn} onChange={(v) => setAttendanceForm({ ...attendanceForm, clockIn: v })} /><Input label="下班" type="time" value={attendanceForm.clockOut} onChange={(v) => setAttendanceForm({ ...attendanceForm, clockOut: v })} /><Input label="備註" value={attendanceForm.note} onChange={(v) => setAttendanceForm({ ...attendanceForm, note: v })} /><button className="rounded-2xl bg-blue-600 px-4 py-3 font-bold text-white md:col-span-2">建立打卡紀錄</button></form>}<div className="space-y-3">{todayRecords.map((record) => { const isEditing = editingAttendanceId === record.id; return <div key={record.id} className="rounded-2xl border p-3"><div className="grid gap-3 md:grid-cols-[1fr_1fr_1fr_1fr_auto_auto] md:items-center"><div className="font-bold">{record.employeeName}</div><div>{record.date}</div><div>{record.clockIn || "-"} - {record.clockOut || "-"}</div><div>{record.workHours || 0} 小時｜{getAttendanceStatusText(record.attendanceStatus)}</div><button onClick={() => setEditingAttendanceId(isEditing ? null : record.id)} className="rounded-xl bg-neutral-900 px-4 py-2 text-sm font-bold text-white">{isEditing ? "收合" : "修改"}</button><button onClick={() => deleteAttendanceRecord(record)} className="rounded-xl bg-red-50 px-4 py-2 text-sm font-bold text-red-700">刪除</button></div>{isEditing && <div className="mt-4 grid gap-3 border-t pt-4 md:grid-cols-5"><Input label="日期" type="date" value={record.date || ""} onChange={(v) => updateAttendanceRecord(record, { date: v })} /><Input label="上班" type="time" value={record.clockIn || ""} onChange={(v) => updateAttendanceRecord(record, { clockIn: v })} /><Input label="下班" type="time" value={record.clockOut || ""} onChange={(v) => updateAttendanceRecord(record, { clockOut: v })} /><Select label="狀態" value={record.attendanceStatus || "normal"} onChange={(v) => updateAttendanceRecord(record, { attendanceStatus: v })}><option value="normal">正常</option><option value="late">遲到</option><option value="earlyLeave">早退</option><option value="lateAndEarlyLeave">遲到＋早退</option><option value="noSchedule">無排班打卡</option><option value="manualCorrection">補卡修正</option></Select><Input label="備註" value={record.note || ""} onChange={(v) => updateAttendanceRecord(record, { note: v })} /></div>}</div>; })}</div></Card><Card title="補卡審核管理" subtitle="主管可新增、修改、刪除補卡資料，也可通過或退回。"><div className="mb-4 flex justify-end"><button type="button" onClick={() => setCreatingCorrection(!creatingCorrection)} className="rounded-2xl bg-neutral-900 px-4 py-2 text-sm font-bold text-white">{creatingCorrection ? "收合新增" : "新增補卡資料"}</button></div>{creatingCorrection && <form onSubmit={createCorrectionRequest} className="mb-5 grid gap-3 rounded-2xl bg-neutral-50 p-4 md:grid-cols-4"><Select label="員工" value={correctionForm.employeeId} onChange={(v) => setCorrectionForm({ ...correctionForm, employeeId: v })}>{activeEmployees.map((emp) => <option key={emp.id} value={emp.lineUserId || emp.id}>{emp.name || emp.displayName}</option>)}</Select><Select label="類型" value={correctionForm.type} onChange={(v) => setCorrectionForm({ ...correctionForm, type: v })}><option value="clockIn">補上班卡</option><option value="clockOut">補下班卡</option></Select><Input label="日期" type="date" value={correctionForm.date} onChange={(v) => setCorrectionForm({ ...correctionForm, date: v })} /><Input label="時間" type="time" value={correctionForm.time} onChange={(v) => setCorrectionForm({ ...correctionForm, time: v })} /><Select label="狀態" value={correctionForm.status} onChange={(v) => setCorrectionForm({ ...correctionForm, status: v })}><option value="pending">待審核</option><option value="approved">已通過</option><option value="rejected">已退回</option></Select><Input label="原因" value={correctionForm.reason} onChange={(v) => setCorrectionForm({ ...correctionForm, reason: v })} /><button className="rounded-2xl bg-blue-600 px-4 py-3 font-bold text-white md:col-span-2">建立補卡資料</button></form>}<div className="space-y-3">{corrections.map((item) => { const isEditing = editingCorrectionId === item.id; return <div key={item.id} className="rounded-2xl border p-3"><div className="grid gap-3 md:grid-cols-[1fr_1fr_1fr_1fr_auto_auto_auto_auto] md:items-center"><div className="font-bold">{item.employeeName}</div><div>{item.date} {item.time}</div><div>{item.type === "clockIn" ? "補上班" : "補下班"}</div><div>{statusText(item.status)}</div><button onClick={() => reviewCorrection(item, true)} className="rounded-xl bg-green-50 px-3 py-2 text-sm font-bold text-green-700">通過</button><button onClick={() => reviewCorrection(item, false)} className="rounded-xl bg-amber-50 px-3 py-2 text-sm font-bold text-amber-700">退回</button><button onClick={() => setEditingCorrectionId(isEditing ? null : item.id)} className="rounded-xl bg-neutral-900 px-3 py-2 text-sm font-bold text-white">{isEditing ? "收合" : "修改"}</button><button onClick={() => deleteCorrectionRequest(item)} className="rounded-xl bg-red-50 px-3 py-2 text-sm font-bold text-red-700">刪除</button></div>{isEditing && <div className="mt-4 grid gap-3 border-t pt-4 md:grid-cols-5"><Select label="類型" value={item.type || "clockIn"} onChange={(v) => updateCorrectionRequest(item, { type: v })}><option value="clockIn">補上班卡</option><option value="clockOut">補下班卡</option></Select><Input label="日期" type="date" value={item.date || ""} onChange={(v) => updateCorrectionRequest(item, { date: v })} /><Input label="時間" type="time" value={item.time || ""} onChange={(v) => updateCorrectionRequest(item, { time: v })} /><Select label="狀態" value={item.status || "pending"} onChange={(v) => updateCorrectionRequest(item, { status: v })}><option value="pending">待審核</option><option value="approved">已通過</option><option value="rejected">已退回</option></Select><Input label="原因" value={item.reason || ""} onChange={(v) => updateCorrectionRequest(item, { reason: v })} /></div>}</div>; })}</div></Card></div>;
}

function SchedulePanel({ setGlobalError }) {
  const [employees, setEmployees] = useState([]);
  const [boardDepartment, setBoardDepartment] = useState("全部");
  const [selectedMonth, setSelectedMonth] = useState(getMonthString());
  const [selectedWeekIndex, setSelectedWeekIndex] = useState(1);
  const [shiftTemplates, setShiftTemplates] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [saving, setSaving] = useState(false);
  const [shiftForm, setShiftForm] = useState({ name: "烘焙早班", department: "烘焙坊", startTime: "08:00", endTime: "16:00", graceMinutes: DEFAULT_GRACE_MINUTES });
  const [scheduleForm, setScheduleForm] = useState({ employeeId: "", date: todayString(), shiftId: "", note: "" });
  const [quickCell, setQuickCell] = useState(null);
  const weekDates = useMemo(() => getMonthWeekDates(selectedMonth, selectedWeekIndex), [selectedMonth, selectedWeekIndex]);
  const selectedShift = shiftTemplates.find((item) => item.id === scheduleForm.shiftId);
  const boardEmployees = useMemo(() => filterEmployeesByDepartment(employees, boardDepartment), [employees, boardDepartment]);
  const scheduleEmployeeOptions = useMemo(() => selectedShift?.department ? employees.filter((emp) => employeeCanWorkDepartment(emp, selectedShift.department)) : employees, [employees, selectedShift]);
  const quickCellEmployee = useMemo(() => quickCell ? employees.find((emp) => emp.lineUserId === quickCell.employeeId) || null : null, [employees, quickCell]);
  const quickCellShiftOptions = useMemo(() => quickCellEmployee ? shiftTemplates.filter((shift) => employeeCanWorkDepartment(quickCellEmployee, shift.department)) : [], [quickCellEmployee, shiftTemplates]);
  const weekStart = weekDates[0]?.date || todayString();
  const weekEnd = weekDates[6]?.date || todayString();
  useEffect(() => { loadEmployees(); loadShiftTemplates(); }, []);
  useEffect(() => { loadSchedules(); }, [weekStart, weekEnd]);
  useEffect(() => { if (scheduleEmployeeOptions.length && !scheduleEmployeeOptions.some((emp) => emp.lineUserId === scheduleForm.employeeId)) setScheduleForm((prev) => ({ ...prev, employeeId: scheduleEmployeeOptions[0].lineUserId })); }, [scheduleEmployeeOptions, scheduleForm.employeeId]);
  async function loadEmployees() { const snap = await safeRun(() => getDocs(query(collection(db, "employees"), where("status", "==", "active"))), "讀取員工清單失敗。", setGlobalError); if (snap) { const list = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((e) => e.role !== "owner").map((emp) => ({ ...emp, departments: getEmployeeDepartments(emp) })); const sorted = sortByFieldAsc(list, "name"); setEmployees(sorted); if (sorted.length) setScheduleForm((prev) => ({ ...prev, employeeId: prev.employeeId || sorted[0].lineUserId })); } }
  async function loadShiftTemplates() { const snap = await safeRun(() => getDocs(collection(db, "shiftTemplates")), "讀取班次設定失敗。", setGlobalError); if (!snap) return; let rows = sortByFieldAsc(snap.docs.map((d) => ({ id: d.id, ...d.data() })), "name"); if (!rows.length) { const defaults = [ { name: "烘焙早班", department: "烘焙坊", startTime: "08:00", endTime: "16:00", graceMinutes: DEFAULT_GRACE_MINUTES }, { name: "烘焙晚班", department: "烘焙坊", startTime: "13:00", endTime: "21:00", graceMinutes: DEFAULT_GRACE_MINUTES }, { name: "超市早班", department: "超市", startTime: "08:00", endTime: "16:00", graceMinutes: DEFAULT_GRACE_MINUTES }, { name: "超市晚班", department: "超市", startTime: "16:00", endTime: "22:00", graceMinutes: DEFAULT_GRACE_MINUTES } ]; for (const item of defaults) await safeRun(() => addDoc(collection(db, "shiftTemplates"), { ...item, scheduledMinutes: minutesBetween(item.startTime, item.endTime), createdAt: serverTimestamp(), updatedAt: serverTimestamp() }), "建立預設班次失敗。", setGlobalError); const nextSnap = await safeRun(() => getDocs(collection(db, "shiftTemplates")), "重新讀取班次失敗。", setGlobalError); if (nextSnap) rows = sortByFieldAsc(nextSnap.docs.map((d) => ({ id: d.id, ...d.data() })), "name"); } setShiftTemplates(rows); if (rows.length) setScheduleForm((prev) => ({ ...prev, shiftId: prev.shiftId || rows[0].id })); }
  async function loadSchedules() { const snap = await safeRun(() => getDocs(query(collection(db, "schedules"), where("date", ">=", weekStart), where("date", "<=", weekEnd))), "讀取週排班失敗。", setGlobalError); if (snap) setSchedules(sortByFieldAsc(snap.docs.map((d) => ({ id: d.id, ...d.data() })), "date")); }
  async function createShiftTemplate(e) { e.preventDefault(); if (!shiftForm.name.trim()) return alert("請填寫班次名稱"); if (minutesBetween(shiftForm.startTime, shiftForm.endTime) <= 0) return alert("下班時間必須晚於上班時間"); setSaving(true); const ok = await safeRun(() => addDoc(collection(db, "shiftTemplates"), { name: shiftForm.name.trim(), department: shiftForm.department, startTime: shiftForm.startTime, endTime: shiftForm.endTime, scheduledMinutes: minutesBetween(shiftForm.startTime, shiftForm.endTime), graceMinutes: Number(shiftForm.graceMinutes || DEFAULT_GRACE_MINUTES), createdAt: serverTimestamp(), updatedAt: serverTimestamp() }), "新增班次失敗。", setGlobalError); if (ok) await loadShiftTemplates(); setSaving(false); }
  async function removeShiftTemplate(shiftId) { const ok = await safeRun(() => deleteDoc(doc(db, "shiftTemplates", shiftId)), "刪除班次失敗。", setGlobalError); if (ok !== null) await loadShiftTemplates(); }
  async function writeSchedule(emp, shift, date, note = "") { return safeRun(() => addDoc(collection(db, "schedules"), { employeeId: emp.lineUserId, employeeName: emp.name || emp.displayName, department: shift.department, date, month: date.slice(0, 7), shiftId: shift.id, shiftName: shift.name, startTime: shift.startTime, endTime: shift.endTime, scheduledMinutes: minutesBetween(shift.startTime, shift.endTime), graceMinutes: Number(shift.graceMinutes ?? DEFAULT_GRACE_MINUTES), note, status: "scheduled", createdAt: serverTimestamp(), updatedAt: serverTimestamp() }), "新增排班失敗。", setGlobalError); }
  async function assignShift(e) { e?.preventDefault?.(); const emp = employees.find((x) => x.lineUserId === scheduleForm.employeeId); const shift = shiftTemplates.find((x) => x.id === scheduleForm.shiftId); if (!emp) return alert("請選擇員工"); if (!shift) return alert("請選擇班次"); if (!employeeCanWorkDepartment(emp, shift.department)) return alert(`${emp.name || emp.displayName} 目前沒有設定可支援「${shift.department}」。`); setSaving(true); const ok = await writeSchedule(emp, shift, scheduleForm.date, scheduleForm.note.trim()); if (ok) { setScheduleForm((prev) => ({ ...prev, note: "" })); await loadSchedules(); } setSaving(false); }
  async function removeSchedule(scheduleId) { const ok = await safeRun(() => deleteDoc(doc(db, "schedules", scheduleId)), "刪除排班失敗。", setGlobalError); if (ok !== null) await loadSchedules(); }
  function selectCell(employeeId, date) { setScheduleForm((prev) => ({ ...prev, employeeId, date })); setQuickCell({ employeeId, date }); }
  async function assignShiftToCell(shift) { if (!quickCell || !quickCellEmployee || !shift) return; setSaving(true); const ok = await writeSchedule(quickCellEmployee, shift, quickCell.date); if (ok) { setQuickCell(null); await loadSchedules(); } setSaving(false); }
  const getCellSchedules = (employeeId, date) => schedules.filter((item) => item.employeeId === employeeId && item.date === date);
  return <div className="space-y-5"><div className="grid gap-5 lg:grid-cols-2"><Card title="班次設定"><form onSubmit={createShiftTemplate} className="space-y-4"><Input label="班次名稱" value={shiftForm.name} onChange={(v) => setShiftForm({ ...shiftForm, name: v })} /><Select label="部門" value={shiftForm.department} onChange={(v) => setShiftForm({ ...shiftForm, department: v })}>{DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}</Select><div className="grid gap-3 md:grid-cols-3"><Input label="上班時間" type="time" value={shiftForm.startTime} onChange={(v) => setShiftForm({ ...shiftForm, startTime: v })} /><Input label="下班時間" type="time" value={shiftForm.endTime} onChange={(v) => setShiftForm({ ...shiftForm, endTime: v })} /><Input label="寬限分鐘" type="number" value={String(shiftForm.graceMinutes)} onChange={(v) => setShiftForm({ ...shiftForm, graceMinutes: Number(v || 0) })} /></div><button disabled={saving} className="w-full rounded-2xl bg-neutral-900 px-4 py-3 font-bold text-white disabled:opacity-50">新增班次</button></form><div className="mt-5 space-y-2">{shiftTemplates.map((shift) => <div key={shift.id} className="flex items-center justify-between rounded-2xl bg-neutral-100 p-3 text-sm"><div><div className="font-bold">{shift.name}｜{shift.department}</div><div className="text-neutral-500">{shift.startTime} - {shift.endTime}</div></div><button onClick={() => removeShiftTemplate(shift.id)} className="rounded-xl bg-white px-3 py-2 font-bold">刪除</button></div>)}</div></Card><Card title="快速排班"><form onSubmit={assignShift} className="space-y-4"><div className="grid grid-cols-2 gap-3"><Input label="月份" type="month" value={selectedMonth} onChange={setSelectedMonth} /><Select label="週次" value={String(selectedWeekIndex)} onChange={(v) => setSelectedWeekIndex(Number(v))}>{[1,2,3,4,5].map((n) => <option key={n} value={String(n)}>第{n}週</option>)}</Select></div><Input label="排班日期" type="date" value={scheduleForm.date} onChange={(v) => setScheduleForm({ ...scheduleForm, date: v })} /><Select label="員工" value={scheduleForm.employeeId} onChange={(v) => setScheduleForm({ ...scheduleForm, employeeId: v })}>{scheduleEmployeeOptions.map((emp) => <option key={emp.id} value={emp.lineUserId}>{emp.name || emp.displayName}｜{getEmployeeDepartments(emp).join("、")}</option>)}</Select><Select label="班次" value={scheduleForm.shiftId} onChange={(v) => setScheduleForm({ ...scheduleForm, shiftId: v })}>{shiftTemplates.map((shift) => <option key={shift.id} value={shift.id}>{shift.name}｜{shift.startTime}-{shift.endTime}</option>)}</Select><Input label="備註" value={scheduleForm.note} onChange={(v) => setScheduleForm({ ...scheduleForm, note: v })} /><button disabled={saving || !employees.length || !shiftTemplates.length} className="w-full rounded-2xl bg-blue-600 px-4 py-3 font-bold text-white disabled:opacity-50">{saving ? "儲存中..." : "加入排班"}</button></form></Card></div><Card title="週排班表" subtitle={`${weekStart} ～ ${weekEnd}`}><div className="mb-4 grid gap-3 md:grid-cols-[1fr_auto] md:items-center"><div className="flex flex-wrap gap-2">{["全部", ...DEPARTMENTS].map((department) => <button key={department} type="button" onClick={() => setBoardDepartment(department)} className={`rounded-2xl px-4 py-2 text-sm font-bold ${boardDepartment === department ? "bg-neutral-900 text-white" : "bg-neutral-100 text-neutral-600"}`}>{department}</button>)}</div><div className="flex flex-wrap gap-2"><Input label="月份" type="month" value={selectedMonth} onChange={setSelectedMonth} /><Select label="週次" value={String(selectedWeekIndex)} onChange={(v) => setSelectedWeekIndex(Number(v))}>{[1,2,3,4,5].map((n) => <option key={n} value={String(n)}>第{n}週</option>)}</Select></div></div><div className="overflow-x-auto"><table className="w-full min-w-[980px] border-separate border-spacing-0 text-sm"><thead><tr><th className="sticky left-0 z-10 bg-white p-3 text-left text-neutral-500">員工</th>{weekDates.map((day) => <th key={day.date} className={`border-l p-3 text-center ${day.date === todayString() ? "bg-blue-50 text-blue-700" : "bg-white text-neutral-500"}`}><div className="font-bold">{day.weekday}</div><div>{day.mmdd}</div>{day.date === todayString() && <div className="text-xs">今</div>}</th>)}</tr></thead><tbody>{boardEmployees.map((emp) => <tr key={emp.id}><td className="sticky left-0 z-10 border-t bg-white p-3 font-bold"><div>{emp.name || emp.displayName}</div><div className="text-xs font-normal text-neutral-500">{getEmployeeDepartments(emp).join("、")}</div></td>{weekDates.map((day) => { const cellItems = getCellSchedules(emp.lineUserId, day.date); return <td key={`${emp.id}-${day.date}`} onClick={() => selectCell(emp.lineUserId, day.date)} className="min-h-24 cursor-pointer border-l border-t p-2 align-top hover:bg-neutral-50">{cellItems.length === 0 ? <div className="py-4 text-center text-neutral-300">＋ 新增</div> : <div className="space-y-2">{cellItems.map((item) => <div key={item.id} className="rounded-xl bg-blue-50 p-2 text-center text-blue-700"><div className="font-bold">{item.shiftName || item.department}</div><div className="text-xs">{item.startTime}-{item.endTime}</div><button onClick={(e) => { e.stopPropagation(); removeSchedule(item.id); }} className="mt-1 rounded-lg bg-white px-2 py-1 text-xs text-neutral-500">刪除</button></div>)}</div>}</td>; })}</tr>)}</tbody></table></div></Card>{quickCell && quickCellEmployee && <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 p-4 md:items-center"><div className="w-full max-w-md rounded-3xl bg-white p-5 shadow-xl"><div className="mb-4 flex items-start justify-between gap-4"><div><h3 className="text-lg font-bold">新增班次</h3><p className="mt-1 text-sm text-neutral-500">{quickCellEmployee.name || quickCellEmployee.displayName}｜{quickCell.date}</p><p className="mt-1 text-xs text-neutral-400">可支援：{getEmployeeDepartments(quickCellEmployee).join("、")}</p></div><button onClick={() => setQuickCell(null)} className="rounded-full bg-neutral-100 px-3 py-2 text-sm font-bold">關閉</button></div><div className="grid gap-3">{quickCellShiftOptions.map((shift) => <button key={shift.id} disabled={saving} onClick={() => assignShiftToCell(shift)} className="rounded-2xl border border-neutral-200 p-4 text-left transition hover:bg-neutral-50 disabled:opacity-50"><div className="font-bold">{shift.name}</div><div className="mt-1 text-sm text-neutral-500">{shift.department}｜{shift.startTime} - {shift.endTime}</div></button>)}</div></div></div>}</div>;
}

function SalaryPanel({ setGlobalError }) {
  const [month, setMonth] = useState(getMonthString());
  const [employees, setEmployees] = useState([]);
  const [records, setRecords] = useState([]);
  useEffect(() => { load(); }, [month]);
  async function load() { const employeeSnap = await safeRun(() => getDocs(query(collection(db, "employees"), where("status", "==", "active"))), "讀取薪資員工清單失敗。", setGlobalError); if (employeeSnap) setEmployees(sortByFieldAsc(employeeSnap.docs.map((d) => ({ id: d.id, ...d.data() })), "name")); const recordSnap = await safeRun(() => getDocs(query(collection(db, "attendanceRecords"), where("month", "==", month))), "讀取薪資月報失敗。", setGlobalError); if (recordSnap) setRecords(sortByFieldAsc(recordSnap.docs.map((d) => ({ id: d.id, ...d.data() })), "date")); }
  const rows = employees.map((emp) => { const empRecords = records.filter((r) => r.employeeId === emp.lineUserId); const totalMinutes = empRecords.reduce((sum, r) => sum + Number(r.workMinutes || 0), 0); const hours = formatHours(totalMinutes); return { id: emp.id, name: emp.name || emp.displayName, department: getEmployeeDepartments(emp).join("、"), hourlyWage: Number(emp.hourlyWage || 0), totalMinutes, hours, salary: Math.round(hours * Number(emp.hourlyWage || 0)), days: empRecords.length, abnormalCount: empRecords.filter((r) => r.attendanceStatus && r.attendanceStatus !== "normal").length }; });
  return <Card title="薪資月報"><div className="mb-4 max-w-xs"><Input label="月份" type="month" value={month} onChange={setMonth} /></div><div className="overflow-x-auto"><table className="w-full min-w-[820px] border-separate border-spacing-y-2 text-sm"><thead className="text-left text-neutral-500"><tr><th className="px-3 py-2">員工</th><th className="px-3 py-2">可支援部門</th><th className="px-3 py-2">出勤天數</th><th className="px-3 py-2">總分鐘</th><th className="px-3 py-2">總工時</th><th className="px-3 py-2">時薪</th><th className="px-3 py-2">異常</th><th className="px-3 py-2">預估薪資</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id} className="bg-neutral-100"><td className="rounded-l-2xl px-3 py-3 font-bold">{row.name}</td><td className="px-3 py-3">{row.department}</td><td className="px-3 py-3">{row.days}</td><td className="px-3 py-3">{row.totalMinutes}</td><td className="px-3 py-3">{row.hours}</td><td className="px-3 py-3">${row.hourlyWage}</td><td className="px-3 py-3">{row.abnormalCount}</td><td className="rounded-r-2xl px-3 py-3 font-bold">${row.salary.toLocaleString()}</td></tr>)}</tbody></table></div></Card>;
}

function RecordTable({ records }) {
  if (!records.length) return <div className="mt-4 rounded-2xl bg-neutral-100 p-4 text-sm text-neutral-500">目前沒有紀錄</div>;
  return <div className="mt-5 overflow-x-auto"><table className="w-full min-w-[980px] border-separate border-spacing-y-2 text-sm"><thead className="text-left text-neutral-500"><tr><th className="px-3 py-2">日期</th><th className="px-3 py-2">員工</th><th className="px-3 py-2">部門</th><th className="px-3 py-2">班表</th><th className="px-3 py-2">上班</th><th className="px-3 py-2">下班</th><th className="px-3 py-2">分鐘</th><th className="px-3 py-2">工時</th><th className="px-3 py-2">狀態</th><th className="px-3 py-2">來源</th></tr></thead><tbody>{records.map((r) => <tr key={r.id} className="bg-neutral-100"><td className="rounded-l-2xl px-3 py-3">{r.date}</td><td className="px-3 py-3 font-bold">{r.employeeName}</td><td className="px-3 py-3">{r.department || "-"}</td><td className="px-3 py-3">{r.scheduledStart || "-"} - {r.scheduledEnd || "-"}</td><td className="px-3 py-3">{r.clockIn || "-"}</td><td className="px-3 py-3">{r.clockOut || "-"}</td><td className="px-3 py-3">{r.workMinutes || 0}</td><td className="px-3 py-3">{r.workHours || 0}</td><td className="px-3 py-3">{getAttendanceStatusText(r.attendanceStatus)}</td><td className="rounded-r-2xl px-3 py-3">{r.source || "normal"}</td></tr>)}</tbody></table></div>;
}

export default App;
