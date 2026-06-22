// api/slack/events.js
import crypto from "crypto";
import { GoogleAuth } from "google-auth-library";

const SLACK_BOT_TOKEN      = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const GEMINI_API_KEY       = process.env.GEMINI_API_KEY;
const BOT_USER_ID          = process.env.BOT_USER_ID;
const TARGET_CHANNEL       = process.env.TARGET_CHANNEL;
const TTS_CREDENTIALS      = process.env.GOOGLE_TTS_CREDENTIALS;
const MIN_LENGTH           = 400; // 이 길이 이상인 메시지만 자동 처리

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

  // Slack 재시도 요청은 무시 (중복 방지)
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
    event.user === BOT_USER_ID
  ) return res.status(200).end();

  const text = event.text || "";
  if (!text.trim()) return res.status(200).end();
  if (text.length < MIN_LENGTH) return res.status(200).end();

  // 4) 텍스트 브리핑 + 음성 브리핑 따로 생성
  try {
    // 읽는 용 (전문적인 톤) — 스레드에 게시
    const textBriefing = await generateTextBriefing(text);
    await postToThread(
      event.channel,
      event.ts,
      `📋 *AI Briefing:*\n${textBriefing}`
    );

    // 듣는 용 (짧고 깔끔하게) — MP3는 채널 본문에 바로 게시
    const audioScript = await generateAudioScript(text);
    const audioBuffer = await synthesizeSpeech(audioScript);
    if (audioBuffer) {
      await uploadAudioToSlack(event.channel, null, audioBuffer);
    }
  } catch (err) {
    console.error("처리 오류:", err);
  }
  return res.status(200).end();
}

// ─── 읽는 용 브리핑 (전문적인 톤) ─────────────────────────
async function generateTextBriefing(text, retry = true) {
  return callGemini(
    `You are a professional internal communications announcer for a logistics company.
Read the following Slack announcement and create a SHORT briefing (3-4 sentences) in English that:
1. Clearly states what the announcement is about
2. Explains why it matters and who it affects
3. Is written in clear, professional English

Return ONLY the briefing with no preamble, labels, or markdown.

Announcement: ${text}`,
    retry
  );
}

// ─── 듣는 용 스크립트 (짧고 깔끔, 과하게 캐주얼하지 않게) ──
async function generateAudioScript(text, retry = true) {
  return callGemini(
    `You are an internal briefing announcer for a logistics company.
Create a spoken briefing (3-4 sentences) in clear, natural English that explains what this announcement is about and why it matters.
Keep it professional but easy to listen to — not overly casual, no slang. Return ONLY the spoken script. No labels, no markdown.

Announcement: ${text}`,
    retry
  );
}

// ─── Gemini 공통 호출 함수 ────────────────────────────────
async function callGemini(prompt, retry = true) {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
        }),
      }
    );
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "(Failed)";
  } catch (err) {
    if (retry) {
      await new Promise(r => setTimeout(r, 1000));
      return callGemini(prompt, false);
    }
    return "(Failed - please try again)";
  }
}

// ─── Google Cloud TTS로 음성 생성 (MP3 Buffer 반환) ───────
async function synthesizeSpeech(text) {
  const auth = new GoogleAuth({
    credentials: JSON.parse(TTS_CREDENTIALS),
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  const accessToken = tokenResponse.token;

  const res = await fetch(
    "https://texttospeech.googleapis.com/v1/text:synthesize",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        input: { text },
        voice: {
          languageCode: "en-US",
          name: "en-US-Chirp3-HD-Kore", // 부드러운 여성 음성
        },
        audioConfig: {
          audioEncoding: "MP3",
          speakingRate: 1.1, // 살짝 빠르게
        },
      }),
    }
  );

  const data = await res.json();
  if (!data.audioContent) {
    console.error("TTS 응답 오류:", JSON.stringify(data));
    return null;
  }
  return Buffer.from(data.audioContent, "base64");
}

// ─── Slack에 오디오 파일 업로드 (3단계 방식) ──────────────
async function uploadAudioToSlack(channel, thread_ts, audioBuffer) {
  const filename = "briefing.mp3";

  // 1단계: 업로드 URL 요청
  const getUrlRes = await fetch(
    "https://slack.com/api/files.getUploadURLExternal",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      },
      body: new URLSearchParams({
        filename,
        length: String(audioBuffer.length),
      }),
    }
  );
  const getUrlData = await getUrlRes.json();
  if (!getUrlData.ok) {
    console.error("업로드 URL 요청 실패:", JSON.stringify(getUrlData));
    return;
  }

  const { upload_url, file_id } = getUrlData;

  // 2단계: 파일 데이터 업로드
  await fetch(upload_url, {
    method: "POST",
    headers: { "Content-Type": "audio/mpeg" },
    body: audioBuffer,
  });

  // 3단계: 업로드 완료 처리
  const completeBody = {
    files: [{ id: file_id, title: "🔊 Audio Briefing" }],
    channel_id: channel,
    initial_comment: "⚡ *NGL Spark AI briefing for the announcement above.*",
  };
  if (thread_ts) completeBody.thread_ts = thread_ts; // 스레드 지정 시에만 추가

  const completeRes = await fetch(
    "https://slack.com/api/files.completeUploadExternal",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify(completeBody),
    }
  );
  const completeData = await completeRes.json();
  if (!completeData.ok) {
    console.error("업로드 완료 실패:", JSON.stringify(completeData));
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