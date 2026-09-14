const MODEL = "models/lyria-realtime-exp";
const WS_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateMusic";
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const MAX_PROMPT_LENGTH = 600;
const STREAM_MS = 52000;
const FIRST_AUDIO_TIMEOUT_MS = 12000;
const INITIAL_SILENCE_SECONDS = 0.25;

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

function startMusic(socket, prompt) {
  sendJson(socket, {
    musicGenerationConfig: {
      temperature: 0.7,
      guidance: 5.0,
      audioFormat: "pcm16",
      sampleRateHz: SAMPLE_RATE
    }
  });
  sendJson(socket, {
    clientContent: {
      weightedPrompts: [{ text: prompt, weight: 1.0 }]
    }
  });
  sendJson(socket, { playbackControl: "PLAY" });
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
      controller.enqueue(new Uint8Array(Math.round(SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE * INITIAL_SILENCE_SECONDS)));
      closeTimer = setTimeout(closeSocket, STREAM_MS);
      firstAudioTimer = setTimeout(() => {
        if (!sentAudio) closeSocket(new Error("Timed out waiting for Lyria audio."));
      }, FIRST_AUDIO_TIMEOUT_MS);

      socket.addEventListener("open", () => {
        sendJson(socket, { setup: { model: MODEL } });
      });

      socket.addEventListener("message", (event) => {
        if (closed) return;
        let message = null;
        try {
          message = JSON.parse(String(event.data || "{}"));
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
      "x-iriver-audio": `pcm16;rate=${SAMPLE_RATE};channels=${CHANNELS}`
    }
  });
}
