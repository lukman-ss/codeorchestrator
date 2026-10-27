import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '../../..');
export const PROMPT_ARTIFACTS_DIR = resolve(ROOT_DIR, 'data/prompt-artifacts');

const ALLOWED_CDN_HOSTS = new Set([
  'cdn.discordapp.com',
  'media.discordapp.net'
]);

export function ensureArtifactsDirectory(dir = PROMPT_ARTIFACTS_DIR) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch {}
  return dir;
}

export function savePromptArtifact(content, filename = 'specification.txt', dir = PROMPT_ARTIFACTS_DIR) {
  ensureArtifactsDirectory(dir);
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const ext = filename.toLowerCase().endsWith('.md') ? '.md' : '.txt';
  const artifactPath = resolve(dir, `${sha256}${ext}`);
  
  writeFileSync(artifactPath, buffer, { mode: 0o600 });
  try { chmodSync(artifactPath, 0o600); } catch {}

  return {
    content: buffer.toString('utf8'),
    sizeBytes: buffer.length,
    sha256,
    artifactPath
  };
}

export async function downloadAndValidateAttachment(attachment, options = {}) {
  if (!attachment || typeof attachment !== 'object') {
    throw new Error('Attachment is required');
  }

  const filename = (attachment.name || '').trim();
  const lowerName = filename.toLowerCase();
  if (!lowerName.endsWith('.txt') && !lowerName.endsWith('.md')) {
    throw new Error('Invalid file type: Only .txt and .md UTF-8 specification attachments are supported');
  }

  const urlStr = attachment.url;
  if (!urlStr) {
    throw new Error('Attachment URL is missing');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(urlStr);
  } catch {
    throw new Error('Invalid attachment URL format');
  }

  if (!ALLOWED_CDN_HOSTS.has(parsedUrl.hostname.toLowerCase())) {
    throw new Error(`Invalid attachment host '${parsedUrl.hostname}': only Discord CDN origins (cdn.discordapp.com, media.discordapp.net) are permitted`);
  }

  const maxBytes = options.maxBytes || config.maxAttachmentBytes || 262144;
  if (typeof attachment.size === 'number' && attachment.size > maxBytes) {
    throw new Error(`File too large (${Math.round(attachment.size / 1024)}KB). Maximum allowed size is ${Math.round(maxBytes / 1024)}KB`);
  }

  const timeoutMs = options.timeoutMs || 10000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(urlStr, { signal: controller.signal });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error(`Download timed out after ${timeoutMs}ms`);
    }
    throw new Error(`Failed to download prompt attachment: ${err.message}`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new Error(`Failed to download prompt attachment: HTTP ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (buffer.length === 0) {
    throw new Error('Attachment is empty');
  }

  if (buffer.length > maxBytes) {
    throw new Error(`File too large (${Math.round(buffer.length / 1024)}KB). Maximum allowed size is ${Math.round(maxBytes / 1024)}KB`);
  }

  if (buffer.includes(0)) {
    throw new Error('Attachment contains invalid binary or null bytes');
  }

  // Validate UTF-8 strictly
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new Error('Attachment contains invalid UTF-8 encoding');
  }

  const saved = savePromptArtifact(buffer, filename, options.artifactsDir || PROMPT_ARTIFACTS_DIR);

  return {
    content: saved.content,
    filename,
    sizeBytes: saved.sizeBytes,
    sha256: saved.sha256,
    artifactPath: saved.artifactPath
  };
}
