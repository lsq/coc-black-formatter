import { commands, ExtensionContext, LanguageClient, ServiceStat, window, workspace } from 'coc.nvim';

import child_process from 'child_process';
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import extract from 'extract-zip';
import fs from 'fs';
import { HttpsProxyAgent } from 'https-proxy-agent';
import fetch from 'node-fetch';
import path from 'path';
import { rimraf } from 'rimraf';
import stream from 'stream';
import util from 'util';
import dgit from '@dking/dgit';

import { EXTENSION_NS, UPSTREAM_NAME, VSCODE_BLACK_FORMATTER_VERSION } from '../constant';
import { getPythonPath } from '../tool';

const pipeline = util.promisify(stream.pipeline);
const agent = process.env.https_proxy ? new HttpsProxyAgent(process.env.https_proxy as string) : null;
const exec = util.promisify(child_process.exec);

export function register(context: ExtensionContext, client?: LanguageClient) {
  context.subscriptions.push(
    commands.registerCommand(`${EXTENSION_NS}.installServer`, handleInstallServer(context, client)),
  );
}

function handleInstallServer(context: ExtensionContext, client?: LanguageClient) {
  return async () => {
    const msg = `Install/Upgrade ${UPSTREAM_NAME}'s language server?`;
    const useGlobal = workspace.getConfiguration(EXTENSION_NS).get<boolean>('useGlobalCommand', false);

    const ret = await window.showPrompt(msg);
    if (ret) {
      if (client) {
        if (client.serviceState !== ServiceStat.Stopped) {
          await client.stop();
        }
      }

      const pythonCommand = getPythonPath();
      if (useGlobal) {
        await doDownloadServerScript(context).catch((er: any) => {
          throw er;
        });
      } else {
        await doDownload(context).catch(() => {});
        await doExtract(context).catch(() => {});
      }
      await doInstall(pythonCommand, context).catch(() => {});

      commands.executeCommand('editor.action.restart');
    } else {
      //
    }
  };
}

async function doDownloadServerScript(context: ExtensionContext): Promise<void> {
  const targetPath = path.join(context.storagePath, `${UPSTREAM_NAME}`, 'bundled');
  const repoOption = {
    owner: 'lsq', // git 仓库作者名
    repoName: UPSTREAM_NAME, // git 仓库名称
    ref: 'main', // git 仓库指定 branch，commit 或 tag，
    relativePath: 'bundled', // 指定git所需要下载的目录或者文件相对位置
  };
  // const destPath = path.resolve(__dirname, './aaa'); // 目标下载路径
  const destPath = targetPath; // 目标下载路径

  const dgitOptions = {
    maxRetryCount: 3, // 网络问题下载失败时尝试最大重新下载次数
    parallelLimit: 10, // 并行下载个数
    log: false, // 是否开启内部日志
    logSuffix: '', // 日志前缀
    exclude: [], // 需要排除的文件路径,
    include: [], // 需要包含的文件路径
  };

  const hooks = {
    onSuccess: () => void 0,
    onError: (err: any) => err,
    onProgress: (status, node) => void 0,
    onResolved: (status) => void 0,
  };
  await dgit(repoOption, destPath, dgitOptions, hooks);
}

async function doDownload(context: ExtensionContext): Promise<void> {
  const statusItem = window.createStatusBarItem(0, { progress: true });
  statusItem.text = `Downloading ${UPSTREAM_NAME}`;
  statusItem.show();

  const downloadUrl = `https://github.com/microsoft/vscode-black-formatter/archive/refs/tags/${VSCODE_BLACK_FORMATTER_VERSION}.zip`;

  // @ts-ignore
  const resp = await fetch(downloadUrl, { agent });
  if (!resp.ok) {
    statusItem.hide();
    throw new Error('Download failed');
  }

  let cur = 0;
  const len = Number(resp.headers.get('content-length'));
  resp.body.on('data', (chunk: Buffer) => {
    cur += chunk.length;
    const p = ((cur / len) * 100).toFixed(2);
    statusItem.text = `${p}% Downloading ${UPSTREAM_NAME}`;
  });

  const _path = path.join(context.storagePath, `${UPSTREAM_NAME}.zip`);
  const randomHex = randomBytes(5).toString('hex');
  const tempFile = path.join(context.storagePath, `${UPSTREAM_NAME}-${randomHex}.zip`);

  const destFileStream = fs.createWriteStream(tempFile, { mode: 0o755 });
  await pipeline(resp.body, destFileStream);
  await new Promise<void>((resolve) => {
    destFileStream.on('close', resolve);
    destFileStream.destroy();
    setTimeout(resolve, 1000);
  });

  await fs.promises.unlink(_path).catch((err) => {
    if (err.code !== 'ENOENT') throw err;
  });
  await fs.promises.rename(tempFile, _path);

  statusItem.hide();
}

