import * as vscode from 'vscode';
import { ModelCreator } from './modelCreator';
import { FanCreator } from './fanCreator';

// 全局服务实例
let modelCreatorService: ModelCreator | undefined;

export function activate(context: vscode.ExtensionContext) {
    // 在插件激活时，只创建一次服务实例
    const outputChannel = vscode.window.createOutputChannel("Model Creator");
    modelCreatorService = new ModelCreator(outputChannel);
    
    outputChannel.appendLine('[信息] Model Creator 插件已成功激活。');

    let modelCreatorDisposable = vscode.commands.registerCommand('model-creator.createNewModel', async (uri?: vscode.Uri) => {
        if (modelCreatorService) {
            await modelCreatorService.createNewModel(uri);
        } else {
            vscode.window.showErrorMessage('Model Creator 服务尚未初始化!');
        }
    });

    let fanCreatorDisposable = vscode.commands.registerCommand('fan-creator.createNewFan', async (uri?: vscode.Uri) => {
        // FanCreator 也可以考虑使用类似的服务模式，但暂时保持原样以集中解决问题
        const fanCreator = new FanCreator();
        await fanCreator.createNewFan(uri);
    });

    context.subscriptions.push(modelCreatorDisposable, fanCreatorDisposable);
}

export function deactivate() {
    if (modelCreatorService) {
        modelCreatorService.dispose();
        modelCreatorService = undefined;
    }
}
