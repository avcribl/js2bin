const { log, download, upload, fetch, mkdirp, rmrf, copyFileAsync, runCommand, renameAsync, patchFile } = require('./util');
const { gzipSync, createGunzip } = require('zlib');
const { join, dirname, basename, parse, resolve } = require('path');
const fs = require('fs');
const os = require('os');
const tar = require('tar-fs');
const pkg = require('../package.json');

const isWindows = process.platform === 'win32';
const isDarwin = process.platform === 'darwin';
const isLinux = process.platform === 'linux';

const prettyPlatform = {
  win32: 'windows',
  windows: 'windows',
  win: 'windows',
  darwin: 'darwin',
  macos: 'darwin',
  mac: 'darwin',
  linux: 'linux',
  static: 'alpine',
  alpine: 'alpine'
};

const prettyArch = {
  x86: 'x86',
  arm6: 'arm6l',
  arm64: 'arm64',
  arm6l: 'arm6l',
  arm: 'arm7l',
  arm7: 'arm7l',
  arm7l: 'arm7l',
  amd64: 'x64',
  ia32: 'x86',
  x32: 'x86',
  x64: 'x64'
};

// keys are expected to come from values of `prettyArch`
const darwinArch = {
  arm64: 'arm64',
  x64: 'x86_64',
};

function buildName(platform, arch, placeHolderSizeMB, version) {
  return `${platform}-${arch}-${version}-v1-${placeHolderSizeMB}MB`;
}

class NodeJsBuilder {
  constructor(cwd, version, mainAppFile, appName, patchDir) {
    this.version = version;
    this.appFile = resolve(mainAppFile);
    this.appName = appName;
    if (!this.appName) {
      if (basename(this.appFile) !== 'index.js') { // use filename if ! index.js
        this.appName = basename(this.appFile).split('.')[0];
      } else if (basename(dirname(this.appFile))) { // parent dir
        this.appName = basename(dirname(this.appFile));
      } else {
        this.appName = 'app_main';
      }
    }
    const isBsd = process.platform.indexOf('bsd') > -1;
    this.make = isWindows ? 'vcbuild.bat' : isBsd ? 'gmake' : 'make';
    this.configure = isWindows ? 'configure' : './configure';
    this.srcDir = join(__dirname);
    this.patchDir = patchDir || join(this.srcDir, 'patch', version);
    this.buildDir = join(cwd || process.cwd(), 'build');
    this.nodeSrcFile = join(this.buildDir, `node-v${version}.tar.gz`);
    this.nodeSrcDir = join(this.buildDir, `node-v${version}`);
    this.cacheDir = join(cwd || process.cwd(), 'cache');
    this.resultFile = isWindows ? join(this.nodeSrcDir, 'Release', 'node.exe') : join(this.nodeSrcDir, 'out', 'Release', 'node');
    this.placeHolderSizeMB = -1;
    this.builderImageVersion = 3;
  }

  static platform() {
    return prettyPlatform[process.platform];
  }

  static getArch(arch) {
    if (arch.indexOf('linux') > -1) {
      arch = arch.split('/')[1];
    }
    return arch in prettyArch ? prettyArch[arch] : arch;
  }

  async createAndCacheHeaders() {
    if (isWindows || process.arch !== 'x64') {
      return Promise.resolve();
    }

    // Create symlink for Python if needed
    const pythonPath = '/usr/local/bin/python3';
    const python39Path = '/usr/local/bin/python3.9';
    if (fs.existsSync(pythonPath) && !fs.existsSync(python39Path)) {
      await runCommand('ln', ['-s', pythonPath, python39Path]);
    }

    try {
      await runCommand('which', ['python3.9']);
    } catch (e) {
      log('python3.9 not found');
      return Promise.resolve();
    }

    // Use tools/install.py directly to install headers
    const headersDir = `node-v${this.version}`;
    await runCommand('python3.9', [
      'tools/install.py',
      'install',
      '--headers-only',
      '--dest-dir=' + headersDir,
      '--prefix=/'
    ], this.nodeSrcDir);
    
    // Remove symlinks (similar to Makefile's find command)
    // const fullHeadersDir = join(this.nodeSrcDir, '--headers-only--dest-dir=' + headersDir);
    const fullHeadersDir = join(this.nodeSrcDir, headersDir);
    await runCommand('find', [fullHeadersDir, '-type', 'l', '-exec', 'rm', '{}', ';']);
    
    // Move include directory to cache
    const includeDir = join(fullHeadersDir, 'include');
    const cacheIncludeDir = join(this.cacheDir, 'include');

    const files2 = await fs.promises.readdir(includeDir);
    log('Files in src/include:', files2);
    
    // Ensure cache directory exists
    await mkdirp(this.cacheDir);
    
    // Remove existing include directory if it exists
    if (fs.existsSync(cacheIncludeDir)) {
      await runCommand('rm', ['-rf', cacheIncludeDir]);
    }
    
    // Move the include directory
    await runCommand('mv', [includeDir, this.cacheDir]);

    // Create tarball of headers
    const tarFile = `${this.version}-headers.tar`;
    await runCommand('tar', ['-cf', tarFile, 'include'], this.cacheDir);
    
    
    // Clean up the source directory
    // await runCommand('rm', ['-rf', join(this.nodeSrcDir, '--headers-only--dest-dir=' + headersDir)]);
    await runCommand('rm', ['-rf', join(this.nodeSrcDir, headersDir)]);
    
    const files3 = await fs.promises.readdir(this.cacheDir);
    log('Files in cache:', files3);
    // List contents of cache directory
    const files = await fs.promises.readdir(join(cacheIncludeDir, 'node'));
    log('Files in cache/include/node:', files);
  }

