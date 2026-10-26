import { PermissionFlagsBits } from 'discord.js';
import config from './config.js';

export class AuthorizationService {
  constructor(cfg = config) {
    this.config = cfg;
  }

  isDmAllowed() {
    return false; // Default: disable DM execution
  }

  isGuildAllowed(guildId) {
    if (!guildId) return false;
    // Default to deny if no allowlist configured
    if (!this.config.allowedGuildIds || this.config.allowedGuildIds.length === 0) {
      return false;
    }
    if (this.config.allowedGuildIds.includes('*')) return true;
    return this.config.allowedGuildIds.includes(guildId);
  }

  isChannelAllowed(channelId) {
    if (!channelId) return false;
    // Optional allowlist: empty or unset automatically allows all channels accessible to the bot
    if (!this.config.allowedChannelIds || this.config.allowedChannelIds.length === 0) {
      return true;
    }
    if (this.config.allowedChannelIds.includes('*')) return true;
    return this.config.allowedChannelIds.includes(channelId);
  }

  hasBotPermissions(interaction) {
    if (!interaction) return false;

    // Check interaction.botPermissions if explicitly provided (e.g. testing)
    if (interaction.botPermissions !== undefined) {
      if (typeof interaction.botPermissions?.has === 'function') {
        const p = interaction.botPermissions;
        return Boolean(
          (p.has(PermissionFlagsBits.ViewChannel) || p.has('ViewChannel')) &&
          (p.has(PermissionFlagsBits.SendMessages) || p.has('SendMessages'))
        );
      }
      if (typeof interaction.botPermissions === 'boolean') {
        return interaction.botPermissions;
      }
    }

    // Check interaction.appPermissions (Discord standard on interaction payloads)
    if (interaction.appPermissions) {
      if (typeof interaction.appPermissions.has === 'function') {
        const p = interaction.appPermissions;
        return Boolean(
          (p.has(PermissionFlagsBits.ViewChannel) || p.has('ViewChannel')) &&
          (p.has(PermissionFlagsBits.SendMessages) || p.has('SendMessages'))
        );
      }
      if (typeof interaction.appPermissions === 'boolean') {
        return interaction.appPermissions;
      }
    }

    // Check channel.permissionsFor if channel object exists
    if (interaction.channel && typeof interaction.channel.permissionsFor === 'function') {
      const botMember = interaction.guild?.members?.me || interaction.client?.user;
      if (botMember) {
        const perms = interaction.channel.permissionsFor(botMember);
        if (perms && typeof perms.has === 'function') {
          return Boolean(
            (perms.has(PermissionFlagsBits.ViewChannel) || perms.has('ViewChannel')) &&
            (perms.has(PermissionFlagsBits.SendMessages) || perms.has('SendMessages'))
          );
        }
        if (typeof perms === 'boolean') {
          return perms;
        }
      }
    }

    return true;
  }

  isUserAllowed(userId, memberRoles = []) {
    if (!userId) return false;

    // Check user allowlist
    const userAllowed =
      (this.config.allowedUserIds && this.config.allowedUserIds.includes('*')) ||
      (this.config.allowedUserIds && this.config.allowedUserIds.includes(userId));

    if (userAllowed) return true;

    // Check role allowlist
    if (this.config.allowedRoleIds && this.config.allowedRoleIds.length > 0 && Array.isArray(memberRoles)) {
      const hasAllowedRole = memberRoles.some(r => this.config.allowedRoleIds.includes(r));
      if (hasAllowedRole) return true;
    }

    return false;
  }

