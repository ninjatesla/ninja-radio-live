import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { TikTokLiveConnection, WebcastEvent, ControlEvent } from "tiktok-live-connector";
import fs from "node:fs";
import path from "node:path";

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = process.cwd();
const TIKTOK_USERNAME = process.env.TIKTOK_USERNAME || "ninjaboxx";

const FORMATS = {
  "turk-pop": { label: "Türkçe Pop", image: "/images/turk-pop.png" },
  "yabanci-pop": { label: "Yabancı Pop", image: "/images/yabanci-pop.png" },
  "turk-slow": { label: "Türkçe Slow", image: "/images/turk-slow.png" },
  "yabanci-slow": { label: "Yabancı Slow", image: "/images/yabanci-slow.png" },
  "turk-rap": { label: "Türk Rap", image: "/images/turk-rap.png" },
  "yabanci-rap": { label: "Yabancı Rap", image: "/images/yabanci-rap.png" }
};

let activeFormat = "turk-pop";
let currentTrack = null;
let nextTrackId = 0;
let tiktokConnection = null;
let tiktokConnected = false;
let reconnectTimer = null;
const clients = new Set();
const songQueue = [];
const recentGiftEventIds = new Map();

function normalizeText(value = "") {
  return String(value).toLocaleLowerCase("tr-TR")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[ıİ]/g, "i").replace(/[ğĞ]/g, "g")
    .replace(/[üÜ]/g, "u").replace(/[şŞ]/g, "s")
    .replace(/[öÖ]/g, "o").replace(/[çÇ]/g, "c")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

function getTracks(format) {
  const folder = path.join(ROOT, "music", format);
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder, { withFileTypes: true })
    .filter(entry => entry.isFile() && /\.mp3$/i.test(entry.name))
    .map(entry => ({
      title: entry.name.replace(/\.mp3$/i, "").replace(/[_-]+/g, " "),
      file: entry.name,
      format,
      url: "/music/" + encodeURIComponent(format) + "/" + encodeURIComponent(entry.name)
    }));
}

function chooseRandomTrack(format, avoidUrl = "") {
  const tracks = getTracks(format);
  if (!tracks.length) return null;
  let choices = tracks.filter(track => track.url !== avoidUrl);
  if (!choices.length) choices = tracks;
  return choices[Math.floor(Math.random() * choices.length)];
}

function broadcast(payload) {
  const message = JSON.stringify(payload);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(message); } catch (error) {
        console.warn("WebSocket send failed:", error.message);
      }
    }
  }
}

function sendState(socket) {
  socket.send(JSON.stringify({
    type: "state", formats: FORMATS, activeFormat,
    formatInfo: FORMATS[activeFormat], currentTrack,
    queueCount: songQueue.length, tiktokConnected
  }));
}

function playTrack(track, reason = "auto") {
  if (!track) {
    currentTrack = null;
    broadcast({ type: "track", currentTrack: null, queueCount: songQueue.length,
      notice: "Bu formatın klasöründe MP3 bulunamadı." });
    return;
  }
  currentTrack = { ...track, id: ++nextTrackId, startedAt: Date.now(), reason };
  console.log("NOW PLAYING:", FORMATS[track.format]?.label, "=>", track.title, "|", reason);
  broadcast({ type: "track", currentTrack, queueCount: songQueue.length });
}

function changeFormat(format, username = "izleyici", source = "gift") {
  if (!FORMATS[format]) return;
  activeFormat = format;
  songQueue.length = 0;
  broadcast({ type: "format", activeFormat, formatInfo: FORMATS[activeFormat],
    username, source, queueCount: songQueue.length });
  playTrack(chooseRandomTrack(activeFormat, currentTrack?.url || ""), "format-change");
}

function requestRandomSong(username = "izleyici", source = "gift") {
  const track = chooseRandomTrack(activeFormat, currentTrack?.url || "");
  if (!track) {
    broadcast({ type: "notice", message: `${FORMATS[activeFormat].label} klasöründe MP3 bulunamadı.` });
    return;
  }
  songQueue.push({ track, username, source });
  broadcast({ type: "song-queued", username, title: track.title,
    format: activeFormat, queueCount: songQueue.length });
  console.log("SONG QUEUED:", username, "=>", track.title, "| queue:", songQueue.length);
  if (!currentTrack) advanceTrack();
}

function advanceTrack() {
  if (songQueue.length) {
    const next = songQueue.shift();
    playTrack(next.track, "gift-request");
    broadcast({ type: "song-request-playing", username: next.username, title: next.track.title });
  } else {
    playTrack(chooseRandomTrack(activeFormat, currentTrack?.url || ""), "auto-next");
  }
}

app.get("/", (_req, res) => res.sendFile(path.join(ROOT, "live.html")));
app.get("/health", (_req, res) => res.json({
  ok: true, service: "Ninja Radio", tiktokConnected, activeFormat,
  currentTrack: currentTrack?.title || null, queueCount: songQueue.length
}));
app.get("/api/tracks", (_req, res) => {
  const tracks = {};
  for (const format of Object.keys(FORMATS)) tracks[format] = getTracks(format);
  res.json({ formats: FORMATS, tracks });
});
app.get("/manifest.json", (_req, res) =>
  res.sendFile(path.join(ROOT, "manifest.json"))
);

app.get("/sw.js", (_req, res) =>
  res.sendFile(path.join(ROOT, "sw.js"))
);

