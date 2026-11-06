'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { NsisUpdater } = require('electron-updater');
const { ElectronHttpExecutor } = require('electron-updater/out/electronHttpExecutor');
const { Updates } = require('../desktop/updates.cjs');

const data = process.env.FRIEND_TEST_UPDATE_DATA;
const resources = process.env.FRIEND_TEST_UPDATE_RESOURCES;
const origin = process.env.FRIEND_TEST_UPDATE_ORIGIN;
if (!data || !resources || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin ?? '')) {
  throw new Error('Invalid test update fixture');
}
app.setPath('userData', data);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  await window.loadURL('about:blank');
  globalThis.downloadFixtureUpdate = async () => {
    const controller = new Updates({
      app: { isPackaged: true, getVersion: () => '0.4.5', getPath: () => data },
      resources, publish: () => {}, canRestart: () => false,
      createUpdater: () => {
        const updater = new NsisUpdater(undefined, {
          version: '0.4.5',
          name: 'friend-screen-test',
          isPackaged: true,
          appUpdateConfigPath: path.join(resources, 'app-update.yml'),
          userDataPath: data,
          baseCachePath: path.join(data, 'cache'),
          whenReady: () => app.whenReady(),
        });
        updater.httpExecutor = new ElectronHttpExecutor(() => {});
        updater.setFeedURL({ provider: 'generic', url: origin + '/' });
        updater.disableDifferentialDownload = true;
        return updater;
      },
    });
    await controller.load();
    await controller.action('configure', 'https://github.com/example/friend-screen-releases');
    const checked = await controller.action('check');
    const downloaded = await controller.action('download');
    return { checked, downloaded };
  };
});
