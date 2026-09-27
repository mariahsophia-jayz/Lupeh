'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Client, GatewayIntentBits, AttachmentBuilder } = require('discord.js');
const detector = require('./src/detect');

const PREFIX = '.lph';
const MAX_INPUT_BYTES = positiveInt(process.env.LPH_MAX_INPUT_MB, 8) * 1024 * 1024;
const MAX_OUTPUT_BYTES = positiveInt(process.env.LPH_MAX_OUTPUT_MB, 8) * 1024 * 1024;
const JOB_TIMEOUT_MS = positiveInt(process.env.LPH_JOB_TIMEOUT_MINUTES, 15) * 60 * 1000;
const MAX_CONCURRENT_JOBS = positiveInt(process.env.LPH_MAX_JOBS, 2);
const activeJobs = new Set();
const deobPath = path.join(__dirname, 'deob.js');

function positiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function sourceFromMessage(message) {
  const attachment = message.attachments.find(file => /\.(lua|luau)$/i.test(file.name || ''));
  if (attachment) return { type: 'attachment', attachment };

  // Also support a pasted script, optionally inside a Discord ```lua code block.
  const body = message.content.slice(PREFIX.length).trim();
  const match = body.match(/^```(?:lua|luau)?\s*\n([\s\S]*?)\n```$/i);
  if (match) return { type: 'text', source: match[1] };
  return null;
}

async function readAttachment(attachment) {
  if (attachment.size > MAX_INPUT_BYTES) {
    throw new Error(`That file is ${formatBytes(attachment.size)}; the input limit is ${formatBytes(MAX_INPUT_BYTES)}.`);
  }
  const response = await fetch(attachment.url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Couldn't download the attachment (HTTP ${response.status}).`);
  if (Number(response.headers.get('content-length')) > MAX_INPUT_BYTES) {
    throw new Error(`The attachment exceeds the ${formatBytes(MAX_INPUT_BYTES)} input limit.`);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_INPUT_BYTES) {
        await reader.cancel();
        throw new Error(`The attachment exceeds the ${formatBytes(MAX_INPUT_BYTES)} input limit.`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function runDeobfuscator(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [deobPath, inputPath, '--output', outputPath], {
      cwd: __dirname,
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: process.platform !== 'win32',
      env: process.env,
    });
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGTERM'); } catch {}
        setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000).unref();
      } else {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      }
    }, JOB_TIMEOUT_MS);

    child.stderr.on('data', data => {
      // Keep only a short diagnostic tail; deobfuscator output can be verbose.
      stderr = (stderr + data.toString()).slice(-6000);
    });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error('Deobfuscation timed out. Try a smaller script or ask an administrator to raise the job timeout.'));
      if (code !== 0) {
        const detail = stderr.trim().split('\n').slice(-5).join('\n');
        return reject(new Error(detail || `Deobfuscator exited with code ${code}.`));
      }
      resolve(stderr);
    });
  });
}

function formatBytes(size) {
  return size >= 1024 * 1024
    ? `${(size / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.ceil(size / 1024)} KB`;
}

async function handleCommand(message) {
  if (message.author.bot || !/^\.lph(?:\s|$)/i.test(message.content)) return;
  const source = sourceFromMessage(message);
  if (!source) {
    await message.reply('Attach a `.lua` or `.luau` file to `.lph`, or paste the script in a ```lua code block. Example: `.lph` + `script.lua`.');
    return;
  }
  if (activeJobs.size >= MAX_CONCURRENT_JOBS) {
    await message.reply('I’m busy deobfuscating other scripts right now. Please try again in a little while.');
    return;
  }

  const jobKey = message.id;
  activeJobs.add(jobKey);
  let workdir;
  let status;
  try {
    status = await message.reply('⏳ Working on it… Large scripts can take a few minutes.');
    const input = source.type === 'attachment'
      ? await readAttachment(source.attachment)
      : Buffer.from(source.source, 'utf8');
    if (input.length === 0) throw new Error('The supplied script is empty.');
    if (input.length > MAX_INPUT_BYTES) throw new Error(`The input limit is ${formatBytes(MAX_INPUT_BYTES)}.`);

    workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'lupeh-discord-'));
    const inputPath = path.join(workdir, 'input.lua');
    const outputPath = path.join(workdir, 'deobfuscated.lua');
    await fs.writeFile(inputPath, input);
    await runDeobfuscator(inputPath, outputPath);
    const output = await fs.readFile(outputPath);
    if (!output.length) throw new Error('The deobfuscator returned an empty result.');
    if (output.length > MAX_OUTPUT_BYTES) {
      throw new Error(`The result is ${formatBytes(output.length)}, above the bot’s ${formatBytes(MAX_OUTPUT_BYTES)} upload limit.`);
    }

    const { plugin } = detector.detect(input.toString('latin1'));
    const versionNote = plugin.name.startsWith('luraph_') && plugin.name !== 'luraph_v15'
      ? `${plugin.label} detected. This engine’s full devirtualizer is tuned for v15; other versions may produce a behavior trace instead.\n`
      : '';
    await status.edit({
      content: `${versionNote}✅ Deobfuscation finished.`,
      files: [new AttachmentBuilder(output, { name: 'deobfuscated.lua' })],
    });
  } catch (error) {
    const messageText = error && error.message ? error.message : 'Unknown error.';
    await (status ? status.edit(`❌ ${messageText.slice(0, 1800)}`) : message.reply(`❌ ${messageText.slice(0, 1800)}`));
  } finally {
    activeJobs.delete(jobKey);
    if (workdir) await fs.rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('Missing DISCORD_TOKEN environment variable.');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});
client.on('messageCreate', message => {
  handleCommand(message).catch(error => console.error('Command handler failed:', error));
});
client.once('ready', () => console.log(`Lupeh bot ready as ${client.user.tag}; command: ${PREFIX}`));
client.login(token).catch(error => {
  console.error('Discord login failed:', error.message);
  process.exitCode = 1;
});
