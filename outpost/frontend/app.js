// Client: the browser half of the event-sourcing contract.
//
//   1. GET /api/snapshot           -> { seq, state, meta }   (state = projector fold of the log)
//   2. EventSource /api/events?since=<seq>                  (every later event, in order)
//   3. apply(state, event) from /shared/projector.js        (the same reducer the server runs)
//
// Every number the UI shows is read from `client.state`, which only ever changes through
// a snapshot or `apply`. Nothing in this file synthesises events or state.

import { initialState, apply } from '/shared/projector.js';

const RETRY_MS = 1000;

export function createClient() {
  const subs = new Set();
  const linkSubs = new Set();
  let es = null;
  let retryTimer = 0;
  let resyncing = false;
  let closed = false;

  const client = {
    state: initialState(),
    meta: {},
    /** 'connecting' | 'live' | 'reconnecting' — the transport, not the station. */
    link: 'connecting',
    linkDetail: '',
    ready: null,
    /** fn(event) after each apply; fn(null) after a (re)snapshot. Returns unsubscribe. */
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    /** fn(link, detail) whenever the transport state changes. Returns unsubscribe. */
    onLink(fn) {
      linkSubs.add(fn);
      return () => linkSubs.delete(fn);
    },
    post,
    artifactUrl(id) {
      return `/api/artifacts/${encodeURIComponent(id)}/content`;
    },
    artifactMetaUrl(id) {
      return `/api/artifacts/${encodeURIComponent(id)}`;
    },
    close() {
      closed = true;
      clearTimeout(retryTimer);
      if (es) es.close();
      es = null;
    },
  };

  function notify(e) {
    for (const fn of subs) {
      try {
        fn(e);
      } catch (err) {
        console.error('outpost subscriber failed', err);
      }
    }
  }

  function setLink(link, detail = '') {
    if (client.link === link && client.linkDetail === detail) return;
    client.link = link;
    client.linkDetail = detail;
    for (const fn of linkSubs) {
      try {
        fn(link, detail);
      } catch (err) {
        console.error('outpost link subscriber failed', err);
      }
    }
  }

  async function fetchSnapshot() {
    const res = await fetch('/api/snapshot', { cache: 'no-store', headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`snapshot HTTP ${res.status}`);
    const snap = await res.json();
    if (!snap || typeof snap !== 'object' || !snap.state || typeof snap.state.seq !== 'number') {
      throw new Error('snapshot malformed');
    }
    return snap;
  }

  function adopt(snap) {
    client.state = snap.state;
    client.meta = snap.meta || {};
  }

  function openStream() {
    if (closed) return;
    if (es) es.close();
    const since = client.state.seq;
    const source = new EventSource(`/api/events?since=${since}`);
    es = source;
    const onMessage = (msg) => {
      if (es !== source) return;
      let e;
      try {
        e = JSON.parse(msg.data);
      } catch {
        return;
      }
      if (!e || typeof e.seq !== 'number' || typeof e.type !== 'string') return;
      if (e.seq <= client.state.seq) {
        // The server only replays seq > since. An older seq means its log was reset
        // (new data dir): our projection is no longer a prefix of its log.
        if (e.seq < client.state.seq) resync('server sequence went backwards');
        return;
      }
      apply(client.state, e);
      notify(e);
    };
    source.addEventListener('outpost', onMessage);
    source.onmessage = onMessage; // tolerate frames sent without an event name
    source.onopen = () => {
      if (es === source) setLink('live');
    };
    source.onerror = () => {
      if (es !== source) return;
      source.close();
      es = null;
      setLink('reconnecting', 'event stream dropped');
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (closed) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(reconnect, RETRY_MS);
  }

  // Is the server's log still the one we projected? Compare the newest feed entry we hold
  // that the snapshot also retains. No overlap means we cannot tell; assume it is.
  function sameLog(snapState) {
    const theirs = new Map((snapState.feed || []).map((f) => [f.seq, f]));
    const mine = client.state.feed || [];
    for (let i = mine.length - 1; i >= 0; i--) {
      const g = theirs.get(mine[i].seq);
      if (g) return g.ts === mine[i].ts && g.type === mine[i].type && g.text === mine[i].text;
    }
    return true;
  }

  // Reopen with since=state.seq. The snapshot fetch is only used to detect a reset log
  // (seq went backwards, or the same seq now names a different event) and to pick up
  // changed meta (e.g. restarted with a provider key).
  async function reconnect() {
    if (closed) return;
    try {
      const snap = await fetchSnapshot();
      if (snap.state.seq < client.state.seq || !sameLog(snap.state)) {
        adopt(snap);
        notify(null);
      } else if (JSON.stringify(snap.meta || {}) !== JSON.stringify(client.meta)) {
        client.meta = snap.meta || {};
        notify(null);
      }
      openStream();
    } catch (err) {
      setLink('reconnecting', String(err.message || err));
      scheduleReconnect();
    }
  }

  async function resync(reason) {
    if (resyncing || closed) return;
    resyncing = true;
    if (es) es.close();
    es = null;
    setLink('reconnecting', reason);
    try {
      adopt(await fetchSnapshot());
      notify(null);
      openStream();
    } catch (err) {
      setLink('reconnecting', String(err.message || err));
      scheduleReconnect();
    } finally {
      resyncing = false;
    }
  }

  async function post(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-outpost-client': '1' },
      body: JSON.stringify(body ?? {}),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (!res.ok) throw new Error((json && json.error) || `${res.status} ${res.statusText || 'request failed'}`);
    return json ?? {};
  }

  client.ready = (async () => {
    for (;;) {
      try {
        adopt(await fetchSnapshot());
        break;
      } catch (err) {
        setLink('connecting', String(err.message || err));
        await new Promise((r) => setTimeout(r, RETRY_MS));
      }
    }
    openStream();
  })();

  return client;
}