async function doExtract(context: ExtensionContext) {
  const zipPath = path.join(context.storagePath, `${UPSTREAM_NAME}.zip`);
  const extractPath = path.join(context.storagePath);
  const extractedFilenames: string[] = [];
  const targetPath = path.join(context.storagePath, `${UPSTREAM_NAME}`);

  rimraf.sync(targetPath);

  if (fs.existsSync(zipPath)) {
    await extract(zipPath, {
      dir: extractPath,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      onEntry(entry, _zipfile) {
        extractedFilenames.push(entry.fileName);
      },
    });

    const extractedBaseDirName = extractedFilenames[0];
    const extractedBasePath = path.join(context.storagePath, extractedBaseDirName);

    // Add text file for tag version identification
    const versionTxtFilePath = path.join(extractedBasePath, 'version.txt');
    fs.writeFileSync(versionTxtFilePath, `tag: ${VSCODE_BLACK_FORMATTER_VERSION}`);

    fs.renameSync(extractedBasePath, targetPath);
    rimraf.sync(zipPath);
  }
}
// 工具函数：获取虚拟环境中的 python 可执行文件路径（带平台适配）
function getVenvPythonPath(storagePath: string, venvName: string): string {
  const venvRoot = path.join(storagePath, venvName, 'venv');
  const binDir =
    process.platform === 'win32' && !process?.report?.getReport?.()?.header?.osName?.startsWith('MINGW')
      ? 'Scripts'
      : 'bin';
  const ext = process.platform === 'win32' ? '.exe' : '';
  return path.join(venvRoot, binDir, `python${ext}`);
  // return fs.existsSync(fullPath) ? fullPath : '';
}

function spawnAsync(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });
    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (err) => {
      reject(err);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const error = new Error(
          `Command failed with exit code ${code}.\nArgs: ${JSON.stringify(args)}\nStderr: ${stderr}`,
        );
        (error as any).code = code;
        (error as any).stdout = stdout;
        (error as any).stderr = stderr;
        reject(error);
      }
    });
  });
}

async function doInstall(pythonCommand: string, context: ExtensionContext): Promise<void> {
  const useGlobal = workspace.getConfiguration(EXTENSION_NS).get<boolean>('useGlobalCommand', false);

  if (useGlobal) {
    window.showInformationMessage('Using global black command; skipping installation.');
    return;
  }

  const venvName = UPSTREAM_NAME; // 假设 UPSTREAM_NAME 已定义，如 'vscode-black-formatter'
  const requirementsTxtPath = path.join(context.storagePath, venvName, 'requirements.txt');
  const venvRoot = path.join(context.storagePath, venvName, 'venv');
  const venvPython = getVenvPythonPath(context.storagePath, venvName);

  // 确保 requirements.txt 存在
  if (!fs.existsSync(requirementsTxtPath)) {
    window.showErrorMessage(`requirements.txt not found at ${requirementsTxtPath}`);
    throw new Error('Missing requirements.txt');
  }

  // 清理旧虚拟环境
  rimraf.sync(venvRoot);

  const statusItem = window.createStatusBarItem(0, { progress: true });
  statusItem.text = 'Installing black-formatter language server...';
  statusItem.show();

  try {
    window.showInformationMessage('Installing black-formatter language server...');

    // 分两步执行更可靠（避免 && 在某些 shell 中的问题，尤其是 Windows）
    window.showInformationMessage('Creating virtual environment...');
    await spawnAsync(pythonCommand, ['-m', 'venv', venvRoot]);

    window.showInformationMessage('Installing dependencies...');
    await spawnAsync(venvPython, ['-m', 'pip', 'install', '-r', requirementsTxtPath]);

    statusItem.hide();
    window.showInformationMessage('Installation of black-formatter language server is complete!');
  } catch (error: any) {
    statusItem.hide();
    const message = error?.message || String(error);
    window.showErrorMessage(`Installation failed: ${message}`);
    console.error('Installation error:', error); // 可选：记录详细日志到控制台
    throw error; // 保留原始错误，便于上层处理
  }
}
