import { NodeSSH } from 'node-ssh';
import path from 'path';

const ssh = new NodeSSH();

async function deploy() {
  try {
    console.log('Connecting to server 101.34.246.121...');
    await ssh.connect({
      host: '101.34.246.121',
      username: 'root',
      password: 'Sy060708',
      tryKeyboard: true,
      onKeyboardInteractive: (name, instructions, instructionsLang, prompts, finish) => {
        console.log('Keyboard interactive prompt: ', prompts);
        if (prompts.length > 0 && prompts[0].prompt.toLowerCase().includes('password')) {
          finish(['Sy060708']);
        } else {
          finish([]);
        }
      }
    });
    console.log('Connected!');

    const remoteDir = '/root/qq-openai-bridge';
    const localDir = 'D:/vibe_coding/teamtoapi';

    console.log(`Creating directory ${remoteDir} on server...`);
    await ssh.execCommand(`mkdir -p ${remoteDir}`);

    console.log('Uploading files...');
    const ignoreList = ['node_modules', '.git', 'deploy.js'];
    await ssh.putDirectory(localDir, remoteDir, {
      recursive: true,
      concurrency: 10,
      validate: (itemPath) => {
        const baseName = path.basename(itemPath);
        return !ignoreList.includes(baseName);
      }
    });

    console.log('Upload complete. Installing dependencies on server...');
    const resultInstall = await ssh.execCommand('npm install --production', { cwd: remoteDir });
    console.log('npm install output:', resultInstall.stdout);
    if (resultInstall.stderr) console.error('npm install error:', resultInstall.stderr);

    console.log('Starting server via pm2 (if installed) or node bg...');
    await ssh.execCommand('npm install -g pm2', { cwd: remoteDir }); // ensure pm2
    await ssh.execCommand('pm2 stop qq-bridge || true', { cwd: remoteDir });
    const resultStart = await ssh.execCommand('pm2 start src/index.js --name qq-bridge', { cwd: remoteDir });
    console.log('Server started!', resultStart.stdout);

    ssh.dispose();
  } catch (err) {
    console.error('Error during deployment:', err.message);
    ssh.dispose();
  }
}

deploy();
