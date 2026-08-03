import crypto from "node:crypto";

const FEIE_PRINT_URL = "https://api.jp.feieyun.com/Api/Open/printMsg";

function badRequest(res, message) {
  return res.status(400).json({ ok: false, message });
}

function makeSignature(user, ukey, stime) {
  return crypto.createHash("sha1").update(`${user}${ukey}${stime}`).digest("hex");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  const body = req.body || {};
  const user = String(body.user || "").trim();
  const ukey = String(body.ukey || "").trim();
  const sn = String(body.sn || "").trim();
  const content = String(body.content || "").trim();

  if (!user) return badRequest(res, "Missing required field: user");
  if (!ukey) return badRequest(res, "Missing required field: ukey");
  if (!sn) return badRequest(res, "Missing required field: sn");
  if (!content) return badRequest(res, "Missing required field: content");

  const stime = String(Math.floor(Date.now() / 1000));
  const params = new URLSearchParams({
    user,
    stime,
    sig: makeSignature(user, ukey, stime),
    apiname: "Open_printMsg",
    sn,
    content,
    times: "1",
  });

  try {
    const response = await fetch(FEIE_PRINT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: params.toString(),
    });

    const rawText = await response.text();
    let parsed = rawText;
    try { parsed = JSON.parse(rawText); } catch {}

    if (!response.ok) {
      return res.status(500).json({ ok: false, message: `Feie HTTP ${response.status}`, raw: parsed });
    }

    const ok = parsed && typeof parsed === "object" && parsed.ret === 0;
    return res.status(ok ? 200 : 500).json({
      ok,
      message: ok ? "列印任務已送出" : parsed?.msg || "飛鵝列印失敗",
      raw: parsed,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: `Failed to call Feie print API: ${error instanceof Error ? error.message : "Unknown error"}`,
    });
  }
}
