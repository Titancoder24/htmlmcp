const state = require('./scene-state');

const MAX_CODE_LENGTH = 50000;
const MAX_LINE_COUNT = 2000;

function validateCode(code) {
  const errors = [];
  if (code.length > MAX_CODE_LENGTH) {
    errors.push(`Code exceeds maximum length of ${MAX_CODE_LENGTH} characters`);
  }
  const lineCount = code.split('\n').length;
  if (lineCount > MAX_LINE_COUNT) {
    errors.push(`Code exceeds maximum of ${MAX_LINE_COUNT} lines`);
  }
  return errors;
}

function getAgentNameFromMeta(meta) {
  if (meta && meta._agentName) return meta._agentName;
  return 'Unknown Agent';
}

const tools = [
  {
    name: 'get_code',
    description: "Read the current Three.js scene source code from the editor. Returns the complete code as a string. Call this first to understand what's in the scene before making changes.",
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    },
    handler(params, meta) {
      return {
        code: state.code,
        lineCount: state.code.split('\n').length,
        lastModifiedBy: state.lastModifiedBy
      };
    }
  },
  {
    name: 'update_code',
    description: "Replace the entire Three.js scene code. Use this when making large changes or rewriting the scene. The code must define: a `scene` (THREE.Scene), a `camera` (THREE.PerspectiveCamera), and an `animate(time)` function. Variables `width`, `height`, and `renderer` are provided by the runtime.",
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'The complete Three.js scene code'
        }
      },
      required: ['code']
    },
    handler(params, meta) {
      const { code } = params;
      const agentName = getAgentNameFromMeta(meta);

      const validationErrors = validateCode(code);
      if (validationErrors.length > 0) {
        return { success: false, error: { code: 'VALIDATION_ERROR', message: validationErrors.join('; ') } };
      }

      if (!code.includes('scene') || !code.includes('camera') || !code.includes('animate')) {
        return {
          success: false,
          error: {
            code: 'INVALID_CODE',
            message: "Code must define 'scene', 'camera', and 'animate' function.",
            suggestion: "Ensure your code creates a THREE.Scene as 'scene', a THREE.PerspectiveCamera as 'camera', and defines function animate(time) { renderer.render(scene, camera); }"
          }
        };
      }

      const changedLines = state.updateCode(code, agentName);
      const agentInfo = state.connectedAgents.find(a => a.name === agentName);

      state.broadcast('code_update', {
        code: state.code,
        changedLines,
        agent: agentName,
        agentType: agentInfo ? agentInfo.type : 'unknown'
      });

      return {
        success: true,
        lineCount: code.split('\n').length,
        changedLines: changedLines.length,
        errors: []
      };
    }
  },
  {
    name: 'patch_code',
    description: "Insert, replace, or delete specific lines in the scene code. More surgical than update_code — use this for small changes like adding an object or tweaking a material.",
    inputSchema: {
      type: 'object',
      properties: {
        startLine: {
          type: 'number',
          description: 'The line number to start the patch (1-indexed)'
        },
        endLine: {
          type: 'number',
          description: 'The line number to end the patch (inclusive). Omit to insert at startLine without removing any lines.'
        },
        newCode: {
          type: 'string',
          description: 'The new code to insert. Use empty string to delete lines.'
        }
      },
      required: ['startLine', 'newCode']
    },
    handler(params, meta) {
      const { startLine, endLine, newCode } = params;
      const agentName = getAgentNameFromMeta(meta);
      const lines = state.code.split('\n');

      if (startLine < 1 || startLine > lines.length + 1) {
        return {
          success: false,
          error: {
            code: 'INVALID_LINE',
            message: `startLine ${startLine} is out of range. Code has ${lines.length} lines.`
          }
        };
      }

      const start = startLine - 1;
      const end = endLine ? endLine : start;
      const deleteCount = endLine ? (end - start + 1) : 0;
      const newLines = newCode ? newCode.split('\n') : [];

      lines.splice(start, deleteCount, ...newLines);
      const updatedCode = lines.join('\n');

      const validationErrors = validateCode(updatedCode);
      if (validationErrors.length > 0) {
        return { success: false, error: { code: 'VALIDATION_ERROR', message: validationErrors.join('; ') } };
      }

      const changedLines = [];
      for (let i = start; i < start + newLines.length; i++) {
        changedLines.push(i + 1);
      }

      state.updateCode(updatedCode, agentName);
      const agentInfo = state.connectedAgents.find(a => a.name === agentName);

      state.broadcast('code_update', {
        code: state.code,
        changedLines,
        agent: agentName,
        agentType: agentInfo ? agentInfo.type : 'unknown'
      });

      state.addLogEntry({
        type: 'tool',
        agent: agentName,
        message: `patch_code: lines ${startLine}-${endLine || startLine}, ${newLines.length} new lines`
      });

      return {
        success: true,
        linesAffected: newLines.length,
        totalLines: lines.length
      };
    }
  },
  {
    name: 'get_scene_info',
    description: "Analyze the current scene code and return a structured summary of all objects, lights, and materials. Useful for understanding the scene before modifying it.",
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    },
    handler(params, meta) {
      const code = state.code;

      const objects = [];
      const meshRegex = /(?:const|let|var)\s+(\w+)\s*=\s*new\s+THREE\.Mesh\(/g;
      let match;
      while ((match = meshRegex.exec(code)) !== null) {
        objects.push({ name: match[1], type: 'Mesh' });
      }

      const groupRegex = /(?:const|let|var)\s+(\w+)\s*=\s*new\s+THREE\.Group\(/g;
      while ((match = groupRegex.exec(code)) !== null) {
        objects.push({ name: match[1], type: 'Group' });
      }

      const lights = [];
      const lightRegex = /(?:const|let|var)\s+(\w+)\s*=\s*new\s+THREE\.(\w*Light)\(/g;
      while ((match = lightRegex.exec(code)) !== null) {
        lights.push({ name: match[1], type: match[2] });
      }

      const materials = [];
      const matRegex = /(?:const|let|var)\s+(\w+)\s*=\s*new\s+THREE\.(\w*Material)\(/g;
      while ((match = matRegex.exec(code)) !== null) {
        materials.push({ name: match[1], type: match[2] });
      }

      const hasAnimation = /function\s+animate\s*\(/.test(code);

      return {
        objects,
        lights,
        materials,
        hasAnimation,
        lineCount: code.split('\n').length,
        sections: {
          hasSceneSetup: code.includes('// === SCENE SETUP ==='),
          hasCamera: code.includes('// === CAMERA ==='),
          hasLighting: code.includes('// === LIGHTING ==='),
          hasObjects: code.includes('// === OBJECTS ==='),
          hasAnimation: code.includes('// === ANIMATION ===')
        }
      };
    }
  },
  {
    name: 'add_object',
    description: "Add a new 3D object to the scene. Generates Three.js code for geometry + material + mesh and inserts it before the animate function.",
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Object type: box, sphere, cylinder, cone, torus, torusKnot, plane, dodecahedron, icosahedron, octahedron, ring'
        },
        position: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            z: { type: 'number' }
          },
          description: 'Position {x, y, z}. Defaults to (0, 1, 0).'
        },
        material: {
          type: 'object',
          properties: {
            color: { type: 'string', description: 'Hex color string like "#ff0000" or 0xff0000' },
            roughness: { type: 'number' },
            metalness: { type: 'number' }
          },
          description: 'Material properties. Defaults to a standard material.'
        },
        name: {
          type: 'string',
          description: 'Variable name for the mesh. Auto-generated if omitted.'
        }
      },
      required: ['type']
    },
    handler(params, meta) {
      const { type, position, material, name: customName } = params;
      const agentName = getAgentNameFromMeta(meta);

      const geometryMap = {
        box: 'BoxGeometry(1.5, 1.5, 1.5)',
        sphere: 'SphereGeometry(0.8, 32, 32)',
        cylinder: 'CylinderGeometry(0.5, 0.5, 2, 32)',
        cone: 'ConeGeometry(0.7, 1.5, 32)',
        torus: 'TorusGeometry(0.7, 0.3, 16, 48)',
        torusknot: 'TorusKnotGeometry(0.6, 0.2, 100, 16)',
        torusKnot: 'TorusKnotGeometry(0.6, 0.2, 100, 16)',
        plane: 'PlaneGeometry(2, 2)',
        dodecahedron: 'DodecahedronGeometry(0.8)',
        icosahedron: 'IcosahedronGeometry(0.8)',
        octahedron: 'OctahedronGeometry(0.8)',
        ring: 'RingGeometry(0.4, 0.8, 32)'
      };

      const geoStr = geometryMap[type] || geometryMap[type.toLowerCase()];
      if (!geoStr) {
        return {
          success: false,
          error: {
            code: 'INVALID_TYPE',
            message: `Unknown object type: "${type}". Supported: ${Object.keys(geometryMap).join(', ')}`,
            suggestion: 'Use one of the supported types or use update_code to write custom geometry.'
          }
        };
      }

      const objName = customName || type.toLowerCase().replace(/[^a-z]/g, '') + Math.floor(Math.random() * 900 + 100);
      const pos = position || { x: 0, y: 1, z: 0 };
      const color = (material && material.color) || '#10A37F';
      const roughness = (material && material.roughness !== undefined) ? material.roughness : 0.3;
      const metalness = (material && material.metalness !== undefined) ? material.metalness : 0.6;

      const colorValue = color.startsWith('#') ? `0x${color.slice(1)}` : color;

      const codeBlock = [
        '',
        `// ${objName}`,
        `const ${objName}Geo = new THREE.${geoStr};`,
        `const ${objName}Mat = new THREE.MeshStandardMaterial({`,
        `  color: ${colorValue},`,
        `  roughness: ${roughness},`,
        `  metalness: ${metalness}`,
        `});`,
        `const ${objName} = new THREE.Mesh(${objName}Geo, ${objName}Mat);`,
        `${objName}.position.set(${pos.x}, ${pos.y}, ${pos.z});`,
        `${objName}.castShadow = true;`,
        `scene.add(${objName});`,
      ];

      const lines = state.code.split('\n');
      let insertIdx = -1;

      for (let i = 0; i < lines.length; i++) {
        if (/\/\/\s*===\s*ANIMATION\s*===/.test(lines[i])) {
          insertIdx = i;
          break;
        }
      }

      if (insertIdx === -1) {
        for (let i = 0; i < lines.length; i++) {
          if (/function\s+animate\s*\(/.test(lines[i])) {
            insertIdx = i;
            break;
          }
        }
      }

      if (insertIdx === -1) {
        insertIdx = lines.length;
      }

      lines.splice(insertIdx, 0, ...codeBlock);
      const updatedCode = lines.join('\n');

      const changedLines = [];
      for (let i = insertIdx; i < insertIdx + codeBlock.length; i++) {
        changedLines.push(i + 1);
      }

      state.updateCode(updatedCode, agentName);
      const agentInfo = state.connectedAgents.find(a => a.name === agentName);

      state.broadcast('code_update', {
        code: state.code,
        changedLines,
        agent: agentName,
        agentType: agentInfo ? agentInfo.type : 'unknown'
      });

      state.addLogEntry({
        type: 'tool',
        agent: agentName,
        message: `add_object({ type: "${type}" }) — ${codeBlock.length} lines added`
      });

      return {
        success: true,
        objectName: objName,
        linesAdded: codeBlock.length
      };
    }
  },
  {
    name: 'remove_object',
    description: "Remove an object from the scene by variable name. Removes geometry, material, mesh, and scene.add lines.",
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The variable name of the mesh to remove'
        }
      },
      required: ['name']
    },
    handler(params, meta) {
      const { name: objName } = params;
      const agentName = getAgentNameFromMeta(meta);
      const lines = state.code.split('\n');

      const pattern = new RegExp(
        `(const|let|var)\\s+${objName}(Geo|Mat)?\\b|` +
        `${objName}\\.(position|rotation|castShadow|receiveShadow|scale)\\b|` +
        `scene\\.add\\(\\s*${objName}\\s*\\)|` +
        `\\/\\/\\s*${objName}$`
      );

      const filteredLines = [];
      let linesRemoved = 0;

      for (const line of lines) {
        if (pattern.test(line)) {
          linesRemoved++;
        } else {
          filteredLines.push(line);
        }
      }

      if (linesRemoved === 0) {
        return {
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: `No object found with variable name "${objName}".`,
            suggestion: 'Use get_scene_info to see all objects in the scene.'
          }
        };
      }

      const updatedCode = filteredLines.join('\n');
      state.updateCode(updatedCode, agentName);
      const agentInfo = state.connectedAgents.find(a => a.name === agentName);

      state.broadcast('code_update', {
        code: state.code,
        changedLines: [],
        agent: agentName,
        agentType: agentInfo ? agentInfo.type : 'unknown'
      });

      state.addLogEntry({
        type: 'tool',
        agent: agentName,
        message: `remove_object("${objName}") — ${linesRemoved} lines removed`
      });

      return {
        success: true,
        linesRemoved
      };
    }
  },
  {
    name: 'get_errors',
    description: "Check if the current scene code has any runtime errors from the 3D preview.",
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    },
    handler(params, meta) {
      return {
        hasErrors: state.errors.length > 0,
        errors: state.errors
      };
    }
  },
  {
    name: 'screenshot',
    description: "Capture a screenshot of the current 3D preview as a base64 PNG. Useful to verify what the scene looks like.",
    inputSchema: {
      type: 'object',
      properties: {
        width: { type: 'number', description: 'Screenshot width in pixels (default: iframe width)' },
        height: { type: 'number', description: 'Screenshot height in pixels (default: iframe height)' }
      },
      required: []
    },
    handler(params, meta) {
      if (!state.latestScreenshot) {
        state.broadcast('request_screenshot', {});
        return {
          success: false,
          error: {
            code: 'NO_SCREENSHOT',
            message: 'No screenshot available yet. The frontend has been asked to capture one. Try again in a moment.'
          }
        };
      }

      return {
        success: true,
        image: state.latestScreenshot.image,
        width: state.latestScreenshot.width,
        height: state.latestScreenshot.height,
        capturedAt: state.latestScreenshot.timestamp
      };
    }
  }
];

module.exports = tools;
