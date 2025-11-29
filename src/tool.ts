import { ExtensionContext, workspace } from 'coc.nvim';

import fs from 'fs';
import path from 'path';
import which from 'which';
import { EXTENSION_NS } from './constant';
import { spawn } from 'child_process';

// 缓存：绝对路径 → 检测 Promise
const pythonTypeCache = new Map<string, Promise<boolean>>();
/**
 * 检测指定 python 可执行文件是否为 MSYS2/MinGW 版本
 * @param {string} pythonExe - Python 可执行文件路径(可以是相对路径)
 * @returns {Promise<boolean>} - true表示是MSYS2/cygwin Python
 */
export function isMsys2Python(pythonExe: string): Promise<boolean> {
  // 标准化为绝对路径作为缓存键
  const absPath = path.resolve(pythonExe);

  // 若已存在检测任务，直接返回其Promise（自动去重并发）
  if (pythonTypeCache.has(absPath)) {
    return pythonTypeCache.get(absPath)!;
  }
  const detectionScript = `
import sysconfig, sys;
platform = sysconfig.get_platform();
is_cygwin = platform.startswith('cygwin');
print('MSYS2' if is_cygwin else 'NATIVE')
`;
  const detectPromise = new Promise<boolean>((resolve, reject) => {
    // 查询 sysconfig.get_platform()

    const child = spawn(absPath, ['-c', detectionScript], {
      windowsHide: true,
      timeout: 5000, // 5秒超时
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '',
      stderr = '';
    child.stdout.on('data', (data: Buffer) => (output += data.toString()));
    child.stderr.on('data', (data: Buffer) => (stderr += data.toString()));

    child.on('error', (err: Error) => {
      pythonTypeCache.delete(absPath);
      reject(new Error(`Failed to spawn Python at ${absPath}: ${err.message}`));
    });
    child.on('close', (code: number | null, signal: string | null) => {
      if (code !== 0 || signal !== null) {
        reject(
          new Error(`Python at ${absPath} exited with code ${code} or signal ${signal}. Stderr: "${stderr.trim()}"`),
        );
        return;
      }
      const result = output.trim();
      resolve(result === 'MSYS2');
    });
  });

  // 缓存 Promise（即使 pending 状态也缓存，实现并发去重）
  pythonTypeCache.set(absPath, detectPromise);

  return detectPromise;
}

/**
 * 将路径转换为 MSYS2 风格路径。
 * 支持输入：
 * - Windows 绝对路径（盘符开头）：'D:\\a\\b.py' → '/d/a/b.py'
 * - MSYS2 路径：'/d/a/b.py' → '/d/a/b.py'（透传）
 *
 * @param inputPath - 输入路径（可为 Windows 或 MSYS2 风格）
 * @returns 标准化的 MSYS2 路径（以 /drive/... 形式）
 * @throws Error - 如果无法识别为有效本地路径
 */
export function toMsys2Path(inputPath: string): string {
  // 先统一斜杠
  let normalized = inputPath.replace(/\\/g, '/');

  // 情况 1: 已是 MSYS2 路径（如 /c/..., /d/...）
  const msysMatch = normalized.match(/^\/([a-zA-Z])\/(.*)$/);
  if (msysMatch) {
    const drive = msysMatch[1].toLowerCase();
    const rest = msysMatch[2];
    // 确保不包含多余 //，并标准化
    return `/${drive}/${rest.replace(/^\/+/, '')}`;
  }

  // 情况 2: Windows 盘符路径（如 C:\... 或 D:/...）
  const winMatch = normalized.match(/^([a-zA-Z]):\/(.*)$/);
  if (winMatch) {
    const drive = winMatch[1].toLowerCase();
    const rest = winMatch[2];
    return `/${drive}/${rest}`;
  }

  // 情况 3: 相对路径？尝试转为绝对 Windows 路径再试
  try {
    const absWin = path.resolve(inputPath).replace(/\\/g, '/');
    const retryMatch = absWin.match(/^([a-zA-Z]):\/(.*)$/);
    if (retryMatch) {
      const drive = retryMatch[1].toLowerCase();
      const rest = retryMatch[2];
      return `/${drive}/${rest}`;
    }
  } catch {
    // ignore
  }

  // 无法识别
  throw new Error(
    `Cannot convert to MSYS2 path: "${inputPath}". Expected Windows absolute path (e.g., "C:\\a\\b") or MSYS2 path (e.g., "/c/a/b").`,
  );
}

/**
 * 根据 Python 类型返回合适的脚本路径
 * @param pythonExe - Python 可执行文件路径
 * @param scriptPath - 脚本原始路径（Windows 风格）
 * @returns Promise<string> - 最终应传递给 Python 的脚本路径
 */
export async function getScriptPathForPython(pythonExe: string, scriptPath: string): Promise<string> {
  const isMsys = await isMsys2Python(pythonExe);
  return isMsys ? toMsys2Path(scriptPath) : path.resolve(scriptPath);
}

// 获取配置或系统中的 Python 路径
export function getPythonPath(): string {
  let pythonPath = workspace.getConfiguration(EXTENSION_NS).get<string>('builtin.pythonPath', '');
  if (pythonPath) return fs.realpathSync(pythonPath);

  pythonPath = which.sync('python3', { nothrow: true }) || which.sync('python', { nothrow: true }) || '';
  return pythonPath ? fs.realpathSync(pythonPath) : '';
}

// 构建虚拟环境中的可执行文件路径（自动适配平台）
function getVenvExecutable(context: ExtensionContext, executableName: string): string  {
  if (workspace.getConfiguration(EXTENSION_NS).get<string>('useGlobalCommand')) {
    const globPath =
      which.sync(executableName, { nothrow: true }) || which.sync(`${executableName}.exe`, { nothrow: true }) || '';
    return globPath ? fs.realpathSync(globPath) : '';
  } else {
    const venvBase = path.join(context.storagePath, 'vscode-black-formatter', 'venv');
    const binDir =
      process.platform === 'win32' && !process?.report?.getReport?.()?.header?.osName.startsWith('MINGW')
        ? 'Scripts'
        : 'bin';
    const ext = process.platform === 'win32' ? '.exe' : '';

    const fullPath = path.join(venvBase, binDir, `${executableName}${ext}`);
    return fs.existsSync(fullPath) ? fullPath : executableName;
  }
}

// 构建捆绑资源中的文件路径
function getBundledFilePath(context: ExtensionContext, ...segments: string[]): string | undefined {
  const useGlob = workspace.getConfiguration(EXTENSION_NS).get<string>('useGlobalCommand');
  const useBuiltInServer = workspace.getConfiguration(EXTENSION_NS).get<string>('importStrategy');
  if (useBuiltInServer === 'useBundled') {
    return path.join(context.asAbsolutePath('./server'), ...segments);
  }

  const fullPath = path.join(
    context.storagePath,
    `vscode-black-formatter${useGlob ? '.only_lsp' : ''}`,
    'bundled',
    'tool',
    ...segments,
  );
  return fs.existsSync(fullPath) ? fullPath : undefined;
}

// 导出的公共接口
export function getBlackLspBlackPath(context: ExtensionContext): string | undefined {
  return getVenvExecutable(context, 'black');
}

export function getBlackLspServerInterpreterPath(context: ExtensionContext): string {
  return getVenvExecutable(context, 'python');
}

export function getBlackLspServerScriptPath(context: ExtensionContext): string | undefined {
  return getBundledFilePath(context, 'lsp_server.py');
}
