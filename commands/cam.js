(function () {
  window.SkydiveCommands = window.SkydiveCommands || [];

  const runtimes = new WeakMap();
  const CALLS_URL = "/.netlify/functions/calls";
  const SIGNAL_POLL_MS = 1800;
  const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

  function stopStream(stream) {
    if (!stream) return;
    for (const track of stream.getTracks()) track.stop();
  }

  function setStatus(elements, text) {
    if (elements.status) elements.status.textContent = text;
  }

  function createPeerId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function getRoomInfo(state, context) {
    const space = context && typeof context.currentSpaceSlug === "string" ? context.currentSpaceSlug.trim() : "";
    const nodeId = context && typeof context.nodeId === "string" ? context.nodeId.trim() : "";
    const createdAt = Number(state && state.createdAt) || 0;
    const room = nodeId || (createdAt ? `cam-${createdAt}` : "");
    if (!space || !room) return null;
    return { space, room };
  }

  function getCallUrl(runtime) {
    const params = new URLSearchParams({
      space: runtime.room.space,
      room: runtime.room.room,
      peer: runtime.peerId,
      after: String(runtime.lastSignalAt)
    });
    return `${CALLS_URL}?${params.toString()}`;
  }

  async function sendSignal(runtime, type, to = "*", payload = {}) {
    if (!runtime.room || runtime.discard) return;
    const response = await fetch(CALLS_URL, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        space: runtime.room.space,
        room: runtime.room.room,
        peer: runtime.peerId,
        type,
        to,
        payload
      })
    });
    if (!response.ok) throw new Error(`Call signal failed: ${response.status}`);
  }

  async function getMedia(includeAudio) {
    const video = {
      facingMode: "user",
      width: { ideal: 960 },
      height: { ideal: 960 }
    };

    try {
      return await navigator.mediaDevices.getUserMedia({ video, audio: includeAudio });
    } catch (error) {
      if (!includeAudio) throw error;
      return navigator.mediaDevices.getUserMedia({ video, audio: false });
    }
  }

  function playVideo(video, stream, elements, statusText) {
    video.srcObject = stream;
    elements.card.dataset.ready = "true";
    setStatus(elements, statusText || "");
    const playPromise = video.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(() => {
        setStatus(elements, "Tap to start");
      });
    }
  }

  async function startPreview(container, elements, runtime) {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
      setStatus(elements, "Camera unavailable");
      return;
    }
    if (runtime.previewStream || runtime.broadcastStream) return;

    setStatus(elements, "Camera");
    try {
      const stream = await getMedia(false);
      if (runtime.discard || !container.isConnected || runtime.broadcastStream) {
        stopStream(stream);
        return;
      }
      runtime.previewStream = stream;
      elements.video.muted = true;
      elements.video.classList.add("cam-video-local");
      playVideo(elements.video, stream, elements, "");
    } catch (error) {
      const denied = error && (error.name === "NotAllowedError" || error.name === "PermissionDeniedError");
      setStatus(elements, denied ? "Camera blocked" : "Camera error");
    }
  }

  function closePeerConnection(runtime, peerId) {
    const peer = runtime.peers.get(peerId);
    if (!peer) return;
    try {
      peer.connection.close();
    } catch (error) {
      // Older browser builds can throw while closing a failed peer.
    }
    runtime.peers.delete(peerId);
  }

  function closeAllPeerConnections(runtime) {
    for (const peerId of Array.from(runtime.peers.keys())) closePeerConnection(runtime, peerId);
  }

  function showFirstRemoteStream(elements, runtime) {
    for (const peer of runtime.peers.values()) {
      if (peer.stream) {
        elements.video.muted = false;
        elements.video.classList.remove("cam-video-local");
        playVideo(elements.video, peer.stream, elements, "Live");
        return true;
      }
    }
    return false;
  }

  async function stopBroadcast(container, elements, runtime) {
    closeAllPeerConnections(runtime);
    runtime.connectingPeers.clear();
    stopStream(runtime.broadcastStream);
    runtime.broadcastStream = null;
    elements.card.dataset.calling = "false";
    elements.video.muted = true;
    elements.video.classList.add("cam-video-local");
    if (runtime.previewStream) {
      playVideo(elements.video, runtime.previewStream, elements, "");
      return;
    }
    await startPreview(container, elements, runtime);
  }

  async function ensureBroadcastStream(container, elements, runtime) {
    if (runtime.broadcastStream) return runtime.broadcastStream;
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") return null;

    setStatus(elements, "Joining call");
    try {
      const stream = await getMedia(true);
      if (runtime.discard || !container.isConnected) {
        stopStream(stream);
        return null;
      }

      stopStream(runtime.previewStream);
      runtime.previewStream = null;
      runtime.broadcastStream = stream;
      elements.card.dataset.calling = "true";
      elements.video.muted = true;
      elements.video.classList.add("cam-video-local");
      playVideo(elements.video, stream, elements, "Live");
      return stream;
    } catch (error) {
      const denied = error && (error.name === "NotAllowedError" || error.name === "PermissionDeniedError");
      setStatus(elements, denied ? "Camera blocked" : "Camera error");
      return null;
    }
  }

  async function createOffer(runtime, peerId) {
    const peer = runtime.peers.get(peerId);
    if (!peer || runtime.connectingPeers.has(peerId)) return;
    runtime.connectingPeers.add(peerId);
    try {
      const offer = await peer.connection.createOffer();
      await peer.connection.setLocalDescription(offer);
      await sendSignal(runtime, "offer", peerId, offer);
    } finally {
      runtime.connectingPeers.delete(peerId);
    }
  }

  function ensurePeerConnection(container, elements, runtime, peerId) {
    if (runtime.peers.has(peerId)) return runtime.peers.get(peerId);

    const connection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const peer = { connection, stream: null };
    runtime.peers.set(peerId, peer);

    if (runtime.broadcastStream) {
      for (const track of runtime.broadcastStream.getTracks()) {
        connection.addTrack(track, runtime.broadcastStream);
      }
    }

    connection.addEventListener("icecandidate", (event) => {
      if (event.candidate) void sendSignal(runtime, "ice", peerId, event.candidate.toJSON()).catch(console.error);
    });

    connection.addEventListener("track", (event) => {
      if (!event.streams || !event.streams[0]) return;
      peer.stream = event.streams[0];
      if (!runtime.discard && container.isConnected) showFirstRemoteStream(elements, runtime);
    });

    connection.addEventListener("connectionstatechange", () => {
      if (connection.connectionState === "failed" || connection.connectionState === "closed") {
        closePeerConnection(runtime, peerId);
        if (!showFirstRemoteStream(elements, runtime) && runtime.broadcastStream) {
          playVideo(elements.video, runtime.broadcastStream, elements, "Live");
        }
      }
    });

    return peer;
  }

  async function connectToPeer(container, elements, runtime, peerId) {
    if (peerId === runtime.peerId) return;
    const stream = await ensureBroadcastStream(container, elements, runtime);
    if (!stream || runtime.discard) return;
    ensurePeerConnection(container, elements, runtime, peerId);
    if (runtime.peerId < peerId) await createOffer(runtime, peerId);
  }

  async function handleSignal(container, elements, runtime, message) {
    const messageId = message && message.id;
    if (messageId && runtime.processedSignalIds.has(messageId)) return;
    if (messageId) runtime.processedSignalIds.add(messageId);

    const from = message && message.from;
    const type = message && message.type;
    if (!from || from === runtime.peerId || runtime.discard) return;
    const payload = message.payload || {};

    if (type === "offer") {
      await ensureBroadcastStream(container, elements, runtime);
      const peer = ensurePeerConnection(container, elements, runtime, from);
      await peer.connection.setRemoteDescription(new RTCSessionDescription(payload));
      const answer = await peer.connection.createAnswer();
      await peer.connection.setLocalDescription(answer);
      await sendSignal(runtime, "answer", from, answer);
      return;
    }

    if (type === "answer") {
      const peer = runtime.peers.get(from);
      if (peer && peer.connection.signalingState !== "stable") {
        await peer.connection.setRemoteDescription(new RTCSessionDescription(payload));
      }
      return;
    }

    if (type === "ice") {
      const peer = runtime.peers.get(from);
      if (peer && payload && payload.candidate) {
        await peer.connection.addIceCandidate(new RTCIceCandidate(payload));
      }
    }
  }

  async function pollCall(container, elements, runtime) {
    if (runtime.discard) return;
    if (!runtime.room || document.hidden) {
      runtime.pollTimer = setTimeout(() => pollCall(container, elements, runtime), SIGNAL_POLL_MS);
      return;
    }

    try {
      const response = await fetch(getCallUrl(runtime), {
        headers: { "Accept": "application/json" },
        cache: "no-store"
      });
      if (!response.ok) throw new Error(`Call signaling failed: ${response.status}`);
      const data = await response.json();
      if (runtime.discard) return;

      const participants = Array.isArray(data.participants) ? data.participants : [];
      const remotePeerIds = participants
        .map((participant) => participant && participant.peer)
        .filter((peerId) => peerId && peerId !== runtime.peerId);
      const activeRemotePeers = new Set(remotePeerIds);

      for (const peerId of Array.from(runtime.peers.keys())) {
        if (!activeRemotePeers.has(peerId)) closePeerConnection(runtime, peerId);
      }

      if (remotePeerIds.length === 0) {
        if (runtime.broadcastStream) await stopBroadcast(container, elements, runtime);
      } else {
        for (const peerId of remotePeerIds) await connectToPeer(container, elements, runtime, peerId);
      }

      const messages = Array.isArray(data.messages) ? data.messages : [];
      for (const message of messages) {
        try {
          await handleSignal(container, elements, runtime, message);
        } catch (error) {
          console.error(error);
        }
      }
      runtime.lastSignalAt = Number(data.now) || Date.now();
      if (remotePeerIds.length > 0 && !showFirstRemoteStream(elements, runtime) && runtime.broadcastStream) {
        playVideo(elements.video, runtime.broadcastStream, elements, "Live");
      }
    } catch (error) {
      console.error(error);
      if (!runtime.broadcastStream) setStatus(elements, "Camera");
    } finally {
      if (!runtime.discard) {
        runtime.pollTimer = setTimeout(() => pollCall(container, elements, runtime), SIGNAL_POLL_MS);
      }
    }
  }

  function startCallPresence(container, elements, runtime) {
    if (!runtime.room) return;
    runtime.pollTimer = setTimeout(() => pollCall(container, elements, runtime), 250);
  }

  function sendLeave(runtime) {
    if (!runtime.room || !navigator.sendBeacon) return;
    const body = JSON.stringify({
      space: runtime.room.space,
      room: runtime.room.room,
      peer: runtime.peerId,
      type: "leave"
    });
    navigator.sendBeacon(CALLS_URL, new Blob([body], { type: "application/json" }));
  }

  function createState() {
    return {
      createdAt: Date.now()
    };
  }

  window.SkydiveCommands.push({
    id: "cam",
    aliases: ["camera", "webcam"],
    title: "Camera",
    description: "Show a local webcam bubble.",

    createState,

    getTitle() {
      return "Camera";
    },

    destroy(container) {
      const runtime = runtimes.get(container);
      if (!runtime) return;
      runtime.discard = true;
      if (runtime.pollTimer !== null) clearTimeout(runtime.pollTimer);
      sendLeave(runtime);
      closeAllPeerConnections(runtime);
      stopStream(runtime.broadcastStream);
      stopStream(runtime.previewStream);
      runtimes.delete(container);
    },

    render(container, state = {}, onState = null, context = {}) {
      this.destroy(container);

      const runtime = {
        peerId: createPeerId(),
        room: getRoomInfo(state, context),
        previewStream: null,
        broadcastStream: null,
        peers: new Map(),
        connectingPeers: new Set(),
        processedSignalIds: new Set(),
        lastSignalAt: 0,
        pollTimer: null,
        discard: false
      };
      runtimes.set(container, runtime);

      container.innerHTML = `
        <div class="cam-card" data-calling="false">
          <video class="cam-video cam-video-local" autoplay muted playsinline></video>
          <div class="cam-status" aria-live="polite">Camera</div>
        </div>
      `;

      const style = document.createElement("style");
      style.textContent = `
        .cam-card {
          position: relative;
          width: 5.8em;
          height: 5.8em;
          overflow: hidden;
          border: 0.08em solid rgba(17, 24, 39, 0.18);
          border-radius: 50%;
          background: #f4f4f2;
          box-shadow: 0 0.12em 0.52em rgba(17, 24, 39, 0.16);
          color: #3f3d37;
        }

        .cam-card[data-calling="true"] {
          border-color: rgba(36, 131, 76, 0.55);
          box-shadow: 0 0 0 0.05em rgba(36, 131, 76, 0.16), 0 0.12em 0.52em rgba(17, 24, 39, 0.16);
        }

        .cam-video {
          display: block;
          width: 100%;
          height: 100%;
          object-fit: cover;
          opacity: 0;
          transition: opacity 180ms ease;
          background: #f4f4f2;
        }

        .cam-video-local {
          transform: scaleX(-1);
        }

        .cam-card[data-ready="true"] .cam-video {
          opacity: 1;
        }

        .cam-status {
          position: absolute;
          inset: 0;
          display: grid;
          place-items: center;
          padding: 0.7em;
          color: #4b4840;
          font: 400 0.42em/1.1 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
          letter-spacing: 0;
          text-align: center;
          white-space: normal;
          pointer-events: none;
        }

        .cam-card[data-ready="true"] .cam-status:empty {
          display: none;
        }
      `;
      container.appendChild(style);

      const elements = {
        card: container.querySelector(".cam-card"),
        video: container.querySelector(".cam-video"),
        status: container.querySelector(".cam-status")
      };

      elements.card.addEventListener("click", () => {
        if (!elements.video.srcObject) return;
        const playPromise = elements.video.play();
        if (playPromise && typeof playPromise.catch === "function") playPromise.catch(() => {});
      });

      void startPreview(container, elements, runtime);
      startCallPresence(container, elements, runtime);
    }
  });
})();
