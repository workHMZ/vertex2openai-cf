import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import readline from 'node:readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const generateApiKey = () => {
  return crypto.randomBytes(16).toString('hex');
};

const runCommand = (command, input, allowFail = false) => {
  try {
    if (input) {
      execSync(command, { input, stdio: ['pipe', 'inherit', 'inherit'] });
    } else {
      execSync(command, { stdio: 'inherit' });
    }
  } catch (error) {
    console.error(`⚠️ Command failed: ${command}`);
    if (!allowFail) {
      process.exit(1);
    } else {
      console.log('⏩ Continuing deployment despite the error above...');
    }
  }
};

const main = async () => {
  // Skip interactive setup in CI environments (like Cloudflare Dashboard)
  if (process.env.CI || !process.stdout.isTTY) {
    console.log('🚀 CI environment detected. Skipping interactive setup and deploying directly...');
    runCommand('npx wrangler deploy');
    return;
  }

  console.log('🚀 Starting deployment setup...');
  
  // 1. API_KEY setup
  const apiKeyInput = await new Promise(resolve => {
    rl.question('\n📝 Do you want to update the API_KEY? (Press Enter to SKIP if already set, type "random" to generate, or paste your new key):\n> ', resolve);
  });

  const normalizedInput = apiKeyInput.trim();
  if (normalizedInput.toLowerCase() === 'random') {
    const apiKey = generateApiKey();
    console.log(`\n🔑 Generated random API_KEY for your adapter: \x1b[32m${apiKey}\x1b[0m`);
    console.log('   (Make sure to save this key! You will need it for API authentication.)');
    console.log('\nSetting API_KEY secret in Cloudflare...');
    runCommand('npx wrangler secret put API_KEY', apiKey, true);
  } else if (normalizedInput !== '') {
    console.log('\nSetting custom API_KEY secret in Cloudflare...');
    runCommand('npx wrangler secret put API_KEY', normalizedInput, true);
  } else {
    console.log('\n⏩ Skipping API_KEY setup.');
  }

  // 2. Prompt for Vertex AI API Key
  const vertexKey = await new Promise(resolve => {
    rl.question('\n📝 Enter your Vertex AI Express API Key (Press Enter to skip if already set or using Service Account):\n> ', resolve);
  });

  if (vertexKey.trim()) {
    console.log('\nSetting VERTEX_EXPRESS_API_KEY secret in Cloudflare...');
    runCommand('npx wrangler secret put VERTEX_EXPRESS_API_KEY', vertexKey.trim(), true);
  } else {
    console.log('\n⏩ Skipping Vertex AI Express API Key setup.');
  }

  // 3. Deploy
  console.log('\n⚡ Deploying to Cloudflare Workers...');
  runCommand('npx wrangler deploy');

  console.log('\n✅ Deployment process completed!');
  rl.close();
};

main();
