// MAIN-world interceptor for Anything (anything.com), injected at
// document_start. Must stay import-free. The build URL is /build/<opaqueSlug>,
// which is NOT the projectGroup id the GraphQL API wants, and the id is not in
// the static HTML. The page itself talks to POST
// https://www.anything.com/api/graphql with an `authorization` JWT and embeds
// the real projectGroupId/organizationId in its query variables. So this
// MAIN-world script wraps window.fetch + XMLHttpRequest to (a) capture the auth
// token and (b) remember the projectGroupId it sees the page use. On COLLECT the
// content script asks us for the build's revision usage; we replay
// GetProjectGroupRevisionsForChat in the page's own origin (so CORS/cookies
// behave exactly like the app) and return the per-revision duration + credits.

(() => {
  const REQUEST_TYPE = 'WAB_ANYTHING_GET_REVISIONS';
  const RESPONSE_TYPE = 'WAB_ANYTHING_REVISIONS';
  const GRAPHQL_PATH = '/api/graphql';
  const PROJECT_GROUP_ID_RE = /"projectGroupId"\s*:\s*"([0-9a-f-]{36})"/i;

  let authToken: string | null = null;
  let latestProjectGroupId: string | null = null;

  function urlOf(input: RequestInfo | URL): string {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    return (input as Request).url ?? '';
  }

  function readHeaderValue(headers: unknown, name: string): string | null {
    if (!headers) return null;
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
      return headers.get(name);
    }
    if (Array.isArray(headers)) {
      for (const pair of headers) {
        if (Array.isArray(pair) && typeof pair[0] === 'string' && pair[0].toLowerCase() === name) {
          return typeof pair[1] === 'string' ? pair[1] : null;
        }
      }
      return null;
    }
    if (typeof headers === 'object') {
      for (const key of Object.keys(headers as Record<string, unknown>)) {
        if (key.toLowerCase() === name) {
          const value = (headers as Record<string, unknown>)[key];
          return typeof value === 'string' ? value : null;
        }
      }
    }
    return null;
  }

  function rememberToken(value: string | null): void {
    if (value && value.length > 20) authToken = value;
  }

  function rememberProjectGroupId(bodyText: string | null): void {
    if (!bodyText) return;
    const match = PROJECT_GROUP_ID_RE.exec(bodyText);
    if (match?.[1]) latestProjectGroupId = match[1];
  }

  function captureFromRequest(input: RequestInfo | URL, init?: RequestInit): void {
    try {
      if (!urlOf(input).includes(GRAPHQL_PATH)) return;
      let auth = readHeaderValue(init?.headers, 'authorization');
      if (!auth && typeof Request !== 'undefined' && input instanceof Request) {
        auth = input.headers.get('authorization');
      }
      rememberToken(auth);
      const body = init?.body;
      if (typeof body === 'string') rememberProjectGroupId(body);
    } catch {
      // never break the page's own fetch
    }
  }

  // --- fetch ---
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    captureFromRequest(input, init);
    return originalFetch(input, init);
  };

  // --- XMLHttpRequest (belt-and-suspenders; Apollo uses fetch) ---
  interface TrackedXHR extends XMLHttpRequest {
    __wabUrl?: string;
  }
  const xhrProto = XMLHttpRequest.prototype;
  const originalOpen = xhrProto.open;
  const originalSend = xhrProto.send;
  const originalSetHeader = xhrProto.setRequestHeader;
  xhrProto.open = function (this: TrackedXHR, method: string, url: string | URL, ...rest: unknown[]) {
    this.__wabUrl = typeof url === 'string' ? url : url.href;
    // @ts-expect-error — forwarding the original variadic signature verbatim.
    return originalOpen.call(this, method, url, ...rest);
  };
  xhrProto.setRequestHeader = function (this: TrackedXHR, name: string, value: string) {
    try {
      if (
        name.toLowerCase() === 'authorization' &&
        this.__wabUrl &&
        this.__wabUrl.includes(GRAPHQL_PATH)
      ) {
        rememberToken(value);
      }
    } catch {
      // best-effort
    }
    return originalSetHeader.call(this, name, value);
  };
  xhrProto.send = function (this: TrackedXHR, body?: Document | XMLHttpRequestBodyInit | null) {
    try {
      if (this.__wabUrl && this.__wabUrl.includes(GRAPHQL_PATH) && typeof body === 'string') {
        rememberProjectGroupId(body);
      }
    } catch {
      // best-effort
    }
    return originalSend.call(this, body ?? null);
  };

  // The query the page uses to render the chat thread. Returns every chat-style
  // revision with the per-turn generationDurationMs + totalCredits we meter on.
  const REVISIONS_QUERY = `query WAB_AnythingThreadMetrics($projectGroupId: ID!, $first: Int) {
    projectGroupById(id: $projectGroupId) {
      id
      revisions(
        order: [{ createdAt: "DESC" }]
        first: $first
        input: {
          actions: [
            CHAT
            AUTO_SELECT_CHAT
            DEEP_DEBUGGING
            EXPERT_SWE
            DISCUSSION
            ORCHESTRATOR
            DELEGATE_TO_SUB_AGENT
            DESIGN_AGENT
            PLAN_AGENT
          ]
        }
      ) {
        totalCount
        edges {
          node {
            id
            action
            status
            createdAt
            generationDurationMs
            totalCredits
            refundedAt
            chat {
              id
              content
            }
          }
        }
      }
    }
  }`;

  interface RevisionNode {
    id?: string;
    action?: string;
    status?: string;
    createdAt?: string;
    generationDurationMs?: number | string | null;
    totalCredits?: number | string | null;
    refundedAt?: string | null;
    chat?: { id?: string; content?: string } | null;
  }

  async function fetchRevisions(
    projectGroupId: string,
  ): Promise<{ revisions: RevisionNode[] | null; error?: string }> {
    if (!authToken) {
      return { revisions: null, error: 'Not signed in to Anything (no auth token captured yet)' };
    }
    try {
      const response = await originalFetch(GRAPHQL_PATH, {
        method: 'POST',
        headers: {
          authorization: authToken,
          'content-type': 'application/json',
          'apollographql-client-name': 'flux-web',
          accept: 'application/graphql-response+json,application/json;q=0.9',
        },
        body: JSON.stringify({
          operationName: 'WAB_AnythingThreadMetrics',
          variables: { projectGroupId, first: 100 },
          query: REVISIONS_QUERY,
        }),
      });
      if (!response.ok) {
        const hint =
          response.status === 401 || response.status === 403
            ? ' — make sure you are signed in to Anything'
            : '';
        return { revisions: null, error: `Revisions query failed: HTTP ${response.status}${hint}` };
      }
      const data: unknown = await response.json();
      const errors = (data as { errors?: { message?: string }[] }).errors;
      const edges = (
        data as {
          data?: { projectGroupById?: { revisions?: { edges?: { node?: RevisionNode }[] } } };
        }
      )?.data?.projectGroupById?.revisions?.edges;
      if (!Array.isArray(edges)) {
        const message = errors?.[0]?.message ?? 'no revisions returned';
        return { revisions: null, error: `Revisions query failed: ${message}` };
      }
      const revisions = edges
        .map((edge) => edge?.node)
        .filter((node): node is RevisionNode => !!node);
      return { revisions };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { revisions: null, error: `Revisions query failed: ${message}` };
    }
  }

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
    const requested = (data as { projectGroupId?: unknown }).projectGroupId;
    const projectGroupId =
      typeof requested === 'string' && requested.length > 0 ? requested : latestProjectGroupId;
    if (!projectGroupId) {
      window.postMessage(
        {
          type: RESPONSE_TYPE,
          projectGroupId: null,
          revisions: null,
          error:
            'Could not determine the build — open the build chat and let it load (so the page requests its revisions), then retry',
        },
        window.location.origin,
      );
      return;
    }
    void fetchRevisions(projectGroupId).then((result) => {
      window.postMessage(
        {
          type: RESPONSE_TYPE,
          projectGroupId,
          revisions: result.revisions,
          error: result.error ?? null,
        },
        window.location.origin,
      );
    });
  });
})();
