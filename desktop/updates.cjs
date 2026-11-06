'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { repository, validManifest, artifactHash } = require('./update-manifest.cjs');

function loadJson(file) {
  return fs.readFile(file, 'utf8').then(JSON.parse).catch(() => null);
}

class Updates {
  constructor({ app, resources, publish, canRestart, createUpdater }) {
    this.app = app;
    this.resources = resources;
    this.publish = publish;
    this.canRestart = canRestart;
    this.createUpdater = createUpdater ?? (url => {
      const { NsisUpdater } = require('electron-updater');
      return new NsisUpdater({ provider: 'generic', url });
    });
    this.settingsPath = path.join(app.getPath('userData'), 'update-feed.json');
    this.state = { phase: 'idle', current: app.getVersion(), repository: '', version: '', notes: '', progress: 0, error: '' };
  }

  async load() {
    const config = await loadJson(path.join(this.resources, 'friend-screen-update.json'));
    const settings = await loadJson(this.settingsPath);
    this.publicKey = config?.publicKey;
    for (const candidate of [settings?.repository, config?.repository]) {
      if (!candidate) continue;
      try { this.state.repository = repository(candidate); break; } catch {}
    }
    this.set({ phase: !this.app.isPackaged || !this.publicKey ? 'unavailable' :
      this.state.repository ? 'idle' : 'unconfigured' });
  }

  set(change) {
    Object.assign(this.state, change);
    this.publish({ ...this.state });
  }

  get busy() { return ['configuring', 'checking', 'downloading', 'installing'].includes(this.state.phase); }
  get installing() { return this.state.phase === 'installing'; }

  async action(action, value) {
    if (action === 'configure') await this.configure(value);
    else if (action === 'check') await this.check();
    else if (action === 'download') await this.download();
    else if (action === 'install') await this.install();
    else if (action !== 'state') throw new Error('无效的更新操作。');
    return { ...this.state };
  }

  async configure(value) {
    if (this.busy || this.state.phase === 'unavailable') return;
    let url;
    try { url = repository(value); }
    catch (error) { this.set({ error: error.message }); return; }
    const previous = this.state.phase;
    const temporary = this.settingsPath + '.new';
    this.set({ phase: 'configuring', error: '' });
    try {
      await fs.mkdir(path.dirname(this.settingsPath), { recursive: true });
      await fs.writeFile(temporary, JSON.stringify({ repository: url }), 'utf8');
      await fs.rename(temporary, this.settingsPath);
      this.set({ phase: 'idle', repository: url, version: '', notes: '', progress: 0 });
    } catch {
      await fs.rm(temporary, { force: true }).catch(() => {});
      this.set({ phase: previous, error: '无法保存更新仓库，请重试。' });
    }
  }

  async check() {
    if (this.busy || ['unavailable', 'unconfigured', 'ready'].includes(this.state.phase)) return;
    this.set({ phase: 'checking', error: '', version: '', notes: '', progress: 0 });
    try {
      const updater = this.createUpdater(this.state.repository + '/releases/latest/download/');
      updater.autoDownload = false;
      updater.autoInstallOnAppQuit = false;
      updater.autoRunAppAfterInstall = true;
      updater.allowPrerelease = false;
      updater.allowDowngrade = false;
      updater.disableWebInstaller = true;
      updater.logger = null;
      updater.on('error', () => {
        if (this.installing) this.set({ phase: 'ready', error: '无法启动更新安装，请重试。' });
      });
      updater.on('download-progress', progress => {
        if (this.state.phase === 'downloading' && Number.isFinite(progress.percent)) {
          this.set({ progress: Math.max(0, Math.min(100, Math.floor(progress.percent))) });
        }
      });
      const result = await updater.checkForUpdates();
      if (!validManifest(result?.updateInfo, this.publicKey)) {
        this.set({ phase: 'error', error: '更新清单未通过签名验证，请联系发布者。' });
        return;
      }
      if (!result.isUpdateAvailable) {
        this.set({ phase: 'current' });
        return;
      }
      this.updater = updater;
      this.manifest = result.updateInfo;
      this.set({ phase: 'available', version: this.manifest.version, notes: this.manifest.releaseNotes });
    } catch (error) {
      this.set({ phase: 'error', error: error.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' ?
        '仓库中还没有已发布的更新清单 latest.yml。' : '无法检查更新，请确认网络和发布仓库地址。' });
    }
  }

  async download() {
    if (this.state.phase !== 'available') return;
    this.set({ phase: 'downloading', progress: 0, error: '' });
    try {
      const [file] = await this.updater.downloadUpdate();
      if (await artifactHash(file) !== this.manifest.sha512) throw new Error('Invalid update hash');
      this.downloadedFile = file;
      this.set({ phase: 'ready', progress: 100 });
    } catch {
      this.set({ phase: 'available', progress: 0, error: '下载失败或文件校验未通过，请重新下载。' });
    }
  }

  async install() {
    if (this.state.phase !== 'ready') return;
    if (!this.canRestart()) {
      this.set({ error: '请先停止屏幕共享，再重启并更新。' });
      return;
    }
    this.set({ phase: 'installing', error: '' });
    try {
      if (await artifactHash(this.downloadedFile) !== this.manifest.sha512) throw new Error('Invalid update hash');
      this.updater.quitAndInstall(false, true);
    } catch {
      this.set({ phase: 'available', progress: 0, error: '更新文件已变化，请重新下载。' });
    }
  }
}

module.exports = { Updates };
