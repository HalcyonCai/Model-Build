const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 确保out目录存在
if (!fs.existsSync('out')) {
    console.log('编译插件...');
    execSync('npm run compile', { stdio: 'inherit' });
}

// 安装vsce（如果还没有安装）
try {
    execSync('vsce --version', { stdio: 'ignore' });
} catch (error) {
    console.log('安装vsce...');
    execSync('npm install -g vsce', { stdio: 'inherit' });
}

// 打包插件
console.log('打包插件...');
execSync('vsce package', { stdio: 'inherit' });

console.log('插件打包完成！');