  isProjectAllowedForUser(userId, memberRoles = [], project) {
    if (!project) return false;
    const projectSlug = project.slug || project;
    const projectId = project.id || project;

    // Creator always has permission to their own project
    if (typeof project === 'object' && project !== null) {
      if (project.creator_user_id === userId || project.user_id === userId || project.metadata?.createdByUserId === userId) {
        return true;
      }
    }

    // 1. Check user-specific project mappings first if configured
    if (this.config.userProjects && this.config.userProjects[userId]) {
      const allowedList = this.config.userProjects[userId];
      return allowedList.includes(projectId) || allowedList.includes(projectSlug);
    }

    // 2. Check global allowed projects
    if (!this.config.allowedProjects || this.config.allowedProjects.length === 0) {
      return false;
    }
    if (this.config.allowedProjects.includes('*')) return true;
    return this.config.allowedProjects.includes(projectId) || this.config.allowedProjects.includes(projectSlug);
  }

  isSessionAllowedForUser(userId, memberRoles = [], session) {
    if (!session) return false;
    if (!this.isUserAllowed(userId, memberRoles)) return false;

    const isAdmin =
      (this.config.adminUserIds && this.config.adminUserIds.includes(userId)) ||
      (this.config.adminRoleIds && memberRoles.some(r => this.config.adminRoleIds.includes(r)));

    if (session.session_type === 'standalone') {
      if (!session.user_id) return true;
      if (session.user_id === userId || isAdmin) return true;
      return false;
    }

    if (session.session_type === 'project' || session.project_id) {
      return this.isProjectAllowedForUser(userId, memberRoles, session.project_id);
    }

    return true;
  }

  canExecuteCommand(subcommand, userId, memberRoles = []) {
    if (!this.isUserAllowed(userId, memberRoles)) return false;

    // Privileged administrative commands require specific admin rights
    if (subcommand === 'cancel' || subcommand === 'project:create' || subcommand === 'project:import') {
      const hasAdminUsers = this.config.adminUserIds && this.config.adminUserIds.length > 0;
      const hasAdminRoles = this.config.adminRoleIds && this.config.adminRoleIds.length > 0;

      if (hasAdminUsers || hasAdminRoles) {
        const isAdminUser = hasAdminUsers && this.config.adminUserIds.includes(userId);
        const hasAdminRole = hasAdminRoles && memberRoles.some(r => this.config.adminRoleIds.includes(r));
        return isAdminUser || hasAdminRole;
      }
    }

    return true;
  }

  validateInteraction(interaction, subcommand = null) {
    // 1. Enforce guild context (no DMs)
    if (!interaction.guildId || !interaction.inGuild?.()) {
      return { allowed: false, reason: 'Command execution is not permitted in Direct Messages.' };
    }

    // 2. Enforce guild allowlist
    if (!this.isGuildAllowed(interaction.guildId)) {
      return { allowed: false, reason: 'This server is not authorized to execute CodeOrchestrator commands.' };
    }

    // 3. Enforce channel allowlist (optional: empty/unset allows all bot-accessible channels)
    if (!this.isChannelAllowed(interaction.channelId)) {
      return { allowed: false, reason: 'Commands cannot be executed in this channel.' };
    }

    // 4. Enforce bot Discord permissions in channel
    if (!this.hasBotPermissions(interaction)) {
      return { allowed: false, reason: 'Bot lacks required channel permissions (ViewChannel, SendMessages).' };
    }

    // 5. Extract roles
    const memberRoles = interaction.member?.roles?.cache
      ? Array.from(interaction.member.roles.cache.keys())
      : Array.isArray(interaction.member?.roles)
      ? interaction.member.roles
      : [];

    // 6. Enforce user / role allowlist
    const userId = interaction.user?.id || interaction.userId;
    if (!this.isUserAllowed(userId, memberRoles)) {
      return { allowed: false, reason: 'You are not authorized to use CodeOrchestrator.' };
    }

    // 7. Enforce command-level permissions
    if (subcommand && !this.canExecuteCommand(subcommand, userId, memberRoles)) {
      return { allowed: false, reason: `You are not authorized to run the '/code ${subcommand}' command.` };
    }

    return { allowed: true };
  }
}

export default new AuthorizationService();