  downloadExpandNodeSource() {
    const url = `https://nodejs.org/dist/v${this.version}/node-v${this.version}.tar.gz`;
    if (fs.existsSync(this.nodePath('configure'))) {
      log(`node version=${this.version} already downloaded and expanded, using it`);
      return Promise.resolve();
    }

    if (this.version.split('.')[0] >= 15) {
      return rmrf(this.nodeSrcDir)
        .then(() => runCommand('git', ['clone', 'https://github.com/nodejs/node.git', this.nodeSrcDir]))
        .then(() => runCommand('git', ['checkout', 'd9aa33fdbf015ee2aa799c106b5039d4675f90cf'], this.nodeSrcDir))
        .then(() => this.applyPatches());
    }

    return download(url, this.nodeSrcFile)
      .then(() => new Promise((resolve, reject) => {
        log(`expanding node source, file=${this.nodeSrcFile} ...`);
        fs.createReadStream(this.nodeSrcFile)
          .pipe(createGunzip())
          .pipe(tar.extract(dirname(this.nodeSrcDir)))
          .on('error', reject)
          .on('finish', resolve);
      }));
  }

  downloadCachedBuild(platform, arch, placeHolderSizeMB) {
    placeHolderSizeMB = placeHolderSizeMB || this.placeHolderSizeMB;
    const name = buildName(platform, arch, placeHolderSizeMB, this.version);
    const filename = join(this.cacheDir, name);
    if (fs.existsSync(filename)) {
      log(`build name=${name} already downloaded, using it`);
      return Promise.resolve(filename);
    }
    const baseUrl = `https://github.com/criblio/js2bin/releases/download/v${pkg.version}/`;
    const url = `${baseUrl}${name}`;
    return download(url, filename);
  }

  uploadNodeBinary(name, uploadBuild, cache, arch, ptrCompression) {
    if (!uploadBuild && !cache) return Promise.resolve();
    if (!name) {
      arch = NodeJsBuilder.getArch(arch);
      const platform = prettyPlatform[process.platform] + (ptrCompression ? '-ptrc' : '');
      name = buildName(platform, arch, this.placeHolderSizeMB, this.version);
    }

    let p = Promise.resolve();
    if (cache) {
      p = mkdirp(this.cacheDir)
        .then(() => copyFileAsync(this.resultFile, join(this.cacheDir, name)));
    }

    if (!uploadBuild) return p;

    // now upload to release
    const headers = {
      Authorization: 'token ' + process.env.GITHUB_TOKEN
    };
    return p
      .then(() => fetch(`https://api.github.com/repos/criblio/js2bin/releases/tags/v${pkg.version}`, headers))
      .then(JSON.parse)
      .then(p => p.upload_url.split('{')[0])
      .then(baseUrl => {
        const url = `${baseUrl}?name=${encodeURIComponent(name)}`;
        return upload(url, this.resultFile, headers);
      });
  }

  nodePath(...pathSegments) {
    return join(this.nodeSrcDir, ...pathSegments);
  }

  revertBackup(origFile) {
    if (!fs.existsSync(origFile + '.bak')) { return Promise.resolve(); }
    return renameAsync(origFile + '.bak', origFile);
  }

  createBackup(origFile) {
    if (fs.existsSync(origFile + '.bak')) { return Promise.resolve(); } // do not overwrite backup
    return copyFileAsync(origFile, origFile + '.bak');
  }

  cleanupBuild() {
    log(`cleaning up build dir=${this.nodeSrcDir}`);
    return rmrf(dirname(this.nodeSrcDir), 5);
  }

  getPlaceholderContent(sizeMB) {
    const appMainCont = '~N~o~D~e~o~N~e~\n'.repeat(sizeMB * 1024 * 1024 / 16);
    return Buffer.from('`' + appMainCont + '`');
  }

