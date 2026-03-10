import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import config from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------
const state = {
  pnetApiKey: config.PNET_API_KEY, // Bearer token received from pnet after approval (persisted)
  registered: !!config.PNET_API_KEY, // Already registered if we have a saved key
  approved: !!config.PNET_API_KEY,   // Already approved if we have a saved key
  nodeAlias: null,        // Our node's alias, fetched after approval
  userUuid: null,         // Our user UUID
  deviceUuid: null,       // Our app's device UUID (from app info)
  deviceAlias: null,      // Our app's device alias
  messages: [],           // All messages (sent + received)
  sseClients: new Set(),  // Active SSE connections
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function pushSSE(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of state.sseClients) {
    res.write(data);
  }
}

function addMessage(msg) {
  state.messages.push(msg);
  pushSSE({ type: 'message', message: msg });
}

async function pnetFetch(path, options = {}) {
  const url = `${config.PNET_URL}${path}`;
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (state.pnetApiKey) {
    headers['Authorization'] = `Bearer ${state.pnetApiKey}`;
  }
  const res = await fetch(url, { ...options, headers });
  return res;
}

// ---------------------------------------------------------------------------
// Registration logic (retries every 10 s until pnet is reachable)
// ---------------------------------------------------------------------------
async function register() {
  const body = {
    app_uuid: config.APP_UUID,
    app_name: config.APP_NAME,
    host: config.APP_HOST,
    app_api_key: config.APP_API_KEY,
  };

  try {
    const res = await fetch(`${config.PNET_URL}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.status === 201) {
      const data = await res.json();
      console.log('[register] Registration successful — api_key received');
      state.pnetApiKey = data.api_key;
      state.registered = true;
      state.approved = true;
      config.saveFile(config.PNET_KEY_FILE, data.api_key);
      pushSSE({ type: 'status', status: getStatus() });
      fetchNodeInfo();
      return;
    } else if (res.status === 422) {
      // UUID already registered but we have no saved key — state is unrecoverable
      // without re-registering under a new UUID.
      console.error(
        '[register] Already registered with pnet but no API key saved. ' +
        'Delete .app_uuid and .pnet_api_key then restart to re-register.'
      );
      return;
    } else {
      const text = await res.text();
      console.warn(`[register] pnet returned ${res.status}: ${text}`);
    }
  } catch (err) {
    console.warn('[register] Could not reach pnet, retrying in 10 s:', err.message);
  }

  // Retry after 10 seconds on network errors
  setTimeout(register, 10_000);
}

// ---------------------------------------------------------------------------
// Fetch node info after approval to get alias
// ---------------------------------------------------------------------------
async function fetchNodeInfo() {
  try {
    const res = await pnetFetch('/api/node');
    if (res.ok) {
      const data = await res.json();
      state.nodeAlias   = data?.user?.alias       ?? null;
      state.userUuid    = data?.user?.uuid         ?? null;
      state.deviceUuid  = data?.app?.device_uuid   ?? data?.device?.uuid ?? null;
      state.deviceAlias = data?.app?.device_alias  ?? null;
      pushSSE({ type: 'status', status: getStatus() });
    }
  } catch (err) {
    console.warn('[fetchNodeInfo] Failed:', err.message);
  }
}

function getStatus() {
  return {
    registered: state.registered,
    approved: state.approved,
    node_alias: state.nodeAlias,
    user_uuid: state.userUuid,
    device_uuid: state.deviceUuid,
    device_alias: state.deviceAlias,
    app_uuid: config.APP_UUID,
    app_name: config.APP_NAME,
    app_host: config.APP_HOST,
  };
}

// ---------------------------------------------------------------------------
// Poll pnet for queued inbound messages (catches messages missed while offline)
// ---------------------------------------------------------------------------
async function pollMessages() {
  if (!state.approved) return;
  try {
    const res = await pnetFetch('/api/messages');
    if (!res.ok) return;
    const data = await res.json();
    for (const m of data.messages ?? []) {
      const msg = {
        id: `pnet-${m.id}`,
        direction: 'received',
        from_user_uuid:   m.from_user_uuid,
        from_device_uuid: m.from_device_uuid,
        text:             m.payload,
        timestamp:        m.received_at,
      };
      if (!state.messages.find(x => x.id === msg.id)) {
        console.log('[pollMessages] Received queued message from', m.from_user_uuid);
        addMessage(msg);
      }
    }
  } catch (err) {
    console.warn('[pollMessages] Failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Callbacks from pnet
// ---------------------------------------------------------------------------

// POST /receive_message — pnet calls this when we have an incoming message
app.post('/receive_message', (req, res) => {
  // Verify our app_api_key
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token !== config.APP_API_KEY) {
    console.warn('[receive_message] Unauthorized attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { from_user_uuid, from_device_uuid, payload } = req.body;
  if (payload === undefined) {
    return res.status(400).json({ error: 'Missing payload' });
  }

  const msg = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    direction: 'received',
    from_user_uuid,
    from_device_uuid,
    text: payload,
    timestamp: new Date().toISOString(),
  };
  console.log('[receive_message] Received message from', from_user_uuid);
  addMessage(msg);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Our own API endpoints
// ---------------------------------------------------------------------------

// GET /api/status
app.get('/api/status', (_req, res) => {
  res.json(getStatus());
});

// GET /api/contacts — proxy to pnet /api/node, return contacts
app.get('/api/contacts', async (_req, res) => {
  if (!state.approved) {
    return res.status(503).json({ error: 'Not yet registered with pnet' });
  }
  try {
    const pnetRes = await pnetFetch('/api/node');
    if (!pnetRes.ok) {
      const text = await pnetRes.text();
      return res.status(pnetRes.status).json({ error: text });
    }
    const data = await pnetRes.json();
    // Update alias while we're here
    if (data?.user?.alias) {
      state.nodeAlias = data.user.alias;
    }
    const contacts = data?.user?.contacts ?? [];
    res.json({ contacts });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// GET /api/node — full node info (so the frontend can get device lists)
app.get('/api/node', async (_req, res) => {
  if (!state.approved) {
    return res.status(503).json({ error: 'Not yet registered with pnet' });
  }
  try {
    const pnetRes = await pnetFetch('/api/node');
    if (!pnetRes.ok) {
      const text = await pnetRes.text();
      return res.status(pnetRes.status).json({ error: text });
    }
    const data = await pnetRes.json();
    // Update cached state while we have fresh node data
    const changed =
      state.nodeAlias  !== (data?.user?.alias       ?? state.nodeAlias)  ||
      state.userUuid   !== (data?.user?.uuid         ?? state.userUuid)   ||
      state.deviceUuid !== (data?.app?.device_uuid   ?? state.deviceUuid) ||
      state.deviceAlias !== (data?.app?.device_alias ?? state.deviceAlias);
    state.nodeAlias   = data?.user?.alias       ?? state.nodeAlias;
    state.userUuid    = data?.user?.uuid         ?? state.userUuid;
    state.deviceUuid  = data?.app?.device_uuid   ?? data?.device?.uuid ?? state.deviceUuid;
    state.deviceAlias = data?.app?.device_alias  ?? state.deviceAlias;
    if (changed) pushSSE({ type: 'status', status: getStatus() });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// POST /api/send — proxy to pnet /api/send
app.post('/api/send', async (req, res) => {
  if (!state.approved) {
    return res.status(503).json({ error: 'Not yet registered with pnet' });
  }
  const { to_user_uuid, to_device_uuid, to_app_uuid, payload } = req.body;
  if (!to_user_uuid || !payload) {
    return res.status(400).json({ error: 'Missing to_user_uuid or payload' });
  }

  try {
    const pnetRes = await pnetFetch('/api/send', {
      method: 'POST',
      body: JSON.stringify({ to_user_uuid, to_device_uuid, to_app_uuid, payload }),
    });

    const responseText = await pnetRes.text();
    let responseData;
    try { responseData = JSON.parse(responseText); } catch { responseData = { raw: responseText }; }

    if (!pnetRes.ok) {
      return res.status(pnetRes.status).json({ error: responseData });
    }

    // Record sent message locally
    const msg = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      direction: 'sent',
      to_user_uuid,
      to_device_uuid,
      to_app_uuid,
      text: payload,
      timestamp: new Date().toISOString(),
    };
    addMessage(msg);
    res.json({ ok: true, message: msg });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// GET /api/messages — return all stored messages
app.get('/api/messages', (_req, res) => {
  res.json({ messages: state.messages });
});

// ---------------------------------------------------------------------------
// SSE endpoint
// ---------------------------------------------------------------------------
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if proxied
  res.flushHeaders();

  // Send current status immediately
  res.write(`data: ${JSON.stringify({ type: 'status', status: getStatus() })}\n\n`);

  // Keep-alive ping every 25 s
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);

  state.sseClients.add(res);
  console.log(`[SSE] Client connected (${state.sseClients.size} total)`);

  req.on('close', () => {
    clearInterval(ping);
    state.sseClients.delete(res);
    console.log(`[SSE] Client disconnected (${state.sseClients.size} total)`);
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(config.APP_PORT, () => {
  console.log(`pnet-messenger listening on port ${config.APP_PORT}`);
  console.log(`APP_UUID: ${config.APP_UUID}`);
  console.log(`APP_HOST: ${config.APP_HOST}`);
  console.log(`PNET_URL: ${config.PNET_URL}`);

  // Poll pnet for queued messages every 30 seconds
  setInterval(pollMessages, 30_000);

  if (config.PNET_API_KEY) {
    console.log('[startup] Found persisted pnet api_key — skipping registration');
    fetchNodeInfo();
    pollMessages();
  } else {
    register();
  }
});
