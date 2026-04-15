// ===== DOM REFERENCES =====
const codeEditor = document.getElementById('code-editor');
const lineNumbersEl = document.getElementById('line-numbers');
const previewIframe = document.getElementById('preview-iframe');
const leftCol = document.getElementById('left-col');
const dragHandle = document.getElementById('drag-handle');
const activityLog = document.getElementById('activity-log');
const connectedAgentsEl = document.getElementById('connected-agents');
const serverUrlEl = document.getElementById('server-url');
const previewDot = document.getElementById('preview-dot');
const previewStatusText = document.getElementById('preview-status-text');
const runBtn = document.getElementById('run-btn');

// ===== STATE =====
let gutterMarkers = {}; // { lineNumber: agentType }
let agents = [];
let syncTimer = null;

// ===== INIT =====
function init() {
  // Set server URL display
  const serverUrl = window.location.origin + '/mcp';
  serverUrlEl.textContent = serverUrl;

  // Replace placeholder URLs in config blocks
  document.querySelectorAll('.config-url-placeholder').forEach(el => {
    el.textContent = serverUrl;
  });

  // Fetch initial state
  fetch('/api/state')
    .then(r => r.json())
    .then(data => {
      codeEditor.value = data.code;
      agents = data.agents || [];
      updateLineNumbers();
      refreshPreview();
      renderAgents();
      if (data.log) {
        data.log.forEach(entry => addLogEntry(entry));
      }
    })
    .catch(() => {
      // Fallback: the SSE init event will provide the state
    });

  connectSSE();
  setupEditor();
  setupTabs();
  setupDragHandle();
  setupKeyboard();
  setupIframeMessages();
}

// ===== SSE =====
function connectSSE() {
  const sse = new EventSource('/events');

  sse.addEventListener('init', (e) => {
    const data = JSON.parse(e.data);
    codeEditor.value = data.code;
    agents = data.agents || [];
    updateLineNumbers();
    refreshPreview();
    renderAgents();
    if (data.log) {
      data.log.forEach(entry => addLogEntry(entry));
    }
  });

  sse.addEventListener('code_update', (e) => {
    const data = JSON.parse(e.data);
    codeEditor.value = data.code;
    updateLineNumbers();
    refreshPreview();

    if (data.changedLines && data.agentType) {
      applyGutterMarkers(data.changedLines, data.agentType);
    }
  });

  sse.addEventListener('agent_connect', (e) => {
    const agent = JSON.parse(e.data);
    const exists = agents.find(a => a.id === agent.id);
    if (!exists) {
      agents.push(agent);
    }
    renderAgents();
  });

  sse.addEventListener('agent_disconnect', (e) => {
    const data = JSON.parse(e.data);
    agents = agents.filter(a => a.id !== data.id);
    renderAgents();
  });

  sse.addEventListener('tool_call', (e) => {
    const entry = JSON.parse(e.data);
    addLogEntry(entry);
  });

  sse.addEventListener('request_screenshot', () => {
    captureScreenshot();
  });

  sse.onerror = () => {
    setTimeout(() => connectSSE(), 3000);
  };
}

// ===== EDITOR =====
function setupEditor() {
  codeEditor.addEventListener('input', () => {
    updateLineNumbers();
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      fetch('/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: codeEditor.value }),
      });
      refreshPreview();
    }, 800);
  });

  codeEditor.addEventListener('scroll', () => {
    lineNumbersEl.scrollTop = codeEditor.scrollTop;
  });

  // Tab key inserts spaces
  codeEditor.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = codeEditor.selectionStart;
      const end = codeEditor.selectionEnd;
      const value = codeEditor.value;
      codeEditor.value = value.substring(0, start) + '  ' + value.substring(end);
      codeEditor.selectionStart = codeEditor.selectionEnd = start + 2;
      codeEditor.dispatchEvent(new Event('input'));
    }
  });
}

function setupKeyboard() {
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      fetch('/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: codeEditor.value }),
      });
      refreshPreview();
    }
  });

  runBtn.addEventListener('click', () => {
    fetch('/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: codeEditor.value }),
    });
    refreshPreview();
  });
}

