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
 * 目前功能：
 * 1. LIFF / DEV_MODE 雙模式。
 * 2. 正式模式：用 LINE profile.userId 判定身份。
 *    - userId 在 OWNER_LINE_USER_IDS：自動建立 / 進入老闆帳號。
 *    - Firestore employees/{userId} 已存在：依 status / role 進入員工或主管。
 *    - Firestore 沒有資料：顯示「申請加入員工系統」。
 * 3. 員工申請、主管後台、員工 CRUD、打卡紀錄 CRUD、補卡 CRUD。
 * 4. 排班、部門、時薪 / 正職薪資、薪資單加扣項、部門薪資統計。
 * 5. 公司定位設定與打卡定位驗證。
 */

// ===== 🔥 上線設定區（只需要改這裡） =====
// 開發測試保持 true；正式接 LINE LIFF 時改 false。
const DEV_MODE = false;
const DEV_LOGIN_AS = "owner"; // DEV_MODE=true 時才會使用：owner / newEmployee / employee
const LIFF_ID = "2009896295-aplNwbiH";
const OWNER_LINE_USER_IDS = ["U0d01ce43203dbcf0d3a94436b60eb232"];
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
const DEFAULT_FULL_TIME_MONTHLY_HOURS = 160;
const DEV_ALLOW_LOCATION_FALLBACK = true;

const DEFAULT_COMPANY_LOCATIONS = [
  { name: "烘焙坊", latitude: 23.7096, longitude: 120.5433, radiusMeters: 150 },
  { name: "超市", latitude: 23.7096, longitude: 120.5433, radiusMeters: 150 },
];

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
  const [h, m] = String(hhmm).split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
};

const minutesBetween = (startHHMM, endHHMM) => {
  const start = toMinutes(startHHMM);
  const end = toMinutes(endHHMM);
  if (start === null || end === null) return 0;
  return Math.max(0, end - start);
};

const formatHours = (minutes) => Math.round((Number(minutes || 0) / 60) * 100) / 100;

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
  const employeeType = form.employeeType || "hourly";
  return {
    id: lineUserId,
    lineUserId,
    name: form.name.trim(),
    displayName: form.displayName?.trim() || form.name.trim(),
    pictureUrl: "",
    role: form.role || "employee",
    status: form.status || "active",
    employeeType,
    department: departments[0],
    departments,
    hourlyWage: Number(form.hourlyWage || 0),
    baseSalary: Number(form.baseSalary || 0),
    overtimeHourlyWage: Number(form.overtimeHourlyWage || form.hourlyWage || 0),
    phone: form.phone?.trim() || "",
    note: form.note?.trim() || "主管手動新增",
  };
}

function calculateSalary({ employeeType, totalMinutes, hourlyWage, baseSalary, overtimeHourlyWage, adjustments = [], standardMonthlyHours = DEFAULT_FULL_TIME_MONTHLY_HOURS }) {
  const hours = formatHours(totalMinutes);
  const additions = adjustments.filter((item) => item.type === "addition").reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const deductions = adjustments.filter((item) => item.type === "deduction").reduce((sum, item) => sum + Number(item.amount || 0), 0);
  if (employeeType === "fullTime") {
    const overtimeHours = Math.max(0, Math.round((hours - standardMonthlyHours) * 100) / 100);
    const basePay = Number(baseSalary || 0);
    const overtimePay = Math.round(overtimeHours * Number(overtimeHourlyWage || 0));
    return { hours, overtimeHours, basePay, overtimePay, additions, deductions, salaryBeforeAdjustments: basePay + overtimePay, salary: Math.round(basePay + overtimePay + additions - deductions) };
  }
  const basePay = Math.round(hours * Number(hourlyWage || 0));
  return { hours, overtimeHours: 0, basePay, overtimePay: 0, additions, deductions, salaryBeforeAdjustments: basePay, salary: Math.round(basePay + additions - deductions) };
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

function getMonthDates(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(year, monthNumber, 0).getDate();
  const weekdayLabels = ["日", "一", "二", "三", "四", "五", "六"];

  return Array.from({ length: lastDay }).map((_, index) => {
    const day = index + 1;
    const dateObj = new Date(year, monthNumber - 1, day);
    const dd = String(day).padStart(2, "0");
    return {
      day,
      date: `${year}-${String(monthNumber).padStart(2, "0")}-${dd}`,
      weekday: weekdayLabels[dateObj.getDay()],
    };
  });
}

function getDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function getGeolocationErrorMessage(error) {
  const code = error?.code;
  if (code === 1) return "定位權限被拒絕。請到瀏覽器或 LINE 的網站設定中允許定位權限。";
  if (code === 2) return "目前無法取得定位。請確認 GPS、Wi-Fi 或行動網路已開啟，並稍後再試。";
  if (code === 3) return "取得定位逾時。請移到收訊較好的地方後再試一次。";
  if (!navigator.geolocation) return "此瀏覽器不支援定位。";
  return error?.message || "定位失敗，請確認定位權限已開啟。";
}

async function getCurrentPositionSafe() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("此瀏覽器不支援定位。"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve(position),
      (error) => reject(new Error(getGeolocationErrorMessage(error))),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
    );
  });
}

function buildDevPosition(locations) {
  const first = locations?.[0] || DEFAULT_COMPANY_LOCATIONS[0];
  return {
    coords: {
      latitude: Number(first.latitude),
      longitude: Number(first.longitude),
      accuracy: 0,
    },
    __devFallback: true,
  };
}

async function getClockPosition(companyLocations) {
  try {
    return await getCurrentPositionSafe();
  } catch (error) {
    if (DEV_MODE && DEV_ALLOW_LOCATION_FALLBACK) {
      console.warn("DEV_MODE location fallback:", error);
      return buildDevPosition(companyLocations);
    }
    throw error;
  }
}

