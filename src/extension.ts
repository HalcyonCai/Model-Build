import * as vscode from 'vscode';
import { ModelCreator } from './modelCreator';
import { FanCreator } from './fanCreator';

export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "model-creator" is now active!');

    let modelCreatorDisposable = vscode.commands.registerCommand('model-creator.createNewModel', async (uri?: vscode.Uri) => {
        const modelCreator = new ModelCreator();
        await modelCreator.createNewModel(uri);
    });

    let fanCreatorDisposable = vscode.commands.registerCommand('fan-creator.createNewFan', async (uri?: vscode.Uri) => {
        const fanCreator = new FanCreator();
        await fanCreator.createNewFan(uri);
    });

    context.subscriptions.push(modelCreatorDisposable, fanCreatorDisposable);
}

export function deactivate() {}
