
const Module = require('module');
const { brotliDecompressSync } = require('zlib');
const { join, dirname } = require('path');
const fs = require('fs');
const crypto = require('crypto');

// --- OTA Overlay ---

const EMBEDDED_SIGNING_PUBLIC_KEY = '__JS2BIN_SIGNING_PUBLIC_KEY__';

function verifySignature(data, signature, publicKeyPem) {
  try {
    const verify = crypto.createVerify('SHA256');
    verify.update(data);
    verify.end();
    return verify.verify({ key: publicKeyPem, dsaEncoding: 'der' }, signature);
  } catch {
    return false;
  }
}

function loadTrustedKeys(trustedKeysDir) {
  const keys = [];
  try {
    if (!fs.existsSync(trustedKeysDir)) return keys;
    const files = fs.readdirSync(trustedKeysDir);
    for (const file of files) {
      if (file.endsWith('.pub')) {
        try {
          keys.push(fs.readFileSync(join(trustedKeysDir, file), 'utf8'));
        } catch {
          // Skip unreadable key files
        }
      }
    }
  } catch {
    // Directory read failed — no additional keys
  }
  return keys;
}

function tryLoadOTABundle(execDir) {
  const otaDir = process.env.JS2BIN_OTA_DIR || join(execDir, 'ota', 'current');

  const bundlePath = join(otaDir, 'bundle.js');
  const sigPath = join(otaDir, 'bundle.js.sig');

  if (!fs.existsSync(bundlePath) || !fs.existsSync(sigPath)) {
    return null;
  }

  let bundleData;
  let sigData;

  try {
    bundleData = fs.readFileSync(bundlePath);
    sigData = fs.readFileSync(sigPath);
  } catch (err) {
    process.stderr.write(`[js2bin] OTA: failed to read bundle files: ${err.message}\n`);
    return null;
  }

  const trustedKeysDir = join(execDir, 'ota', 'trusted-keys');
  const allKeys = [EMBEDDED_SIGNING_PUBLIC_KEY, ...loadTrustedKeys(trustedKeysDir)];

  if (allKeys.length === 0) {
    process.stderr.write('[js2bin] OTA: no signing keys available (no embedded key, no trusted-keys directory). Ignoring OTA bundle.\n');
    return null;
  }

  let signatureValid = false;
  for (const key of allKeys) {
    if (verifySignature(bundleData, sigData, key)) {
      signatureValid = true;
      break;
    }
  }

  if (!signatureValid) {
    process.stderr.write('[js2bin] OTA: signature verification failed — bundle is unsigned or tampered. Falling back to embedded JS.\n');
    return null;
  }

  process.stderr.write(`[js2bin] OTA: loaded valid bundle from ${otaDir}\n`);
  return bundleData.toString('utf8');
}

// --- Main bootstrap ---

let source = process.binding('natives')._js2bin_app_main;
if (source.startsWith('`~')) {
  console.log(`js2bin binary with ${Math.floor(source.length / 1024 / 1024)}MB of placeholder content.
For more info see: js2bin --help`);
  process.exit(-1);
}

const nullIdx = source.indexOf('\0');
if (nullIdx > -1) {
  source = source.substr(0, nullIdx);
}

const parts = source.split('\n');
const appName = Buffer.from(parts[0], 'base64').toString();
const filename = join(dirname(process.execPath), `${appName.trim()}.js`);

const embeddedSource = parts[1];

// Try OTA overlay
let activeSource = embeddedSource;
try {
  const otaBundle = tryLoadOTABundle(dirname(process.execPath));
  if (otaBundle) {
    activeSource = otaBundle;
  }
} catch (err) {
  process.stderr.write(`[js2bin] OTA: unexpected error during overlay load: ${err.message}. Falling back to embedded JS.\n`);
}

// here we turn what looks like an internal module to an non-internal one
// that way the module is loaded exactly as it would by: node app_main.js
const mod = new Module(process.execPath, null);
mod.id = '.'; // main module
mod.filename = filename; // dirname of this is used by require
process.mainModule = mod; // main module

let decompressedSource;
try {
  decompressedSource = brotliDecompressSync(Buffer.from(activeSource, 'base64'), { chunkSize: 128 * 1024 * 1024 }).toString();
} catch (err) {
  if (activeSource !== embeddedSource) {
    process.stderr.write(`[js2bin] OTA: failed to decompress OTA bundle: ${err.message}. Falling back to embedded JS.\n`);
    decompressedSource = brotliDecompressSync(Buffer.from(embeddedSource, 'base64'), { chunkSize: 128 * 1024 * 1024 }).toString();
  } else {
    throw err;
  }
}

mod._compile(`

// initialize clustering
const cluster = require('cluster');
if (cluster.worker) {
   // NOOP - cluster worker already initialized, likely Node 12.x+
}else if (process.argv[1] && process.env.NODE_UNIQUE_ID) {
   cluster._setupWorker()
   delete process.env.NODE_UNIQUE_ID
} else {
  process.argv.splice(1, 0, __filename); // don't mess with argv in clustering
}

${decompressedSource}

`, filename);
