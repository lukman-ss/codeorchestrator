import {
  Client,
  GatewayIntentBits,
  REST,
  Routes
} from 'discord.js';
import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import config from './config.js';
import apiClient from './api-client.js';
import persistence from './persistence.js';
import auth from './authorization.js';
import { OrchestratorEventListener } from './event-listener.js';
import codeCommand, { data as codeCommandData } from './commands/code.js';
import {
  safeMentions,
  safeReply,
  safeEditReply,
  formatErrorPayload,
  redactSensitive
} from './notifications.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PID_FILE = resolve(__dirname, '../bridge.pid');

export class DiscordBridgeApp {
  constructor(cfg = config) {
    this.config = cfg;
    this.client = null;
    this.eventListener = null;
    this.isShuttingDown = false;
  }

  acquireLock() {
    const pidFile = this.config?.pidFile || PID_FILE;
    if (existsSync(pidFile)) {
      try {
        const oldPid = parseInt(readFileSync(pidFile, 'utf8'), 10);
        if (oldPid && !isNaN(oldPid)) {
          if (oldPid === process.pid) {
            return;
          }
          // Check if process is still alive
          try {
            process.kill(oldPid, 0);
            throw new Error(`Another Discord Bridge instance is already running with PID ${oldPid}`);
          } catch (e) {
            if (e.code === 'ESRCH') {
              // Stale PID file, can overwrite
            } else {
              throw e;
            }
          }
        }
      } catch (err) {
        if (!err.message.includes('ESRCH')) throw err;
      }
    }
    writeFileSync(pidFile, process.pid.toString(), 'utf8');
  }

  releaseLock() {
    try {
      const pidFile = this.config?.pidFile || PID_FILE;
      if (existsSync(pidFile)) {
        const storedPid = parseInt(readFileSync(pidFile, 'utf8'), 10);
        if (storedPid === process.pid) {
          unlinkSync(pidFile);
        }
      }
    } catch {}
  }

  async registerSlashCommands() {
    if (!this.config.token || !this.config.clientId) {
      console.warn('[DiscordBridge] Missing DISCORD_BOT_TOKEN or DISCORD_CLIENT_ID; skipping slash command registration.');
      return false;
    }

    const rest = new REST({ version: '10' }).setToken(this.config.token);
    const commandsJson = [codeCommandData.toJSON()];

    try {
      if (this.config.guildId) {
        console.log(`[DiscordBridge] Registering slash commands for guild ${this.config.guildId}...`);
        await rest.put(
          Routes.applicationGuildCommands(this.config.clientId, this.config.guildId),
          { body: commandsJson }
        );
      } else {
        console.log('[DiscordBridge] Registering slash commands globally...');
        await rest.put(
          Routes.applicationCommands(this.config.clientId),
          { body: commandsJson }
        );
      }
      console.log('[DiscordBridge] Successfully registered slash commands.');
      return true;
    } catch (err) {
      console.error('[DiscordBridge] Failed to register slash commands:', err.message);
      return false;
    }
  }

  async start() {
    this.acquireLock();

    // Verify Orchestrator API connectivity
    try {
      const health = await apiClient.getHealth();
      console.log(`[DiscordBridge] Connected to CodeOrchestrator at ${this.config.apiUrl} (status: ${health.status})`);
    } catch (err) {
      console.warn(`[DiscordBridge] Warning: Could not reach CodeOrchestrator health endpoint: ${err.message}`);
    }

    if (!this.config.token) {
      console.warn('[DiscordBridge] DISCORD_BOT_TOKEN is not configured. Standing by in offline mode.');
      return;
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages
      ]
    });

    this.eventListener = new OrchestratorEventListener(
      apiClient,
      persistence,
      this.client,
      this.config
    );

    // Setup Discord interaction router
    this.client.on('interactionCreate', async (interaction) => {
      try {
        if (interaction.isChatInputCommand()) {
          if (interaction.commandName === 'code') {
            await codeCommand.execute(interaction, this.eventListener);
          }
        } else if (interaction.isAutocomplete()) {
          if (interaction.commandName === 'code') {
            await codeCommand.handleAutocomplete(interaction);
          }
        } else if (interaction.isButton()) {
          await this.handleButtonInteraction(interaction);
        }
      } catch (err) {
        console.error('[DiscordBridge] Error handling interaction:', err);
        try {
          if (interaction.isRepliable()) {
            const errPayload = formatErrorPayload(err, { type: 'interaction_error', ephemeral: true });
            if (interaction.deferred || interaction.replied) {
              await safeEditReply(interaction, errPayload, { type: 'interaction_error' });
            } else {
              await safeReply(interaction, errPayload, { type: 'interaction_error' });
            }
          }
        } catch {}
      }
    });

    this.client.once('ready', async (c) => {
      console.log(`[DiscordBridge] Logged in as ${c.user.tag} (ID: ${c.user.id})`);
      // Start real-time event listener
      this.eventListener.start();
      // Register commands
      await this.registerSlashCommands();
    });

    await this.client.login(this.config.token);
  }

  async handleButtonInteraction(interaction) {
    if (interaction.customId.startsWith('confirm_cancel:')) {
      const id = interaction.customId.replace('confirm_cancel:', '');

      const authCheck = auth.validateInteraction(interaction, 'cancel');
      if (!authCheck.allowed) {
        return safeReply(interaction, {
          content: `❌ **Access Denied**: ${authCheck.reason}`,
          ephemeral: true,
          allowedMentions: safeMentions
        }, { type: 'auth_denied' });
      }

      await interaction.deferUpdate();

      try {
        let cancelRes;
        try {
          cancelRes = await apiClient.cancelJob(id);
        } catch {
          cancelRes = await apiClient.cancelTask(id);
        }

        persistence.updateExecution(id, { status: 'cancelled' });

        await safeEditReply(interaction, {
          content: `🛑 Execution \`${id}\` has been cancelled. Status: \`${cancelRes?.status || 'cancelled'}\`.`,
          components: [],
          allowedMentions: safeMentions
        }, { type: 'cancel_success' });
      } catch (err) {
        await safeEditReply(interaction, {
          content: redactSensitive(`❌ Failed to cancel \`${id}\`: ${err.message}`),
          components: [],
          allowedMentions: safeMentions
        }, { type: 'cancel_error' });
      }
    }
  }

  async shutdown(signal = 'SIGTERM') {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    console.log(`[DiscordBridge] Received ${signal}. Shutting down gracefully...`);

    if (this.eventListener) {
      this.eventListener.stop();
    }

    try {
      persistence.close();
    } catch {}

    if (this.client) {
      try {
        await this.client.destroy();
      } catch {}
    }

    this.releaseLock();
    console.log('[DiscordBridge] Shutdown complete.');
  }
}

// Standalone execution entrypoint
if (process.argv[1] && process.argv[1].endsWith('src/index.js')) {
  const app = new DiscordBridgeApp();

  process.on('SIGINT', () => {
    app.shutdown('SIGINT').then(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    app.shutdown('SIGTERM').then(() => process.exit(0));
  });

  app.start().catch((err) => {
    console.error('[DiscordBridge] Fatal startup error:', err);
    app.releaseLock();
    process.exit(1);
  });
}

export default DiscordBridgeApp;
