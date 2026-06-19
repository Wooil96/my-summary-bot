// api/slack/events.js
import crypto from "crypto";

const SLACK_BOT_TOKEN      = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const GEMINI_API_KEY       = process.env.GEMINI_API_KEY;
const BOT_USER_ID          = process.env.BOT_USER_ID;
const TARGET_CHANNEL       = process.env.TARGET_CHANNEL;
const MIN_LENGTH           = 400; // 이 길이 이상인 메시지만 자동 요약

export const config = {
  api: { bodyParser: false },
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const rawBody = await getRawBody(req);
  const body = JSON.parse(rawBody);

  // 1) URL 검증
  if (body.type === "url_verification") {
    return res.status(200).json({ challenge: body.challenge });
  }

  // Slack 재시도 요청은 무시 (중복 요약 방지)
  if (req.headers["x-slack-retry-num"]) {
    return res.status(200).end();
  }

  // 2) 서명 검증
  if (!verifySignature(req.headers, rawBody)) {
    return res.status(403).send("Invalid signature");
  }

  // 3) 새 메시지 이벤트 처리
  const event = body.event;
  if (!event) return res.status(200).end();

  if (
    event.type !== "message" ||
    (event.subtype && event.subtype !== "file_share") ||
    event.bot_id ||
    event.user === BOT_USER_ID ||
    event.channel !== TARGET_CHANNEL
  ) return res.status(200).end();

  const text = event.text || "";
  if (!text.trim()) return res.status(200).end();

  // 400자 이상인 긴 메시지만 자동 요약
  if (text.length < MIN_LENGTH) return res.status(200).end();

  // 요약 후 스레드에 게시
  try {
    const summary = await summarizeText(text);
    const listenUrl = `https://my-summary-bot-chi.vercel.app/api/listen?text=${encodeURIComponent(summary)}`;
    await postToThread(
      event.channel,
      event.ts,
      `📋 *Summary:*\n${summary}\n\n🔊 <${listenUrl}|Listen to Summary>`
    );
  } catch (err) {
    console.error("요약 오류:", err);
  }
  return res.status(200).end();
}

// ─── Gemini API 요약 ─────────────────────────────────────
async function summarizeText(text, retry = true) {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `Summarize the following Slack message in English in 3-4 concise sentences.
Return ONLY the summary with no explanation or preamble.

Message: ${text}`,
            }],
          }],
        }),
      }
    );
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "(Summary failed)";
  } catch (err) {
    if (retry) {
      await new Promise(r => setTimeout(r, 1000));
      return summarizeText(text, false);
    }
    return "(Summary failed - please try again)";
  }
}

// ─── 스레드에 메시지 게시 ────────────────────────────────
async function postToThread(channel, thread_ts, text) {
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel, thread_ts, text, unfurl_links: false }),
  });
}

// ─── Slack 서명 검증 ─────────────────────────────────────
function verifySignature(headers, rawBody) {
  const timestamp = headers["x-slack-request-timestamp"];
  const signature = headers["x-slack-signature"];
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const hmac = crypto
    .createHmac("sha256", SLACK_SIGNING_SECRET)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex");
  return `v0=${hmac}` === signature;
}

// ─── Raw body 읽기 ───────────────────────────────────────
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}