function updateLineNumbers() {
  const lines = codeEditor.value.split('\n');
  lineNumbersEl.innerHTML = lines.map((_, i) => {
    const num = i + 1;
    const agent = gutterMarkers[num];
    const cls = agent ? `agent-${agent}` : '';
    return `<span class="${cls}">${num}</span>`;
  }).join('\n');
  lineNumbersEl.scrollTop = codeEditor.scrollTop;
}

function applyGutterMarkers(changedLines, agentType) {
  if (!changedLines || !agentType) return;
  changedLines.forEach(line => {
    gutterMarkers[line] = agentType;
  });
  updateLineNumbers();

  // Clear markers after 30 seconds
  setTimeout(() => {
    changedLines.forEach(line => {
      if (gutterMarkers[line] === agentType) {
        delete gutterMarkers[line];
      }
    });
    updateLineNumbers();
  }, 30000);
}

// ===== PREVIEW =====
function buildPreviewHTML(code) {
  return `<!DOCTYPE html>
<html><head><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { overflow: hidden; background: #0a0a0f; }
  #error { position: fixed; top: 10px; left: 10px; right: 10px;
    color: #f85149; font: 12px/1.5 'JetBrains Mono', monospace;
    background: rgba(30,0,0,0.95); padding: 10px 14px; border-radius: 6px;
    border: 1px solid #7f1d1d; display: none; z-index: 99;
    white-space: pre-wrap; max-height: 40vh; overflow: auto; }
</style></head>
<body>
<div id="error"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"><\/script>
<script>
try {
  const width = window.innerWidth, height = window.innerHeight;
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.shadowMap.enabled = true;
  document.body.appendChild(renderer.domElement);

  ${code}

  function loop(t) { requestAnimationFrame(loop); animate(t); }
  loop(0);

  window.addEventListener('resize', () => {
    const w = window.innerWidth, h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });

  window.parent.postMessage({ type: 'scene-ready' }, '*');

  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'request-screenshot') {
      renderer.render(scene, camera);
      const img = renderer.domElement.toDataURL('image/png');
      window.parent.postMessage({ type: 'screenshot-response', image: img,
        width: renderer.domElement.width, height: renderer.domElement.height }, '*');
    }
  });
} catch(e) {
  const el = document.getElementById('error');
  el.style.display = 'block';
  el.textContent = e.message + '\\n' + (e.stack || '');
  window.parent.postMessage({ type: 'threejs-error', error: { message: e.message, stack: e.stack } }, '*');
}
<\/script></body></html>`;
}

function refreshPreview() {
  previewDot.className = 'status-dot';
  previewStatusText.textContent = 'Loading...';
  previewIframe.srcdoc = buildPreviewHTML(codeEditor.value);
}

function setupIframeMessages() {
  window.addEventListener('message', (e) => {
    if (!e.data || typeof e.data.type !== 'string') return;

    if (e.data.type === 'scene-ready') {
      previewDot.className = 'status-dot ready';
      previewStatusText.textContent = 'Running';
      // Clear errors
      fetch('/errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ errors: [] }),
      });
    }

    if (e.data.type === 'threejs-error') {
      previewDot.className = 'status-dot error';
      previewStatusText.textContent = 'Error';
      fetch('/errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ errors: [e.data.error] }),
      });
    }

    if (e.data.type === 'screenshot-response') {
      fetch('/screenshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: e.data.image,
          width: e.data.width,
          height: e.data.height
        }),
      });
    }
  });
}

function captureScreenshot() {
  previewIframe.contentWindow.postMessage({ type: 'request-screenshot' }, '*');
}

// ===== TABS =====
function setupTabs() {
  document.querySelectorAll('.panel-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.panel-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    });
  });
}

// ===== DRAG HANDLE =====
function setupDragHandle() {
  let isDragging = false;

  dragHandle.addEventListener('mousedown', (e) => {
    isDragging = true;
    dragHandle.classList.add('active');
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const ratio = Math.max(0.25, Math.min(0.75, e.clientX / window.innerWidth));
    leftCol.style.width = (ratio * 100) + '%';
  });

  window.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      dragHandle.classList.remove('active');
    }
  });
}

