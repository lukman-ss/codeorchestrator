import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, GatewayIntentBits } from 'discord.js';
import config from '../src/config.js';

test('Real Discord gateway connectivity smoke test', async (t) => {
  if (!config.token) {
    t.skip('Real Discord smoke test: NOT TESTED (DISCORD_BOT_TOKEN is not configured in .env)');
    return;
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds]
  });

  try {
    await client.login(config.token);
    assert.ok(client.user?.id, 'Discord user ID must be available after login');
    console.log(`[SmokeTest] Connected successfully as ${client.user.tag}`);
  } finally {
    await client.destroy();
  }
});