app.get("/ninja-radio-icon.png", (_req, res) =>
  res.sendFile(path.join(ROOT, "ninja-radio-icon.png"))
);
app.use("/images", express.static(path.join(ROOT, "images")));
app.use("/music", express.static(path.join(ROOT, "music")));
app.get("/live.html", (_req, res) => res.sendFile(path.join(ROOT, "live.html")));

const server = app.listen(PORT, () => {
  console.log("Ninja Radio running on port", PORT);
  console.log("TikTok account: @" + TIKTOK_USERNAME);
  console.log("Initial format: " + FORMATS[activeFormat].label);
});

const wss = new WebSocketServer({ server });
wss.on("connection", socket => {
  clients.add(socket);
  sendState(socket);
  socket.on("message", raw => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }
    if (data.type === "trackEnded" && currentTrack && Number(data.trackId) === Number(currentTrack.id)) {
      advanceTrack();
    }
    // Visible only with ?test=1; useful for local tests before sending a real gift.
    if (data.type === "testSong") requestRandomSong("test kullanıcısı", "test");
    if (data.type === "testFormat") changeFormat("turk-pop", "test kullanıcısı", "test");
  });
  socket.on("close", () => clients.delete(socket));
  socket.on("error", () => clients.delete(socket));
});

function giftNameFrom(data) {
  const details = data.giftDetails || data.gift || data.extendedGiftInfo || {};
  return String(details.giftName || details.name || details.gift_name ||
    data.giftName || data.gift_name || data.extendedGiftInfo?.giftName ||
    data.extendedGiftInfo?.name || "").trim();
}

function handleGift(data) {
  const username = data.user?.displayId || data.user?.uniqueId || data.user?.nickname || "izleyici";
  const nickname = data.user?.nickname || username;
  const giftName = giftNameFrom(data);
  const normalizedGiftName = normalizeText(giftName);
  const details = data.giftDetails || data.gift || data.extendedGiftInfo || {};
  const giftId = data.giftId ?? details.giftId ?? details.id ?? null;
  const diamondCount = Number(details.diamondCount ?? details.diamond_count ??
    data.diamondCount ?? data.diamond_count ?? 0);
  const giftType = Number(data.giftType || 0);
  const repeatEnd = data.repeatEnd;
  const eventId = data.common?.msgId || data.common?.messageId || data.msgId || data.eventId || data.logId || null;

  if (eventId) {
    const now = Date.now();
    for (const [id, time] of recentGiftEventIds) if (now - time > 120000) recentGiftEventIds.delete(id);
    if (recentGiftEventIds.has(String(eventId))) return;
    recentGiftEventIds.set(String(eventId), now);
  }
  console.log("GIFT:", username, "|", giftName || "UNKNOWN", "| diamonds:", diamondCount,
    "| giftId:", giftId, "| repeat:", data.repeatCount || 1, "| repeatEnd:", repeatEnd);

  // Seri hediyelerde yalnızca serinin bitiş olayı ödül oluşturur.
  if (giftType === 1 && repeatEnd === false) return;

  broadcast({ type: "gift", username, nickname, giftName: giftName || "Bilinmeyen hediye", diamondCount, giftId });

  // Donat / Donut / Doughnut: aktif formatta rastgele şarkıyı kuyruğa ekle.
  if (["donut", "doughnut", "donat"].includes(normalizedGiftName) ||
      normalizedGiftName.includes("donut") || normalizedGiftName.includes("doughnut")) {
    requestRandomSong(nickname, "gift");
    return;
  }

  // Deneme aşaması: yalnızca Şapka / Hat / Cap, Türkçe Pop formatını etkinleştirir.
  if (["hat", "cap", "sapka"].includes(normalizedGiftName) ||
      normalizedGiftName.startsWith("hat ") || normalizedGiftName.startsWith("cap ")) {
    changeFormat("turk-pop", nickname, "gift");
    return;
  }
  console.log("GIFT: Bu hediye için henüz işlem tanımlı değil:", giftName);
}

function connectTikTok() {
  if (tiktokConnection) {
    try { tiktokConnection.removeAllListeners(); } catch {}
  }
  console.log("Connecting to TikTok LIVE: @" + TIKTOK_USERNAME);
  tiktokConnection = new TikTokLiveConnection(TIKTOK_USERNAME, {
    processInitialData: false, fetchRoomInfoOnConnect: true
  });
  tiktokConnection.on(ControlEvent.CONNECTED, state => {
    tiktokConnected = true;
    console.log("TIKTOK LIVE CONNECTED | Room:", state.roomId);
    broadcast({ type: "status", tiktokConnected: true });
  });
  tiktokConnection.on(ControlEvent.DISCONNECTED, () => {
    tiktokConnected = false;
    broadcast({ type: "status", tiktokConnected: false });
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectTikTok, 10000);
  });
  tiktokConnection.on(ControlEvent.ERROR, error => {
    console.error("TikTok connection error:", error?.message || error);
  });
  tiktokConnection.on(WebcastEvent.GIFT, handleGift);
  tiktokConnection.connect().catch(error => {
    tiktokConnected = false;
    console.error("TikTok connection failed:", error?.message || error);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectTikTok, 15000);
  });
}

playTrack(chooseRandomTrack(activeFormat), "startup");
connectTikTok();
