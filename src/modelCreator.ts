import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import * as util from 'util';

const execPromise = util.promisify(exec);

interface ModelInfo {
    name: string;
    configBlock: string;
    startLine: number;
    endLine: number;
}

interface CppConfiguration {
    name: string;
    defines: string[];
}

export class ModelCreator {
    private outputChannel: vscode.OutputChannel;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel("Model Creator");
    }

    async createNewModel(uri?: vscode.Uri): Promise<void> {
        try {
            const document = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
            if (!document) throw new Error('无法获取当前文档。请打开一个文件。');
            if (!this.isConfigFile(document.fileName)) throw new Error('当前文件不是一个有效的Config_*.h文件。');

            const existingModels = this.parseExistingModels(document.getText());
            if (existingModels.length === 0) throw new Error('在文件中未找到可识别的机型配置块。');
            
            const commonPrefix = this.getCommonModelPrefix(existingModels);
            if (!commonPrefix) throw new Error('无法从文件中已定义的机型中确定通用前缀 (例如 PGEL)。');

            const selectedTarget = await this.selectTargetConfiguration(document.uri, existingModels, commonPrefix);
            if (!selectedTarget) { return; }

            const referenceModel = await this.selectReferenceModel(existingModels);
            if (!referenceModel) { return; }

            const newModelName = await this.inputNewModelName(selectedTarget);
            if (!newModelName) { return; }

            const softwareVersion = await this.inputSoftwareVersion();
            const eePromVersion = await this.inputEePromVersion();
            const customCodeName = await this.inputCustomCodeName();

            const newEepromMacro = this.generateEepromMacro(newModelName, eePromVersion);

            await this.createModelConfiguration(document, referenceModel, newModelName, newEepromMacro, softwareVersion, customCodeName);
            await this.updateGenCodeBat(document.uri, newEepromMacro);
            await this.updateSystemParaC(document.uri, newEepromMacro, commonPrefix);
            await this.updateCustomH(document.uri, referenceModel.name, newModelName);
            await this.handleBinFileAndExecuteGenCode(document.uri, newEepromMacro);

            await vscode.workspace.saveAll();
            vscode.window.showInformationMessage('所有被修改过的文件都已自动保存。');

        } catch (error: any) {
            vscode.window.showErrorMessage(`创建机型失败: ${error.message}`);
            this.outputChannel.appendLine(`[错误] ${error.stack}`);
        }
    }

    private isConfigFile(filePath: string): boolean {
        return path.basename(filePath).startsWith('Config_') && filePath.endsWith('.h');
    }
    
    private getCommonModelPrefix(models: ModelInfo[]): string | null {
        if (models.length === 0) return null;
        const firstName = models[0].name;
        const parts = firstName.split('_');
        return parts.length > 1 ? parts[0] : firstName;
    }

    private parseExistingModels(content: string): ModelInfo[] {
        const lines = content.split(/\r?\n/);
        const models: ModelInfo[] = [];
        const directiveRegex = /^#\s*(if|elif)\s+([A-Z0-9_]+)/;
        for (let i = 0; i < lines.length; i++) {
            const match = lines[i].trim().match(directiveRegex);
            if (match) {
                const modelName = match[2];
                const startLine = i;
                let endLine = i;
                let endLineFound = false;

                for (let j = i + 1; j < lines.length; j++) {
                    const nextLine = lines[j].trim();
                    if (['#if', '#elif', '#else', '#endif'].some(d => nextLine.startsWith(d))) {
                        let actualEndLine = j - 1;
                        while(actualEndLine > startLine && lines[actualEndLine].trim() === '') {
                            actualEndLine--;
                        }
                        endLine = actualEndLine;
                        endLineFound = true;
                        break;
                    }
                }

                if (!endLineFound) { 
                    let actualEndLine = lines.length - 1;
                     while(actualEndLine > startLine && lines[actualEndLine].trim() === '') {
                        actualEndLine--;
                    }
                    endLine = actualEndLine;
                }

                const configBlock = lines.slice(startLine, endLine + 1).join('\n');
                models.push({ name: modelName, configBlock, startLine, endLine });
                i = endLine; 
            }
        }
        return models;
    }
    
    private async selectTargetConfiguration(fileUri: vscode.Uri, existingModels: ModelInfo[], commonPrefix: string): Promise<CppConfiguration | undefined> {
        const allConfigurations = this.getCppConfigurations(fileUri);
        if (!allConfigurations) throw new Error('在 .vscode/c_cpp_properties.json 中找不到任何配置。');
        
        const existingModelNames = new Set(existingModels.map(m => m.name));
        const filteredConfigurations = allConfigurations.filter(config => {
            const modelName = this.extractModelNameFromDefines(config.defines);
            return modelName && !existingModelNames.has(modelName) && modelName.startsWith(commonPrefix);
        });

        if (filteredConfigurations.length === 0) throw new Error(`没有找到与前缀 '${commonPrefix}' 匹配的、且尚未在当前文件中定义的 C/C++ Target。`);
        
        const items = filteredConfigurations.map(config => ({ label: config.name, config }));
        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: `请选择一个 '${commonPrefix}' 相关的 C/C++ Target`,
            ignoreFocusOut: true,
        });
        return selected?.config;
    }

    private getCppConfigurations(fileUri: vscode.Uri): CppConfiguration[] | null {
        try {
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
            if (!workspaceFolder) return null;
            const configPath = path.join(workspaceFolder.uri.fsPath, '.vscode', 'c_cpp_properties.json');
            if (fs.existsSync(configPath)) {
                const configContent = fs.readFileSync(configPath, 'utf8');
                const jsonContent = configContent.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
                const configJson = JSON.parse(jsonContent);
                return configJson.configurations;
            }
        } catch (error: any) {
            this.outputChannel.appendLine(`[致命错误] 读取 C/C++ 配置时发生错误: ${error.message}\n${error.stack}`);
        }
        return null;
    }

    private async selectReferenceModel(models: ModelInfo[]): Promise<ModelInfo | undefined> {
        const items = models.map(model => ({ label: model.name, model }));
        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: '请选择一个参考机型',
            ignoreFocusOut: true
        });
        return selected?.model;
    }

    private async inputNewModelName(target: CppConfiguration): Promise<string | undefined> {
        const defaultModelName = this.extractModelNameFromDefines(target.defines);
        return await vscode.window.showInputBox({
            prompt: '请输入新机型的名称',
            value: defaultModelName || '',
            validateInput: (value) => {
                if (!value?.trim()) { return '机型名称不能为空。'; }
                if (!/^[A-Z_][A-Z0-9_]*$/.test(value)) {
                    return '机型名称只能包含大写字母、数字和下划线，且必须以字母或下划线开头。';
                }
                return null;
            },
            ignoreFocusOut: true
        });
    }

    private async inputSoftwareVersion(): Promise<string | undefined> {
        return await vscode.window.showInputBox({
            prompt: '请输入软件版本号 (例如: 0x19035B01)，可留空',
            validateInput: (value) => {
                if (value && !/^0x[0-9a-fA-F]{8}$/.test(value)) {
                    return '请输入有效的16进制版本号，例如: 0x19035B01';
                }
                return null;
            },
            ignoreFocusOut: true
        });
    }

    private async inputEePromVersion(): Promise<string | undefined> {
        return await vscode.window.showInputBox({
            prompt: '请输入EEPROM版本号 (例如: 195B)，可留空',
            validateInput: (value) => {
                if (value && !/^[0-9a-zA-Z]+$/.test(value)) { return '版本号只能包含字母和数字'; }
                return null;
            },
            ignoreFocusOut: true
        });
    }

    private async inputCustomCodeName(): Promise<string | undefined> {
        return await vscode.window.showInputBox({
            prompt: '请输入客户料号 (例如: INV12K3OC...)，可留空',
            validateInput: (value) => {
                if (value && value.length > 30) { return '客户料号名称最长为30字节'; }
                return null;
            },
            ignoreFocusOut: true
        });
    }

    private extractModelNameFromDefines(defines: string[]): string | null {
        if (!defines) return null;
        const modelRegex = /([A-Z0-9_]*KFW[A-Z0-9_]*)/;
        for (const define of defines) {
            const defineStr = define.split('=')[0].trim();
            if (modelRegex.test(defineStr)) return defineStr;
        }
        return null;
    }
    
    private generateEepromMacro(newModelName: string, eePromVersion?: string): string {
        let baseName = newModelName;
        const match = newModelName.match(/^([A-Z]+)_KFW(.+)$/);
        if (match) {
            const prefix = match[1], rest = match[2];
            const restMatch = rest.match(/^([^_]+(?:_[^_]+)?)_(.+)$/);
            if (restMatch) {
                baseName = `${restMatch[1]}_${prefix}_${restMatch[2]}`;
            } else {
                 baseName = newModelName.replace(/^([A-Z]+)_/, '');
            }
        } else {
            baseName = newModelName.replace(/^([A-Z]+)_/, '');
        }
        return `EEPROMDATA_${baseName}${eePromVersion ? `_${eePromVersion}` : ''}`;
    }

    private transformMacroToFilename(macro: string): string {
        const baseName = macro.replace(/^EEPROMDATA_/, '');
        const parts = baseName.split('_');
        const newParts = parts.map(part => {
            if (/^[A-Z]+$/.test(part)) {
                return part.toLowerCase();
            }
            return part;
        });
        return `eepromdata_${newParts.join('_')}`;
    }

    private async createModelConfiguration(document: vscode.TextDocument, referenceModel: ModelInfo, newModelName: string, newEepromMacro: string, softwareVersion?: string, customCodeName?: string): Promise<void> {
        let lines = referenceModel.configBlock.split('\n');
        
        lines[0] = lines[0].replace(referenceModel.name, newModelName).replace(/^#\s*if/, '#elif');
        
        const macroProcessors = [
            { key: 'SOFTWARE_VERSION', value: softwareVersion, regex: /#define\s+SOFTWARE_VERSION/, createLine: (val: string) => `#define SOFTWARE_VERSION                (uint32_t)${val}        // 软件版本号` },
            { key: 'CUSTOM_CODE_NAME', value: customCodeName, regex: /#define\s+CUSTOM_CODE_NAME/, createLine: (val: string) => `#define CUSTOM_CODE_NAME                "${val}"       // 客户料号名称 最长30字节` },
            { key: 'EEPROMDATA', value: newEepromMacro, regex: /#define\s+EEPROMDATA_/, createLine: null }
        ];

        for (const processor of macroProcessors) {
            const lineIndex = lines.findIndex(line => processor.regex.test(line));
            
            if (lineIndex > -1) {
                if (processor.value) {
                    const originalLine = lines[lineIndex];
                     if (processor.key === 'SOFTWARE_VERSION') {
                        lines[lineIndex] = originalLine.replace(/0x[0-9a-fA-F]{8}/, softwareVersion!);
                     } else if (processor.key === 'CUSTOM_CODE_NAME') {
                        lines[lineIndex] = originalLine.replace(/"[^"]*"/, `"${customCodeName!}"`);
                     } else if (processor.key === 'EEPROMDATA') {
                        lines[lineIndex] = originalLine.replace(/EEPROMDATA_[^\s]+/, newEepromMacro);
                     }
                } else {
                     if(processor.key !== 'EEPROMDATA') {
                        lines.splice(lineIndex, 1);
                     }
                }
            } else {
                if (processor.value && processor.createLine) {
                    lines.push(processor.createLine(processor.value));
                }
            }
        }
        
        const newModelBlock = lines.join('\n');
        
        const models = this.parseExistingModels(document.getText());
        const lastModel = models[models.length - 1];
        if (!lastModel) throw new Error("无法确定最后一个机型的位置。");

        const lastModelEndLine = document.lineAt(lastModel.endLine);

        const edit = new vscode.WorkspaceEdit();
        const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
        const contentToInsert = `${eol}${eol}${newModelBlock}`;
        
        edit.insert(document.uri, lastModelEndLine.range.end, contentToInsert);

        if (await vscode.workspace.applyEdit(edit)) {
            vscode.window.showInformationMessage(`新机型 ${newModelName} 已成功创建！`);
        } else {
            throw new Error(`写入 ${path.basename(document.fileName)} 失败。`);
        }
    }

    private async updateGenCodeBat(configFileUri: vscode.Uri, newEepromMacro: string): Promise<void> {
        const genCodePath = path.join(path.dirname(configFileUri.fsPath), 'GenCode.bat');
        if (!fs.existsSync(genCodePath)) {
            this.outputChannel.appendLine(`[警告] 在 ${genCodePath} 未找到 GenCode.bat 文件，跳过更新。`);
            return;
        }

        try {
            const eepromName = this.transformMacroToFilename(newEepromMacro);
            const command = `bin2c ${eepromName}.bin ${eepromName} eepromdata`;
            
            const genCodeContent = await vscode.workspace.fs.readFile(vscode.Uri.file(genCodePath));
            let contentString = Buffer.from(genCodeContent).toString('utf-8');
            
            if (contentString.includes(command)) {
                vscode.window.showInformationMessage('GenCode.bat 中已存在相同指令，无需添加。');
                return;
            }

            const newContent = contentString.trimEnd() + '\r\n' + command;
            await vscode.workspace.fs.writeFile(vscode.Uri.file(genCodePath), Buffer.from(newContent, 'utf-8'));
            
            vscode.window.showInformationMessage('GenCode.bat 已成功更新！');

        } catch (error: any) {
            vscode.window.showErrorMessage(`更新 GenCode.bat 失败: ${error.message}`);
            this.outputChannel.appendLine(`[错误] 更新 GenCode.bat 时出错: ${error.stack}`);
        }
    }

    private async updateSystemParaC(configFileUri: vscode.Uri, newEepromMacro: string, customerPrefix: string): Promise<void> {
        const systemParaPath = path.resolve(path.dirname(configFileUri.fsPath), '../../User/SystemPara.c');
        
        if (!fs.existsSync(systemParaPath)) {
            this.outputChannel.appendLine(`[警告] 在 ${systemParaPath} 未找到 SystemPara.c 文件，跳过更新。`);
            return;
        }

        try {
            const document = await vscode.workspace.openTextDocument(systemParaPath);
            const text = document.getText();
            const lines = text.split(/\r?\n/);
            
            const elseIndex = lines.findIndex(line => line.trim().startsWith('#else'));
            if (elseIndex === -1) {
                throw new Error("在 SystemPara.c 中未找到 #else 指令，无法确定插入位置。");
            }
            
            let insertLineNum = elseIndex;
            if(insertLineNum > 0 && lines[insertLineNum-1].trim() === ''){
                insertLineNum--;
            }

            const eepromNameLower = this.transformMacroToFilename(newEepromMacro);
            const newBlock = `#elif  ${newEepromMacro}\r\n#include "CustomerConfig/${customerPrefix.toUpperCase()}/${eepromNameLower}.h"`;
            
            const macroCheckRegex = new RegExp(`\\b${newEepromMacro}\\b`);
            if (macroCheckRegex.test(text)) {
                 vscode.window.showInformationMessage('SystemPara.c 中已存在相同宏定义，无需添加。');
                 return;
            }

            const edit = new vscode.WorkspaceEdit();
            const positionToInsert = new vscode.Position(insertLineNum, 0);
            
            const contentToInsert = `${newBlock}\r\n`;

            edit.replace(document.uri, new vscode.Range(positionToInsert, positionToInsert), contentToInsert);

            if (await vscode.workspace.applyEdit(edit)) {
                vscode.window.showInformationMessage('SystemPara.c 已成功更新！');
            } else {
                 throw new Error("写入 SystemPara.c 失败。");
            }

        } catch (error: any) {
             vscode.window.showErrorMessage(`更新 SystemPara.c 失败: ${error.message}`);
             this.outputChannel.appendLine(`[错误] 更新 SystemPara.c 时出错: ${error.stack}`);
        }
    }

    private async updateCustomH(configFileUri: vscode.Uri, referenceModelName: string, newModelName: string): Promise<void> {
        const customHPath = path.resolve(path.dirname(configFileUri.fsPath), '../../../Driver/DrivePublicFunction/DrivePublicFunction_No4/Custom.h');
        
        if (!fs.existsSync(customHPath)) {
            this.outputChannel.appendLine(`[警告] 在 ${customHPath} 未找到 Custom.h 文件，跳过更新。`);
            return;
        }
    
        try {
            const document = await vscode.workspace.openTextDocument(customHPath);
            const text = document.getText();
            const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
            
            const modelsInCustomH = this.parseExistingModels(text);
            if (modelsInCustomH.length === 0) {
                this.outputChannel.appendLine(`[警告] 在 Custom.h 中未找到任何机型配置块，跳过更新。`);
                return;
            }

            const refModelBlockInfo = modelsInCustomH.find(m => m.name === referenceModelName);
    
            if (!refModelBlockInfo) {
                this.outputChannel.appendLine(`[警告] 在 Custom.h 中未找到参考机型 ${referenceModelName} 的配置块，跳过更新。`);
                return;
            }
    
            const motorLines = refModelBlockInfo.configBlock.split(/\r?\n/).filter(line => 
                line.trim().startsWith('#define MOTOR1_TYPE') || line.trim().startsWith('#define MOTOR2_TYPE')
            );
    
            if (motorLines.length === 0) {
                this.outputChannel.appendLine(`[信息] 参考机型 ${referenceModelName} 在 Custom.h 中没有 MOTOR 定义，跳过更新。`);
                return;
            }
    
            const newBlockContent = [`#elif ${newModelName}`, ...motorLines].join(eol);
    
            const lastModelInCustomH = modelsInCustomH[modelsInCustomH.length - 1];
            
            const edit = new vscode.WorkspaceEdit();
            const endOfLastBlock = document.lineAt(lastModelInCustomH.endLine).range.end;
            edit.insert(document.uri, endOfLastBlock, eol + newBlockContent);
    
            if (await vscode.workspace.applyEdit(edit)) {
                vscode.window.showInformationMessage('Custom.h 已成功更新！');
            } else {
                 throw new Error("写入 Custom.h 失败。");
            }
    
        } catch (error: any) {
             vscode.window.showErrorMessage(`更新 Custom.h 失败: ${error.message}`);
             this.outputChannel.appendLine(`[错误] 更新 Custom.h 时出错: ${error.stack}`);
        }
    }

    private async handleBinFileAndExecuteGenCode(configFileUri: vscode.Uri, newEepromMacro: string): Promise<void> {
        const workDir = path.dirname(configFileUri.fsPath);
        
        try {
            const files = await vscode.workspace.fs.readDirectory(vscode.Uri.file(workDir));
            const binFiles = files.filter(([fileName, fileType]) => 
                fileType === vscode.FileType.File && fileName.endsWith('.bin')
            );
    
            if (binFiles.length === 1) {
                const [oldFileName] = binFiles[0];
                const oldFilePath = path.join(workDir, oldFileName);
                const newBinFileName = this.transformMacroToFilename(newEepromMacro) + '.bin';
                const newFilePath = path.join(workDir, newBinFileName);
    
                await vscode.workspace.fs.rename(vscode.Uri.file(oldFilePath), vscode.Uri.file(newFilePath));
                vscode.window.showInformationMessage(`已将 ${oldFileName} 重命名为 ${newBinFileName}。`);
    
                vscode.window.showInformationMessage('正在执行 GenCode.bat 以生成 EEPROM 头文件...');
                await execPromise('GenCode.bat', { cwd: workDir });
                vscode.window.showInformationMessage('GenCode.bat 执行完毕。');
    
                const finalBinFiles = (await vscode.workspace.fs.readDirectory(vscode.Uri.file(workDir)))
                    .filter(([fileName, fileType]) => fileType === vscode.FileType.File && fileName.endsWith('.bin'));
    
                for (const [binFile] of finalBinFiles) {
                    await vscode.workspace.fs.delete(vscode.Uri.file(path.join(workDir, binFile)));
                }
                vscode.window.showInformationMessage('已清理所有 .bin 文件。');
    
            } else if (binFiles.length > 1) {
                vscode.window.showWarningMessage('检测到多个 .bin 文件。将删除所有 .bin 文件，并跳过 GenCode.bat 的执行。');
                for (const [binFile] of binFiles) {
                    await vscode.workspace.fs.delete(vscode.Uri.file(path.join(workDir, binFile)));
                }
                vscode.window.showInformationMessage('已删除所有 .bin 文件。');
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(`处理 .bin 文件并执行 GenCode.bat 时出错: ${error.message}`);
            this.outputChannel.appendLine(`[错误] handleBinFileAndExecuteGenCode: ${error.stack}`);
        }
    }
}
