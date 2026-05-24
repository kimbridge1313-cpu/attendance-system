import admin from "firebase-admin";

function initAdmin() {
  if (admin.apps.length > 0) return admin.app();

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT");

  const serviceAccount = JSON.parse(raw);

  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

function getTaiwanDate() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function formatDateSlash(dateText) {
  return String(dateText || "").replaceAll("-", "/");
}

function money(value) {
  return `$${Number(value || 0).toLocaleString("zh-TW")}`;
}

function getDepartmentLabel(value) {
  const map = {
    bakery: "烘焙",
    supermarket: "超市",
    lottery: "台彩",
  };

  return map[value] || value || "未分部門";
}

function getItemName(record) {
  if (record.vendorName) return `${record.item || record.category || "貨款"}(${record.vendorName})`;
  return record.item || record.category || record.note || "未命名項目";
}

function buildLineMessage({ date, incomeRecords, expenseRecords }) {
  const incomeTotal = incomeRecords.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const expenseTotal = expenseRecords.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const netCash = incomeTotal - expenseTotal;

  const incomeLines = incomeRecords.length
    ? incomeRecords.map((item) => {
        return `🟢 [${getDepartmentLabel(item.department)}] ${getItemName(item)}: ${money(item.amount)}`;
      })
    : ["🟢 今日無收入紀錄"];

  const expenseLines = expenseRecords.length
    ? expenseRecords.map((item) => {
        return `🔴 [${getDepartmentLabel(item.department)}] ${getItemName(item)}: ${money(item.amount)}`;
      })
    : ["🔴 今日無支出紀錄"];

  const appUrl = process.env.APP_BASE_URL || "";

  return [
    `📋 【${formatDateSlash(date)} 現金帳核對】`,
    "",
    "--- 今日收入清單 ---",
    ...incomeLines,
    "",
    "--- 今日支出清單 ---",
    ...expenseLines,
    "",
    "==========================",
    `💰 今日淨現金：${money(netCash)}`,
    "(請以此金額核對櫃檯現金變動)",
    "==========================",
    "🔗 詳細流水帳連結：",
    appUrl,
  ].join("\n");
}

async function pushLineMessage(text) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const targetId = process.env.LINE_TARGET_ID;

  if (!token) throw new Error("Missing LINE_CHANNEL_ACCESS_TOKEN");
  if (!targetId) throw new Error("Missing LINE_TARGET_ID");

  const response = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      to: targetId,
      messages: [
        {
          type: "text",
          text,
        },
      ],
    }),
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`LINE push failed: ${response.status} ${responseText}`);
  }

  return responseText;
}

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;

  if (!secret) return true;

  const authHeader = req.headers.authorization || "";
  const querySecret = req.query?.secret || "";

  return authHeader === `Bearer ${secret}` || querySecret === secret;
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  try {
    if (!isAuthorized(req)) {
      return res.status(401).json({
        error: "Unauthorized",
      });
    }

    initAdmin();

    const db = admin.firestore();
    const date = req.query?.date || getTaiwanDate();

    const snapshot = await db
      .collection("dailyCash")
      .where("date", "==", date)
      .get();

    const records = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    const incomeRecords = records
      .filter((item) => item.type === "income")
      .sort((a, b) => String(a.department || "").localeCompare(String(b.department || ""), "zh-Hant"));

    const expenseRecords = records
      .filter((item) => item.type === "expense")
      .sort((a, b) => String(a.department || "").localeCompare(String(b.department || ""), "zh-Hant"));

    const text = buildLineMessage({
      date,
      incomeRecords,
      expenseRecords,
    });

    await pushLineMessage(text);

    return res.status(200).json({
      ok: true,
      date,
      count: records.length,
      preview: text,
    });
  } catch (error) {
    console.error("daily-line-report error:", error);

    return res.status(500).json({
      error: error.message || "Internal server error",
    });
  }
}
