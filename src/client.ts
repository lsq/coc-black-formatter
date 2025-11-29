import { ExtensionContext, LanguageClient, LanguageClientOptions, ServerOptions, workspace, Uri } from 'coc.nvim';

import which from 'which';

import { EXTENSION_NS } from './constant';
import { getBlackLspBlackPath, getBlackLspServerInterpreterPath, getBlackLspServerScriptPath, getScriptPathForPython } from './tool';

export async function createLanguageClient(context: ExtensionContext) {
  const devServerInterpreter = workspace.expand(
    workspace.getConfiguration(EXTENSION_NS).get<string>('dev.serverInterpreter', ''),
  );
  const devServerScript = workspace.expand(
    workspace.getConfiguration(EXTENSION_NS).get<string>('dev.serverScript', ''),
  );

  const serverInterpreter = devServerInterpreter ? devServerInterpreter : getBlackLspServerInterpreterPath(context);
  const serverScript = devServerScript ? devServerScript : getBlackLspServerScriptPath(context);
  if (!serverInterpreter || !serverScript) return;
  const finalServerScript = await getScriptPathForPython(serverInterpreter, serverScript)

  const serverOptions: ServerOptions = {
    command: serverInterpreter,
    args: [finalServerScript],
  };

  const initializationOptions = await getInitializationOptions(context);

  const clientOptions: LanguageClientOptions = {
    synchronize: {
      configurationSection: [EXTENSION_NS],
    },
    documentSelector: ['python'],
    initializationOptions,
  };

  const client = new LanguageClient(EXTENSION_NS, 'black-formatter-lsp', serverOptions, clientOptions);
  return client;
}

type ImportStrategy = 'fromEnvironment' | 'useBundled';
type ShowNotifications = 'off' | 'onError' | 'onWarning' | 'always';

type ExtensionInitializationOptions = {
  globalSettings: {
    cwd: string;
    workspace: string;
    args: string[];
    path: string[];
    importStrategy: ImportStrategy;
    interpreter: string[];
    showNotifications: ShowNotifications;
  };
};

function convertFromWorkspaceConfigToInitializationOptions() {
  const settings = workspace.getConfiguration(EXTENSION_NS);

  const initializationOptions = <ExtensionInitializationOptions>{
    globalSettings: {
      cwd: workspace.root,
      workspace: Uri.parse(workspace.root).toString(),
      args: settings.get('args'),
      path: settings.get('path'),
      importStrategy: settings.get<ImportStrategy>(`importStrategy`) ?? 'fromEnvironment',
      interpreter: settings.get('interpreter'),
      showNotifications: settings.get<ShowNotifications>('showNotifications'),
    },
    settings: {},
  };

  return initializationOptions;
}

async function getInitializationOptions(context: ExtensionContext) {
  const initializationOptions = convertFromWorkspaceConfigToInitializationOptions();

  if (workspace.getConfiguration(EXTENSION_NS).get<boolean>('useDetectBlackCommand')) {
    if (initializationOptions.globalSettings.path.length === 0) {
      const envToolCommandPath = await getScriptPathForPython(getBlackLspServerInterpreterPath(context), getBlackLspBlackPath(context)!);
      initializationOptions.globalSettings.path = [envToolCommandPath];
    }
  }

  return initializationOptions;
}
