import { ExtensionContext, workspace } from 'coc.nvim';

import fs from 'fs';
import path from 'path';
import which from 'which';
import { EXTENSION_NS } from './constant';

// 获取配置或系统中的 Python 路径
export function getPythonPath(): string {
  let pythonPath = workspace.getConfiguration(EXTENSION_NS).get<string>('builtin.pythonPath', '');
  if (pythonPath) return fs.realpathSync(pythonPath);

  pythonPath = which.sync('python3', { nothrow: true }) || which.sync('python', { nothrow: true }) || '';
  return pythonPath ? fs.realpathSync(pythonPath) : '';
}

// 构建虚拟环境中的可执行文件路径（自动适配平台）
function getVenvExecutable(context: ExtensionContext, executableName: string): string | undefined {
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
    return fs.existsSync(fullPath) ? fullPath : undefined;
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

export function getBlackLspServerInterpreterPath(context: ExtensionContext): string | undefined {
  return getVenvExecutable(context, 'python');
}

export function getBlackLspServerScriptPath(context: ExtensionContext): string | undefined {
  return getBundledFilePath(context, 'lsp_server.py');
}
