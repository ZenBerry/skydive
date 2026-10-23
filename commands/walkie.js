(function () {
  window.SkydiveCommands = window.SkydiveCommands || [];

  const runtimes = new WeakMap();
  const activeRuntimes = new Map();
  const CALLS_URL = "/.netlify/functions/calls";
  const SQUELCH_URL = "/assets/radio-sign-off-squelch.wav";
  const SIGNAL_POLL_MS = 450;
  const DETACH_GRACE_MS = 5000;
  const RECEIVED_PEER_TTL_MS = 60000;
  const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
  let lastInteractedRuntime = null;
  let keyboardRuntime = null;

  function randomId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function stopStream(stream) {
    if (!stream) return;
    for (const track of stream.getTracks()) track.stop();
  }

  function getRoom(context) {
    const space = context && typeof context.currentSpaceSlug === "string" ? context.currentSpaceSlug.trim() : "";
    const nodeId = context && typeof context.nodeId === "string" ? context.nodeId.trim() : "";
    return space && nodeId ? { space, room: nodeId } : null;
  }

  function getRuntimeKey(room) {
    return room ? `${room.space}\n${room.room}` : "";
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
    if (!response.ok) throw new Error(`Walkie signal failed: ${response.status}`);
  }

  function setTalking(runtime, talking) {
    runtime.talking = talking;
    const button = runtime.elements && runtime.elements.button;
    if (button) {
      button.dataset.talking = String(talking);
      button.setAttribute("aria-pressed", String(talking));
    }
    for (const peer of runtime.peers.values()) {
      if (peer.audio) peer.audio.muted = talking;
    }
  }

  function connectAudioElement(runtime, audio) {
    if (runtime.context && typeof runtime.context.connectAudioElement === "function") {
      runtime.context.connectAudioElement(audio);
    }
  }

  function createRemoteAudio(runtime, peer) {
    if (!runtime.elements || !runtime.elements.card || !peer.stream) return;
    if (peer.audio) peer.audio.remove();
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.playsInline = true;
    audio.hidden = true;
    audio.muted = runtime.talking;
    audio.srcObject = peer.stream;
    runtime.elements.card.appendChild(audio);
    peer.audio = audio;
    const playPromise = audio.play();
    if (playPromise && typeof playPromise.catch === "function") playPromise.catch(() => {});
  }

  function playSquelch(runtime) {
    if (runtime.talking || !runtime.elements || !runtime.elements.squelch) return;
    const audio = runtime.elements.squelch;
    try { audio.currentTime = 0; } catch (error) { /* Metadata may not be ready yet. */ }
    const playPromise = audio.play();
    if (playPromise && typeof playPromise.catch === "function") playPromise.catch(() => {});
  }

  function closePeer(runtime, peerId) {
    const peer = runtime.peers.get(peerId);
    if (!peer) return;
    if (peer.audio) peer.audio.remove();
    try { peer.connection.close(); } catch (error) { /* Already-closed peers can throw. */ }
    runtime.peers.delete(peerId);
  }

  function closeAllPeers(runtime) {
    for (const peerId of Array.from(runtime.peers.keys())) closePeer(runtime, peerId);
  }

  function ensurePeer(runtime, peerId) {
    if (runtime.peers.has(peerId)) return runtime.peers.get(peerId);
    const connection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const peer = { connection, stream: null, audio: null, offerSent: false };
    runtime.peers.set(peerId, peer);

    if (runtime.role === "publisher" && runtime.stream) {
      for (const track of runtime.stream.getTracks()) connection.addTrack(track, runtime.stream);
    }
    connection.addEventListener("icecandidate", (event) => {
      if (event.candidate) void sendSignal(runtime, "ice", peerId, event.candidate.toJSON()).catch(console.error);
    });
    connection.addEventListener("track", (event) => {
      if (runtime.role !== "viewer" || !event.streams || !event.streams[0]) return;
      peer.stream = event.streams[0];
      runtime.receivedPeers.set(peerId, Date.now());
      createRemoteAudio(runtime, peer);
    });
    connection.addEventListener("connectionstatechange", () => {
      if (connection.connectionState === "failed" || connection.connectionState === "closed") {
        closePeer(runtime, peerId);
      }
    });
    return peer;
  }

  async function createOffer(runtime, peerId) {
    const peer = ensurePeer(runtime, peerId);
    if (peer.offerSent || runtime.connectingPeers.has(peerId)) return;
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

  async function handleSignal(runtime, message) {
    const messageId = message && message.id;
    if (messageId && runtime.processedSignalIds.has(messageId)) return;
    if (messageId) runtime.processedSignalIds.add(messageId);
    const from = message && message.from;
    const type = message && message.type;
    if (!from || from === runtime.peerId || runtime.discard) return;
    const payload = message.payload || {};

    if (type === "talk-end") {
      const receivedAt = runtime.receivedPeers.get(from) || 0;
      if (runtime.role === "viewer" && Date.now() - receivedAt <= RECEIVED_PEER_TTL_MS) playSquelch(runtime);
      runtime.receivedPeers.delete(from);
      return;
    }
    if (runtime.role === "viewer" && type === "offer") {
      const peer = ensurePeer(runtime, from);
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

  function schedulePoll(runtime, delay = SIGNAL_POLL_MS) {
    if (runtime.discard) return;
    if (runtime.pollTimer !== null) clearTimeout(runtime.pollTimer);
    runtime.pollTimer = setTimeout(() => pollWalkie(runtime), delay);
  }

  async function pollWalkie(runtime) {
    runtime.pollTimer = null;
    if (runtime.discard || runtime.polling || !runtime.room) return;
    runtime.polling = true;
    try {
      const response = await fetch(getCallUrl(runtime), {
        headers: { "Accept": "application/json" },
        cache: "no-store"
      });
      if (!response.ok) throw new Error(`Walkie signaling failed: ${response.status}`);
      const data = await response.json();
      if (runtime.discard) return;

      const messages = Array.isArray(data.messages) ? data.messages : [];
      for (const message of messages) {
        try { await handleSignal(runtime, message); } catch (error) { console.error(error); }
      }

      const participants = Array.isArray(data.participants) ? data.participants : [];
      const expectedPeers = new Set(participants
        .filter((participant) => participant && participant.peer !== runtime.peerId && (
          runtime.role === "publisher" ? participant.role === "viewer" : participant.role === "publisher"
        ))
        .map((participant) => participant.peer));
      for (const peerId of Array.from(runtime.peers.keys())) {
        if (!expectedPeers.has(peerId)) closePeer(runtime, peerId);
      }
      if (runtime.role === "publisher" && runtime.stream) {
        for (const peerId of expectedPeers) await createOffer(runtime, peerId);
      }
      runtime.lastSignalAt = Number(data.now) || Date.now();
    } catch (error) {
      console.error(error);
    } finally {
      runtime.polling = false;
      schedulePoll(runtime);
    }
  }

  async function beginTalk(runtime, hold) {
    if (!runtime || runtime.discard || !runtime.room) return;
    runtime.holds.add(hold);
    if (runtime.talking) return;
    lastInteractedRuntime = runtime;
    setTalking(runtime, true);
    runtime.role = "publisher";
    runtime.receivedPeers.clear();
    closeAllPeers(runtime);
    try {
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
        throw new Error("Microphone unavailable");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      if (!runtime.talking || runtime.discard) {
        stopStream(stream);
        return;
      }
      runtime.stream = stream;
      schedulePoll(runtime, 0);
    } catch (error) {
      console.error(error);
      runtime.role = "viewer";
      setTalking(runtime, false);
      if (runtime.elements && runtime.elements.button) runtime.elements.button.title = "Microphone unavailable";
      schedulePoll(runtime, 0);
    }
  }

  function endTalk(runtime, hold) {
    if (!runtime) return;
    runtime.holds.delete(hold);
    if (!runtime.talking || runtime.holds.size > 0) return;
    if (runtime.stream) void sendSignal(runtime, "talk-end").catch(console.error);
    setTalking(runtime, false);
    stopStream(runtime.stream);
    runtime.holds.clear();
    runtime.stream = null;
    runtime.role = "viewer";
    closeAllPeers(runtime);
    runtime.connectingPeers.clear();
    schedulePoll(runtime, 0);
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

  function closeRuntime(runtime) {
    if (!runtime || runtime.discard) return;
    runtime.discard = true;
    if (runtime.pollTimer !== null) clearTimeout(runtime.pollTimer);
    if (runtime.detachTimer !== null) clearTimeout(runtime.detachTimer);
    sendLeave(runtime);
    setTalking(runtime, false);
    stopStream(runtime.stream);
    closeAllPeers(runtime);
    if (runtime.key) activeRuntimes.delete(runtime.key);
    if (lastInteractedRuntime === runtime) lastInteractedRuntime = null;
    if (keyboardRuntime === runtime) keyboardRuntime = null;
  }

  function connectedRuntimes() {
    return Array.from(activeRuntimes.values()).filter((runtime) => (
      !runtime.discard && runtime.container && runtime.container.isConnected && runtime.room
    ));
  }

  function chooseKeyboardRuntime() {
    const available = connectedRuntimes();
    if (available.length === 0) return null;
    return available.find((runtime) => runtime.elements && runtime.elements.button === document.activeElement)
      || available.find((runtime) => runtime.elements && runtime.elements.card.matches(":hover"))
      || available.find((runtime) => runtime.container.classList.contains("selected"))
      || (available.length === 1 ? available[0] : null)
      || (available.includes(lastInteractedRuntime) ? lastInteractedRuntime : null);
  }

  document.addEventListener("keydown", (event) => {
    if (event.code !== "ShiftRight" || event.repeat || keyboardRuntime) return;
    keyboardRuntime = chooseKeyboardRuntime();
    if (keyboardRuntime) void beginTalk(keyboardRuntime, "keyboard");
  }, true);

  document.addEventListener("keyup", (event) => {
    if (event.code !== "ShiftRight" || !keyboardRuntime) return;
    const runtime = keyboardRuntime;
    keyboardRuntime = null;
    endTalk(runtime, "keyboard");
  }, true);

  window.addEventListener("blur", () => {
    if (!keyboardRuntime) return;
    const runtime = keyboardRuntime;
    keyboardRuntime = null;
    endTalk(runtime, "keyboard");
  });

  window.addEventListener("pagehide", () => {
    for (const runtime of Array.from(activeRuntimes.values())) closeRuntime(runtime);
  });

  window.SkydiveCommands.push({
    id: "walkie",
    title: "Walkie Talkie",
    description: "Hold to talk with everyone viewing this space.",

    createState() {
      return { createdAt: Date.now() };
    },

    getTitle() {
      return "Walkie Talkie";
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
      const room = getRoom(context);
      const key = getRuntimeKey(room);
      let runtime = key ? activeRuntimes.get(key) : null;
      if (!runtime || runtime.discard) {
        runtime = {
          key,
          room,
          peerId: randomId(),
          role: "viewer",
          talking: false,
          holds: new Set(),
          stream: null,
          peers: new Map(),
          receivedPeers: new Map(),
          connectingPeers: new Set(),
          processedSignalIds: new Set(),
          lastSignalAt: 0,
          pollTimer: null,
          polling: false,
          detachTimer: null,
          container: null,
          elements: null,
          context,
          discard: false
        };
        if (key) activeRuntimes.set(key, runtime);
      } else if (runtime.detachTimer !== null) {
        clearTimeout(runtime.detachTimer);
        runtime.detachTimer = null;
      }
      runtimes.set(container, runtime);

      container.innerHTML = `
        <div class="walkie-card">
          <button class="walkie-talk" type="button" aria-pressed="false" data-talking="false">Talk</button>
          <audio class="walkie-squelch" preload="auto" src="${SQUELCH_URL}" hidden></audio>
        </div>
      `;
      const style = document.createElement("style");
      style.textContent = `
        .walkie-card {
          display: grid;
          place-items: center;
          min-width: 4.7em;
          padding: 0.72em;
          border: 0.055em solid var(--widget-border-color);
          border-radius: var(--widget-shell-radius);
          corner-shape: squircle;
          background: var(--widget-color, #fffaf3);
          color: #40342b;
        }

        .walkie-talk {
          min-width: 3.25em;
          padding: 0.42em 0.8em;
          border: 0.055em solid var(--widget-border-color);
          border-radius: var(--widget-button-radius);
          corner-shape: squircle;
          background: var(--widget-button-color, #e7dac9);
          color: #111;
          font: inherit;
          line-height: 1;
          cursor: pointer;
          user-select: none;
          touch-action: none;
        }

        .walkie-talk[data-talking="true"] {
          background: color-mix(in srgb, var(--widget-button-color), #000 14%) !important;
          transform: translateY(0.04em);
        }

        .walkie-talk:disabled {
          cursor: default;
          opacity: 0.5;
        }
      `;
      container.appendChild(style);

      const elements = {
        card: container.querySelector(".walkie-card"),
        button: container.querySelector(".walkie-talk"),
        squelch: container.querySelector(".walkie-squelch")
      };
      runtime.container = container;
      runtime.elements = elements;
      runtime.context = context;
      elements.button.disabled = !room;
      elements.button.title = room ? "Hold to talk · Right Shift" : "Shared spaces only";
      connectAudioElement(runtime, elements.squelch);
      for (const peer of runtime.peers.values()) {
        if (peer.stream) createRemoteAudio(runtime, peer);
      }
      setTalking(runtime, runtime.talking);

      elements.button.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        lastInteractedRuntime = runtime;
        elements.button.setPointerCapture(event.pointerId);
        event.preventDefault();
        void beginTalk(runtime, `pointer:${event.pointerId}`);
      });
      const release = (event) => {
        if (event && elements.button.hasPointerCapture(event.pointerId)) {
          elements.button.releasePointerCapture(event.pointerId);
        }
        endTalk(runtime, `pointer:${event.pointerId}`);
      };
      elements.button.addEventListener("pointerup", release);
      elements.button.addEventListener("pointercancel", release);
      elements.button.addEventListener("lostpointercapture", (event) => endTalk(runtime, `pointer:${event.pointerId}`));

      if (room && runtime.pollTimer === null && !runtime.polling) schedulePoll(runtime, 0);
    }
  });
})();