function findMatchedCompanyLocation(companyLocations, latitude, longitude) {
  return (companyLocations || []).find((location) => {
    const distance = getDistanceMeters(latitude, longitude, Number(location.latitude), Number(location.longitude));
    return distance <= Number(location.radiusMeters || 150);
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

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);

  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function downloadCsv(filename, headers, rows) {
  const csv = [headers, ...rows]
    .map((row) => row.map(csvEscape).join(","))
    .join("\n");

  const blob = new Blob(["﻿" + csv], {
    type: "text/csv;charset=utf-8;",
  });

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;

  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  URL.revokeObjectURL(url);
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
  console.assert(getMonthDates("2026-05").length === 31, "month dates should return every day in selected month");
  console.assert(isNetworkFetchError({ message: "TypeError: Failed to fetch" }) === true, "failed fetch should be detected");
  console.assert(isOfflineError({ message: "Failed to get document because the client is offline." }) === true, "offline errors should be detected");
  console.assert(calculateSalary({ employeeType: "hourly", totalMinutes: 600, hourlyWage: 200 }).salary === 2000, "hourly salary should use total hours times hourly wage");
  console.assert(calculateSalary({ employeeType: "fullTime", totalMinutes: 9660, baseSalary: 30000, overtimeHourlyWage: 200 }).salary === 30200, "full-time salary should add overtime pay after standard hours");
  console.assert(calculateSalary({ employeeType: "hourly", totalMinutes: 600, hourlyWage: 200, adjustments: [{ type: "addition", amount: 500 }, { type: "deduction", amount: 100 }] }).salary === 2400, "salary should apply additions and deductions");
  console.assert(getGeolocationErrorMessage({ code: 1 }).includes("定位權限"), "geolocation permission error should be readable");
  console.assert(getDistanceMeters(23.7096, 120.5433, 23.7096, 120.5433) === 0, "same location distance should be 0");
  console.assert(csvEscape('a,b') === '"a,b"', "csvEscape should quote commas");
  console.assert(csvEscape('a"b') === '"a""b"', "csvEscape should escape quotes");
}
runSelfTests();

const isFirebaseConfigReady = () => Boolean(firebaseConfig.apiKey && firebaseConfig.projectId && !firebaseConfig.apiKey.includes("請貼上"));
const isLiffReady = () => Boolean(LIFF_ID && !LIFF_ID.includes("請貼上"));

function App() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [profile, setProfile] = useState(null);
  const [employee, setEmployee] = useState(null);
  const [todayRecords, setTodayRecords] = useState([]);
  const [todaySchedules, setTodaySchedules] = useState([]);
  const [activeTab, setActiveTab] = useState("clock");
  const [companyLocations, setCompanyLocations] = useState(DEFAULT_COMPANY_LOCATIONS);

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
    await loadCompanyLocations();

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
        employeeType: "hourly",
        department: DEV_LOGIN_AS === "owner" ? "管理" : "烘焙坊",
        departments: DEV_LOGIN_AS === "owner" ? ["烘焙坊", "超市"] : ["烘焙坊"],
        hourlyWage: DEV_LOGIN_AS === "owner" ? 0 : 190,
        baseSalary: 0,
        overtimeHourlyWage: DEV_LOGIN_AS === "owner" ? 0 : 190,
        phone: "",
        note: "Firebase 離線時的 DEV fallback，不會寫入資料庫。",
      });
      setLoading(false);
      return;
    }

    if (employeeSnap?.exists()) {
      const employeeData = { id: employeeSnap.id, ...employeeSnap.data() };
      setEmployee(employeeData);
      await Promise.all([loadTodayRecords(lineProfile.userId), loadTodaySchedules(lineProfile.userId)]);
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
        employeeType: "hourly",
        department: "管理",
        departments: ["烘焙坊", "超市"],
        hourlyWage: 0,
        baseSalary: 0,
        overtimeHourlyWage: 0,
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

  async function loadCompanyLocations() {
    const settingSnap = await safeRun(() => getDoc(doc(db, "settings", "companyLocations")), "讀取公司定位設定失敗。", setError);
    if (settingSnap?.exists()) {
      const data = settingSnap.data();
      if (Array.isArray(data.locations) && data.locations.length) {
        setCompanyLocations(data.locations);
      }
    }
  }

  async function loadTodayRecords(userId) {
    const date = todayString();
    const snap = await safeRun(() => getDocs(query(collection(db, "attendanceRecords"), where("employeeId", "==", userId), where("date", "==", date), limit(50))), "讀取今日打卡失敗。", setError);
    if (!snap) return;
    setTodayRecords(sortByCreatedAtDesc(snap.docs.map((item) => ({ id: item.id, ...item.data() }))));
  }

  async function loadTodaySchedules(userId) {
    const date = todayString();
    const snap = await safeRun(() => getDocs(query(collection(db, "schedules"), where("employeeId", "==", userId), where("date", "==", date), limit(50))), "讀取今日班表失敗。", setError);
    if (!snap) return;
    setTodaySchedules(sortByFieldAsc(snap.docs.map((item) => ({ id: item.id, ...item.data() })), "startTime"));
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
      employeeType: "hourly",
      department: form.department,
      departments: [form.department],
      hourlyWage: 0,
      baseSalary: 0,
      overtimeHourlyWage: 0,
      phone: form.phone.trim(),
      note: form.note.trim(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    const ok = await safeRun(() => setDoc(doc(db, "employees", profile.userId), data), "送出加入申請失敗。", setError);
    if (ok !== null) setEmployee({ id: profile.userId, ...data });
  }

  async function clockIn(selectedSchedule = null, selectedDepartment = "") {
    if (!profile || !employee) return;
    try {
      const position = await getClockPosition(companyLocations);
      const latitude = position.coords.latitude;
      const longitude = position.coords.longitude;
      const matchedLocation = findMatchedCompanyLocation(companyLocations, latitude, longitude);

      if (!matchedLocation) {
        alert("你目前不在公司允許打卡範圍內。");
        return;
      }

      const date = todayString();
      const time = currentTimeString();
      const check = evaluateAttendance({ schedule: selectedSchedule, clockIn: time, clockOut: "" });
      const department = selectedSchedule?.department || selectedDepartment || employee.department || matchedLocation.name || "未設定";
      const data = {
        employeeId: profile.userId,
        employeeName: employee.name || profile.displayName,
        department,
        date,
        month: date.slice(0, 7),
        scheduleId: selectedSchedule?.id || null,
        scheduledStart: selectedSchedule?.startTime || "",
        scheduledEnd: selectedSchedule?.endTime || "",
        clockIn: time,
        clockOut: "",
        clockInAt: serverTimestamp(),
        clockOutAt: null,
        workMinutes: 0,
        workHours: 0,
        attendanceStatus: check.attendanceStatus,
        lateMinutes: check.lateMinutes,
        earlyLeaveMinutes: 0,
        source: position.__devFallback ? "dev-location-fallback" : "normal",
        locationVerified: true,
        locationName: matchedLocation.name,
        latitude,
        longitude,
        status: "open",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      const ref = await safeRun(() => addDoc(collection(db, "attendanceRecords"), data), "上班打卡失敗。", setError);
      if (ref) setTodayRecords((prev) => [{ id: ref.id, ...data }, ...prev]);
    } catch (err) {
      const message = err?.message || "定位失敗，請開啟手機定位權限後再打卡。";
      alert(message);
      console.error(err);
    }
  }

  async function clockOut(record, selectedSchedule = null) {
    if (!record?.id) return;
    try {
      const position = await getClockPosition(companyLocations);
      const latitude = position.coords.latitude;
      const longitude = position.coords.longitude;
      const matchedLocation = findMatchedCompanyLocation(companyLocations, latitude, longitude);

      if (!matchedLocation) {
        alert("你目前不在公司允許打卡範圍內。");
        return;
      }

      const scheduleForRecord = selectedSchedule || todaySchedules.find((schedule) => schedule.id === record.scheduleId) || null;
      const time = currentTimeString();
      const workMinutes = minutesBetween(record.clockIn, time);
      const check = evaluateAttendance({ schedule: scheduleForRecord, clockIn: record.clockIn, clockOut: time });
      const updateData = {
        clockOut: time,
        clockOutAt: serverTimestamp(),
        workMinutes,
        workHours: formatHours(workMinutes),
        attendanceStatus: check.attendanceStatus,
        lateMinutes: check.lateMinutes,
        earlyLeaveMinutes: check.earlyLeaveMinutes,
        status: "completed",
        locationVerified: true,
        clockOutLocationName: matchedLocation.name,
        clockOutLatitude: latitude,
        clockOutLongitude: longitude,
        updatedAt: serverTimestamp(),
      };
      const ok = await safeRun(() => updateDoc(doc(db, "attendanceRecords", record.id), updateData), "下班打卡失敗。", setError);
      if (ok !== null) setTodayRecords((prev) => prev.map((item) => item.id === record.id ? { ...item, ...updateData } : item));
    } catch (err) {
      const message = err?.message || "定位失敗，請開啟手機定位權限後再打卡。";
      alert(message);
      console.error(err);
    }
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
        {DEV_MODE && <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">目前是 DEV_MODE，身份：<b>{DEV_LOGIN_AS}</b>。定位失敗時會使用公司預設位置作為測試 fallback。</div>}
        <nav className="mb-5 grid grid-cols-2 gap-2 md:grid-cols-6">
          <TabButton active={activeTab === "clock"} onClick={() => setActiveTab("clock")}>打卡</TabButton>
          <TabButton active={activeTab === "correction"} onClick={() => setActiveTab("correction")}>補卡</TabButton>
          <TabButton active={activeTab === "myStats"} onClick={() => setActiveTab("myStats")}>我的統計</TabButton>
          {isManager && <TabButton active={activeTab === "admin"} onClick={() => setActiveTab("admin")}>主管後台</TabButton>}
          {isManager && <TabButton active={activeTab === "schedule"} onClick={() => setActiveTab("schedule")}>排班</TabButton>}
          {isManager && <TabButton active={activeTab === "salary"} onClick={() => setActiveTab("salary")}>薪資單</TabButton>}
        </nav>
        {activeTab === "clock" && <ClockPanel employee={employee} todayRecords={todayRecords} todaySchedules={todaySchedules} onClockIn={clockIn} onClockOut={clockOut} onReload={() => Promise.all([loadTodayRecords(profile.userId), loadTodaySchedules(profile.userId)])} />}
        {activeTab === "correction" && <CorrectionPanel employee={employee} profile={profile} setGlobalError={setError} />}
        {activeTab === "myStats" && <MyStatsPanel employee={employee} setGlobalError={setError} />}
        {activeTab === "admin" && isManager && <AdminPanel currentUser={employee} setGlobalError={setError} companyLocations={companyLocations} setCompanyLocations={setCompanyLocations} />}
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
function Card({ title, subtitle, children, compact = false }) {
  return <section className={`rounded-3xl bg-white shadow-sm ${compact ? "p-4" : "p-5"}`}><div className={compact ? "mb-2" : "mb-4"}><h2 className={compact ? "text-base font-bold" : "text-lg font-bold"}>{title}</h2>{subtitle && <p className={`mt-1 text-neutral-500 ${compact ? "text-xs" : "text-sm"}`}>{subtitle}</p>}</div>{children}</section>;
}
function Input({ label, value, onChange, type = "text" }) {
  return <label className="block min-w-0"><span className="mb-1 block text-sm font-medium text-neutral-700">{label}</span><input type={type} value={value} onChange={(e) => onChange(e.target.value)} className="box-border h-12 w-full min-w-0 max-w-full appearance-none rounded-2xl border border-neutral-200 bg-white px-4 text-base leading-none outline-none focus:border-neutral-900" style={{ WebkitAppearance: "none" }} /></label>;
}
function Select({ label, value, onChange, children }) {
  return <label className="block min-w-0"><span className="mb-1 block text-sm font-medium text-neutral-700">{label}</span><select value={value} onChange={(e) => onChange(e.target.value)} className="box-border h-12 w-full min-w-0 max-w-full appearance-none rounded-2xl border border-neutral-200 bg-white px-4 text-base leading-none outline-none focus:border-neutral-900" style={{ WebkitAppearance: "none" }}>{children}</select></label>;
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

function ClockPanel({ employee, todayRecords, todaySchedules, onClockIn, onClockOut, onReload }) {
  const employeeDepartments = getEmployeeDepartments(employee);
  const [selectedScheduleId, setSelectedScheduleId] = useState("");
  const [selectedDepartment, setSelectedDepartment] = useState(employeeDepartments[0] || "烘焙坊");

  const openRecords = todayRecords.filter((record) => !record.clockOut);
  const selectedSchedule = todaySchedules.find((schedule) => schedule.id === selectedScheduleId) || todaySchedules[0] || null;
  const activeRecord = selectedSchedule ? openRecords.find((record) => record.scheduleId === selectedSchedule.id) || null : openRecords[0] || null;
  const clockDepartment = selectedSchedule?.department || selectedDepartment;

  return <div className="space-y-4">
    <section className="rounded-3xl bg-red-600 p-4 text-white shadow-sm">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-bold">今日班表</h2>
          <p className="mt-1 text-xs text-red-100">{todayString()}</p>
        </div>
        <button onClick={onReload} className="rounded-2xl bg-white/15 px-3 py-2 text-xs font-bold text-white">重新整理</button>
      </div>

      {todaySchedules.length > 0 ? <div className="space-y-3">
        <Select label="選擇今日班次" value={selectedSchedule?.id || ""} onChange={setSelectedScheduleId}>
          {todaySchedules.map((schedule) => <option key={schedule.id} value={schedule.id}>{schedule.department}｜{schedule.startTime}-{schedule.endTime}</option>)}
        </Select>
        <div className="rounded-2xl bg-white/15 px-3 py-2 text-sm">
          <div className="font-bold">{selectedSchedule?.department || employee.department || "未設定"}</div>
          <div>{selectedSchedule?.startTime || "--:--"} - {selectedSchedule?.endTime || "--:--"}</div>
        </div>
      </div> : <div className="space-y-3">
        <div className="rounded-2xl bg-white/15 px-3 py-2 text-xs">今天尚未排班。若仍打卡，系統會標記為「無排班打卡」。</div>
        {employeeDepartments.length > 1 && <Select label="選擇上班部門" value={selectedDepartment} onChange={setSelectedDepartment}>{employeeDepartments.map((department) => <option key={department} value={department}>{department}</option>)}</Select>}
      </div>}

      <div className="mt-4 grid gap-3">
        {!activeRecord ? <button onClick={() => onClockIn(selectedSchedule, clockDepartment)} className="rounded-2xl bg-white px-4 py-4 text-lg font-black text-red-600 shadow-sm">上班打卡</button> : <button onClick={() => onClockOut(activeRecord, selectedSchedule)} className="rounded-2xl bg-white px-4 py-4 text-lg font-black text-red-600 shadow-sm">下班打卡</button>}
        {activeRecord && <div className="text-center text-xs text-red-100">目前進行中：{activeRecord.clockIn} 上班｜{activeRecord.department}</div>}
      </div>
    </section>

    <Card title="今日紀錄" subtitle="打卡後會出現在這裡，可支援一天多時段。">
      {todayRecords.length === 0 ? <div className="rounded-2xl bg-neutral-100 p-4 text-sm text-neutral-500">今天尚無打卡紀錄</div> : <div className="space-y-3">{todayRecords.map((record) => <div key={record.id} className="rounded-2xl border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="font-bold">{record.department || "未設定部門"}</div>
            <div className="text-sm text-neutral-500">{record.clockIn || "-"} - {record.clockOut || "尚未下班"}</div>
          </div>
          <div className="text-right text-sm">
            <div className="font-bold">{record.clockOut ? `${record.workHours || 0} 小時` : "進行中"}</div>
            <div className="text-xs text-neutral-500">{getAttendanceStatusText(record.attendanceStatus)}</div>
          </div>
        </div>
        {record.attendanceStatus && record.attendanceStatus !== "normal" && <div className="mt-3 rounded-xl bg-red-50 p-2 text-xs text-red-700">{getAttendanceStatusText(record.attendanceStatus)}{record.lateMinutes > 0 ? `｜遲到 ${record.lateMinutes} 分` : ""}{record.earlyLeaveMinutes > 0 ? `｜早退 ${record.earlyLeaveMinutes} 分` : ""}</div>}
      </div>)}</div>}
    </Card>
  </div>;
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

function CompanyLocationPanel({ companyLocations, setCompanyLocations, setGlobalError }) {
  const [form, setForm] = useState({ name: "", latitude: "", longitude: "", radiusMeters: 150 });
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [editingIndex, setEditingIndex] = useState(null);

  async function saveLocations(nextLocations) {
    setSaving(true);
    const ok = await safeRun(() => setDoc(doc(db, "settings", "companyLocations"), { locations: nextLocations, updatedAt: serverTimestamp() }, { merge: true }), "儲存公司定位設定失敗。", setGlobalError);
    if (ok !== null) setCompanyLocations(nextLocations);
    setSaving(false);
  }

  async function addLocation(e) {
    e.preventDefault();
    if (!form.name.trim()) return alert("請填寫地點名稱");
    if (!form.latitude || !form.longitude) return alert("請填寫緯度與經度");
    const nextLocation = { name: form.name.trim(), latitude: Number(form.latitude), longitude: Number(form.longitude), radiusMeters: Number(form.radiusMeters || 150) };
    if (Number.isNaN(nextLocation.latitude) || Number.isNaN(nextLocation.longitude)) return alert("緯度與經度必須是數字");
    await saveLocations([...companyLocations, nextLocation]);
    setForm({ name: "", latitude: "", longitude: "", radiusMeters: 150 });
  }

  async function updateLocation(index, patch) {
    const nextLocations = companyLocations.map((location, i) => i === index ? { ...location, ...patch } : location);
    await saveLocations(nextLocations);
  }

  async function deleteLocation(index) {
    const okConfirm = window.confirm("確定刪除這個公司打卡位置？");
    if (!okConfirm) return;
    const nextLocations = companyLocations.filter((_, i) => i !== index);
    await saveLocations(nextLocations);
  }

  async function useCurrentLocation() {
    try {
      const position = await getCurrentPositionSafe();
      setForm((prev) => ({ ...prev, latitude: String(position.coords.latitude), longitude: String(position.coords.longitude) }));
    } catch (err) {
      console.error(err);
      alert(err?.message || "取得目前定位失敗，請確認瀏覽器定位權限已開啟。");
    }
  }

  return <Card title="公司定位設定" subtitle="設定允許打卡的位置與半徑。員工打卡時必須在任一地點範圍內。"><div className="mb-4 flex items-center justify-between"><div className="text-sm text-neutral-500">目前共 {companyLocations.length} 個打卡地點</div><button type="button" onClick={() => setExpanded(!expanded)} className="rounded-2xl bg-neutral-900 px-4 py-2 text-sm font-bold text-white">{expanded ? "收合設定" : "展開設定"}</button></div>{expanded && <><form onSubmit={addLocation} className="mb-5 grid gap-3 rounded-2xl bg-neutral-50 p-4 md:grid-cols-5"><Input label="地點名稱" value={form.name} onChange={(v) => setForm({ ...form, name: v })} /><Input label="緯度 latitude" type="number" value={String(form.latitude)} onChange={(v) => setForm({ ...form, latitude: v })} /><Input label="經度 longitude" type="number" value={String(form.longitude)} onChange={(v) => setForm({ ...form, longitude: v })} /><Input label="允許半徑/公尺" type="number" value={String(form.radiusMeters)} onChange={(v) => setForm({ ...form, radiusMeters: Number(v || 150) })} /><div className="grid gap-2"><button type="button" onClick={useCurrentLocation} className="rounded-2xl bg-white px-4 py-3 text-sm font-bold text-neutral-700">使用目前位置</button><button disabled={saving} className="rounded-2xl bg-blue-600 px-4 py-3 text-sm font-bold text-white disabled:opacity-50">新增地點</button></div></form><div className="space-y-3">{companyLocations.length === 0 ? <div className="rounded-2xl bg-amber-50 p-4 text-sm text-amber-800">尚未設定公司位置。未設定時，建議先新增至少一個位置再正式使用打卡。</div> : companyLocations.map((location, index) => {
        const isEditing = editingIndex === index;
        return <div key={`${location.name}-${index}`} className="rounded-2xl border p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-bold">{location.name}</div>
              <div className="text-xs text-neutral-500">{location.radiusMeters} 公尺內可打卡</div>
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => setEditingIndex(isEditing ? null : index)} className="rounded-xl bg-neutral-900 px-4 py-2 text-sm font-bold text-white">{isEditing ? "收合" : "修改"}</button>
              <button type="button" onClick={() => deleteLocation(index)} className="rounded-xl bg-red-50 px-4 py-2 text-sm font-bold text-red-700">刪除</button>
            </div>
          </div>

          {isEditing && <div className="mt-4 grid gap-3 border-t pt-4 md:grid-cols-4">
            <Input label="地點名稱" value={location.name || ""} onChange={(v) => updateLocation(index, { name: v })} />
            <Input label="緯度" type="number" value={String(location.latitude || "")} onChange={(v) => updateLocation(index, { latitude: Number(v || 0) })} />
            <Input label="經度" type="number" value={String(location.longitude || "")} onChange={(v) => updateLocation(index, { longitude: Number(v || 0) })} />
            <Input label="半徑/公尺" type="number" value={String(location.radiusMeters || 150)} onChange={(v) => updateLocation(index, { radiusMeters: Number(v || 150) })} />
          </div>}
        </div>;
      })}</div></>}</Card>;
}

function AdminPanel({ currentUser, setGlobalError, companyLocations, setCompanyLocations }) {
  const [employeesExpanded, setEmployeesExpanded] = useState(false);
  const [attendanceExpanded, setAttendanceExpanded] = useState(false);
  const [correctionsExpanded, setCorrectionsExpanded] = useState(false);
  const [employees, setEmployees] = useState([]);
  const [corrections, setCorrections] = useState([]);
  const [todayRecords, setTodayRecords] = useState([]);
  const [creatingEmployee, setCreatingEmployee] = useState(false);
  const [editingEmployeeId, setEditingEmployeeId] = useState(null);
  const [creatingAttendance, setCreatingAttendance] = useState(false);
  const [editingAttendanceId, setEditingAttendanceId] = useState(null);
  const [creatingCorrection, setCreatingCorrection] = useState(false);
  const [editingCorrectionId, setEditingCorrectionId] = useState(null);
  const [manualEmployeeForm, setManualEmployeeForm] = useState({ lineUserId: "", name: "", displayName: "", phone: "", role: "employee", status: "active", employeeType: "hourly", departments: ["烘焙坊"], hourlyWage: 190, baseSalary: 0, overtimeHourlyWage: 190, note: "" });
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
  async function createManualEmployee(e) { e.preventDefault(); if (!manualEmployeeForm.name.trim()) return alert("請填寫員工姓名"); const data = buildManualEmployeeData(manualEmployeeForm); const ok = await safeRun(() => setDoc(doc(db, "employees", data.lineUserId), { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true }), "建立員工資料失敗。", setGlobalError); if (ok !== null) { setManualEmployeeForm({ lineUserId: "", name: "", displayName: "", phone: "", role: "employee", status: "active", employeeType: "hourly", departments: ["烘焙坊"], hourlyWage: 190, baseSalary: 0, overtimeHourlyWage: 190, note: "" }); setCreatingEmployee(false); await loadAll(); } }
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
  return <div className="space-y-5"><CompanyLocationPanel companyLocations={companyLocations} setCompanyLocations={setCompanyLocations} setGlobalError={setGlobalError} /><Card title="員工管理" subtitle="預設顯示員工摘要，點擊修改後才展開詳細資料。"><div className="mb-4 flex items-center justify-between"><div className="text-sm text-neutral-500">目前共 {employees.length} 位員工</div><button type="button" onClick={() => setEmployeesExpanded(!employeesExpanded)} className="rounded-2xl bg-neutral-900 px-4 py-2 text-sm font-bold text-white">{employeesExpanded ? "收合" : "展開"}</button></div>{employeesExpanded && <><div className="mb-5 rounded-3xl border border-neutral-200 bg-neutral-50 p-4"><div className="mb-3 flex items-center justify-between gap-3"><div><h3 className="font-bold">手動新增員工</h3><p className="mt-1 text-xs text-neutral-500">LINE ID 可先留空，系統會產生 MANUAL ID。</p></div><button type="button" onClick={() => setCreatingEmployee(!creatingEmployee)} className="rounded-2xl bg-neutral-900 px-4 py-2 text-sm font-bold text-white">{creatingEmployee ? "收合" : "新增員工"}</button></div>{creatingEmployee && <form onSubmit={createManualEmployee} className="grid gap-3 md:grid-cols-3"><Input label="員工姓名" value={manualEmployeeForm.name} onChange={(v) => setManualEmployeeForm({ ...manualEmployeeForm, name: v })} /><Input label="LINE User ID / 員工ID（可先留空）" value={manualEmployeeForm.lineUserId} onChange={(v) => setManualEmployeeForm({ ...manualEmployeeForm, lineUserId: v })} /><Input label="電話" value={manualEmployeeForm.phone} onChange={(v) => setManualEmployeeForm({ ...manualEmployeeForm, phone: v })} /><Select label="狀態" value={manualEmployeeForm.status} onChange={(v) => setManualEmployeeForm({ ...manualEmployeeForm, status: v })}><option value="pending">待審核</option><option value="active">啟用</option><option value="disabled">停用</option></Select><Select label="權限" value={manualEmployeeForm.role} onChange={(v) => setManualEmployeeForm({ ...manualEmployeeForm, role: v })}><option value="employee">員工</option><option value="manager">管理員</option><option value="owner">老闆</option></Select><Select label="薪資類型" value={manualEmployeeForm.employeeType} onChange={(v) => setManualEmployeeForm({ ...manualEmployeeForm, employeeType: v })}><option value="hourly">時薪員工</option><option value="fullTime">正職員工</option></Select>{manualEmployeeForm.employeeType === "hourly" ? <Input label="時薪" type="number" value={String(manualEmployeeForm.hourlyWage)} onChange={(v) => setManualEmployeeForm({ ...manualEmployeeForm, hourlyWage: Number(v || 0), overtimeHourlyWage: Number(v || 0) })} /> : <><Input label="底薪" type="number" value={String(manualEmployeeForm.baseSalary)} onChange={(v) => setManualEmployeeForm({ ...manualEmployeeForm, baseSalary: Number(v || 0) })} /><Input label="加班時薪" type="number" value={String(manualEmployeeForm.overtimeHourlyWage)} onChange={(v) => setManualEmployeeForm({ ...manualEmployeeForm, overtimeHourlyWage: Number(v || 0) })} /></>}<div className="md:col-span-2"><DepartmentCheckboxes label="可支援部門" value={manualEmployeeForm.departments} onChange={(departments) => setManualEmployeeForm({ ...manualEmployeeForm, departments })} /></div><Input label="備註" value={manualEmployeeForm.note} onChange={(v) => setManualEmployeeForm({ ...manualEmployeeForm, note: v })} /><button className="rounded-2xl bg-blue-600 px-4 py-3 font-bold text-white md:col-span-3">建立員工資料</button></form>}</div><div className="space-y-3">{employees.map((emp) => { const isEditing = editingEmployeeId === emp.id; const statusLabel = emp.status === "active" ? "啟用" : emp.status === "pending" ? "待審核" : emp.status === "disabled" ? "停用" : emp.status || "未知"; const roleLabel = emp.role === "owner" ? "老闆" : emp.role === "manager" ? "管理員" : "員工"; return <div key={emp.id} className="rounded-2xl border bg-white p-3"><div className="grid gap-3 md:grid-cols-[1.5fr_1fr_1fr_1fr_auto_auto] md:items-center"><div><div className="font-bold">{emp.name || emp.displayName || "未命名員工"}</div><div className="break-all text-xs text-neutral-500">{emp.lineUserId || emp.id}</div></div><div className="text-sm"><span className={`rounded-full px-3 py-1 font-bold ${emp.status === "active" ? "bg-green-50 text-green-700" : emp.status === "disabled" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700"}`}>{statusLabel}</span></div><div className="text-sm text-neutral-600">{roleLabel}</div><div className="text-sm text-neutral-600">{getEmployeeDepartments(emp).join("、")}｜{emp.employeeType === "fullTime" ? `正職 $${Number(emp.baseSalary || 0).toLocaleString()}＋加班$${Number(emp.overtimeHourlyWage || 0)}/hr` : `時薪 $${Number(emp.hourlyWage || 0)}/hr`}</div><button type="button" onClick={() => setEditingEmployeeId(isEditing ? null : emp.id)} className="rounded-xl bg-neutral-900 px-4 py-2 text-sm font-bold text-white">{isEditing ? "收合" : "修改"}</button><button type="button" onClick={() => deleteEmployee(emp)} className="rounded-xl bg-red-50 px-4 py-2 text-sm font-bold text-red-700">刪除</button></div>{isEditing && <div className="mt-4 grid gap-3 border-t pt-4 md:grid-cols-4"><Input label="姓名" value={emp.name || ""} onChange={(v) => updateEmployee(emp, { name: v })} /><Input label="電話" value={emp.phone || ""} onChange={(v) => updateEmployee(emp, { phone: v })} /><Select label="狀態" value={emp.status || "pending"} onChange={(v) => updateEmployee(emp, { status: v })}><option value="pending">待審核</option><option value="active">啟用</option><option value="disabled">停用</option></Select><Select label="權限" value={emp.role || "employee"} onChange={(v) => updateEmployee(emp, { role: v })}><option value="employee">員工</option><option value="manager">管理員</option><option value="owner">老闆</option></Select><div className="md:col-span-2"><DepartmentCheckboxes label="可支援部門" value={getEmployeeDepartments(emp)} onChange={(departments) => updateEmployee(emp, { departments, department: departments[0] || "烘焙坊" })} /></div><Select label="薪資類型" value={emp.employeeType || "hourly"} onChange={(v) => updateEmployee(emp, { employeeType: v })}><option value="hourly">時薪員工</option><option value="fullTime">正職員工</option></Select>{(emp.employeeType || "hourly") === "hourly" ? <Input label="時薪" type="number" value={String(emp.hourlyWage || 0)} onChange={(v) => updateEmployee(emp, { hourlyWage: Number(v || 0), overtimeHourlyWage: Number(v || 0) })} /> : <><Input label="底薪" type="number" value={String(emp.baseSalary || 0)} onChange={(v) => updateEmployee(emp, { baseSalary: Number(v || 0) })} /><Input label="加班時薪" type="number" value={String(emp.overtimeHourlyWage || 0)} onChange={(v) => updateEmployee(emp, { overtimeHourlyWage: Number(v || 0) })} /></>}<Input label="備註" value={emp.note || ""} onChange={(v) => updateEmployee(emp, { note: v })} /></div>}</div>; })}</div></>}</Card><Card title="打卡紀錄管理" subtitle="主管可手動新增、修改、刪除打卡紀錄。"><div className="mb-4 flex items-center justify-between"><div className="text-sm text-neutral-500">今日共 {todayRecords.length} 筆打卡紀錄</div><button type="button" onClick={() => setAttendanceExpanded(!attendanceExpanded)} className="rounded-2xl bg-neutral-900 px-4 py-2 text-sm font-bold text-white">{attendanceExpanded ? "收合" : "展開"}</button></div>{attendanceExpanded && <><div className="mb-4 flex justify-end"><button type="button" onClick={() => setCreatingAttendance(!creatingAttendance)} className="rounded-2xl bg-neutral-900 px-4 py-2 text-sm font-bold text-white">{creatingAttendance ? "收合新增" : "新增打卡紀錄"}</button></div>{creatingAttendance && <form onSubmit={createAttendanceRecord} className="mb-5 grid gap-3 rounded-2xl bg-neutral-50 p-4 md:grid-cols-4"><Select label="員工" value={attendanceForm.employeeId} onChange={(v) => { const emp = getEmployeeByLineId(v); setAttendanceForm({ ...attendanceForm, employeeId: v, department: emp?.department || getEmployeeDepartments(emp)[0] || "烘焙坊" }); }}>{activeEmployees.map((emp) => <option key={emp.id} value={emp.lineUserId || emp.id}>{emp.name || emp.displayName}</option>)}</Select><Select label="部門" value={attendanceForm.department} onChange={(v) => setAttendanceForm({ ...attendanceForm, department: v })}>{DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}</Select><Input label="日期" type="date" value={attendanceForm.date} onChange={(v) => setAttendanceForm({ ...attendanceForm, date: v })} /><Input label="上班" type="time" value={attendanceForm.clockIn} onChange={(v) => setAttendanceForm({ ...attendanceForm, clockIn: v })} /><Input label="下班" type="time" value={attendanceForm.clockOut} onChange={(v) => setAttendanceForm({ ...attendanceForm, clockOut: v })} /><Input label="備註" value={attendanceForm.note} onChange={(v) => setAttendanceForm({ ...attendanceForm, note: v })} /><button className="rounded-2xl bg-blue-600 px-4 py-3 font-bold text-white md:col-span-2">建立打卡紀錄</button></form>}<div className="space-y-3">{todayRecords.map((record) => { const isEditing = editingAttendanceId === record.id; return <div key={record.id} className="rounded-2xl border p-3"><div className="grid gap-3 md:grid-cols-[1fr_1fr_1fr_1fr_auto_auto] md:items-center"><div className="font-bold">{record.employeeName}</div><div>{record.date}</div><div>{record.clockIn || "-"} - {record.clockOut || "-"}</div><div>{record.workHours || 0} 小時｜{getAttendanceStatusText(record.attendanceStatus)}</div><button onClick={() => setEditingAttendanceId(isEditing ? null : record.id)} className="rounded-xl bg-neutral-900 px-4 py-2 text-sm font-bold text-white">{isEditing ? "收合" : "修改"}</button><button onClick={() => deleteAttendanceRecord(record)} className="rounded-xl bg-red-50 px-4 py-2 text-sm font-bold text-red-700">刪除</button></div>{isEditing && <div className="mt-4 grid gap-3 border-t pt-4 md:grid-cols-5"><Input label="日期" type="date" value={record.date || ""} onChange={(v) => updateAttendanceRecord(record, { date: v })} /><Input label="上班" type="time" value={record.clockIn || ""} onChange={(v) => updateAttendanceRecord(record, { clockIn: v })} /><Input label="下班" type="time" value={record.clockOut || ""} onChange={(v) => updateAttendanceRecord(record, { clockOut: v })} /><Select label="狀態" value={record.attendanceStatus || "normal"} onChange={(v) => updateAttendanceRecord(record, { attendanceStatus: v })}><option value="normal">正常</option><option value="late">遲到</option><option value="earlyLeave">早退</option><option value="lateAndEarlyLeave">遲到＋早退</option><option value="noSchedule">無排班打卡</option><option value="manualCorrection">補卡修正</option></Select><Input label="備註" value={record.note || ""} onChange={(v) => updateAttendanceRecord(record, { note: v })} /></div>}</div>; })}</div></>}</Card><Card title="補卡審核管理" subtitle="主管可新增、修改、刪除補卡資料，也可通過或退回。"><div className="mb-4 flex items-center justify-between"><div className="text-sm text-neutral-500">目前共 {corrections.length} 筆補卡申請</div><button type="button" onClick={() => setCorrectionsExpanded(!correctionsExpanded)} className="rounded-2xl bg-neutral-900 px-4 py-2 text-sm font-bold text-white">{correctionsExpanded ? "收合" : "展開"}</button></div>{correctionsExpanded && <><div className="mb-4 flex justify-end"><button type="button" onClick={() => setCreatingCorrection(!creatingCorrection)} className="rounded-2xl bg-neutral-900 px-4 py-2 text-sm font-bold text-white">{creatingCorrection ? "收合新增" : "新增補卡資料"}</button></div>{creatingCorrection && <form onSubmit={createCorrectionRequest} className="mb-5 grid gap-3 rounded-2xl bg-neutral-50 p-4 md:grid-cols-4"><Select label="員工" value={correctionForm.employeeId} onChange={(v) => setCorrectionForm({ ...correctionForm, employeeId: v })}>{activeEmployees.map((emp) => <option key={emp.id} value={emp.lineUserId || emp.id}>{emp.name || emp.displayName}</option>)}</Select><Select label="類型" value={correctionForm.type} onChange={(v) => setCorrectionForm({ ...correctionForm, type: v })}><option value="clockIn">補上班卡</option><option value="clockOut">補下班卡</option></Select><Input label="日期" type="date" value={correctionForm.date} onChange={(v) => setCorrectionForm({ ...correctionForm, date: v })} /><Input label="時間" type="time" value={correctionForm.time} onChange={(v) => setCorrectionForm({ ...correctionForm, time: v })} /><Select label="狀態" value={correctionForm.status} onChange={(v) => setCorrectionForm({ ...correctionForm, status: v })}><option value="pending">待審核</option><option value="approved">已通過</option><option value="rejected">已退回</option></Select><Input label="原因" value={correctionForm.reason} onChange={(v) => setCorrectionForm({ ...correctionForm, reason: v })} /><button className="rounded-2xl bg-blue-600 px-4 py-3 font-bold text-white md:col-span-2">建立補卡資料</button></form>}<div className="space-y-3">{corrections.map((item) => { const isEditing = editingCorrectionId === item.id; return <div key={item.id} className="rounded-2xl border p-3"><div className="grid gap-3 md:grid-cols-[1fr_1fr_1fr_1fr_auto_auto_auto_auto] md:items-center"><div className="font-bold">{item.employeeName}</div><div>{item.date} {item.time}</div><div>{item.type === "clockIn" ? "補上班" : "補下班"}</div><div>{statusText(item.status)}</div><button onClick={() => reviewCorrection(item, true)} className="rounded-xl bg-green-50 px-3 py-2 text-sm font-bold text-green-700">通過</button><button onClick={() => reviewCorrection(item, false)} className="rounded-xl bg-amber-50 px-3 py-2 text-sm font-bold text-amber-700">退回</button><button onClick={() => setEditingCorrectionId(isEditing ? null : item.id)} className="rounded-xl bg-neutral-900 px-3 py-2 text-sm font-bold text-white">{isEditing ? "收合" : "修改"}</button><button onClick={() => deleteCorrectionRequest(item)} className="rounded-xl bg-red-50 px-3 py-2 text-sm font-bold text-red-700">刪除</button></div>{isEditing && <div className="mt-4 grid gap-3 border-t pt-4 md:grid-cols-5"><Select label="類型" value={item.type || "clockIn"} onChange={(v) => updateCorrectionRequest(item, { type: v })}><option value="clockIn">補上班卡</option><option value="clockOut">補下班卡</option></Select><Input label="日期" type="date" value={item.date || ""} onChange={(v) => updateCorrectionRequest(item, { date: v })} /><Input label="時間" type="time" value={item.time || ""} onChange={(v) => updateCorrectionRequest(item, { time: v })} /><Select label="狀態" value={item.status || "pending"} onChange={(v) => updateCorrectionRequest(item, { status: v })}><option value="pending">待審核</option><option value="approved">已通過</option><option value="rejected">已退回</option></Select><Input label="原因" value={item.reason || ""} onChange={(v) => updateCorrectionRequest(item, { reason: v })} /></div>}</div>; })}</div></>}</Card></div>;
}

function SchedulePanel({ setGlobalError }) {
  const [employees, setEmployees] = useState([]);
  const [boardDepartment, setBoardDepartment] = useState("全部");
  const [selectedMonth, setSelectedMonth] = useState(getMonthString());
  const [selectedWeekIndex, setSelectedWeekIndex] = useState(1);
  const [shiftTemplates, setShiftTemplates] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [saving, setSaving] = useState(false);
  const [editingShiftId, setEditingShiftId] = useState(null);
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
  async function updateShiftTemplate(shift, patch) {
    const next = { ...shift, ...patch };
    const ok = await safeRun(
      () => updateDoc(doc(db, "shiftTemplates", shift.id), {
        ...patch,
        scheduledMinutes: minutesBetween(next.startTime, next.endTime),
        updatedAt: serverTimestamp(),
      }),
      "修改班次失敗。",
      setGlobalError
    );
    if (ok !== null) await loadShiftTemplates();
  }

  async function removeShiftTemplate(shiftId) { const ok = await safeRun(() => deleteDoc(doc(db, "shiftTemplates", shiftId)), "刪除班次失敗。", setGlobalError); if (ok !== null) await loadShiftTemplates(); }
  async function writeSchedule(emp, shift, date, note = "") { return safeRun(() => addDoc(collection(db, "schedules"), { employeeId: emp.lineUserId, employeeName: emp.name || emp.displayName, department: shift.department, date, month: date.slice(0, 7), shiftId: shift.id, shiftName: shift.name, startTime: shift.startTime, endTime: shift.endTime, scheduledMinutes: minutesBetween(shift.startTime, shift.endTime), graceMinutes: Number(shift.graceMinutes ?? DEFAULT_GRACE_MINUTES), note, status: "scheduled", createdAt: serverTimestamp(), updatedAt: serverTimestamp() }), "新增排班失敗。", setGlobalError); }
  async function assignShift(e) { e?.preventDefault?.(); const emp = employees.find((x) => x.lineUserId === scheduleForm.employeeId); const shift = shiftTemplates.find((x) => x.id === scheduleForm.shiftId); if (!emp) return alert("請選擇員工"); if (!shift) return alert("請選擇班次"); if (!employeeCanWorkDepartment(emp, shift.department)) return alert(`${emp.name || emp.displayName} 目前沒有設定可支援「${shift.department}」。`); setSaving(true); const ok = await writeSchedule(emp, shift, scheduleForm.date, scheduleForm.note.trim()); if (ok) { setScheduleForm((prev) => ({ ...prev, note: "" })); await loadSchedules(); } setSaving(false); }
  async function removeSchedule(scheduleId) { const ok = await safeRun(() => deleteDoc(doc(db, "schedules", scheduleId)), "刪除排班失敗。", setGlobalError); if (ok !== null) await loadSchedules(); }
  function selectCell(employeeId, date) { setScheduleForm((prev) => ({ ...prev, employeeId, date })); setQuickCell({ employeeId, date }); }
  async function assignShiftToCell(shift) { if (!quickCell || !quickCellEmployee || !shift) return; setSaving(true); const ok = await writeSchedule(quickCellEmployee, shift, quickCell.date); if (ok) { setQuickCell(null); await loadSchedules(); } setSaving(false); }
  const getCellSchedules = (employeeId, date) => schedules.filter((item) => item.employeeId === employeeId && item.date === date);

  function exportScheduleCsv() {
    const headers = ["員工", "可支援部門", ...weekDates.map((day) => `${day.weekday} ${day.date}`)];
    const rows = boardEmployees.map((emp) => [
      emp.name || emp.displayName || "未命名員工",
      getEmployeeDepartments(emp).join("、"),
      ...weekDates.map((day) => getCellSchedules(emp.lineUserId, day.date).map((item) => `${item.shiftName || item.department} ${item.startTime}-${item.endTime}`).join(" / ")),
    ]);
    downloadCsv(`schedule-${selectedMonth}-week${selectedWeekIndex}.csv`, headers, rows);
  }

  function exportMonthlyScheduleCsv() {
    const monthDates = getMonthDates(selectedMonth);
    const headers = ["日期", "星期", ...boardEmployees.map((emp) => emp.name || emp.displayName || "未命名員工")];
    const rows = monthDates.map((day) => [
      day.day,
      day.weekday,
      ...boardEmployees.map((emp) => {
        const shifts = schedules
          .filter((item) => item.employeeId === emp.lineUserId && item.date === day.date)
          .map((item) => `${item.startTime}-${item.endTime}`)
          .join(" / ");
        return shifts || "X";
      }),
    ]);
    downloadCsv(`monthly-schedule-${selectedMonth}.csv`, headers, rows);
  }

  return <div className="space-y-5"><div className="grid gap-5 lg:grid-cols-2"><Card title="班次設定"><form onSubmit={createShiftTemplate} className="space-y-4"><Input label="班次名稱" value={shiftForm.name} onChange={(v) => setShiftForm({ ...shiftForm, name: v })} /><Select label="部門" value={shiftForm.department} onChange={(v) => setShiftForm({ ...shiftForm, department: v })}>{DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}</Select><div className="grid gap-3 md:grid-cols-3"><Input label="上班時間" type="time" value={shiftForm.startTime} onChange={(v) => setShiftForm({ ...shiftForm, startTime: v })} /><Input label="下班時間" type="time" value={shiftForm.endTime} onChange={(v) => setShiftForm({ ...shiftForm, endTime: v })} /><Input label="寬限分鐘" type="number" value={String(shiftForm.graceMinutes)} onChange={(v) => setShiftForm({ ...shiftForm, graceMinutes: Number(v || 0) })} /></div><button disabled={saving} className="w-full rounded-2xl bg-neutral-900 px-4 py-3 font-bold text-white disabled:opacity-50">新增班次</button></form><div className="mt-5 space-y-2">{shiftTemplates.map((shift) => { const isEditing = editingShiftId === shift.id; return <div key={shift.id} className="rounded-2xl bg-neutral-100 p-3 text-sm"><div className="flex items-center justify-between gap-3"><div><div className="font-bold">{shift.name}｜{shift.department}</div><div className="text-neutral-500">{shift.startTime} - {shift.endTime}｜寬限 {shift.graceMinutes ?? DEFAULT_GRACE_MINUTES} 分</div></div><div className="flex gap-2"><button type="button" onClick={() => setEditingShiftId(isEditing ? null : shift.id)} className="rounded-xl bg-neutral-900 px-3 py-2 font-bold text-white">{isEditing ? "收合" : "修改"}</button><button type="button" onClick={() => removeShiftTemplate(shift.id)} className="rounded-xl bg-white px-3 py-2 font-bold">刪除</button></div></div>{isEditing && <div className="mt-4 grid gap-3 border-t border-neutral-200 pt-4 md:grid-cols-5"><Input label="班次名稱" value={shift.name || ""} onChange={(v) => updateShiftTemplate(shift, { name: v })} /><Select label="部門" value={shift.department || "烘焙坊"} onChange={(v) => updateShiftTemplate(shift, { department: v })}>{DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}</Select><Input label="上班時間" type="time" value={shift.startTime || ""} onChange={(v) => updateShiftTemplate(shift, { startTime: v })} /><Input label="下班時間" type="time" value={shift.endTime || ""} onChange={(v) => updateShiftTemplate(shift, { endTime: v })} /><Input label="寬限分鐘" type="number" value={String(shift.graceMinutes ?? DEFAULT_GRACE_MINUTES)} onChange={(v) => updateShiftTemplate(shift, { graceMinutes: Number(v || 0) })} /></div>}</div>; })}</div></Card><Card title="快速排班"><form onSubmit={assignShift} className="space-y-4"><div className="grid grid-cols-2 gap-3"><Input label="月份" type="month" value={selectedMonth} onChange={setSelectedMonth} /><Select label="週次" value={String(selectedWeekIndex)} onChange={(v) => setSelectedWeekIndex(Number(v))}>{[1,2,3,4,5].map((n) => <option key={n} value={String(n)}>第{n}週</option>)}</Select></div><Input label="排班日期" type="date" value={scheduleForm.date} onChange={(v) => setScheduleForm({ ...scheduleForm, date: v })} /><Select label="員工" value={scheduleForm.employeeId} onChange={(v) => setScheduleForm({ ...scheduleForm, employeeId: v })}>{scheduleEmployeeOptions.map((emp) => <option key={emp.id} value={emp.lineUserId}>{emp.name || emp.displayName}｜{getEmployeeDepartments(emp).join("、")}</option>)}</Select><Select label="班次" value={scheduleForm.shiftId} onChange={(v) => setScheduleForm({ ...scheduleForm, shiftId: v })}>{shiftTemplates.map((shift) => <option key={shift.id} value={shift.id}>{shift.name}｜{shift.startTime}-{shift.endTime}</option>)}</Select><Input label="備註" value={scheduleForm.note} onChange={(v) => setScheduleForm({ ...scheduleForm, note: v })} /><button disabled={saving || !employees.length || !shiftTemplates.length} className="w-full rounded-2xl bg-blue-600 px-4 py-3 font-bold text-white disabled:opacity-50">{saving ? "儲存中..." : "加入排班"}</button></form></Card></div><Card title="週排班表" subtitle={`${weekStart} ～ ${weekEnd}`}><div className="mb-4 flex flex-wrap justify-end gap-2"><button type="button" onClick={exportMonthlyScheduleCsv} className="rounded-2xl bg-white px-4 py-2 text-sm font-bold text-neutral-700 shadow-sm">匯出月班表 CSV</button><button type="button" onClick={exportScheduleCsv} className="rounded-2xl bg-neutral-900 px-4 py-2 text-sm font-bold text-white">匯出週班表 CSV</button></div><div className="mb-4 grid gap-3 md:grid-cols-[1fr_auto] md:items-center"><div className="flex flex-wrap gap-2">{["全部", ...DEPARTMENTS].map((department) => <button key={department} type="button" onClick={() => setBoardDepartment(department)} className={`rounded-2xl px-4 py-2 text-sm font-bold ${boardDepartment === department ? "bg-neutral-900 text-white" : "bg-neutral-100 text-neutral-600"}`}>{department}</button>)}</div><div className="flex flex-wrap gap-2"><Input label="月份" type="month" value={selectedMonth} onChange={setSelectedMonth} /><Select label="週次" value={String(selectedWeekIndex)} onChange={(v) => setSelectedWeekIndex(Number(v))}>{[1,2,3,4,5].map((n) => <option key={n} value={String(n)}>第{n}週</option>)}</Select></div></div><div className="overflow-x-auto"><table className="w-full min-w-[980px] border-separate border-spacing-0 text-sm"><thead><tr><th className="sticky left-0 z-10 bg-white p-3 text-left text-neutral-500">員工</th>{weekDates.map((day) => <th key={day.date} className={`border-l p-3 text-center ${day.date === todayString() ? "bg-blue-50 text-blue-700" : "bg-white text-neutral-500"}`}><div className="font-bold">{day.weekday}</div><div>{day.mmdd}</div>{day.date === todayString() && <div className="text-xs">今</div>}</th>)}</tr></thead><tbody>{boardEmployees.map((emp) => <tr key={emp.id}><td className="sticky left-0 z-10 border-t bg-white p-3 font-bold"><div>{emp.name || emp.displayName}</div><div className="text-xs font-normal text-neutral-500">{getEmployeeDepartments(emp).join("、")}</div></td>{weekDates.map((day) => { const cellItems = getCellSchedules(emp.lineUserId, day.date); return <td key={`${emp.id}-${day.date}`} onClick={() => selectCell(emp.lineUserId, day.date)} className="min-h-24 cursor-pointer border-l border-t p-2 align-top hover:bg-neutral-50">{cellItems.length === 0 ? <div className="py-4 text-center text-neutral-300">＋ 新增</div> : <div className="space-y-2">{cellItems.map((item) => <div key={item.id} className="rounded-xl bg-blue-50 p-2 text-center text-blue-700"><div className="font-bold">{item.shiftName || item.department}</div><div className="text-xs">{item.startTime}-{item.endTime}</div><button onClick={(e) => { e.stopPropagation(); removeSchedule(item.id); }} className="mt-1 rounded-lg bg-white px-2 py-1 text-xs text-neutral-500">刪除</button></div>)}</div>}</td>; })}</tr>)}</tbody></table></div></Card>{quickCell && quickCellEmployee && <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 p-4 md:items-center"><div className="w-full max-w-md rounded-3xl bg-white p-5 shadow-xl"><div className="mb-4 flex items-start justify-between gap-4"><div><h3 className="text-lg font-bold">新增班次</h3><p className="mt-1 text-sm text-neutral-500">{quickCellEmployee.name || quickCellEmployee.displayName}｜{quickCell.date}</p><p className="mt-1 text-xs text-neutral-400">可支援：{getEmployeeDepartments(quickCellEmployee).join("、")}</p></div><button onClick={() => setQuickCell(null)} className="rounded-full bg-neutral-100 px-3 py-2 text-sm font-bold">關閉</button></div><div className="grid gap-3">{quickCellShiftOptions.map((shift) => <button key={shift.id} disabled={saving} onClick={() => assignShiftToCell(shift)} className="rounded-2xl border border-neutral-200 p-4 text-left transition hover:bg-neutral-50 disabled:opacity-50"><div className="font-bold">{shift.name}</div><div className="mt-1 text-sm text-neutral-500">{shift.department}｜{shift.startTime} - {shift.endTime}</div></button>)}</div></div></div>}</div>;
}

function SalaryPanel({ setGlobalError }) {
  const [month, setMonth] = useState(getMonthString());
  const [employees, setEmployees] = useState([]);
  const [records, setRecords] = useState([]);
  const [adjustments, setAdjustments] = useState([]);
  const [creatingAdjustment, setCreatingAdjustment] = useState(false);
  const [adjustmentForm, setAdjustmentForm] = useState({ employeeId: "", type: "deduction", title: "請假扣費", amount: 0, note: "" });
  useEffect(() => { load(); }, [month]);
  async function load() {
    const employeeSnap = await safeRun(() => getDocs(query(collection(db, "employees"), where("status", "==", "active"))), "讀取薪資員工清單失敗。", setGlobalError);
    if (employeeSnap) {
      const rows = sortByFieldAsc(employeeSnap.docs.map((d) => ({ id: d.id, ...d.data() })), "name");
      setEmployees(rows);
      const first = rows.find((emp) => emp.role !== "owner") || rows[0];
      if (first) setAdjustmentForm((prev) => ({ ...prev, employeeId: prev.employeeId || first.lineUserId || first.id }));
    }
    const recordSnap = await safeRun(() => getDocs(query(collection(db, "attendanceRecords"), where("month", "==", month))), "讀取薪資月報失敗。", setGlobalError);
    if (recordSnap) setRecords(sortByFieldAsc(recordSnap.docs.map((d) => ({ id: d.id, ...d.data() })), "date"));
    const adjustmentSnap = await safeRun(() => getDocs(query(collection(db, "payrollAdjustments"), where("month", "==", month), limit(200))), "讀取薪資調整項失敗。", setGlobalError);
    if (adjustmentSnap) setAdjustments(sortByCreatedAtDesc(adjustmentSnap.docs.map((d) => ({ id: d.id, ...d.data() }))));
  }
  function getEmployeeByLineId(employeeId) { return employees.find((emp) => (emp.lineUserId || emp.id) === employeeId); }
  async function createPayrollAdjustment(e) {
    e.preventDefault();
    if (!adjustmentForm.employeeId) return alert("請選擇員工");
    if (!adjustmentForm.title.trim()) return alert("請填寫項目名稱");
    if (Number(adjustmentForm.amount || 0) <= 0) return alert("金額必須大於 0");
    const emp = getEmployeeByLineId(adjustmentForm.employeeId);
    const payload = { employeeId: adjustmentForm.employeeId, employeeName: emp?.name || emp?.displayName || "未命名員工", month, type: adjustmentForm.type, title: adjustmentForm.title.trim(), amount: Number(adjustmentForm.amount || 0), note: adjustmentForm.note.trim(), createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
    const ok = await safeRun(() => addDoc(collection(db, "payrollAdjustments"), payload), "新增薪資調整項失敗。", setGlobalError);
    if (ok !== null) { setAdjustmentForm((prev) => ({ ...prev, title: prev.type === "addition" ? "獎金" : "請假扣費", amount: 0, note: "" })); setCreatingAdjustment(false); await load(); }
  }
  async function deletePayrollAdjustment(item) {
    const okConfirm = window.confirm(`確定刪除「${item.employeeName}｜${item.title}｜$${Number(item.amount || 0).toLocaleString()}」？`);
    if (!okConfirm) return;
    const ok = await safeRun(() => deleteDoc(doc(db, "payrollAdjustments", item.id)), "刪除薪資調整項失敗。", setGlobalError);
    if (ok !== null) await load();
  }
  const rows = employees.map((emp) => {
    const empId = emp.lineUserId || emp.id;
    const empRecords = records.filter((r) => r.employeeId === empId);
    const empAdjustments = adjustments.filter((item) => item.employeeId === empId);
    const totalMinutes = empRecords.reduce((sum, r) => sum + Number(r.workMinutes || 0), 0);
    const salaryInfo = calculateSalary({ employeeType: emp.employeeType || "hourly", totalMinutes, hourlyWage: emp.hourlyWage, baseSalary: emp.baseSalary, overtimeHourlyWage: emp.overtimeHourlyWage, adjustments: empAdjustments });
    return { id: emp.id, employeeId: empId, name: emp.name || emp.displayName, employeeType: emp.employeeType || "hourly", department: getEmployeeDepartments(emp).join("、"), hourlyWage: Number(emp.hourlyWage || 0), baseSalary: Number(emp.baseSalary || 0), overtimeHourlyWage: Number(emp.overtimeHourlyWage || 0), totalMinutes, hours: salaryInfo.hours, overtimeHours: salaryInfo.overtimeHours, basePay: salaryInfo.basePay, overtimePay: salaryInfo.overtimePay, additions: salaryInfo.additions, deductions: salaryInfo.deductions, salaryBeforeAdjustments: salaryInfo.salaryBeforeAdjustments, salary: salaryInfo.salary, days: empRecords.length, abnormalCount: empRecords.filter((r) => r.attendanceStatus && r.attendanceStatus !== "normal").length, adjustments: empAdjustments };
  });
  const totalPayroll = rows.reduce((sum, row) => sum + Number(row.salary || 0), 0);
  const totalAdditions = rows.reduce((sum, row) => sum + Number(row.additions || 0), 0);
  const totalDeductions = rows.reduce((sum, row) => sum + Number(row.deductions || 0), 0);
  const departmentPayrollRows = Object.values(rows.reduce((acc, row) => {
    const department = row.department?.split("、")?.[0] || "未設定";
    if (!acc[department]) acc[department] = { department, employeeCount: 0, totalHours: 0, basePay: 0, overtimePay: 0, additions: 0, deductions: 0, salary: 0 };
    acc[department].employeeCount += 1;
    acc[department].totalHours = Math.round((acc[department].totalHours + Number(row.hours || 0)) * 100) / 100;
    acc[department].basePay += Number(row.basePay || 0);
    acc[department].overtimePay += Number(row.overtimePay || 0);
    acc[department].additions += Number(row.additions || 0);
    acc[department].deductions += Number(row.deductions || 0);
    acc[department].salary += Number(row.salary || 0);
    return acc;
  }, {}));

  function exportPayrollCsv() {
    const headers = ["月份", "員工", "薪資類型", "部門", "出勤天數", "總工時", "加班時數", "基本薪資", "加班費", "增加費用", "扣除費用", "應發薪資", "調整明細"];
    const exportRows = rows.map((row) => [
      month,
      row.name,
      row.employeeType === "fullTime" ? "正職" : "時薪",
      row.department,
      row.days,
      row.hours,
      row.overtimeHours || 0,
      row.basePay,
      row.overtimePay,
      row.additions,
      row.deductions,
      row.salary,
      row.adjustments.map((item) => `${item.type === "addition" ? "+" : "-"}${item.amount} ${item.title}${item.note ? `（${item.note}）` : ""}`).join(" / "),
    ]);
    downloadCsv(`payroll-${month}.csv`, headers, exportRows);
  }

  function exportDepartmentPayrollCsv() {
    const headers = ["月份", "部門", "人數", "總工時", "基本薪資", "加班費", "增加費用", "扣除費用", "應發薪資"];
    const exportRows = departmentPayrollRows.map((row) => [month, row.department, row.employeeCount, row.totalHours, row.basePay, row.overtimePay, row.additions, row.deductions, row.salary]);
    downloadCsv(`department-payroll-${month}.csv`, headers, exportRows);
  }

  return <Card title="薪資單" subtitle="可自訂薪資加項與扣項，例如：獎金、請假扣費、餐費、借支等。"><div className="mb-4 grid gap-3 md:grid-cols-4"><Input label="月份" type="month" value={month} onChange={setMonth} /><InfoBox label="總加項" value={`$${totalAdditions.toLocaleString()}`} /><InfoBox label="總扣項" value={`$${totalDeductions.toLocaleString()}`} /><InfoBox label="應發薪資合計" value={`$${totalPayroll.toLocaleString()}`} /></div><div className="mb-5 flex flex-wrap justify-end gap-2"><button type="button" onClick={exportDepartmentPayrollCsv} className="rounded-2xl bg-white px-4 py-2 text-sm font-bold text-neutral-700 shadow-sm">匯出部門統計 CSV</button><button type="button" onClick={exportPayrollCsv} className="rounded-2xl bg-neutral-900 px-4 py-2 text-sm font-bold text-white">匯出薪資單 CSV</button></div><div className="mb-5 rounded-3xl border border-neutral-200 bg-white p-4"><div className="mb-3"><h3 className="font-bold">各部門薪資統計</h3><p className="mt-1 text-xs text-neutral-500">依員工主要部門即時計算，調整加項或扣項後會同步更新。</p></div>{departmentPayrollRows.length === 0 ? <div className="rounded-2xl bg-neutral-50 p-3 text-sm text-neutral-500">目前沒有薪資資料</div> : <div className="overflow-x-auto"><table className="w-full min-w-[920px] border-separate border-spacing-y-2 text-sm"><thead className="text-left text-neutral-500"><tr><th className="px-3 py-2">部門</th><th className="px-3 py-2">人數</th><th className="px-3 py-2">總工時</th><th className="px-3 py-2">基本薪資</th><th className="px-3 py-2">加班費</th><th className="px-3 py-2">增加費用</th><th className="px-3 py-2">扣除費用</th><th className="px-3 py-2">應發薪資</th></tr></thead><tbody>{departmentPayrollRows.map((row) => <tr key={row.department} className="bg-neutral-100"><td className="rounded-l-2xl px-3 py-3 font-bold">{row.department}</td><td className="px-3 py-3">{row.employeeCount}</td><td className="px-3 py-3">{row.totalHours}</td><td className="px-3 py-3">${row.basePay.toLocaleString()}</td><td className="px-3 py-3">${row.overtimePay.toLocaleString()}</td><td className="px-3 py-3 text-green-700">${row.additions.toLocaleString()}</td><td className="px-3 py-3 text-red-700">${row.deductions.toLocaleString()}</td><td className="rounded-r-2xl px-3 py-3 font-bold">${row.salary.toLocaleString()}</td></tr>)}</tbody></table></div>}</div><div className="mb-5 rounded-3xl border border-neutral-200 bg-neutral-50 p-4"><div className="mb-3 flex items-center justify-between gap-3"><div><h3 className="font-bold">薪資調整項</h3><p className="mt-1 text-xs text-neutral-500">加項會增加應發薪資，扣項會扣除應發薪資。</p></div><button type="button" onClick={() => setCreatingAdjustment(!creatingAdjustment)} className="rounded-2xl bg-neutral-900 px-4 py-2 text-sm font-bold text-white">{creatingAdjustment ? "收合" : "新增調整項"}</button></div>{creatingAdjustment && <form onSubmit={createPayrollAdjustment} className="grid gap-3 md:grid-cols-6"><Select label="員工" value={adjustmentForm.employeeId} onChange={(v) => setAdjustmentForm({ ...adjustmentForm, employeeId: v })}>{employees.filter((emp) => emp.role !== "owner").map((emp) => <option key={emp.id} value={emp.lineUserId || emp.id}>{emp.name || emp.displayName}</option>)}</Select><Select label="類型" value={adjustmentForm.type} onChange={(v) => setAdjustmentForm({ ...adjustmentForm, type: v, title: v === "addition" ? "獎金" : "請假扣費" })}><option value="addition">增加費用</option><option value="deduction">扣除費用</option></Select><Input label="項目名稱" value={adjustmentForm.title} onChange={(v) => setAdjustmentForm({ ...adjustmentForm, title: v })} /><Input label="金額" type="number" value={String(adjustmentForm.amount)} onChange={(v) => setAdjustmentForm({ ...adjustmentForm, amount: Number(v || 0) })} /><Input label="備註" value={adjustmentForm.note} onChange={(v) => setAdjustmentForm({ ...adjustmentForm, note: v })} /><button className="rounded-2xl bg-blue-600 px-4 py-3 font-bold text-white">新增</button></form>}</div><div className="space-y-4">{rows.map((row) => <div key={row.id} className="rounded-3xl border bg-white p-4"><div className="grid gap-3 md:grid-cols-[1.5fr_1fr_1fr_1fr_1fr] md:items-center"><div><div className="font-bold">{row.name}</div><div className="text-xs text-neutral-500">{row.department}｜{row.employeeType === "fullTime" ? "正職" : "時薪"}</div></div><InfoBox label="總工時" value={`${row.hours} 小時`} /><InfoBox label="基本薪資" value={`$${Number(row.basePay || 0).toLocaleString()}`} /><InfoBox label="加班費" value={`$${Number(row.overtimePay || 0).toLocaleString()}`} /><InfoBox label="應發薪資" value={`$${Number(row.salary || 0).toLocaleString()}`} /></div><div className="mt-4 grid gap-3 md:grid-cols-5"><div className="rounded-2xl bg-neutral-100 p-3 text-sm"><div className="text-neutral-500">出勤天數</div><div className="font-bold">{row.days}</div></div><div className="rounded-2xl bg-neutral-100 p-3 text-sm"><div className="text-neutral-500">異常</div><div className="font-bold">{row.abnormalCount}</div></div><div className="rounded-2xl bg-neutral-100 p-3 text-sm"><div className="text-neutral-500">加班時數</div><div className="font-bold">{row.overtimeHours || 0}</div></div><div className="rounded-2xl bg-green-50 p-3 text-sm text-green-700"><div>增加費用</div><div className="font-bold">${Number(row.additions || 0).toLocaleString()}</div></div><div className="rounded-2xl bg-red-50 p-3 text-sm text-red-700"><div>扣除費用</div><div className="font-bold">${Number(row.deductions || 0).toLocaleString()}</div></div></div><div className="mt-4"><div className="mb-2 text-sm font-bold text-neutral-700">調整明細</div>{row.adjustments.length === 0 ? <div className="rounded-2xl bg-neutral-50 p-3 text-sm text-neutral-500">尚無加扣項</div> : <div className="space-y-2">{row.adjustments.map((item) => <div key={item.id} className={`flex items-center justify-between rounded-2xl p-3 text-sm ${item.type === "addition" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}><div><div className="font-bold">{item.type === "addition" ? "+" : "-"} ${Number(item.amount || 0).toLocaleString()}｜{item.title}</div>{item.note && <div className="text-xs opacity-80">{item.note}</div>}</div><button onClick={() => deletePayrollAdjustment(item)} className="rounded-xl bg-white px-3 py-2 font-bold text-neutral-700">刪除</button></div>)}</div>}</div></div>)}</div></Card>;
}

function RecordTable({ records }) {
  if (!records.length) return <div className="mt-4 rounded-2xl bg-neutral-100 p-4 text-sm text-neutral-500">目前沒有紀錄</div>;
  return <div className="mt-5 overflow-x-auto"><table className="w-full min-w-[980px] border-separate border-spacing-y-2 text-sm"><thead className="text-left text-neutral-500"><tr><th className="px-3 py-2">日期</th><th className="px-3 py-2">員工</th><th className="px-3 py-2">部門</th><th className="px-3 py-2">班表</th><th className="px-3 py-2">上班</th><th className="px-3 py-2">下班</th><th className="px-3 py-2">分鐘</th><th className="px-3 py-2">工時</th><th className="px-3 py-2">狀態</th><th className="px-3 py-2">來源</th></tr></thead><tbody>{records.map((r) => <tr key={r.id} className="bg-neutral-100"><td className="rounded-l-2xl px-3 py-3">{r.date}</td><td className="px-3 py-3 font-bold">{r.employeeName}</td><td className="px-3 py-3">{r.department || "-"}</td><td className="px-3 py-3">{r.scheduledStart || "-"} - {r.scheduledEnd || "-"}</td><td className="px-3 py-3">{r.clockIn || "-"}</td><td className="px-3 py-3">{r.clockOut || "-"}</td><td className="px-3 py-3">{r.workMinutes || 0}</td><td className="px-3 py-3">{r.workHours || 0}</td><td className="px-3 py-3">{getAttendanceStatusText(r.attendanceStatus)}</td><td className="rounded-r-2xl px-3 py-3">{r.source || "normal"}</td></tr>)}</tbody></table></div>;
}

export default App;
