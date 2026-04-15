const DEFAULT_SCENE_CODE = `// === SCENE SETUP ===
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a1a);
scene.fog = new THREE.FogExp2(0x0a0a1a, 0.015);

// === CAMERA ===
const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1000);
camera.position.set(5, 4, 7);
camera.lookAt(0, 0, 0);

// === LIGHTING ===
const ambientLight = new THREE.AmbientLight(0x404060, 0.6);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
directionalLight.position.set(10, 15, 10);
directionalLight.castShadow = true;
directionalLight.shadow.mapSize.width = 1024;
directionalLight.shadow.mapSize.height = 1024;
scene.add(directionalLight);

const pointLight = new THREE.PointLight(0x4488ff, 1, 20);
pointLight.position.set(-3, 5, -3);
scene.add(pointLight);

const pointLight2 = new THREE.PointLight(0xff6644, 0.6, 15);
pointLight2.position.set(4, 3, 4);
scene.add(pointLight2);

// === OBJECTS ===
// Ground plane
const groundGeo = new THREE.PlaneGeometry(30, 30);
const groundMat = new THREE.MeshStandardMaterial({
  color: 0x1a1a2e,
  roughness: 0.9,
  metalness: 0.1
});
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -1;
ground.receiveShadow = true;
scene.add(ground);

// Rotating box
const boxGeo = new THREE.BoxGeometry(1.5, 1.5, 1.5);
const boxMat = new THREE.MeshStandardMaterial({
  color: 0xD97706,
  roughness: 0.3,
  metalness: 0.7
});
const box = new THREE.Mesh(boxGeo, boxMat);
box.position.set(-2, 0.75, 0);
box.castShadow = true;
scene.add(box);

// Floating sphere
const sphereGeo = new THREE.SphereGeometry(0.8, 32, 32);
const sphereMat = new THREE.MeshStandardMaterial({
  color: 0x4285F4,
  roughness: 0.2,
  metalness: 0.8
});
const sphere = new THREE.Mesh(sphereGeo, sphereMat);
sphere.position.set(2, 1.5, 0);
sphere.castShadow = true;
scene.add(sphere);

// Grid helper
const grid = new THREE.GridHelper(20, 20, 0x303050, 0x202040);
grid.position.y = -0.99;
scene.add(grid);

// === ANIMATION ===
function animate(time) {
  const t = time * 0.001;

  // Rotate box
  box.rotation.y = t * 0.5;
  box.rotation.x = Math.sin(t * 0.3) * 0.2;

  // Float sphere up and down
  sphere.position.y = 1.5 + Math.sin(t * 1.2) * 0.5;
  sphere.rotation.y = t * 0.3;

  // Animate point light
  pointLight.position.x = Math.sin(t * 0.7) * 4;
  pointLight.position.z = Math.cos(t * 0.7) * 4;

  renderer.render(scene, camera);
}`;

const state = {
  code: DEFAULT_SCENE_CODE,
  lastModifiedBy: null,
  errors: [],
  connectedAgents: [],
  activityLog: [],
  sseClients: [],
  latestScreenshot: null,
  toolCallCounts: new Map(),

  updateCode(newCode, agentName) {
    const oldLines = this.code.split('\n');
    const newLines = newCode.split('\n');
    this.code = newCode;
    this.lastModifiedBy = agentName || 'user';

    const changedLines = [];
    const maxLen = Math.max(oldLines.length, newLines.length);
    for (let i = 0; i < maxLen; i++) {
      if (oldLines[i] !== newLines[i]) {
        changedLines.push(i + 1);
      }
    }

    if (agentName) {
      this.addLogEntry({
        type: 'tool',
        agent: agentName,
        message: `Updated code (${newLines.length} lines, ${changedLines.length} changed)`
      });
    }

    return changedLines;
  },

  addAgent(agent) {
    this.connectedAgents.push(agent);
    this.addLogEntry({
      type: 'connect',
      agent: agent.name,
      message: `${agent.name} connected via MCP`
    });
    this.broadcast('agent_connect', agent);
  },

  removeAgent(id) {
    const idx = this.connectedAgents.findIndex(a => a.id === id);
    if (idx !== -1) {
      const agent = this.connectedAgents.splice(idx, 1)[0];
      this.addLogEntry({
        type: 'disconnect',
        agent: agent.name,
        message: `${agent.name} disconnected`
      });
      this.broadcast('agent_disconnect', { id: agent.id, name: agent.name });
      this.toolCallCounts.delete(id);
      return agent;
    }
    return null;
  },

  addLogEntry(entry) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      ...entry
    };
    this.activityLog.push(logEntry);
    if (this.activityLog.length > 500) {
      this.activityLog = this.activityLog.slice(-400);
    }
    this.broadcast('tool_call', logEntry);
  },

  broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    this.sseClients = this.sseClients.filter(client => {
      try {
        client.write(msg);
        return true;
      } catch (e) {
        return false;
      }
    });
  },

  checkRateLimit(agentId) {
    const now = Date.now();
    if (!this.toolCallCounts.has(agentId)) {
      this.toolCallCounts.set(agentId, []);
    }
    const calls = this.toolCallCounts.get(agentId);
    const recentCalls = calls.filter(t => now - t < 60000);
    this.toolCallCounts.set(agentId, recentCalls);
    if (recentCalls.length >= 30) {
      return false;
    }
    recentCalls.push(now);
    return true;
  },

  detectAgent(clientInfo) {
    const name = (clientInfo && clientInfo.name || '').toLowerCase();
    if (name.includes('chatgpt') || name.includes('openai')) {
      return { type: 'chatgpt', color: '#10A37F', displayName: 'ChatGPT' };
    }
    if (name.includes('claude')) {
      return { type: 'claude', color: '#D97706', displayName: 'Claude' };
    }
    if (name.includes('gemini')) {
      return { type: 'gemini', color: '#4285F4', displayName: 'Gemini' };
    }
    if (name.includes('perplexity')) {
      return { type: 'perplexity', color: '#8B5CF6', displayName: 'Perplexity' };
    }
    return { type: 'unknown', color: '#6b7280', displayName: clientInfo && clientInfo.name || 'Unknown Agent' };
  }
};

module.exports = state;