  getAppContentToBundle() {
    const mainAppFileCont = gzipSync(fs.readFileSync(this.appFile), {level: 9}).toString('base64');
    return Buffer.from(this.appName).toString('base64') + '\n' + mainAppFileCont;
  }

  prepareNodeJsBuild() {
    // install _third_party_main.js
    // install app_main.js
    const appMainPath = this.nodePath('lib', '_js2bin_app_main.js');
    return Promise.resolve()
      .then(() => copyFileAsync(
        join(this.srcDir, '_third_party_main.js'), // this is the entrypoint to the light wrapper that js2bin inserts
        this.nodePath('lib', '_third_party_main.js')
      ))
      .then(() => {
        const m = /^__(\d+)MB__$/i.exec(basename(this.appFile)); // placeholder file
        if (m) {
          this.placeHolderSizeMB = Number(m[1]);
          fs.writeFileSync(appMainPath, this.getPlaceholderContent(this.placeHolderSizeMB));
        } else {
          fs.writeFileSync(appMainPath, this.getAppContentToBundle());
        }
      });
  }

  async patchThirdPartyMain() {
    await patchFile(this.nodeSrcDir, join(this.patchDir, 'run_third_party_main.js.patch'));
    await patchFile(this.nodeSrcDir, join(this.patchDir, 'node.cc.patch'));
    // await patchFile(this.nodeSrcDir, join(this.patchDir, 'fs-event.c.patch'));
  }

  async patchNodeCompileIssues() {
    await patchFile(this.nodeSrcDir, join(this.patchDir, 'node.gyp.patch'));

    if (isWindows) {
      // await patchFile(this.nodeSrcDir, join(this.patchDir, 'vcbuild.bat.patch'));
      // await patchFile(this.nodeSrcDir, join(this.patchDir, 'v8config.patch'));
      // The following patches fix the memory leak when using pointer compression
      // They are fixing both Linux and Windows, however, we only apply them to Windows to keep the blast radius small
      // await patchFile(this.nodeSrcDir, join(this.patchDir, 'configure.py.patch'));
      // await patchFile(this.nodeSrcDir, join(this.patchDir, 'features.gypi.patch'));
      // await patchFile(this.nodeSrcDir, join(this.patchDir, 'node_buffer.cc.patch'));
      // await patchFile(this.nodeSrcDir, join(this.patchDir, 'v8_backing_store_callers.patch'));
    }

    if (isLinux) {
      await patchFile(this.nodeSrcDir, join(this.patchDir, 'no_rand_on_glibc.patch'));
    }
  }

  async applyPatches() {
    await this.patchThirdPartyMain();
    await this.patchNodeCompileIssues();
  }

  printDiskUsage() {
    if (isWindows) {
      const parsedPath = parse(this.resultFile);
      return runCommand('fsutil', ['volume', 'diskfree', parsedPath.root]);
    }
    return runCommand('df', ['-h']);
  }

  buildInContainer(ptrCompression) {
    const containerTag = `cribl/js2bin-builder:${this.builderImageVersion}`;
    // const containerTag = `cribl-stream9:${this.builderImageVersion}`;
    // return this.buildDockerImage('linux/amd64')
      // .then(() => runCommand(
    return runCommand(
      'docker', ['run',
          '-v', `${process.cwd()}:/js2bin/`,
          '-t', containerTag,
          '/bin/bash', '-c',
          `source /opt/rh/devtoolset-10/enable && cd /js2bin && npm install && ./js2bin.js --ci --node=${this.version} --size=${this.placeHolderSizeMB}MB ${ptrCompression ? '--pointer-compress=true' : ''}`
        ]
      );
  }
            // `source /opt/rh/gcc-toolset-12/enable && cd /js2bin && npm install && ./js2bin.js --ci --node=${this.version} --size=${this.placeHolderSizeMB}MB ${ptrCompression ? '--pointer-compress=true' : ''}`

  buildInContainerNonX64(arch, ptrCompression) {
    const containerTag = `cribl/js2bin-builder:${this.builderImageVersion}-nonx64`;
    // const containerTag = `cribl-stream9:${this.builderImageVersion}-nonx64`;
    // return this.buildDockerImage(arch)
      // .then(() => runCommand(
    return runCommand(
      'docker', ['run',
          '--platform', arch,
          '-v', `${process.cwd()}:/js2bin/`,
          '-t', containerTag,
          '/bin/bash', '-c',
          `source /opt/rh/devtoolset-10/enable && cd /js2bin && npm install && ./js2bin.js --ci --node=${this.version} --size=${this.placeHolderSizeMB}MB ${ptrCompression ? '--pointer-compress=true' : ''}`
      ]
    );
  }

