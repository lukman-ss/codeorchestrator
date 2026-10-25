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
    if (!this.config.allowedChannelIds || this.config.allowedChannelIds.length === 0) {
      return false;
    }
    if (this.config.allowedChannelIds.includes('*')) return true;
    return this.config.allowedChannelIds.includes(channelId);
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

  canExecuteCommand(subcommand, userId, memberRoles = []) {
    if (!this.isUserAllowed(userId, memberRoles)) return false;

    // Administrative commands like cancel can require specific admin rights
    if (subcommand === 'cancel') {
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

    // 3. Enforce channel allowlist
    if (!this.isChannelAllowed(interaction.channelId)) {
      return { allowed: false, reason: 'Commands cannot be executed in this channel.' };
    }

    // 4. Extract roles
    const memberRoles = interaction.member?.roles?.cache
      ? Array.from(interaction.member.roles.cache.keys())
      : Array.isArray(interaction.member?.roles)
      ? interaction.member.roles
      : [];

    // 5. Enforce user / role allowlist
    const userId = interaction.user?.id || interaction.userId;
    if (!this.isUserAllowed(userId, memberRoles)) {
      return { allowed: false, reason: 'You are not authorized to use CodeOrchestrator.' };
    }

    // 6. Enforce command-level permissions
    if (subcommand && !this.canExecuteCommand(subcommand, userId, memberRoles)) {
      return { allowed: false, reason: `You are not authorized to run the '/code ${subcommand}' command.` };
    }

    return { allowed: true };
  }
}

export default new AuthorizationService();
