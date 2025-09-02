import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class FanCreator {
    private outputChannel: vscode.OutputChannel;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel("Fan Creator");
    }

    public async createNewFan(uri?: vscode.Uri): Promise<void> {
        if (!uri) {
            vscode.window.showErrorMessage('请在 Custom.h 文件上右键来执行此命令。');
            return;
        }

        try {
            // Step 1: Select reference fan model
            const referenceFan = await this.selectReferenceFan(uri);
            if (!referenceFan) return;

            // Step 2: Input new fan model name
            const newFanName = await this.inputNewFanName(referenceFan.name);
            if (!newFanName) return;

            const document = await vscode.workspace.openTextDocument(uri);
            const existingFans = this.getFanModels(document);
            if (existingFans.some(fan => fan.name === `MOTOR2_${newFanName.toUpperCase()}`)) {
                vscode.window.showErrorMessage(`创建失败：风机型号 '${newFanName}' 已存在于 Custom.h 中。`);
                return;
            }
            
            // Step 3-7: Input parameters
            const poles = await this.inputFanParameter('Poles', '请输入极对数');
            if (poles === undefined) return;

            const rs = await this.inputFanParameter('Rs', '请输入电阻值');
            if (rs === undefined) return;

            const ld = await this.inputFanParameter('Ld', '请输入 d 轴电感');
            if (ld === undefined) return;

            const lq = await this.inputFanParameter('Lq', '请输入 q 轴电感');
            if (lq === undefined) return;

            const ke = await this.inputFanParameter('Ke', '请输入反电动势系数');
            if (ke === undefined) return;

            await this.updateFiles(uri, referenceFan, newFanName, { poles, rs, ld, lq, ke });

            vscode.window.showInformationMessage(`风机型号 ${newFanName} 已成功创建！`);

        } catch (error: any) {
            vscode.window.showErrorMessage(`创建风机型号失败: ${error.message}`);
            this.outputChannel.appendLine(`[错误] ${error.stack}`);
        }
    }

    private async updateFiles(customHUri: vscode.Uri, referenceFan: { name: string, value: number, line: number }, newFanName: string, params: { poles: number, rs: number, ld: number, lq: number, ke: number }): Promise<void> {
        const baseDir = path.dirname(customHUri.fsPath);
        const focDriverDir = path.resolve(baseDir, '../../FOCDcFanDriver/FOCDcFanDriver_No4');
        const focFansDir = path.join(focDriverDir, 'FocFans');

        // 1. Create new fan header file
        await this.createNewFanHeader(focFansDir, focDriverDir, referenceFan.name, newFanName, params);

        // 2. Update Custom.h
        await this.updateCustomH(customHUri, referenceFan, newFanName);
        
        // 3. Update customerInterface2.c
        const customerInterfacePath = path.join(focDriverDir, 'customerInterface2.c');
        await this.updateCustomerInterface(vscode.Uri.file(customerInterfacePath), newFanName);

        // 4. Update focfanName_Table.h
        const fanNameTablePath = path.join(focDriverDir, 'focfanName_Table.h');
        await this.updateFanNameTable(vscode.Uri.file(fanNameTablePath), newFanName);
        
        await vscode.workspace.saveAll();
        vscode.window.showInformationMessage('所有相关文件已更新并保存。');
    }
    
    private async findHeaderPathForFanMacro(focDriverDir: string, fanMacroName: string): Promise<string> {
        const customerInterfacePath = path.join(focDriverDir, 'customerInterface2.c');
        const content = fs.readFileSync(customerInterfacePath, 'utf-8');
        const lines = content.split(/\r?\n/);

        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(fanMacroName)) {
                const includeLine = lines[i+1];
                const match = includeLine.match(/#include\s*"FocFans\/([^"]+)"/);
                if (match) {
                    return match[1];
                }
            }
        }
        throw new Error(`在 customerInterface2.c 中未找到 ${fanMacroName} 对应的头文件。`);
    }

    private async createNewFanHeader(focFansDir: string, focDriverDir: string, referenceFanName: string, newFanName: string, params: { poles: number, rs: number, ld: number, lq: number, ke: number }): Promise<void> {
        
        const refFanMacro = `MOTOR2_${referenceFanName}`;
        const refFanFileName = await this.findHeaderPathForFanMacro(focDriverDir, refFanMacro);

        const newFanFileName = `${newFanName.replace(/_DEBUG$/, '')}.h`;
        
        const refFilePath = path.join(focFansDir, refFanFileName);
        const newFilePath = path.join(focFansDir, newFanFileName);

        if (!fs.existsSync(refFilePath)) {
            throw new Error(`参考风机文件 ${refFanFileName} 不存在。`);
        }
        
        let content = fs.readFileSync(refFilePath, 'utf-8');

        // Replace parameters
        content = content.replace(/Motor2_i32PolePairs\s*=\s*[^;]+;/, `Motor2_i32PolePairs  = ${params.poles};`);
        content = content.replace(/Motor2_f32Rs\s*=\s*[^;]+;/, `Motor2_f32Rs         = ${((1.1 * params.rs) / 2).toFixed(2)};`);
        content = content.replace(/Motor2_f32Ld\s*=\s*[^;]+;/, `Motor2_f32Ld		    = ${Math.round(params.ld / 2)};`);
        content = content.replace(/Motor2_f32Lq\s*=\s*[^;]+;/, `Motor2_f32Lq		    = ${Math.round(params.lq / 2)};`);
        content = content.replace(/Motor2_f32Ke\s*=\s*[^;]+;/, `Motor2_f32Ke         = ${params.ke.toFixed(1)};`);

        // Update header guard
        const newHeaderGuard = `__${newFanFileName.replace('.h', '').toUpperCase()}_H__`;
        content = content.replace(/#ifndef\s+_*[A-Z0-9_]+_H__*/, `#ifndef ${newHeaderGuard}`);
        content = content.replace(/#define\s+_*[A-Z0-9_]+_H__*/, `#define ${newHeaderGuard}`);
        
        fs.writeFileSync(newFilePath, content);
    }

    private getFanModels(document: vscode.TextDocument): { name: string, value: number, line: number }[] {
        const text = document.getText();
        const lines = text.split(/\r?\n/);
        const fanModels: { name: string, value: number, line: number }[] = [];
        const fanRegex = /#define\s+(MOTOR2_[A-Z0-9_]+)\s+([0-9]+)/;

        let lastLine = -1;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const match = line.match(fanRegex);
            if (match) {
                // Heuristic: fan model definitions are contiguous. A big jump in line numbers
                // indicates we've moved to a different section of the file.
                if (lastLine !== -1 && (i - lastLine) > 10) { 
                    break;
                }
                fanModels.push({ name: match[1], value: parseInt(match[2]), line: i });
                lastLine = i;
            }
        }
        return fanModels;
    }

    private async updateCustomH(uri: vscode.Uri, referenceFan: { name: string, value: number, line: number }, newFanName: string): Promise<void> {
        // FINAL, DEFINITIVE STRATEGY 11.0: Find boundaries, delete everything in between, and rebuild correctly.

        const document = await vscode.workspace.openTextDocument(uri);
        const fanModels = this.getFanModels(document);
        const lines = document.getText().split(/\r?\n/);

        if (fanModels.length === 0) {
            throw new Error('在 Custom.h 中未找到风机型号定义块。');
        }
        
        // 1. Find the anchor line index.
        const anchorRegex = /^\s*#if\s*\(\s*MODEL_TYPE\s*==\s*MODEL_YUETU_AIRCONDITION\s*\)/;
        const anchorIndex = lines.findIndex(line => anchorRegex.test(line));

        if (anchorIndex === -1) {
            throw new Error(`在 Custom.h 中未能使用正则表达式定位到锚点 "#if (MODEL_TYPE == MODEL_YUETU_AIRCONDITION)"。请检查该行是否存在。`);
        }
        
        // 2. Scan FORWARDS to find the *actual* last fan definition before the anchor.
        let lastFanInBlockIndex = -1;
        const fanRegex = /^\s*#define\s+MOTOR2_/;
        for (let i = 0; i < anchorIndex; i++) {
            if (fanRegex.test(lines[i])) {
                lastFanInBlockIndex = i;
            }
        }
        
        if (lastFanInBlockIndex === -1) {
            throw new Error(`在锚点 "#if..." 上方未能找到任何有效的 "#define MOTOR2_" 风机定义。`);
        }

        const alignmentLine = document.lineAt(lastFanInBlockIndex);
        
        // 3. Calculate alignment based on the true last line.
        const valueMatch = alignmentLine.text.match(/\s+([0-9]+)/);
        const valueColumn = valueMatch ? valueMatch.index! + valueMatch[0].length - valueMatch[1].length : 48;

        // 4. Construct the new line content.
        const newFanValue = Math.max(...fanModels.map(f => f.value)) + 1;
        const newFanDefine = `MOTOR2_${newFanName.toUpperCase()}`;
        const definePart = `#define ${newFanDefine}`;
        const spacesNeeded = Math.max(1, valueColumn - definePart.length);
        const newLineContent = `${definePart}${' '.repeat(spacesNeeded)}${newFanValue}`;

        // 5. Delete the space between the last fan and the anchor, then insert the new macro with a blank line.
        const edit = new vscode.WorkspaceEdit();
        const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';

        // Define the range to be replaced: from the line after the last fan to the line just before the anchor.
        const startReplacePos = new vscode.Position(lastFanInBlockIndex + 1, 0);
        const endReplacePos = new vscode.Position(anchorIndex, 0);
        const rangeToDelete = new vscode.Range(startReplacePos, endReplacePos);

        // The content to insert: the new macro, followed by a blank line.
        const contentToInsert = newLineContent + eol + eol;
        
        edit.replace(uri, rangeToDelete, contentToInsert);
        await vscode.workspace.applyEdit(edit);
    }

    private async updateCustomerInterface(uri: vscode.Uri, newFanName: string): Promise<void> {
        const document = await vscode.workspace.openTextDocument(uri);
        const text = document.getText();
        const lines = text.split(/\r?\n/);

        const errorLineText = '#error "NO MOTOR_TYPE"';
        let errorLineIndex = -1;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(errorLineText)) {
                errorLineIndex = i;
                break;
            }
        }

        if (errorLineIndex === -1) {
            throw new Error(`在 customerInterface2.c 中未找到错误指令 "${errorLineText}"。`);
        }

        const elseIndex = errorLineIndex - 1; 
        if (elseIndex < 0 || !lines[elseIndex].trim().startsWith('#else')) {
            throw new Error('在 customerInterface2.c 中 #error 指令前未找到匹配的 #else 指令。');
        }

        const newFanModelName = newFanName.toUpperCase();
        const fanFileName = newFanName.replace(/_DEBUG$/, '');

        const newBlock = `#elif (MOTOR2_TYPE == MOTOR2_${newFanModelName})\n#include "FocFans/${fanFileName}.h"`;

        const position = new vscode.Position(elseIndex, 0);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, position, newBlock + '\n');
        await vscode.workspace.applyEdit(edit);
    }
    
    private async updateFanNameTable(uri: vscode.Uri, newFanName: string): Promise<void> {
        const document = await vscode.workspace.openTextDocument(uri);
        const text = document.getText();
        const lines = text.split(/\r?\n/);
    
        const errorLineText = '#error "BAD FAN NAME DEFINE"';
        let errorLineIndex = -1;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(errorLineText)) {
                errorLineIndex = i;
                break;
            }
        }

        if (errorLineIndex === -1) {
            throw new Error(`在 focfanName_Table.h 中未找到错误指令 "${errorLineText}"。`);
        }
        
        const elseIndex = errorLineIndex - 1; 
        if (elseIndex < 0 || !lines[elseIndex].trim().startsWith('#else')) {
            throw new Error('在 focfanName_Table.h 中 #error 指令前未找到匹配的 #else 指令。');
        }
        
        const newFanModelName = newFanName.toUpperCase();
        const fanName = newFanName.replace(/_DEBUG$/, '');

        const newBlock = `#elif (MOTOR2_TYPE == MOTOR2_${newFanModelName})\n#define FAN_NAME "${fanName}"`;
    
        const position = new vscode.Position(elseIndex, 0);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, position, newBlock + '\n');
        await vscode.workspace.applyEdit(edit);
    }

    private async selectReferenceFan(uri: vscode.Uri): Promise<{ name: string, value: number, line: number } | undefined> {
        const document = await vscode.workspace.openTextDocument(uri);
        const fans = this.getFanModels(document).map(def => ({
            label: def.name.replace('MOTOR2_', ''), // for QuickPick
            name: def.name.replace('MOTOR2_', ''),
            value: def.value,
            line: def.line
        }));

        if (fans.length === 0) {
            vscode.window.showErrorMessage('在 Custom.h 中未找到有效的风机型号定义。');
            return;
        }

        const selected = await vscode.window.showQuickPick(fans, {
            placeHolder: '请选择一个参考风机型号',
            ignoreFocusOut: true,
        });
        
        return selected ? { name: selected.name, value: selected.value, line: selected.line } : undefined;
    }

    private async inputNewFanName(defaultName: string): Promise<string | undefined> {
        return await vscode.window.showInputBox({
            prompt: '请输入新的风机型号名称',
            value: defaultName,
            validateInput: value => {
                if (!value) return '名称不能为空';
                if (!/^[A-Z0-9_]+$/.test(value)) return '名称只能包含大写字母、数字和下划线。';
                return null;
            },
            ignoreFocusOut: true
        });
    }

    private async inputFanParameter(paramName: string, prompt: string): Promise<number | undefined> {
        const value = await vscode.window.showInputBox({
            prompt: `${prompt} (${paramName})`,
            validateInput: val => {
                if (!val || isNaN(parseFloat(val))) {
                    return '请输入一个有效的数字';
                }
                return null;
            },
            ignoreFocusOut: true
        });
        return value ? parseFloat(value) : undefined;
    }
}

