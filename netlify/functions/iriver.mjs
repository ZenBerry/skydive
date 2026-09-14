const MODEL = "models/lyria-realtime-exp";
const WS_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateMusic";
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const MAX_PROMPT_LENGTH = 600;
const STREAM_MS = 52000;
const FIRST_AUDIO_TIMEOUT_MS = 12000;
const INITIAL_SILENCE_SECONDS = 0.25;
const INITIAL_SILENCE_BYTES = Math.round(SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE * INITIAL_SILENCE_SECONDS);

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json"
    }
  });
}

function cleanPrompt(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_PROMPT_LENGTH);
}

function decodeBase64(value) {
  if (!value) return null;
  if (typeof Buffer !== "undefined") return Buffer.from(value, "base64");
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function createMusicSocket(apiKey) {
  const url = `${WS_URL}?key=${encodeURIComponent(apiKey)}`;
  try {
    return new WebSocket(url, [], {
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey
      }
    });
  } catch (error) {
    return new WebSocket(url);
  }
}

function sendJson(socket, value) {
  socket.send(JSON.stringify(value));
}

function getEventDataType(data) {
  if (data === null) return "null";
  if (data === undefined) return "undefined";
  if (typeof data === "string") return "string";
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) return "buffer";
  if (data instanceof ArrayBuffer) return "arrayBuffer";
  if (ArrayBuffer.isView(data)) return data.constructor && data.constructor.name ? data.constructor.name : "typedArray";
  if (typeof Blob !== "undefined" && data instanceof Blob) return "blob";
  return data.constructor && data.constructor.name ? data.constructor.name : typeof data;
}

async function eventDataToText(data) {
  if (typeof data === "string") return data;
  if (typeof Buffer !== "undefined") {
    if (Buffer.isBuffer(data)) return data.toString("utf8");
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
    if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return eventDataToText(await data.arrayBuffer());
  }
  return String(data || "{}");
}

function startMusic(socket, prompt) {
  sendJson(socket, {
    musicGenerationConfig: {
      temperature: 0.7,
      guidance: 5.0
    }
  });
  sendJson(socket, {
    clientContent: {
      weightedPrompts: [{ text: prompt, weight: 1.0 }]
    }
  });
  sendJson(socket, { playbackControl: "PLAY" });
}

function summarizeMessage(message) {
  if (!message || typeof message !== "object") return { type: "unknown" };
  if (message.setupComplete || message.setup_complete) return { type: "setupComplete" };
  if (message.filteredPrompt || message.filtered_prompt) {
    return {
      type: "filteredPrompt",
      reason: message.filteredPrompt?.filteredReason || message.filtered_prompt?.filtered_reason || ""
    };
  }
  if (message.warning) return { type: "warning", warning: String(message.warning).slice(0, 500) };
  const content = message.serverContent || message.server_content;
  const chunks = content && (content.audioChunks || content.audio_chunks);
  if (Array.isArray(chunks)) {
    return {
      type: "audio",
      chunks: chunks.length,
      bytes: chunks.reduce((total, chunk) => total + (decodeBase64(chunk && chunk.data)?.length || 0), 0)
    };
  }
  return { type: "other", keys: Object.keys(message).slice(0, 12) };
}

function debugMusic(prompt, apiKey) {
  return new Promise((resolve) => {
    const events = [];
    const startedAt = Date.now();
    let socket = null;
    let started = false;
    let settled = false;

    function settle(status, extra = {}) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        if (socket && socket.readyState <= 1) socket.close(1000, "debug done");
      } catch (error) {
        // Ignore debug cleanup failures.
      }
      resolve({
        ok: status === "audio",
        status,
        elapsedMs: Date.now() - startedAt,
        events,
        ...extra
      });
    }

    const timeout = setTimeout(() => {
      settle("timeout", { error: "Timed out waiting for Lyria audio." });
    }, FIRST_AUDIO_TIMEOUT_MS);

    try {
      socket = createMusicSocket(apiKey);
    } catch (error) {
      settle("socket_create_failed", { error: error && error.message ? error.message : String(error) });
      return;
    }

    socket.addEventListener("open", () => {
      events.push({ type: "open", atMs: Date.now() - startedAt });
      sendJson(socket, { setup: { model: MODEL } });
    });

    socket.addEventListener("message", async (event) => {
      let message = null;
      try {
        message = JSON.parse(await eventDataToText(event.data));
      } catch (error) {
        events.push({ type: "parse_error", dataType: getEventDataType(event.data), atMs: Date.now() - startedAt });
        return;
      }
      const summary = summarizeMessage(message);
      events.push({ ...summary, atMs: Date.now() - startedAt });
      if (summary.type === "setupComplete" && !started) {
        started = true;
        startMusic(socket, prompt);
        return;
      }
      if (summary.type === "audio" && summary.bytes > 0) {
        settle("audio", { audioBytes: summary.bytes });
      } else if (summary.type === "filteredPrompt") {
        settle("filtered", { error: summary.reason || "Prompt was filtered." });
      }
    });

    socket.addEventListener("error", () => {
      events.push({ type: "error", atMs: Date.now() - startedAt });
      settle("socket_error", { error: "Could not connect to Lyria." });
    });

    socket.addEventListener("close", (event) => {
      events.push({
        type: "close",
        atMs: Date.now() - startedAt,
        code: event.code,
        reason: event.reason || ""
      });
      settle("closed", { error: event.reason || "Lyria closed before sending audio." });
    });
  });
}

