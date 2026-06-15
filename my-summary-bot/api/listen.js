// api/listen.js — 브라우저 Web Speech API로 TTS 재생
export default function handler(req, res) {
  const text = req.query.text || "No text provided.";
  const safeText = String(text).replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Listening...</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #1a1a2e; color: #fff; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .card { background: #252545; border-radius: 20px; padding: 40px; max-width: 540px; width: 100%; text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,0.4); }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h2 { font-size: 20px; font-weight: 600; margin-bottom: 16px; color: #a78bfa; }
    .text-box { background: #1a1a2e; border-radius: 12px; padding: 20px; font-size: 15px; line-height: 1.7; color: #e2e8f0; margin-bottom: 24px; text-align: left; }
    .controls { display: flex; gap: 12px; justify-content: center; align-items: center; flex-wrap: wrap; }
    .btn { display: inline-flex; align-items: center; gap: 8px; padding: 14px 32px; border-radius: 50px; border: none; font-size: 16px; font-weight: 600; cursor: pointer; transition: all 0.2s; }
    .btn-play { background: #7c3aed; color: #fff; }
    .btn-play:hover { background: #6d28d9; transform: scale(1.03); }
    .btn-stop { background: #374151; color: #fff; display: none; }
    .btn-stop:hover { background: #4b5563; }
    .status { margin-top: 16px; font-size: 13px; color: #9ca3af; }
    .voice-row { margin-top: 18px; font-size: 13px; color: #9ca3af; }
    select { background: #1a1a2e; color: #e2e8f0; border: 1px solid #3b3b5c; border-radius: 8px; padding: 6px 10px; font-size: 13px; margin-top: 6px; max-width: 100%; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🔊</div>
    <h2>Slack Summary</h2>
    <div class="text-box" id="text">${safeText}</div>
    <div class="controls">
      <button class="btn btn-play" id="playBtn" onclick="speak()">▶ Play</button>
      <button class="btn btn-stop" id="stopBtn" onclick="stopSpeak()">■ Stop</button>
    </div>
    <p class="status" id="status">Loading voice...</p>
    <div class="voice-row">
      <div>Voice</div>
      <select id="voiceSelect" onchange="onVoiceChange()"></select>
    </div>
  </div>
  <script>
    const text = ${JSON.stringify(text)};
    let chosenVoice = null;

    // 가장 자연스러운 음성 우선순위로 선택
    function pickBestVoice(voices) {
      return (
        voices.find(v => v.name.includes("Natural") && v.lang.startsWith("en")) ||  // MS Natural (최고 품질)
        voices.find(v => v.name.includes("Aria")) ||
        voices.find(v => v.name.includes("Jenny")) ||
        voices.find(v => v.name === "Google US English") ||                         // Chrome
        voices.find(v => v.name.includes("Samantha")) ||                            // Mac
        voices.find(v => v.lang === "en-US") ||
        voices.find(v => v.lang && v.lang.startsWith("en")) ||
        voices[0]
      );
    }

    function populateVoices() {
      const voices = window.speechSynthesis.getVoices().filter(v => v.lang && v.lang.startsWith("en"));
      const select = document.getElementById("voiceSelect");
      select.innerHTML = "";
      voices.forEach((v, i) => {
        const opt = document.createElement("option");
        opt.value = v.name;
        opt.textContent = v.name + " (" + v.lang + ")";
        select.appendChild(opt);
      });
      chosenVoice = pickBestVoice(voices);
      if (chosenVoice) select.value = chosenVoice.name;
      document.getElementById("status").textContent = "Ready — click Play";
    }

    function onVoiceChange() {
      const name = document.getElementById("voiceSelect").value;
      const voices = window.speechSynthesis.getVoices();
      chosenVoice = voices.find(v => v.name === name) || chosenVoice;
    }

    function speak() {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "en-US";
      u.rate = 0.92;   // 살짝 천천히 = 더 부드럽고 자연스러움
      u.pitch = 1.05;  // 약간 부드럽게
      if (chosenVoice) u.voice = chosenVoice;

      u.onstart = () => {
        document.getElementById("playBtn").style.display = "none";
        document.getElementById("stopBtn").style.display = "inline-flex";
        document.getElementById("status").textContent = "Playing...";
      };
      u.onend = () => {
        document.getElementById("playBtn").style.display = "inline-flex";
        document.getElementById("stopBtn").style.display = "none";
        document.getElementById("status").textContent = "Done!";
      };
      window.speechSynthesis.speak(u);
    }

    function stopSpeak() {
      window.speechSynthesis.cancel();
      document.getElementById("playBtn").style.display = "inline-flex";
      document.getElementById("stopBtn").style.display = "none";
      document.getElementById("status").textContent = "Stopped.";
    }

    // 음성 목록은 비동기로 로드됨 → 로드 완료 후 처리
    window.onload = () => {
      if (window.speechSynthesis.getVoices().length > 0) {
        populateVoices();
        setTimeout(speak, 400);
      } else {
        window.speechSynthesis.onvoiceschanged = () => {
          populateVoices();
          setTimeout(speak, 400);
        };
      }
    };
  </script>
</body>
</html>`;
  res.setHeader("Content-Type", "text/html");
  res.status(200).send(html);
}