  buildDockerImage(arch) {
    const tag = arch === 'linux/amd64'
      ? `cribl-stream9:${this.builderImageVersion}`
      : `cribl-stream9:${this.builderImageVersion}-nonx64`;
    
    const dockerfileName = arch === 'linux/amd64' ? 'Dockerfile.stream9' : 'Dockerfile.stream9.arm64';
    const dockerfilePath = join(dirname(this.srcDir), dockerfileName);
    const buildContext = dirname(this.srcDir);
    
    return runCommand(
      'docker', ['build',
        '--platform', arch,
        '-t', tag,
        '-f', dockerfilePath,
        buildContext
      ]
    );
  }

  // 1. download node source
  // 2. expand node version
  // 3. install _third_party_main.js
  // 4. process mainAppFile (gzip, base64 encode it) - could be a placeholder file
  // 5. kick off ./configure & build
  buildFromSource(uploadBuild, cache, container, arch, ptrCompression) {
    const makeArgs = isWindows ? ['x64', 'no-cctest'] : [`-j${os.cpus().length}`];
    // const makeArgs = isWindows ? ['x64', 'no-cctest', 'clang-cl'] : [`-j${os.cpus().length}`];
    const configArgs = [];
    if(ptrCompression) {
      // if(isWindows) makeArgs.push('v8_ptr_compress');
      if(isWindows) log('skipping v8_ptr_compress for windows');
      else          configArgs.push('--experimental-enable-pointer-compression');
    }
    return this.printDiskUsage()
      .then(() => this.downloadExpandNodeSource())
      .then(() => this.prepareNodeJsBuild())
      .then(() => {
        if (isWindows) { return runCommand(this.make, makeArgs, this.nodeSrcDir); }
        if (isDarwin) {
          let buildArch = darwinArch[NodeJsBuilder.getArch(arch)];
          if (!buildArch) {
            log(`Unrecogized arch '${arch}' for darwin, but we'll try it anyway`);
            buildArch = arch;
          }
          configArgs.push(`--dest-cpu=${buildArch}`);
          // For some reason, configure.py does not set these when given the
          // --dest-cpu argument. Maybe we can patch it to do so?
          makeArgs.push(`CPPFLAGS=-arch ${buildArch}`, `LDFLAGS=-arch ${buildArch}`);
          return runCommand(this.configure, configArgs, this.nodeSrcDir)
            .then(() => runCommand(this.make, makeArgs, this.nodeSrcDir));
        }

        if (!container) {
          const cfgMakeEnv = { ...process.env };
          cfgMakeEnv.LDFLAGS = '-lrt'; // needed for node 12 to be compiled with this old compiler https://github.com/nodejs/node/issues/30077#issuecomment-574535342
          return runCommand(this.configure, configArgs, this.nodeSrcDir, cfgMakeEnv)
            .then(() => runCommand(this.make, makeArgs, this.nodeSrcDir, cfgMakeEnv));
        }
        if (arch !== 'linux/amd64') {
          return this.buildInContainerNonX64(arch, ptrCompression);
        }
        return this.buildInContainer(ptrCompression);
      })
      .then(() => this.uploadNodeBinary(undefined, uploadBuild, cache, arch, ptrCompression))
      .then(() => this.printDiskUsage())
      .then(() => this.createAndCacheHeaders())
      // .then(() => this.cleanupBuild().catch(err => log(err)))
      .then(() => {
        log(`RESULTS: ${this.resultFile}`);
        return this.resultFile;
      })
      .catch(err => this.printDiskUsage().then(() => { throw err; }));
  }

  buildFromCached(platform = 'linux', arch = 'x64', outFile = undefined, cache = false, size) {
    const mainAppFileCont = this.getAppContentToBundle();
    this.placeHolderSizeMB = Math.ceil(mainAppFileCont.length / 1024 / 1024); // 2, 4, 6, 8...
    if (this.placeHolderSizeMB % 2 !== 0) {
      this.placeHolderSizeMB += 1;
    }
    if (size) this.placeHolderSizeMB = parseInt( size.toUpperCase().replaceAll('MB', '') )

    return this.downloadCachedBuild(platform, arch)
      .then(cachedFile => {
        const placeholder = this.getPlaceholderContent(this.placeHolderSizeMB);

        outFile = resolve(outFile || `app-${platform}-${arch}-${this.version}`);
        const execFileCont = fs.readFileSync(cachedFile);
        if (!cache) {
          fs.unlinkSync(cachedFile);
        }

        const placeholderIdx = execFileCont.indexOf(placeholder);
        if (placeholderIdx < 0) {
          throw new Error(`Could not find placeholder in file=${cachedFile}`);
        }

        execFileCont.fill(0, placeholderIdx, placeholderIdx + placeholder.length);
        execFileCont.write(mainAppFileCont, placeholderIdx);
        log(`writing native binary ${outFile}`);
        return mkdirp(dirname(outFile))
          .then(() => fs.writeFileSync(outFile, execFileCont));
      });
  }
}

module.exports = {
  NodeJsBuilder
};