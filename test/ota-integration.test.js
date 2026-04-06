const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const CLI_PATH = path.join(__dirname, '..', 'js2bin.js');

function generateKeypair() {
  return crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'sec1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
}

function createApp(dir, name, code) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, code);
  return filePath;
}

async function runCli(args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath, [CLI_PATH, ...args],
      { timeout: opts.timeout || 30000, env: { ...process.env, ...opts.env } }
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.status || 1, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

async function runBinary(binPath, opts = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(
      binPath, opts.args || [],
      { timeout: opts.timeout || 10000, env: { ...process.env, ...opts.env } }
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.status || 1, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

// ---------------------------------------------------------------------------
// Tier 1: OTA Bundle CLI (--ota) — always runs, fast
// ---------------------------------------------------------------------------

describe('OTA Integration: Bundle CLI (--ota)', () => {
  let tmpDir;
  let keypair;
  let appFile;
  let keyFile;

  const appContent = 'console.log("ota-bundle-test");';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-integ-'));
    keypair = generateKeypair();
    appFile = createApp(tmpDir, 'app.js', appContent);
    keyFile = path.join(tmpDir, 'signing.key');
    fs.writeFileSync(keyFile, keypair.privateKey);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should produce all three bundle artifacts', async () => {
    const outputDir = path.join(tmpDir, 'out');
    const result = await runCli([
      '--ota',
      `--app=${appFile}`,
      `--signing-key=${keyFile}`,
      `--output=${outputDir}`,
    ]);

    assert.equal(result.code, 0, `CLI failed: ${result.stderr}`);
    assert.ok(fs.existsSync(path.join(outputDir, 'bundle.js')));
    assert.ok(fs.existsSync(path.join(outputDir, 'bundle.js.sig')));
    assert.ok(fs.existsSync(path.join(outputDir, 'bundle.js.sha256')));
  });

  it('should produce a bundle that decompresses to the original JS', async () => {
    const outputDir = path.join(tmpDir, 'out');
    await runCli([
      '--ota',
      `--app=${appFile}`,
      `--signing-key=${keyFile}`,
      `--output=${outputDir}`,
    ]);

    const bundleContent = fs.readFileSync(path.join(outputDir, 'bundle.js'), 'utf8');
    const decompressed = zlib.brotliDecompressSync(Buffer.from(bundleContent, 'base64')).toString();
    assert.equal(decompressed, appContent);
  });

  it('should produce a valid signature verifiable with the public key', async () => {
    const outputDir = path.join(tmpDir, 'out');
    await runCli([
      '--ota',
      `--app=${appFile}`,
      `--signing-key=${keyFile}`,
      `--output=${outputDir}`,
    ]);

    const bundleData = fs.readFileSync(path.join(outputDir, 'bundle.js'));
    const sigData = fs.readFileSync(path.join(outputDir, 'bundle.js.sig'));
    const verify = crypto.createVerify('SHA256');
    verify.update(bundleData);
    verify.end();
    assert.ok(verify.verify({ key: keypair.publicKey, dsaEncoding: 'der' }, sigData));
  });

  it('should write a correct sha256 checksum', async () => {
    const outputDir = path.join(tmpDir, 'out');
    await runCli([
      '--ota',
      `--app=${appFile}`,
      `--signing-key=${keyFile}`,
      `--output=${outputDir}`,
    ]);

    const bundleData = fs.readFileSync(path.join(outputDir, 'bundle.js'));
    const expectedChecksum = crypto.createHash('sha256').update(bundleData).digest('hex');
    const writtenChecksum = fs.readFileSync(path.join(outputDir, 'bundle.js.sha256'), 'utf8');
    assert.equal(writtenChecksum, expectedChecksum);
  });

  it('should fail without --signing-key', async () => {
    const result = await runCli([
      '--ota',
      `--app=${appFile}`,
    ]);
    assert.notEqual(result.code, 0);
  });

  it('should fail without --app', async () => {
    const result = await runCli([
      '--ota',
      `--signing-key=${keyFile}`,
    ]);
    assert.notEqual(result.code, 0);
  });

  it('should fail with nonexistent app file', async () => {
    const result = await runCli([
      '--ota',
      '--app=/tmp/does-not-exist-ota-test.js',
      `--signing-key=${keyFile}`,
    ]);
    assert.notEqual(result.code, 0);
  });
});

// ---------------------------------------------------------------------------
// Tier 2: Full Binary OTA Flow
//
// Tries to build an OTA-enabled binary via --build --enable-ota --cache.
// If the OTA cached binary isn't available, falls back to JS2BIN_OTA_BINARY
// env var. Skips if neither works.
// ---------------------------------------------------------------------------

const DEFAULT_NODE_VERSION = '22.22.0';
const PLATFORM = process.platform === 'win32' ? 'windows' : process.platform;
const ARCH = process.arch;

let resolvedBinary = null;
let setupDir = null;

describe('OTA Integration: Full Binary Flow', async () => {
  let tmpDir;
  let keypair;
  let binPath;

  before(async () => {
    setupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-setup-'));
    const embeddedApp = createApp(setupDir, 'embedded.js', 'console.log("embedded-ok");');
    const binName = path.join(setupDir, 'ota-integ-test');

    const buildResult = await runCli([
      '--build',
      `--app=${embeddedApp}`,
      `--node=${DEFAULT_NODE_VERSION}`,
      '--enable-ota',
      '--cache',
      `--name=${binName}`,
      `--platform=${PLATFORM}`,
      `--arch=${ARCH}`,
    ], { timeout: 60000 });

    const builtPath = `${binName}-${PLATFORM}-${ARCH}`;
    if (buildResult.code === 0 && fs.existsSync(builtPath)) {
      if (process.platform === 'darwin') {
        try { await execFileAsync('codesign', ['--force', '--sign', '-', builtPath]); } catch {}
      }
      resolvedBinary = builtPath;
    } else if (process.env.JS2BIN_OTA_BINARY && fs.existsSync(process.env.JS2BIN_OTA_BINARY)) {
      resolvedBinary = process.env.JS2BIN_OTA_BINARY;
    } else {
      assert.fail('No OTA-enabled cached binary available (and JS2BIN_OTA_BINARY not set)');
    }
  });

  after(() => {
    if (setupDir) fs.rmSync(setupDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-binary-test-'));
    keypair = generateKeypair();

    // Copy binary into tmpDir so ota/ dirs are relative to it
    const binName = path.basename(resolvedBinary);
    binPath = path.join(tmpDir, binName);
    fs.copyFileSync(resolvedBinary, binPath);
    fs.chmodSync(binPath, 0o755);
    // Re-sign after copy on macOS
    if (process.platform === 'darwin') {
      const { execFileSync } = require('child_process');
      try { execFileSync('codesign', ['--force', '--sign', '-', binPath]); } catch {}
    }
  });

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Helper: build an OTA bundle from source code and place it in a directory
  async function buildOtaBundle(appCode, outputDir) {
    const appFile = createApp(tmpDir, `ota-app-${Date.now()}.js`, appCode);
    const keyFile = path.join(tmpDir, 'signing.key');
    fs.writeFileSync(keyFile, keypair.privateKey);

    const result = await runCli([
      '--ota',
      `--app=${appFile}`,
      `--signing-key=${keyFile}`,
      `--output=${outputDir}`,
    ]);
    assert.equal(result.code, 0, `OTA bundle build failed: ${result.stderr}`);
    return outputDir;
  }

  // Helper: set up trusted-keys directory with the test public key
  function installTrustedKey() {
    const trustedKeysDir = path.join(tmpDir, 'ota', 'trusted-keys');
    fs.mkdirSync(trustedKeysDir, { recursive: true });
    fs.writeFileSync(path.join(trustedKeysDir, 'test.pub'), keypair.publicKey);
  }

  it('should run embedded app when no OTA bundle is present', async () => {
    const result = await runBinary(binPath);
    assert.equal(result.code, 0, `Binary failed: ${result.stderr}`);
    assert.ok(result.stdout.includes('embedded-ok'), `Expected "embedded-ok", got: ${result.stdout}`);
  });

  it('should load OTA bundle that overrides embedded app', async () => {
    const otaCurrentDir = path.join(tmpDir, 'ota', 'current');
    installTrustedKey();
    await buildOtaBundle('console.log("v2-ok");', otaCurrentDir);

    const result = await runBinary(binPath);
    assert.equal(result.code, 0, `Binary failed: ${result.stderr}`);
    assert.ok(result.stdout.includes('v2-ok'), `Expected OTA output "v2-ok", got: ${result.stdout}`);
  });

  it('should load OTA bundle via CRIBL_OTA_DIR env var', async () => {
    const customOtaDir = path.join(tmpDir, 'custom-ota-location');
    installTrustedKey();
    await buildOtaBundle('console.log("env-var-ok");', customOtaDir);

    const result = await runBinary(binPath, { env: { CRIBL_OTA_DIR: customOtaDir } });
    assert.equal(result.code, 0, `Binary failed: ${result.stderr}`);
    assert.ok(result.stdout.includes('env-var-ok'), `Expected OTA output "env-var-ok", got: ${result.stdout}`);
  });

  it('should fall back to embedded app when OTA signature is tampered', async () => {
    const otaCurrentDir = path.join(tmpDir, 'ota', 'current');
    installTrustedKey();
    await buildOtaBundle('console.log("tampered");', otaCurrentDir);

    // Corrupt the signature
    const sigPath = path.join(otaCurrentDir, 'bundle.js.sig');
    const sig = fs.readFileSync(sigPath);
    sig[0] ^= 0xff;
    fs.writeFileSync(sigPath, sig);

    const result = await runBinary(binPath);
    // Should NOT contain the tampered OTA output
    assert.ok(!result.stdout.includes('tampered'), 'Binary should not have loaded tampered OTA bundle');
    // Stderr should mention signature verification failure
    assert.ok(result.stderr.includes('signature verification failed'), `Expected signature error in stderr, got: ${result.stderr}`);
  });

  it('should verify OTA bundle using trusted-keys directory', async () => {
    const otaCurrentDir = path.join(tmpDir, 'ota', 'current');
    installTrustedKey();
    await buildOtaBundle('console.log("trusted-key-ok");', otaCurrentDir);

    const result = await runBinary(binPath);
    assert.equal(result.code, 0, `Binary failed: ${result.stderr}`);
    assert.ok(result.stdout.includes('trusted-key-ok'), `Expected OTA output "trusted-key-ok", got: ${result.stdout}`);
  });
});
