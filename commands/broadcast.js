(function () {
  window.SkydiveCommands = window.SkydiveCommands || [];

  const runtimes = new WeakMap();
  const activeRuntimes = new Map();
  const CALLS_URL = "/.netlify/functions/calls";
  const LOCAL_OWNER_KEY = "skydive.broadcastOwner.v1";
  const SIGNAL_POLL_MS = 1600;
  const DETACH_GRACE_MS = 5000;
  const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

  function stopStream(stream) {
    if (!stream) return;
    for (const track of stream.getTracks()) track.stop();
  }

  function setStatus(elements, text) {
    if (elements.status) elements.status.textContent = text;
  }

  function randomId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function getLocalOwnerKey() {
    try {
      const existing = localStorage.getItem(LOCAL_OWNER_KEY);
      if (existing) return existing;
      const next = randomId();
      localStorage.setItem(LOCAL_OWNER_KEY, next);
      return next;
    } catch (error) {
      return randomId();
    }
  }

  function sameUser(left, right) {
    return Boolean(left && right && left.id && right.id && left.id === right.id);
  }

  function getRoomInfo(state, context) {
    const space = context && typeof context.currentSpaceSlug === "string" ? context.currentSpaceSlug.trim() : "";
    const nodeId = context && typeof context.nodeId === "string" ? context.nodeId.trim() : "";
    const createdAt = Number(state && state.createdAt) || 0;
    const room = nodeId || (createdAt ? `broadcast-${createdAt}` : "");
    if (!space || !room) return null;
    return { space, room };
  }

  function getRole(state, context) {
    const ownerKey = typeof state.ownerKey === "string" ? state.ownerKey : "";
    if (ownerKey && ownerKey === getLocalOwnerKey()) return "publisher";
    if (sameUser(context && context.nodeCreatedBy, context && context.currentUser)) return "publisher";
    return "viewer";
  }

  function getRuntimeKey(room, role) {
    return room ? `${room.space}\n${room.room}\n${role}` : "";
  }

  function getCallUrl(runtime) {
    const params = new URLSearchParams({
      space: runtime.room.space,
      room: runtime.room.room,
      peer: runtime.peerId,
      role: runtime.role,
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
        role: runtime.role,
        type,
        to,
        payload
      })
    });
    if (!response.ok) throw new Error(`Broadcast signal failed: ${response.status}`);
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

  function playVideo(video, stream, elements, statusText, local) {
    if (video.srcObject !== stream) video.srcObject = stream;
    elements.card.dataset.ready = "true";
    video.muted = Boolean(local);
    video.classList.toggle("broadcast-video-local", Boolean(local));
    setStatus(elements, statusText || "");
    const playPromise = video.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(() => {
        setStatus(elements, "Tap to start");
      });
    }
  }

  function showIdle(elements, runtime) {
    if (runtime.stream || runtime.previewStream) {
      playVideo(elements.video, runtime.stream || runtime.previewStream, elements, "", true);
      return;
    }
    elements.card.dataset.calling = "false";
    setStatus(elements, runtime.role === "publisher" ? "Broadcast" : "Waiting");
  }

  function closePeerConnection(runtime, peerId) {
    const peer = runtime.peers.get(peerId);
    if (!peer) return;
    try {
      peer.connection.close();
    } catch (error) {
      // Failed peer connections can throw during close in some browser builds.
    }
    runtime.peers.delete(peerId);
  }

  function closeAllPeerConnections(runtime) {
    for (const peerId of Array.from(runtime.peers.keys())) closePeerConnection(runtime, peerId);
  }

  function showFirstRemoteStream(elements, runtime) {
    for (const peer of runtime.peers.values()) {
      if (peer.stream) {
        playVideo(elements.video, peer.stream, elements, "Live", false);
        return true;
      }
    }
    return false;
  }

  async function startPreview(container, elements, runtime) {
    if (runtime.role !== "publisher") return;
    if (runtime.previewStream || runtime.stream) return;
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
      setStatus(elements, "Camera unavailable");
      return;
    }

    setStatus(elements, "Broadcast");
    try {
      const stream = await getMedia(false);
      if (runtime.discard || !container.isConnected || runtime.stream) {
        stopStream(stream);
        return;
      }
      runtime.previewStream = stream;
      playVideo(elements.video, stream, elements, "", true);
    } catch (error) {
      const denied = error && (error.name === "NotAllowedError" || error.name === "PermissionDeniedError");
      setStatus(elements, denied ? "Camera blocked" : "Camera error");
    }
  }

  async function stopPublishing(container, elements, runtime) {
    closeAllPeerConnections(runtime);
    runtime.connectingPeers.clear();
    stopStream(runtime.stream);
    runtime.stream = null;
    elements.video.srcObject = null;
    elements.card.dataset.ready = "false";
    elements.card.dataset.calling = "false";
    await startPreview(container, elements, runtime);
  }

  async function ensurePublisherStream(container, elements, runtime) {
    if (runtime.stream) return runtime.stream;
    if (runtime.role !== "publisher") return null;
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
      setStatus(elements, "Camera unavailable");
      return null;
    }

    setStatus(elements, "Starting");
    try {
      const stream = await getMedia(true);
      if (runtime.discard || !container.isConnected) {
        stopStream(stream);
        return null;
      }
      stopStream(runtime.previewStream);
      runtime.previewStream = null;
      runtime.stream = stream;
      elements.card.dataset.calling = "true";
      playVideo(elements.video, stream, elements, "Live", true);
      return stream;
    } catch (error) {
      const denied = error && (error.name === "NotAllowedError" || error.name === "PermissionDeniedError");
      setStatus(elements, denied ? "Camera blocked" : "Camera error");
      return null;
    }
  }

  async function createOffer(runtime, peerId) {
    const peer = runtime.peers.get(peerId);
    if (!peer || peer.offerSent || runtime.connectingPeers.has(peerId)) return;
    runtime.connectingPeers.add(peerId);
    try {
      const offer = await peer.connection.createOffer();
      await peer.connection.setLocalDescription(offer);
      await sendSignal(runtime, "offer", peerId, offer);
      peer.offerSent = true;
    } finally {
      runtime.connectingPeers.delete(peerId);
    }
  }

  function ensurePeerConnection(container, elements, runtime, peerId) {
    if (runtime.peers.has(peerId)) return runtime.peers.get(peerId);

    const connection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const peer = { connection, stream: null, offerSent: false };
    runtime.peers.set(peerId, peer);

    if (runtime.role === "publisher" && runtime.stream) {
      for (const track of runtime.stream.getTracks()) connection.addTrack(track, runtime.stream);
    }

    connection.addEventListener("icecandidate", (event) => {
      if (event.candidate) void sendSignal(runtime, "ice", peerId, event.candidate.toJSON()).catch(console.error);
    });

    connection.addEventListener("track", (event) => {
      if (runtime.role === "publisher" || !event.streams || !event.streams[0]) return;
      peer.stream = event.streams[0];
      if (!runtime.discard && container.isConnected) showFirstRemoteStream(elements, runtime);
    });

    connection.addEventListener("connectionstatechange", () => {
      if (connection.connectionState === "failed" || connection.connectionState === "closed") {
        closePeerConnection(runtime, peerId);
        if (runtime.role === "viewer" && !showFirstRemoteStream(elements, runtime)) {
          elements.video.srcObject = null;
          elements.card.dataset.ready = "false";
          setStatus(elements, "Waiting");
        }
      }
    });

    return peer;
  }

  async function connectToViewer(container, elements, runtime, peerId) {
    if (runtime.role !== "publisher") return;
    const stream = await ensurePublisherStream(container, elements, runtime);
    if (!stream || runtime.discard) return;
    ensurePeerConnection(container, elements, runtime, peerId);
    await createOffer(runtime, peerId);
  }

  async function handleSignal(container, elements, runtime, message) {
    const messageId = message && message.id;
    if (messageId && runtime.processedSignalIds.has(messageId)) return;
    if (messageId) runtime.processedSignalIds.add(messageId);

    const from = message && message.from;
    const type = message && message.type;
    if (!from || from === runtime.peerId || runtime.discard) return;
    const payload = message.payload || {};

    if (runtime.role === "viewer" && type === "offer") {
      const peer = ensurePeerConnection(container, elements, runtime, from);
      await peer.connection.setRemoteDescription(new RTCSessionDescription(payload));
      const answer = await peer.connection.createAnswer();
      await peer.connection.setLocalDescription(answer);
      await sendSignal(runtime, "answer", from, answer);
      return;
    }

    if (runtime.role === "publisher" && type === "answer") {
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

  async function pollBroadcast(runtime) {
    if (runtime.discard) return;
    const container = runtime.container;
    const elements = runtime.elements;
    runtime.pollTimer = null;
    if (!container || !elements || !container.isConnected) {
      runtime.pollTimer = setTimeout(() => pollBroadcast(runtime), SIGNAL_POLL_MS);
      return;
    }
    if (!runtime.room || document.hidden) {
      runtime.pollTimer = setTimeout(() => pollBroadcast(runtime), SIGNAL_POLL_MS);
      return;
    }

    try {
      const response = await fetch(getCallUrl(runtime), {
        headers: { "Accept": "application/json" },
        cache: "no-store"
      });
      if (!response.ok) throw new Error(`Broadcast signaling failed: ${response.status}`);
      const data = await response.json();
      if (runtime.discard) return;

      const participants = Array.isArray(data.participants) ? data.participants : [];
      const viewers = participants
        .filter((participant) => participant && participant.role === "viewer" && participant.peer !== runtime.peerId)
        .map((participant) => participant.peer);
      const publishers = participants
        .filter((participant) => participant && participant.role === "publisher" && participant.peer !== runtime.peerId)
        .map((participant) => participant.peer);
      const expectedPeers = new Set(runtime.role === "publisher" ? viewers : publishers);

      for (const peerId of Array.from(runtime.peers.keys())) {
        if (!expectedPeers.has(peerId)) closePeerConnection(runtime, peerId);
      }

      if (runtime.role === "publisher") {
        if (viewers.length === 0) {
          if (runtime.stream) await stopPublishing(container, elements, runtime);
        } else {
          for (const peerId of viewers) await connectToViewer(container, elements, runtime, peerId);
        }
      } else if (publishers.length === 0) {
        if (!showFirstRemoteStream(elements, runtime)) showIdle(elements, runtime);
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
    } catch (error) {
      console.error(error);
      if (!runtime.stream && !showFirstRemoteStream(elements, runtime)) showIdle(elements, runtime);
    } finally {
      if (!runtime.discard) {
        runtime.pollTimer = setTimeout(() => pollBroadcast(runtime), SIGNAL_POLL_MS);
      }
    }
  }

  function sendLeave(runtime) {
    if (!runtime.room || !navigator.sendBeacon) return;
    const body = JSON.stringify({
      space: runtime.room.space,
      room: runtime.room.room,
      peer: runtime.peerId,
      role: runtime.role,
      type: "leave"
    });
    navigator.sendBeacon(CALLS_URL, new Blob([body], { type: "application/json" }));
  }

  function createState() {
    return {
      createdAt: Date.now(),
      ownerKey: getLocalOwnerKey()
    };
  }

  function closeRuntime(runtime) {
    if (!runtime || runtime.discard) return;
    runtime.discard = true;
    if (runtime.pollTimer !== null) clearTimeout(runtime.pollTimer);
    if (runtime.detachTimer !== null) clearTimeout(runtime.detachTimer);
    sendLeave(runtime);
    closeAllPeerConnections(runtime);
    stopStream(runtime.stream);
    stopStream(runtime.previewStream);
    if (runtime.key) activeRuntimes.delete(runtime.key);
  }

  window.SkydiveCommands.push({
    id: "broadcast",
    aliases: ["cast", "live"],
    title: "Broadcast",
    description: "Share a camera bubble with viewers in this space.",

    createState,

    getTitle() {
      return "Broadcast";
    },

    destroy(container) {
      const runtime = runtimes.get(container);
      if (!runtime) return;
      runtimes.delete(container);
      runtime.container = null;
      runtime.elements = null;
      if (runtime.detachTimer !== null) clearTimeout(runtime.detachTimer);
      runtime.detachTimer = setTimeout(() => {
        runtime.detachTimer = null;
        closeRuntime(runtime);
      }, DETACH_GRACE_MS);
    },

    render(container, state = {}, onState = null, context = {}) {
      this.destroy(container);

      const role = getRole(state, context);
      const room = getRoomInfo(state, context);
      const key = getRuntimeKey(room, role);
      let runtime = key ? activeRuntimes.get(key) : null;
      if (!runtime || runtime.discard) {
        runtime = {
          key,
          peerId: randomId(),
          role,
          room,
          container: null,
          elements: null,
          stream: null,
          previewStream: null,
          peers: new Map(),
          connectingPeers: new Set(),
          processedSignalIds: new Set(),
          lastSignalAt: 0,
          pollTimer: null,
          detachTimer: null,
          discard: false
        };
        if (key) activeRuntimes.set(key, runtime);
      } else {
        if (runtime.detachTimer !== null) {
          clearTimeout(runtime.detachTimer);
          runtime.detachTimer = null;
        }
      }
      runtimes.set(container, runtime);

      container.innerHTML = `
        <div class="broadcast-card" data-calling="false" data-role="${role}">
          <video class="broadcast-video" autoplay muted playsinline></video>
          <div class="broadcast-status" aria-live="polite">Broadcast</div>
        </div>
      `;

      const style = document.createElement("style");
      style.textContent = `
        .broadcast-card {
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

        .broadcast-card[data-calling="true"] {
          border-color: rgba(36, 131, 76, 0.55);
          box-shadow: 0 0 0 0.05em rgba(36, 131, 76, 0.16), 0 0.12em 0.52em rgba(17, 24, 39, 0.16);
        }

        .broadcast-video {
          display: block;
          width: 100%;
          height: 100%;
          object-fit: cover;
          opacity: 0;
          transition: opacity 180ms ease;
          background: #f4f4f2;
        }

        .broadcast-video-local {
          transform: scaleX(-1);
        }

        .broadcast-card[data-ready="true"] .broadcast-video {
          opacity: 1;
        }

        .broadcast-status {
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

        .broadcast-card[data-ready="true"] .broadcast-status:empty {
          display: none;
        }
      `;
      container.appendChild(style);

      const elements = {
        card: container.querySelector(".broadcast-card"),
        video: container.querySelector(".broadcast-video"),
        status: container.querySelector(".broadcast-status")
      };
      runtime.container = container;
      runtime.elements = elements;

      elements.card.addEventListener("click", () => {
        if (!elements.video.srcObject) return;
        const playPromise = elements.video.play();
        if (playPromise && typeof playPromise.catch === "function") playPromise.catch(() => {});
      });

      if (runtime.role === "publisher") {
        if (runtime.stream) playVideo(elements.video, runtime.stream, elements, "Live", true);
        else if (runtime.previewStream) playVideo(elements.video, runtime.previewStream, elements, "", true);
        else void startPreview(container, elements, runtime);
      } else if (!showFirstRemoteStream(elements, runtime)) {
        showIdle(elements, runtime);
      }
      if (runtime.room) {
        if (runtime.pollTimer === null) {
          runtime.pollTimer = setTimeout(() => pollBroadcast(runtime), 250);
        }
      } else {
        setStatus(elements, "Shared space only");
      }
    }
  });
})();
