(function () {
  window.SkydiveCommands = window.SkydiveCommands || [];

  const runtimes = new WeakMap();
  const activeRuntimes = new Map();
  const CALLS_URL = "/.netlify/functions/calls";
  const SQUELCH_URL = "/assets/radio-sign-off-squelch.wav";
  const LISTENER_POLL_MS = 450;
  const TRANSMITTER_POLL_MS = 800;
  const ACTIVE_TRANSMITTER_POLL_MS = 300;
  const DETACH_GRACE_MS = 5000;
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

  function getCallUrl(runtime, transmitter) {
    const params = new URLSearchParams({
      space: runtime.room.space,
      room: runtime.room.room,
      peer: transmitter ? runtime.transmitterId : runtime.listenerId,
      role: transmitter ? "publisher" : "viewer",
      after: String(transmitter ? runtime.transmitterSignalAt : runtime.listenerSignalAt)
    });
    return `${CALLS_URL}?${params.toString()}`;
  }

  async function sendSignal(runtime, type, to = "*", payload = {}, transmitter = false) {
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
        peer: transmitter ? runtime.transmitterId : runtime.listenerId,
        role: transmitter ? "publisher" : "viewer",
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
    for (const peer of runtime.incomingPeers.values()) {
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

  function resumeRemoteAudio() {
    for (const runtime of activeRuntimes.values()) {
      for (const peer of runtime.incomingPeers.values()) {
        if (!peer.audio || !peer.audio.paused) continue;
        const playPromise = peer.audio.play();
        if (playPromise && typeof playPromise.catch === "function") playPromise.catch(() => {});
      }
    }
  }

  function playSquelch(runtime) {
    if (runtime.talking || !runtime.elements || !runtime.elements.squelch) return;
    const audio = runtime.elements.squelch;
    try { audio.currentTime = 0; } catch (error) { /* Metadata may not be ready yet. */ }
    const playPromise = audio.play();
    if (playPromise && typeof playPromise.catch === "function") playPromise.catch(() => {});
  }

  function closeIncomingPeer(runtime, peerId) {
    const peer = runtime.incomingPeers.get(peerId);
    if (!peer) return;
    if (peer.audio) peer.audio.remove();
    try { peer.connection.close(); } catch (error) { /* Already-closed peers can throw. */ }
    runtime.incomingPeers.delete(peerId);
  }

  function closeOutgoingPeer(runtime, peerId) {
    const peer = runtime.outgoingPeers.get(peerId);
    if (!peer) return;
    try { peer.connection.close(); } catch (error) { /* Already-closed peers can throw. */ }
    runtime.outgoingPeers.delete(peerId);
  }

  function closeAllPeers(runtime) {
    for (const peerId of Array.from(runtime.incomingPeers.keys())) closeIncomingPeer(runtime, peerId);
    for (const peerId of Array.from(runtime.outgoingPeers.keys())) closeOutgoingPeer(runtime, peerId);
  }

  function ensureIncomingPeer(runtime, peerId) {
    if (runtime.incomingPeers.has(peerId)) return runtime.incomingPeers.get(peerId);
    const connection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const peer = { connection, stream: null, audio: null, pendingIceCandidates: [] };
    runtime.incomingPeers.set(peerId, peer);

    connection.addEventListener("icecandidate", (event) => {
      if (event.candidate) void sendSignal(runtime, "ice", peerId, event.candidate.toJSON()).catch(console.error);
    });
    connection.addEventListener("track", (event) => {
      const stream = event.streams && event.streams[0]
        ? event.streams[0]
        : typeof MediaStream === "function"
          ? new MediaStream([event.track])
          : null;
      if (!stream) return;
      peer.stream = stream;
      createRemoteAudio(runtime, peer);
    });
    connection.addEventListener("connectionstatechange", () => {
      if (connection.connectionState === "failed" || connection.connectionState === "closed") {
        closeIncomingPeer(runtime, peerId);
      }
    });
    return peer;
  }

  function ensureOutgoingPeer(runtime, peerId) {
    if (runtime.outgoingPeers.has(peerId)) return runtime.outgoingPeers.get(peerId);
    const connection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const transceiver = connection.addTransceiver("audio", { direction: "sendonly" });
    const peer = { connection, sender: transceiver.sender, offerSent: false, pendingIceCandidates: [] };
    runtime.outgoingPeers.set(peerId, peer);

    connection.addEventListener("icecandidate", (event) => {
      if (event.candidate) {
        void sendSignal(runtime, "ice", peerId, event.candidate.toJSON(), true).catch(console.error);
      }
    });
    connection.addEventListener("connectionstatechange", () => {
      if (connection.connectionState === "failed" || connection.connectionState === "closed") {
        closeOutgoingPeer(runtime, peerId);
      }
    });
    const track = runtime.stream && runtime.stream.getAudioTracks()[0];
    if (track) void peer.sender.replaceTrack(track).catch(console.error);
    return peer;
  }

  async function createOffer(runtime, peerId) {
    const peer = ensureOutgoingPeer(runtime, peerId);
    if (peer.offerSent || runtime.connectingPeers.has(peerId)) return;
    runtime.connectingPeers.add(peerId);
    try {
      const offer = await peer.connection.createOffer();
      await peer.connection.setLocalDescription(offer);
      await sendSignal(runtime, "offer", peerId, offer, true);
      peer.offerSent = true;
    } finally {
      runtime.connectingPeers.delete(peerId);
    }
  }

  async function syncOutgoingPeers(runtime, viewerIds) {
    const expected = new Set(viewerIds.filter((peerId) => (
      peerId && peerId !== runtime.listenerId && peerId !== runtime.transmitterId
    )));
    for (const peerId of Array.from(runtime.outgoingPeers.keys())) {
      if (!expected.has(peerId)) closeOutgoingPeer(runtime, peerId);
    }
    for (const peerId of expected) {
      try { await createOffer(runtime, peerId); } catch (error) { console.error(error); }
    }
  }

  async function addOrQueueIceCandidate(peer, payload) {
    if (!peer || !payload || !payload.candidate) return;
    const candidate = new RTCIceCandidate(payload);
    if (!peer.connection.remoteDescription) {
      peer.pendingIceCandidates.push(candidate);
      return;
    }
    await peer.connection.addIceCandidate(candidate);
  }

  async function setRemoteDescription(peer, payload) {
    await peer.connection.setRemoteDescription(new RTCSessionDescription(payload));
    const candidates = peer.pendingIceCandidates.splice(0);
    for (const candidate of candidates) {
      await peer.connection.addIceCandidate(candidate);
    }
  }

  async function handleListenerSignal(runtime, message) {
    const messageId = message && message.id;
    if (messageId && runtime.listenerSignalIds.has(messageId)) return;
    if (messageId) runtime.listenerSignalIds.add(messageId);
    const from = message && message.from;
    const type = message && message.type;
    if (!from || from === runtime.listenerId || from === runtime.transmitterId || runtime.discard) return;
    const payload = message.payload || {};

    if (type === "talk-end") {
      const peer = runtime.incomingPeers.get(from);
      if (peer && peer.stream) playSquelch(runtime);
      return;
    }
    if (type === "offer") {
      const peer = ensureIncomingPeer(runtime, from);
      await setRemoteDescription(peer, payload);
      const answer = await peer.connection.createAnswer();
      await peer.connection.setLocalDescription(answer);
      await sendSignal(runtime, "answer", from, answer);
      return;
    }
    if (type === "ice") {
      const peer = ensureIncomingPeer(runtime, from);
      await addOrQueueIceCandidate(peer, payload);
    }
  }

  async function handleTransmitterSignal(runtime, message) {
    const messageId = message && message.id;
    if (messageId && runtime.transmitterSignalIds.has(messageId)) return;
    if (messageId) runtime.transmitterSignalIds.add(messageId);
    const from = message && message.from;
    const type = message && message.type;
    if (!from || from === runtime.listenerId || from === runtime.transmitterId || runtime.discard) return;
    const payload = message.payload || {};

    if (type === "answer") {
      const peer = runtime.outgoingPeers.get(from);
      if (peer && peer.connection.signalingState !== "stable") {
        await setRemoteDescription(peer, payload);
      }
      return;
    }
    if (type === "ice") {
      const peer = runtime.outgoingPeers.get(from);
      await addOrQueueIceCandidate(peer, payload);
    }
  }

  function scheduleListenerPoll(runtime, delay = LISTENER_POLL_MS) {
    if (runtime.discard) return;
    if (runtime.listenerPollTimer !== null) clearTimeout(runtime.listenerPollTimer);
    runtime.listenerPollTimer = setTimeout(() => pollListener(runtime), delay);
  }

  function scheduleTransmitterPoll(runtime, delay = runtime.talking ? ACTIVE_TRANSMITTER_POLL_MS : TRANSMITTER_POLL_MS) {
    if (runtime.discard) return;
    if (runtime.transmitterPollTimer !== null) clearTimeout(runtime.transmitterPollTimer);
    runtime.transmitterPollTimer = setTimeout(() => pollTransmitter(runtime), delay);
  }

  async function pollListener(runtime) {
    runtime.listenerPollTimer = null;
    if (runtime.discard || runtime.listenerPolling || !runtime.room) return;
    runtime.listenerPolling = true;
    try {
      const response = await fetch(getCallUrl(runtime, false), {
        headers: { "Accept": "application/json" },
        cache: "no-store"
      });
      if (!response.ok) throw new Error(`Walkie listener signaling failed: ${response.status}`);
      const data = await response.json();
      if (runtime.discard) return;

      for (const message of Array.isArray(data.messages) ? data.messages : []) {
        try { await handleListenerSignal(runtime, message); } catch (error) { console.error(error); }
      }
      const participants = Array.isArray(data.participants) ? data.participants : [];
      const viewers = participants
        .filter((participant) => participant && participant.role === "viewer")
        .map((participant) => participant.peer);
      const publishers = new Set(participants
        .filter((participant) => participant && participant.role === "publisher" && participant.peer !== runtime.transmitterId)
        .map((participant) => participant.peer));
      for (const peerId of Array.from(runtime.incomingPeers.keys())) {
        if (!publishers.has(peerId)) closeIncomingPeer(runtime, peerId);
      }
      await syncOutgoingPeers(runtime, viewers);
      runtime.listenerSignalAt = Number(data.now) || Date.now();
    } catch (error) {
      console.error(error);
    } finally {
      runtime.listenerPolling = false;
      scheduleListenerPoll(runtime);
    }
  }

  async function pollTransmitter(runtime) {
    runtime.transmitterPollTimer = null;
    if (runtime.discard || runtime.transmitterPolling || !runtime.room) return;
    runtime.transmitterPolling = true;
    try {
      const response = await fetch(getCallUrl(runtime, true), {
        headers: { "Accept": "application/json" },
        cache: "no-store"
      });
      if (!response.ok) throw new Error(`Walkie transmitter signaling failed: ${response.status}`);
      const data = await response.json();
      if (runtime.discard) return;

      for (const message of Array.isArray(data.messages) ? data.messages : []) {
        try { await handleTransmitterSignal(runtime, message); } catch (error) { console.error(error); }
      }
      const viewers = (Array.isArray(data.participants) ? data.participants : [])
        .filter((participant) => participant && participant.role === "viewer")
        .map((participant) => participant.peer);
      await syncOutgoingPeers(runtime, viewers);
      runtime.transmitterSignalAt = Number(data.now) || Date.now();
    } catch (error) {
      console.error(error);
    } finally {
      runtime.transmitterPolling = false;
      scheduleTransmitterPoll(runtime);
    }
  }

  async function beginTalk(runtime, hold) {
    if (!runtime || runtime.discard || !runtime.room) return;
    runtime.holds.add(hold);
    if (runtime.talking) return;
    lastInteractedRuntime = runtime;
    setTalking(runtime, true);
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
      const track = stream.getAudioTracks()[0];
      await Promise.all(Array.from(runtime.outgoingPeers.values(), (peer) => peer.sender.replaceTrack(track)));
      scheduleTransmitterPoll(runtime, 0);
    } catch (error) {
      console.error(error);
      const stream = runtime.stream;
      runtime.stream = null;
      for (const peer of runtime.outgoingPeers.values()) {
        void peer.sender.replaceTrack(null).catch(console.error);
      }
      stopStream(stream);
      runtime.holds.clear();
      setTalking(runtime, false);
      if (runtime.elements && runtime.elements.button) runtime.elements.button.title = "Microphone unavailable";
    }
  }

  function endTalk(runtime, hold) {
    if (!runtime) return;
    runtime.holds.delete(hold);
    if (!runtime.talking || runtime.holds.size > 0) return;
    const stream = runtime.stream;
    if (stream) void sendSignal(runtime, "talk-end", "*", {}, true).catch(console.error);
    runtime.stream = null;
    runtime.holds.clear();
    setTalking(runtime, false);
    const removals = Array.from(runtime.outgoingPeers.values(), (peer) => peer.sender.replaceTrack(null));
    void Promise.allSettled(removals).finally(() => stopStream(stream));
    scheduleTransmitterPoll(runtime, 0);
  }

  function sendLeave(runtime, transmitter) {
    if (!runtime.room || !navigator.sendBeacon) return;
    const body = JSON.stringify({
      space: runtime.room.space,
      room: runtime.room.room,
      peer: transmitter ? runtime.transmitterId : runtime.listenerId,
      role: transmitter ? "publisher" : "viewer",
      type: "leave"
    });
    navigator.sendBeacon(CALLS_URL, new Blob([body], { type: "application/json" }));
  }

  function closeRuntime(runtime) {
    if (!runtime || runtime.discard) return;
    runtime.discard = true;
    if (runtime.listenerPollTimer !== null) clearTimeout(runtime.listenerPollTimer);
    if (runtime.transmitterPollTimer !== null) clearTimeout(runtime.transmitterPollTimer);
    if (runtime.detachTimer !== null) clearTimeout(runtime.detachTimer);
    sendLeave(runtime, false);
    sendLeave(runtime, true);
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

  document.addEventListener("pointerdown", resumeRemoteAudio, true);
  document.addEventListener("keydown", (event) => {
    resumeRemoteAudio();
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
          listenerId: randomId(),
          transmitterId: randomId(),
          talking: false,
          holds: new Set(),
          stream: null,
          incomingPeers: new Map(),
          outgoingPeers: new Map(),
          connectingPeers: new Set(),
          listenerSignalIds: new Set(),
          transmitterSignalIds: new Set(),
          listenerSignalAt: 0,
          transmitterSignalAt: 0,
          listenerPollTimer: null,
          transmitterPollTimer: null,
          listenerPolling: false,
          transmitterPolling: false,
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
      for (const peer of runtime.incomingPeers.values()) {
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

      if (room) {
        if (runtime.listenerPollTimer === null && !runtime.listenerPolling) scheduleListenerPoll(runtime, 0);
        if (runtime.transmitterPollTimer === null && !runtime.transmitterPolling) scheduleTransmitterPoll(runtime, 0);
      }
    }
  });
})();
