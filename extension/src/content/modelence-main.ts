// MAIN-world interceptor for Modelence, injected at document_start. Must stay
// import-free. Modelence streams the agent chat over a Socket.IO WebSocket
// (wss://cloud.modelence.com/socket.io/...), so there is no on-demand REST
// endpoint to fetch like base44 has. This wraps WebSocket, watches incoming
// frames for the `liveQueryData` payload carrying the chat's `messages` array,
// and buffers the latest one per chatId for the content script to collect.

(() => {
  const REQUEST_TYPE = 'WAB_MODELENCE_GET_CONVERSATION';
  const RESPONSE_TYPE = 'WAB_MODELENCE_CONVERSATION';

  // Socket.IO v4 frames are "<packet><payload>" — a Socket.IO EVENT message is
  // engine.io type 4 (message) + socket.io type 2 (event) = the "42" prefix,
  // followed by a JSON array: 42["liveQueryData", {...}].
  const SOCKETIO_EVENT_PREFIX = '42';

  interface ChatPayload {
    chatId?: string;
    messages?: unknown[];
    [key: string]: unknown;
  }

  // Keep the most recent chat payload per chatId; collection reads the chat
  // matching the active tab's URL.
  const chatsById = new Map<string, ChatPayload>();
  let lastChatId: string | null = null;

  function rememberChat(payload: unknown): void {
    if (typeof payload !== 'object' || payload === null) return;
    const chat = payload as ChatPayload;
    if (!Array.isArray(chat.messages)) return;
    const id = typeof chat.chatId === 'string' ? chat.chatId : '__last__';
    chatsById.set(id, chat);
    lastChatId = id;
  }

  function handleFrame(data: unknown): void {
    if (typeof data !== 'string') return;
    if (!data.startsWith(SOCKETIO_EVENT_PREFIX)) return;
    const jsonStart = data.indexOf('[');
    if (jsonStart === -1) return;
    try {
      const parsed: unknown = JSON.parse(data.slice(jsonStart));
      // Shape: ["liveQueryData", { subscriptionId, data: {...chat...} }]
      if (!Array.isArray(parsed) || parsed[0] !== 'liveQueryData') return;
      const envelope = parsed[1];
      if (typeof envelope !== 'object' || envelope === null) return;
      rememberChat((envelope as { data?: unknown }).data);
    } catch {
      // Frame wasn't the JSON we expected; ignore.
    }
  }

  const OriginalWebSocket = window.WebSocket;
  function WrappedWebSocket(this: WebSocket, url: string | URL, protocols?: string | string[]) {
    const socket = protocols
      ? new OriginalWebSocket(url, protocols)
      : new OriginalWebSocket(url);
    socket.addEventListener('message', (event: MessageEvent) => {
      try {
        handleFrame(event.data);
      } catch {
        // never break the page's own socket handling
      }
    });
    return socket;
  }
  WrappedWebSocket.prototype = OriginalWebSocket.prototype;
  // Preserve the constants (CONNECTING/OPEN/CLOSING/CLOSED).
  Object.defineProperties(WrappedWebSocket, {
    CONNECTING: { value: OriginalWebSocket.CONNECTING },
    OPEN: { value: OriginalWebSocket.OPEN },
    CLOSING: { value: OriginalWebSocket.CLOSING },
    CLOSED: { value: OriginalWebSocket.CLOSED },
  });
  window.WebSocket = WrappedWebSocket as unknown as typeof WebSocket;

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;
    const data: unknown = event.data;
    if (
      typeof data !== 'object' ||
      data === null ||
      (data as { type?: string }).type !== REQUEST_TYPE
    ) {
      return;
    }
    const requestedChatId = (data as { chatId?: string }).chatId;
    const chat =
      (requestedChatId && chatsById.get(requestedChatId)) ||
      (lastChatId ? chatsById.get(lastChatId) : undefined) ||
      null;
    window.postMessage({ type: RESPONSE_TYPE, conversation: chat }, window.location.origin);
  });
})();