// ===== AGENTS =====
function renderAgents() {
  if (agents.length === 0) {
    connectedAgentsEl.innerHTML = '<span class="no-agents">No agents connected</span>';
    return;
  }

  connectedAgentsEl.innerHTML = agents.map(a => {
    const color = a.color || '#6b7280';
    return `<div class="agent-badge" style="background: ${color}20; border: 1px solid ${color}40;" title="Click to disconnect ${a.name}" onclick="disconnectAgent('${a.id}')">
      <span class="agent-dot" style="background: ${color}"></span>
      <span style="color: ${color}">${escapeHtml(a.name)}</span>
    </div>`;
  }).join('');
}

function disconnectAgent(id) {
  agents = agents.filter(a => a.id !== id);
  renderAgents();
}

// ===== ACTIVITY LOG =====
function addLogEntry(entry) {
  const el = document.createElement('div');
  el.className = 'log-entry';

  const time = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false }) : '--:--:--';
  const type = entry.type || 'server';
  const agent = entry.agent || 'System';
  const message = entry.message || '';

  // Determine agent color
  let agentColor = 'var(--text-secondary)';
  const agentLower = agent.toLowerCase();
  if (agentLower.includes('chatgpt')) agentColor = 'var(--accent-chatgpt)';
  else if (agentLower.includes('claude')) agentColor = 'var(--accent-claude)';
  else if (agentLower.includes('gemini')) agentColor = 'var(--accent-gemini)';
  else if (agentLower.includes('perplexity')) agentColor = 'var(--accent-perplexity)';

  el.innerHTML = `<span class="log-time">${time}</span>` +
    `<span class="log-type ${type}">${type.toUpperCase()}</span>` +
    `<span class="log-agent" style="color: ${agentColor}">&#9679; ${escapeHtml(agent)}</span>` +
    `<span class="log-message">${escapeHtml(message)}</span>`;

  activityLog.appendChild(el);
  activityLog.scrollTop = activityLog.scrollHeight;
}

// ===== CONNECTOR UI =====
function toggleConnector(headerEl) {
  const card = headerEl.closest('.connector-card');
  card.classList.toggle('expanded');
}

function copyServerUrl(btnEl) {
  const url = serverUrlEl.textContent;
  navigator.clipboard.writeText(url).then(() => {
    btnEl.textContent = '\u2713 Copied';
    setTimeout(() => { btnEl.textContent = 'Copy'; }, 2000);
  });
}

function copyConfig(btnEl) {
  const pre = btnEl.closest('.config-block').querySelector('pre');
  const text = pre.textContent.replace(/YOUR_MCP_URL/g, window.location.origin + '/mcp');
  navigator.clipboard.writeText(text).then(() => {
    btnEl.textContent = '\u2713 Copied';
    setTimeout(() => { btnEl.textContent = 'Copy'; }, 2000);
  });
}

function simulateAgent(type, name, color) {
  const fakeId = 'sim-' + Math.random().toString(36).slice(2, 8);
  const agent = {
    id: fakeId,
    name: name,
    type: type,
    color: color,
    connectedAt: new Date().toISOString()
  };

  agents.push(agent);
  renderAgents();

  addLogEntry({
    timestamp: new Date().toISOString(),
    type: 'connect',
    agent: name,
    message: `${name} connected via MCP (simulated)`
  });

  // Simulate a tool call after a short delay
  setTimeout(() => {
    addLogEntry({
      timestamp: new Date().toISOString(),
      type: 'tool',
      agent: name,
      message: `get_code() — returned ${codeEditor.value.split('\n').length} lines`
    });
  }, 1500);

  setTimeout(() => {
    addLogEntry({
      timestamp: new Date().toISOString(),
      type: 'tool',
      agent: name,
      message: `get_scene_info() — analyzing scene structure`
    });
  }, 3000);
}

// ===== HELPERS =====
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ===== START =====
init();