export default async function handler(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-origin": "*"
      }
    });
  }

  const apiKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim();
  if (!apiKey) {
    return json(503, { error: "Set GEMINI_API_KEY or GOOGLE_API_KEY in Netlify to enable iRiver." });
  }
  if (typeof WebSocket !== "function") {
    return json(500, { error: "This Node runtime does not expose WebSocket. Use Node 22+ for iRiver." });
  }

  const url = new URL(request.url);
  const prompt = cleanPrompt(url.searchParams.get("prompt"));
  if (!prompt) return json(400, { error: "Prompt is required." });

  if (url.searchParams.get("debug") === "1") {
    return json(200, await debugMusic(prompt, apiKey));
  }

  const body = new ReadableStream({
    start(controller) {
      let socket = null;
      let closed = false;
      let started = false;
      let sentAudio = false;
      let closeTimer = null;
      let firstAudioTimer = null;

      function closeSocket(error = null) {
        if (closed) return;
        closed = true;
        if (closeTimer) clearTimeout(closeTimer);
        if (firstAudioTimer) clearTimeout(firstAudioTimer);
        try {
          if (socket && socket.readyState <= 1) {
            sendJson(socket, { playbackControl: "STOP" });
            socket.close(1000, "done");
          }
        } catch (error) {
          // The socket may already be gone.
        }
        try {
          if (error) controller.error(error);
          else controller.close();
        } catch (error) {
          // The client may have disconnected first.
        }
      }

      socket = createMusicSocket(apiKey);
      controller.enqueue(new Uint8Array(INITIAL_SILENCE_BYTES));
      closeTimer = setTimeout(closeSocket, STREAM_MS);
      firstAudioTimer = setTimeout(() => {
        if (!sentAudio) closeSocket(new Error("Timed out waiting for Lyria audio."));
      }, FIRST_AUDIO_TIMEOUT_MS);

      socket.addEventListener("open", () => {
        sendJson(socket, { setup: { model: MODEL } });
      });

      socket.addEventListener("message", async (event) => {
        if (closed) return;
        let message = null;
        try {
          message = JSON.parse(await eventDataToText(event.data));
        } catch (error) {
          return;
        }
        if ((message.setupComplete || message.setup_complete) && !started) {
          started = true;
          startMusic(socket, prompt);
          return;
        }
        if (message.filteredPrompt || message.filtered_prompt) {
          closeSocket(new Error("The prompt was filtered."));
          return;
        }
        const content = message.serverContent || message.server_content;
        const chunks = content && (content.audioChunks || content.audio_chunks);
        if (!Array.isArray(chunks)) return;
        chunks.forEach((chunk) => {
          const bytes = decodeBase64(chunk && chunk.data);
          if (!bytes || !bytes.length || closed) return;
          sentAudio = true;
          if (firstAudioTimer) {
            clearTimeout(firstAudioTimer);
            firstAudioTimer = null;
          }
          controller.enqueue(bytes);
        });
      });

      socket.addEventListener("error", () => {
        if (closed) return;
        closeSocket(new Error("Could not connect to Lyria."));
      });

      socket.addEventListener("close", (event) => {
        if (sentAudio || event.code === 1000) {
          closeSocket();
          return;
        }
        closeSocket(new Error(event.reason || "Lyria closed before sending audio."));
      });

      request.signal.addEventListener("abort", closeSocket, { once: true });
    }
  });

  return new Response(body, {
    status: 200,
    headers: {
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
      "content-type": "application/octet-stream",
      "x-iriver-audio": `pcm16;rate=${SAMPLE_RATE};channels=${CHANNELS}`,
      "x-iriver-prelude-bytes": String(INITIAL_SILENCE_BYTES)
    }
  });
}
