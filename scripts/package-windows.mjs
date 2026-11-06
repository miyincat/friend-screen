import { packager } from '@electron/packager';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const outputs = await packager({
  dir: root, out: path.join(root, 'dist', pkg.version), name: 'FriendScreen',
  executableName: 'FriendScreen', platform: 'win32', arch: 'x64',
  electronVersion: pkg.devDependencies.electron, appVersion: pkg.version,
  ...(process.env.ELECTRON_ZIP_DIR ? { electronZipDir: process.env.ELECTRON_ZIP_DIR } : {}),
  buildVersion: pkg.version + '.0', asar: true, prune: true, overwrite: false,
  icon: path.join(root, 'desktop', 'icon.ico'),
  ignore: [/^\/(test|docs|artifacts|dist|scripts|data|\.git)(\/|$)/, /^\/\.env($|\.)/, /^\/start-local\.cmd$/],
  win32metadata: { CompanyName: 'Independent Project', ProductName: '同屏小屋', FileDescription: '同屏小屋 · 好友屏幕共享', OriginalFilename: 'FriendScreen.exe' },
});
for (const output of outputs) {
  await copyFile(path.join(root, 'docs', 'desktop.md'), path.join(output, '使用说明.txt'));
  await writeFile(path.join(output, '版本说明.txt'), `同屏小屋 ${pkg.version}\r\nWindows x64 本地测试版。未作商业代码签名。\r\n完整目录需一起保留，不可只复制 EXE。\r\n未包含 Oopz 代码或组件，也不连接 Oopz 服务。\r\nElectron ${pkg.devDependencies.electron}；第三方许可保留在发行目录和应用依赖中。\r\n`);
  console.log(output);
}
