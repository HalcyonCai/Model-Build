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

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
    }

    dispose() {
        this.outputChannel.dispose();
    }

    async createNewModel(uri?: vscode.Uri): Promise<void> {
        try {
            // 修复：从活动编辑器获取上下文
            const editor = vscode.window.activeTextEditor;
            if (!editor) throw new Error('无法获取活动编辑器。');
            const document = uri ? await vscode.workspace.openTextDocument(uri) : editor.document;
            if (!this.isConfigFile(document.fileName)) throw new Error('当前文件不是一个有效的Config_*.h文件。');

            const existingModels = this.parseExistingModels(document.getText());
            if (existingModels.length === 0) throw new Error('在文件中未找到可识别的机型配置块。');
            
            const commonPrefix = this.getCommonModelPrefix(existingModels);
            if (!commonPrefix) throw new Error('无法从文件中已定义的机型中确定通用前缀 (例如 PGEL)。');

            // 最终修复：移除 C/C++ Target 选择，因为它会引入错误的上下文
            // const selectedTarget = await this.selectTargetConfiguration(document.uri, commonPrefix);
            // if (!selectedTarget) { return; }

            const position = editor.selection.active;
            this.outputChannel.appendLine(`[调试] 光标位于第 ${position.line} 行。`);

            const contextualModel = this.findModelAtPosition(existingModels, position);
            let boardNamePattern: string | null = null;
            if (contextualModel) {
                this.outputChannel.appendLine(`[调试] 上下文机型已找到: ${contextualModel.name}`);
                boardNamePattern = this.extractBoardModelFromName(contextualModel.name);
                if (boardNamePattern) {
                    this.outputChannel.appendLine(`[调试] 提取的板卡型号: ${boardNamePattern}`);
                } else {
                    this.outputChannel.appendLine(`[调试] 未能从 '${contextualModel.name}' 提取板卡型号。`);
                }
            } else {
                 this.outputChannel.appendLine(`[调试] 未能在光标位置 (line ${position.line}) 找到上下文机型。`);
            }

            const referenceModel = await this.selectReferenceModel(existingModels, boardNamePattern);
            if (!referenceModel) { return; }
            this.outputChannel.appendLine(`[信息] 已选择参考机型: ${referenceModel.name}`);

            const newModelName = await this.inputNewModelName(referenceModel.name);
            if (!newModelName) { return; }

            const baseName = path.basename(document.fileName, '.h');
            const prefix = 'Config_';
            let customerName = '';
            if (baseName.toLowerCase().startsWith(prefix.toLowerCase())) {
                customerName = baseName.substring(prefix.length).toUpperCase();
            }
            if (!customerName) {
                throw new Error(`无法从文件名 ${document.fileName} 中提取客户名。`);
            }
            this.outputChannel.appendLine(`[信息] 自动识别客户名: ${customerName}`);

            // 修复：使用新的、更可靠的板卡型号提取逻辑
            const boardModel = this.extractBoardModelFromName(referenceModel.name);
            if (!boardModel) {
                throw new Error(`无法从参考机型 '${referenceModel.name}' 中提取板卡型号。请检查命名规范。`);
            }
            this.outputChannel.appendLine(`[信息] 自动提取板卡型号: ${boardModel}`);

            const softwareVersion = await this.inputSoftwareVersion();
            const eePromVersion = await this.inputEePromVersion();
            const customCodeName = await this.inputCustomCodeName();
            const motorTypes = await this.inputMotorTypes(document.uri);

            const newEepromMacro = this.generateEepromMacro(boardModel, customerName, eePromVersion);

            await this.createModelConfiguration(document, referenceModel, newModelName, newEepromMacro, softwareVersion, customCodeName, customerName);
            await this.updateGenCodeBat(document.uri, newEepromMacro);
            await this.updateSystemParaC(document.uri, referenceModel, newEepromMacro, customerName);
            await this.updateCustomH(document.uri, referenceModel, newModelName, motorTypes);
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
    
    /* 
     * 移除此函数，因为它会引入错误的上下文
    private async selectTargetConfiguration(fileUri: vscode.Uri, commonPrefix: string): Promise<CppConfiguration | undefined> {
        const allConfigurations = this.getCppConfigurations(fileUri);
        if (!allConfigurations) throw new Error('在 .vscode/c_cpp_properties.json 中找不到任何配置。');
        
        let configurationsToShow = allConfigurations.filter(config => 
            config.name.toUpperCase().includes(commonPrefix.toUpperCase())
        );

        if (configurationsToShow.length === 0) {
            vscode.window.showWarningMessage(`未找到与客户 '${commonPrefix}' 匹配的 C/C++ Target，将显示所有可用 Target。`);
            configurationsToShow = allConfigurations;
        }
        
        if (configurationsToShow.length === 0) throw new Error(`在 c_cpp_properties.json 中没有找到任何 C/C++ Target。`);
        
        const items = configurationsToShow.map(config => ({ label: config.name, config }));
        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: `请选择一个 '${commonPrefix}' 相关的 C/C++ Target`,
            ignoreFocusOut: true,
        });
        return selected?.config;
    }
    */

    private findVscodeConfig(startUri: vscode.Uri): string | null {
        let currentDir = path.dirname(startUri.fsPath);
        
        while (currentDir !== path.parse(currentDir).root) {
            const configPath = path.join(currentDir, '.vscode', 'c_cpp_properties.json');
            if (fs.existsSync(configPath)) {
                return configPath;
            }
            currentDir = path.dirname(currentDir);
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(startUri);
        if (workspaceFolder) {
            const configPath = path.join(workspaceFolder.uri.fsPath, '.vscode', 'c_cpp_properties.json');
            if (fs.existsSync(configPath)) {
                return configPath;
            }
        }
        
        return null;
    }

    private findNextPreprocessorLine(document: vscode.TextDocument, startLine: number): number {
        for (let i = startLine + 1; i < document.lineCount; i++) {
            const line = document.lineAt(i).text.trim();
            if (['#elif', '#else', '#endif'].some(d => line.startsWith(d))) {
                return i;
            }
        }
        // 作为备选方案，返回最后一个 #endif 的位置
        for (let i = document.lineCount - 1; i >= 0; i--) {
            if (document.lineAt(i).text.trim() === '#endif') {
                return i;
            }
        }
        return -1; // 在有效的C文件中不应发生
    }

    private extractBoardModelFromName(name: string): string | null {
        this.outputChannel.appendLine(`[调试] 尝试从 '${name}' 中提取板卡型号。`);

        // 最终修复：按优先级尝试匹配多种已知的板卡型号格式
        const patterns = [
            /(KFW\d+C_\d+_(?:AC|DC))/i, // 最优先匹配，例如 KFW35C_7_AC
            /(KFW\d+CAF)/i,             // 其次，匹配 KFW...CAF...
            /(KFW\d+C_\d+)/i,            // 最后，匹配基础格式 KFW...C_...
        ];

        for (const pattern of patterns) {
            const match = name.match(pattern);
            if (match && match[1]) {
                const boardModel = match[1];
                this.outputChannel.appendLine(`[调试] 提取成功 (使用模式: ${pattern}): '${boardModel}'`);
                return boardModel;
            }
        }

        this.outputChannel.appendLine(`[警告] 所有模式都未能从 '${name}' 中提取板卡型号。`);
        return null;
    }

    private getCppConfigurations(fileUri: vscode.Uri): CppConfiguration[] | null {
        try {
            const configPath = this.findVscodeConfig(fileUri);
            if (!configPath) {
                this.outputChannel.appendLine(`[警告] 无法在 ${fileUri.fsPath} 的父目录中找到 .vscode/c_cpp_properties.json 文件。`);
                return null;
            }

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

    private async selectReferenceModel(models: ModelInfo[], boardNamePattern: string | null): Promise<ModelInfo | undefined> {
        let modelsToShow = models;
        this.outputChannel.appendLine(`[调试] selectReferenceModel: 总共 ${models.length} 个机型。`);

        if (boardNamePattern) {
            this.outputChannel.appendLine(`[调试] 使用板卡型号 '${boardNamePattern}' 进行过滤。`);
            const filteredModels = models.filter(model => model.name.toUpperCase().includes(boardNamePattern.toUpperCase()));
            
            this.outputChannel.appendLine(`[调试] 过滤后剩下 ${filteredModels.length} 个机型。`);

            if (filteredModels.length > 0) {
                modelsToShow = filteredModels;
            } else {
                this.outputChannel.appendLine(`[警告] 未找到与板卡 '${boardNamePattern}' 匹配的参考机型，将显示所有机型。`);
            }
        } else {
            this.outputChannel.appendLine(`[调试] 未提供板卡型号，显示所有机型。`);
        }

        const items = modelsToShow.map(model => ({ label: model.name, model }));
        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: '请选择一个参考机型',
            ignoreFocusOut: true
        });
        return selected?.model;
    }

    private async inputNewModelName(referenceModelName: string): Promise<string | undefined> {
        return await vscode.window.showInputBox({
            prompt: '请输入新机型的名称',
            value: referenceModelName,
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
            prompt: '请输入EEPROM版本号 (例如: 1980)',
            validateInput: (value) => {
                if (!value?.trim()) { return 'EEPROM版本号不能为空。'; }
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

    private async parseMotorModels(configFileUri: vscode.Uri, motorType: 'fan' | 'compressor'): Promise<string[]> {
        const customHPath = path.resolve(path.dirname(configFileUri.fsPath), '../../../Driver/DrivePublicFunction/DrivePublicFunction_No4/Custom.h');
        this.outputChannel.appendLine(`[信息] 正在从 ${customHPath} 解析 ${motorType} 型号。`);

        if (!fs.existsSync(customHPath)) {
            this.outputChannel.appendLine(`[警告] 在解析电机型号时未找到 Custom.h 文件。`);
            return [];
        }
    
        try {
            const content = fs.readFileSync(customHPath, 'utf8');
            const lines = content.split(/\r?\n/);
            const defines: string[] = [];
            
            if (motorType === 'compressor') {
                const defineRegex = /^\s*#define\s+(COMP_[A-Z0-9_]+)\s+/;
                for (const line of lines) {
                    const match = line.match(defineRegex);
                    if (match && match[1]) {
                        defines.push(match[1]);
                    }
                }
            } else { // 'fan'
                const defineRegex = /^\s*#define\s+(MOTOR2_[A-Z0-9_]*FAN[A-Z0-9_]*)\s+/;
            for (const line of lines) {
                const match = line.match(defineRegex);
                if (match && match[1]) {
                        defines.push(match[1]);
                    }
                }
            }
            
            return [...new Set(defines)];
        } catch (error: any) {
            this.outputChannel.appendLine(`[错误] 解析 Custom.h 文件时出错: ${error.message}`);
            return [];
        }
    }

    private async inputMotorTypes(configFileUri: vscode.Uri): Promise<{ motor1?: string, motor2?: string }> {
        const availableFans = await this.parseMotorModels(configFileUri, 'fan');
        const availableCompressors = await this.parseMotorModels(configFileUri, 'compressor');

        const selectMotor = async (prompt: string, models: string[]): Promise<string | undefined> => {
            const manualInput = '手动输入...';
            const noSetting = '(不设置)';
            const options = [noSetting, manualInput, ...models];
    
            const selection = await vscode.window.showQuickPick(options, {
                placeHolder: prompt,
                ignoreFocusOut: true
            });
    
            if (!selection || selection === noSetting) {
                return undefined;
            }
    
            if (selection === manualInput) {
                return await vscode.window.showInputBox({
                    prompt: prompt,
                    ignoreFocusOut: true
                });
            }
            
            return selection;
        };
    
        // 修复：MOTOR1 是压缩机, MOTOR2 是风机
        const motor1 = await selectMotor('请为 MOTOR1_TYPE (压缩机) 选择或输入一个型号', availableCompressors);
        const motor2 = await selectMotor('请为 MOTOR2_TYPE (风机) 选择或输入一个型号', availableFans);
    
        return { motor1, motor2 };
    }

    /*
     * 移除此函数，因为它不再被使用
    private extractModelNameFromDefines(defines: string[], prefix: string): string | null {
        if (!defines) return null;
        
        const modelRegex = new RegExp(`^${prefix}_[A-Z0-9_]*`);
        for (const define of defines) {
            const defineStr = define.split('=')[0].trim();
            if (modelRegex.test(defineStr)) {
                return defineStr;
            }
        }
    
        for (const define of defines) {
            const defineStr = define.split('=')[0].trim();
            if (defineStr.startsWith(prefix)) {
                return defineStr;
            }
        }
        
        return null;
    }
    */
    
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

    private simplifyBoardModel(boardModel: string): string {
        return boardModel.toUpperCase()
            .replace(/^KFW/, '')       // 移除 KFW 前缀
            .replace(/_(AC|DC)$/, '') // 移除 AC/DC 后缀
            .replace(/^_/, '')       // 移除可能的前导下划线
            .replace(/_$/, '');      // 移除可能的末尾下划线
    }

    private generateEepromMacro(boardModel?: string, customerName?: string, eePromVersion?: string): string {
        if (!boardModel || !customerName || !eePromVersion) {
            throw new Error(`生成 EEPROMDATA 宏时缺少关键信息。`);
        }
    
        const upperCustomerName = customerName.toUpperCase();
        const upperEePromVersion = eePromVersion.toUpperCase();
    
        const simplifiedBoardModel = this.simplifyBoardModel(boardModel);
    
        this.outputChannel.appendLine(`[调试] EEPROM 宏生成: 原始='${boardModel.toUpperCase()}', 简化='${simplifiedBoardModel}'`);
    
        return `EEPROMDATA_${upperCustomerName}_${simplifiedBoardModel}_${upperEePromVersion}`;
    }

    private async createModelConfiguration(document: vscode.TextDocument, referenceModel: ModelInfo, newModelName: string, newEepromMacro: string, softwareVersion: string | undefined, customCodeName: string | undefined, customerName: string): Promise<void> {
        let lines = referenceModel.configBlock.split('\n');
        
        lines[0] = lines[0].replace(referenceModel.name, newModelName).replace(/^#\s*if/, '#elif');
        
        const fullCustomCodeName = customCodeName ? `${customerName.toUpperCase()}_${customCodeName}` : undefined;

        const macroProcessors = [
            { key: 'SOFTWARE_VERSION', value: softwareVersion, regex: /#define\s+SOFTWARE_VERSION/, createLine: (val: string) => `#define SOFTWARE_VERSION                (uint32_t)${val}        // 软件版本号` },
            { key: 'CUSTOM_CODE_NAME', value: fullCustomCodeName, regex: /#define\s+CUSTOM_CODE_NAME/, createLine: (val: string) => `#define CUSTOM_CODE_NAME                "${val}"       // 客户料号名称 最长30字节` },
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
                        lines[lineIndex] = originalLine.replace(/"[^"]*"/, `"${fullCustomCodeName!}"`);
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
        
        const edit = new vscode.WorkspaceEdit();
        const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
        // 最终修复 V5: 使用 WorkspaceEdit 的 replace 方法，确保在原始块后追加
        const range = new vscode.Range(
            new vscode.Position(referenceModel.startLine, 0),
            new vscode.Position(referenceModel.endLine, document.lineAt(referenceModel.endLine).text.length)
        );
        const newContent = `${referenceModel.configBlock}${eol}${eol}${newModelBlock}`;
        
        edit.replace(document.uri, range, newContent);

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

    private deriveRefEepromMacro(referenceModel: ModelInfo, customerName: string): string | null {
        this.outputChannel.appendLine(`[调试] 尝试从参考机型名称派生其 EEPROM 宏。`);
        const { name } = referenceModel;
        
        const parts = name.split('_');
        if (parts.length < 2) {
            this.outputChannel.appendLine(`[警告] 参考机型名称格式不规范，无法派生。`);
            return null;
        }

        const refEePromVersion = parts[parts.length - 1];
        const refBoardModel = this.extractBoardModelFromName(name);

        if (!refBoardModel) {
             this.outputChannel.appendLine(`[警告] 无法从参考机型名称中提取板卡型号。`);
            return null;
        }

        const derivedMacro = this.generateEepromMacro(refBoardModel, customerName, refEePromVersion);
        this.outputChannel.appendLine(`[调试] 派生出的参考宏: ${derivedMacro}`);
        return derivedMacro;
    }

    private findEepromInsertionLine(document: vscode.TextDocument, searchPattern: RegExp): number {
        const lines = document.getText().split(/\r?\n/);
        this.outputChannel.appendLine(`[调试] SystemPara.c 正向搜索, 正则: ${searchPattern}`);

        for (let i = 0; i < lines.length; i++) {
            if (searchPattern.test(lines[i])) {
                this.outputChannel.appendLine(`[调试] 在第 ${i + 1} 行找到匹配的 #elif。`);
                // 从这个匹配行开始，向下找到块的结束位置
                let blockEnd = i + 1;
                while (blockEnd < lines.length) {
                    const line = lines[blockEnd].trim();
                    if (line.startsWith('#elif') || line.startsWith('#else') || line.startsWith('#endif')) {
                        this.outputChannel.appendLine(`[调试] 块结束于第 ${blockEnd + 1} 行，将在此处插入。`);
                        return blockEnd; // 返回下一个预处理指令的行号作为插入点
                    }
                    blockEnd++;
                }
                this.outputChannel.appendLine(`[调试] 这是文件末尾的块，将在文件末尾插入。`);
                return lines.length;
            }
        }

        this.outputChannel.appendLine(`[调试] 未找到匹配项。`);
        return -1; // 未找到
    }

    private async updateSystemParaC(configFileUri: vscode.Uri, referenceModel: ModelInfo, newEepromMacro: string, customerPrefix: string): Promise<void> {
        this.outputChannel.appendLine(`[调试] updateSystemParaC V5 (精准定位) LOGIC ENTRY`);
        const systemParaPath = path.resolve(path.dirname(configFileUri.fsPath), '../../User/SystemPara.c');
        if (!fs.existsSync(systemParaPath)) {
            this.outputChannel.appendLine(`[警告] 在 ${systemParaPath} 未找到 SystemPara.c 文件，跳过更新。`);
            return;
        }

        try {
            const document = await vscode.workspace.openTextDocument(systemParaPath);
            const text = document.getText();
            const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
            
            let insertionLine = -1;
            let refEepromMacroName: string | null = null;

            // 策略1: 尝试从 Config.h 的参考机型块中直接寻找 EEPROM 宏 (最高优先级)
            const refEepromMatch = referenceModel.configBlock.match(/#define\s+(EEPROMDATA_[^\s]+)/);
            if (refEepromMatch && refEepromMatch[1]) {
                refEepromMacroName = refEepromMatch[1];
                this.outputChannel.appendLine(`[调试] 策略1成功: 从 Config.h 找到参考宏 ${refEepromMacroName}`);
            }

            // 策略2: 如果策略1失败，则根据参考机型名称智能推导其 EEPROM 宏
            if (!refEepromMacroName) {
                this.outputChannel.appendLine(`[调试] 策略1失败。尝试策略2: 根据机型名称推导宏。`);
                refEepromMacroName = this.deriveRefEepromMacro(referenceModel, customerPrefix);
            }

            // 使用找到或推导出的宏来定位插入点
            if (refEepromMacroName) {
                const searchRegex = new RegExp(`^\\s*#elif\\s+${refEepromMacroName}\\b`);
                insertionLine = this.findEepromInsertionLine(document, searchRegex);
            }

            // 策略3: 如果以上都失败，则回退到在 #else 前插入
            if (insertionLine === -1) {
                this.outputChannel.appendLine(`[警告] 所有智能定位方式都未能找到参考点，将插入到 #else 前。`);
                const lines = text.split(/\r?\n/);
                insertionLine = lines.findIndex(line => line.trim().startsWith('#else'));
                if (insertionLine === -1) throw new Error("在 SystemPara.c 中未找到 #else 插入点。");
            }
            
            const eepromNameLower = this.transformMacroToFilename(newEepromMacro);
            const newBlock = `#elif ${newEepromMacro}${eol}#include "CustomerConfig/${customerPrefix.toUpperCase()}/${eepromNameLower}.h"`;
            
            if (text.includes(newEepromMacro)) {
                 vscode.window.showInformationMessage('SystemPara.c 中已存在相同宏定义，无需添加。');
                 return;
            }

            this.outputChannel.appendLine(`[调试] 准备在 SystemPara.c 的第 ${insertionLine + 1} 行（从1开始计数）插入新宏块。`);
            const edit = new vscode.WorkspaceEdit();
            edit.insert(document.uri, new vscode.Position(insertionLine, 0), newBlock + eol);

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

    private async updateCustomH(configFileUri: vscode.Uri, referenceModel: ModelInfo, newModelName: string, motorTypes: { motor1?: string, motor2?: string }): Promise<void> {
        const customHPath = path.resolve(path.dirname(configFileUri.fsPath), '../../../Driver/DrivePublicFunction/DrivePublicFunction_No4/Custom.h');
        if (!fs.existsSync(customHPath)) {
            vscode.window.showWarningMessage(`Custom.h 文件未找到，路径: ${customHPath}`);
            return;
        }

        try {
            const document = await vscode.workspace.openTextDocument(customHPath);
            const text = document.getText();
            const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
            
            const modelsInCustomH = this.parseExistingModels(text);
            if (!modelsInCustomH.length) {
                throw new Error("在 Custom.h 中未能解析出任何机型。");
            }

            const motorLines: string[] = [];
            if (motorTypes.motor1?.trim()) {
                motorLines.push(`    #define MOTOR1_TYPE                     ${motorTypes.motor1.trim()}`);
            }
            if (motorTypes.motor2?.trim()) {
                motorLines.push(`    #define MOTOR2_TYPE                     ${motorTypes.motor2.trim()}`);
            }

            if (motorLines.length === 0) {
                this.outputChannel.appendLine('[信息] 没有提供 MOTOR 类型，跳过更新 Custom.h。');
                return;
            }

            const referenceModelInCustomH = modelsInCustomH.find(m => m.name === referenceModel.name);

            if (!referenceModelInCustomH) {
                this.outputChannel.appendLine(`[信息] 在 Custom.h 中未找到参考机型 ${referenceModel.name}，跳过更新。`);
                return;
            }
            this.outputChannel.appendLine(`[调试] 在 Custom.h 中找到参考机型 ${referenceModel.name}，范围：行 ${referenceModelInCustomH.startLine + 1} 到 ${referenceModelInCustomH.endLine + 1}。`);
            
            const referenceLine = document.lineAt(referenceModelInCustomH.startLine).text;
            const indentationMatch = referenceLine.match(/^(\s*)/);
            const indentation = indentationMatch ? indentationMatch[1] : '';

            const { valueColumn, innerIndentation } = this.calculateAlignment(document, referenceModelInCustomH);
            this.outputChannel.appendLine(`[调试] 计算对齐：值起始列=${valueColumn}, 内部缩进='${innerIndentation.replace(/\s/g, '·')}'`);

            const motorLinesFormatted: string[] = [];
            if (motorTypes.motor1?.trim()) {
                const definePart = `${innerIndentation}#define MOTOR1_TYPE`;
                const spacesNeeded = Math.max(1, valueColumn - this.getVisualLength(definePart));
                motorLinesFormatted.push(`${definePart}${' '.repeat(spacesNeeded)}${motorTypes.motor1.trim()}`);
            }
            if (motorTypes.motor2?.trim()) {
                const definePart = `${innerIndentation}#define MOTOR2_TYPE`;
                const spacesNeeded = Math.max(1, valueColumn - this.getVisualLength(definePart));
                motorLinesFormatted.push(`${definePart}${' '.repeat(spacesNeeded)}${motorTypes.motor2.trim()}`);
            }

            const newBlockContent = [`${indentation}#elif ${newModelName}`, ...motorLinesFormatted].join(eol);
            
            const insertionLine = this.findNextPreprocessorLine(document, referenceModelInCustomH.endLine);
            if (insertionLine === -1) {
                this.outputChannel.appendLine(`[错误] 在 Custom.h 中未找到有效的插入点 (在第 ${referenceModelInCustomH.endLine + 1} 行之后)。`);
                throw new Error(`在 Custom.h 中未找到有效的插入点。`);
            }
            this.outputChannel.appendLine(`[调试] 准备在 Custom.h 的第 ${insertionLine + 1} 行插入新机型块。`);
            
            const edit = new vscode.WorkspaceEdit();
            edit.insert(document.uri, new vscode.Position(insertionLine, 0), newBlockContent + eol);
    
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

    private getVisualLength(text: string): number {
        // 将 Tab 替换为4个空格来计算视觉长度
        return text.replace(/\t/g, '    ').length;
    }

    private calculateAlignment(document: vscode.TextDocument, referenceModel: ModelInfo): { valueColumn: number, innerIndentation: string } {
        let valueColumn = 0;
        let innerIndentation = '';
        const startLine = referenceModel.startLine;
        const endLine = this.findNextPreprocessorLine(document, startLine) - 1;
        let foundFirstDefine = false;

        this.outputChannel.appendLine(`[调试] calculateAlignment V4 (Tab-aware): 分析第 ${startLine + 1} 到 ${endLine + 1} 行。`);

        for (let i = startLine + 1; i <= endLine && i < document.lineCount; i++) {
            const lineText = document.lineAt(i).text;
            if (lineText.trim() === '') continue;

            const match = lineText.match(/^(\s*#define\s+[A-Z0-9_]+\s+)/);
            if (match) {
                if (!foundFirstDefine) {
                    const indentMatch = lineText.match(/^(\s*)/);
                    innerIndentation = indentMatch ? indentMatch[1] : '    ';
                    foundFirstDefine = true;
                }
                
                const currentColumn = this.getVisualLength(match[1]);
                if (currentColumn > valueColumn) {
                    valueColumn = currentColumn;
                }
            }
        }
        
        if (!foundFirstDefine) {
            const elifIndentation = (document.lineAt(startLine).text.match(/^(\s*)/) || ['',''])[1];
            innerIndentation = elifIndentation + '    ';
            valueColumn = this.getVisualLength(`${innerIndentation}#define MOTOR2_TYPE `); 
            this.outputChannel.appendLine(`[调试] 未找到 #define，使用默认对齐。`);
        } else {
            const minLength1 = this.getVisualLength(`${innerIndentation}#define MOTOR1_TYPE `);
            const minLength2 = this.getVisualLength(`${innerIndentation}#define MOTOR2_TYPE `);
            valueColumn = Math.max(valueColumn, minLength1, minLength2);
            this.outputChannel.appendLine(`[调试] 在参考块中找到的最宽视觉对齐列为: ${valueColumn}`);
        }

        return { valueColumn, innerIndentation };
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

    private findModelAtPosition(models: ModelInfo[], position: vscode.Position): ModelInfo | undefined {
        return models.find(model => position.line >= model.startLine && position.line <= model.endLine);
    }
}
