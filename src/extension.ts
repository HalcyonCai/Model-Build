import * as vscode from 'vscode';
import { ModelCreator } from './modelCreator';

export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "model-creator" is now active!');

    let disposable = vscode.commands.registerCommand('model-creator.createNewModel', async (uri?: vscode.Uri) => {
        // Create a new instance of ModelCreator for each command execution.
        const modelCreator = new ModelCreator();
        await modelCreator.createNewModel(uri);
    });

    context.subscriptions.push(disposable);
}

export function deactivate() {}
