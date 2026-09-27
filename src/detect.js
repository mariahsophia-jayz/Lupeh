'use strict';

const LURAPH_HEADER = /This file was protected using Luraph Obfuscator v(\d+)(?:\.(\d+))?/;
const LURAPH_VM_SHAPE = /\[\d+\]=(bit32|buffer|string|table|math)\.\w+/;

function detectLuraph(source) {
  const head500 = source.slice(0, 500);
  const m = LURAPH_HEADER.exec(head500);
  if (m) return m[1] === '15' ? 1.0 : 0.85;

  const head2k = source.trimStart().slice(0, 2000);
  if (head2k.startsWith('return setmetatable({') &&
      (LURAPH_VM_SHAPE.test(head2k) || source.slice(0, 200000).includes('LPH'))) {
    return 0.8;
  }
  return 0.0;
}

const HEADER_LINE_RE = /\s*--[ \t]*This file was protected using Luraph Obfuscator v[\d.]+[ \t]*\[https?:\/\/lura\.ph\/?\]/;

function restoreHeaderNewline(source) {
  const m = HEADER_LINE_RE.exec(source);
  if (m) {
    const end = m.index + m[0].length;
    const next = source[end];
    if (next !== '' && next !== '\n' && next !== '\r') {
      return source.slice(0, end) + '\n' + source.slice(end).replace(/^[ \t]+/, '');
    }
  }
  return source;
}

const PLUGINS = [
  {
    name: 'luraph_v15',
    label: 'Luraph v15',
    detect: detectLuraph,
  },
];

function detect(source) {
  const confidence = detectLuraph(source);
  if (confidence >= 0.5) {
    const version = LURAPH_HEADER.exec(source.slice(0, 500));
    const plugin = version
      ? {
          name: version[1] === '15' ? 'luraph_v15' : `luraph_v${version[1]}`,
          label: `Luraph v${version[1]}${version[2] ? `.${version[2]}` : ''}`,
        }
      : { name: 'luraph_unknown', label: 'Luraph (version unknown)' };
    return { plugin, confidence };
  }
  return {
    plugin: { name: 'generic', label: 'unknown obfuscator (behaviour trace only)' },
    confidence: 0,
  };
}

function byName(name) {
  const p = PLUGINS.find(x => x.name === name);
  if (!p) throw new Error(`Unknown obfuscator '${name}' (known: ${PLUGINS.map(x => x.name).join(', ')})`);
  return p;
}

module.exports = { detect, byName, restoreHeaderNewline, PLUGINS };
