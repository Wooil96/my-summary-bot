// api/slack/events.js
import crypto from "crypto";

const SLACK_BOT_TOKEN      = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const GROQ_API_KEY         = process.env.GROQ_API_KEY;
const BOT_USER_ID          = process.env.BOT_USER_ID;
const TARGET_CHANNEL       = process.env.TARGET_CHANNEL;

export const config = {
  api: { bodyParser: false },
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const rawBody = await getRawBody(req);

  // Interactivity(버튼 클릭)는 form-urlencoded로 옴 → payload 파라미터 파싱
  let body;
  if (rawBody.startsWith("payload=")) {
    const decoded = decodeURIComponent(rawBody.slice("payload=".length));
    body = JSON.parse(decoded);
  } else {
    body = JSON.parse(rawBody);
  }

  // 1) URL 검증
  if (body.type === "url_verification") {
    return res.status(200).json({ challenge: body.challenge });
  }

  // 2) 서명 검증
  if (!verifySignature(req.headers, rawBody)) {
    return res.status(403).send("Invalid signature");
  }

  // 3) 버튼 클릭 (Interactivity) 처리
  if (body.type === "block_actions") {
    const action = body.actions?.[0];
    const channel = body.container?.channel_id;
    const thread_ts = body.container?.message_ts;
    const messageText = body.message?.text || body.message?.blocks?.[0]?.text?.text || "";

    if (action?.action_id === "summarize") {
      res.status(200).end();
      const summary = await summarizeText(messageText);
      await postToThread(channel, thread_ts, `📋 *Summary:*\n${summary}`);
    } else if (action?.action_id === "listen") {
      res.status(200).end();
      const summary = await summarizeText(messageText);
      const listenUrl = `https://my-summary-bot-chi.vercel.app/api/listen?text=${encodeURIComponent(summary)}`;
      await postToThread(channel, thread_ts, `🔊 *Listen to summary:*\n${listenUrl}`);
    } else {
      res.status(200).end();
    }
    return;
  }

  // 4) 새 메시지 이벤트 처리
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

  // 5) Summary + Listen 버튼 달기
  await postButtons(event.channel, event.ts, text);
  return res.status(200).end();
}

// ─── 버튼 메시지 게시 ────────────────────────────────────
async function postButtons(channel, thread_ts, originalText) {
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({
      channel,
      thread_ts,
      text: originalText, // fallback text (버튼 액션에서 원문 추출용)
      blocks: [
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "📋 Summary", emoji: true },
              action_id: "summarize",
              style: "primary",
            },
            {
              type: "button",
              text: { type: "plain_text", text: "🔊 Listen", emoji: true },
              action_id: "listen",
            },
          ],
        },
      ],
    }),
  });
}

// ─── Groq API 요약 (무료, Vercel에서 안정적) ──────────────
async function summarizeText(text) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      max_tokens: 500,
      messages: [{
        role: "user",
        content: `Summarize the following Slack message in English in 2-3 concise sentences.
Return ONLY the summary with no explanation or preamble.

Message: ${text}`,
      }],
    }),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || "(Summary failed)";
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