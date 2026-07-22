import 'dotenv/config';
import {
  Client,
  Collection,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ChannelType,
  PermissionsBitField,
  ButtonBuilder,
  ButtonStyle
} from 'discord.js';
import { REST } from '@discordjs/rest';
import express from 'express';
import cron from 'node-cron';

import config from './config/application.js';
import { initializeDatabase } from './utils/database.js';
import { getGuildConfig } from './services/config/guildConfig.js';
import { getServerCounters, saveServerCounters, updateCounter } from './services/serverstatsService.js';
import { logger, startupLog, shutdownLog } from './utils/logger.js';
import { checkBirthdays } from './services/birthdayService.js';
import { checkGiveaways } from './services/giveawayService.js';
import { loadCommands, registerCommands as registerSlashCommands } from './handlers/loaders/commandLoader.js';
import { runSafeTask, handleTaskError, ErrorCodes } from './utils/errorHandler.js';
import { initializeMusic } from './services/music/riffySetup.js';
import { shutdownMusic } from './services/music/playerHandler.js';
import pkg from '../package.json' with { type: 'json' };
import { EXPECTED_SCHEMA_VERSION, EXPECTED_SCHEMA_LABEL } from './config/database/schemaVersion.js';

class TitanBot extends Client {
  constructor() {
    super({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildBans,
  ],
  partials: [Partials.Channel],
});


    this.config = config;
    this.commands = new Collection();
    this.events = new Collection();
    this.buttons = new Collection();
    this.selectMenus = new Collection();
    this.modals = new Collection();
    this.cooldowns = new Collection();
this.tickets = new Map();
this.db = null;
    this.rest = new REST({ version: '10' }).setToken(config.bot.token);
    this.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  // Only handle DMs
  if (message.channel.type !== ChannelType.DM) return;
      
      // User already has an open ticket
if (this.tickets.has(message.author.id)) {
    const channelId = this.tickets.get(message.author.id);
    let channel;

try {
    channel = await this.channels.fetch(channelId);
} catch (error) {
    logger.error("Failed fetching modmail channel:", error);
    this.tickets.delete(message.author.id);
    return;
}


    if (channel) {
        await channel.send({
            embeds: [
                new EmbedBuilder()
                    .setColor("#F2530A")
                    .setAuthor({
                        name: message.author.tag,
                        iconURL: message.author.displayAvatarURL()
                    })
                    .setDescription(message.content)
                    .setTimestamp()
            ]
        });
    }

    return;
}


  const embed = new EmbedBuilder()
    .setColor("#5865F2")
    .setTitle("Mod Mail - Contact Selection")
    .setDescription(
`Please select who you would like to contact:

👤 **Admin**
• Contacting an admin
• Claiming event rewards
• Partnerships
• Reporting staff

🛡️ **Moderator**
• Reporting a problem
• Reporting someone for breaking rules


Select a team below to contact the staff`
    )
    .setTimestamp();


  const menu = new StringSelectMenuBuilder()
    .setCustomId("modmail_team")
    .setPlaceholder("Select a team")
    .addOptions([
      {
        label: "Admin",
        description: "Contact an admin",
        value: "admin",
        emoji: "👤"
      },
      {
        label: "Moderator",
        description: "Contact moderators",
        value: "moderator",
        emoji: "🛡️"
      }
    ]);


  try {
  await message.channel.send({
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(menu)
    ]
  });
} catch (error) {
  logger.error("Failed sending modmail menu:", error);
}

});

    this.on("messageCreate", async (message) => {
    if (message.author.bot) return;

    if (!message.guild) return;

    const ticketUser = [...this.tickets.entries()]
.find(([userId, channelId]) => channelId === message.channel.id);

if (!ticketUser) return;

const userId = ticketUser[0];

try {
    const user = await this.users.fetch(userId);

    await user.send({
        embeds: [
            new EmbedBuilder()
                .setColor("#57F287")
                .setAuthor({
                    name: message.author.tag,
                    iconURL: message.author.displayAvatarURL()
                })
                .setDescription(message.content)
                .setTimestamp()
        ]
    });

} catch (error) {
    logger.error("Failed sending modmail reply to user:", error);
}

});


} // <-- this closes constructor()

async setupModmail() {

  this.on("interactionCreate", async (interaction) => {

    if (!interaction.isStringSelectMenu()) return;

    if (interaction.customId !== "modmail_team") return;


    const team = interaction.values[0];
    
    if (this.tickets.has(interaction.user.id)) {
  return interaction.reply({
    content: "You already have an open ticket.",
    ephemeral: true
  });
      
}

    const guild = this.guilds.cache.get("1522634540223561768");


    if (!guild) {
      return interaction.reply({
        content: "Server not found.",
        ephemeral: true
      });
    }


    const channel = await guild.channels.create({
  name: `modmail-${interaction.user.username}`,
  type: ChannelType.GuildText,
  parent: "1523735590535958618", // Your category ID here

  permissionOverwrites: [

  // Hide from everyone
  {
    id: guild.roles.everyone.id,
    deny: [
      PermissionsBitField.Flags.ViewChannel
    ]
  },


  // Ticket creator can see their ticket
  {
    id: interaction.user.id,
    allow: [
      PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.SendMessages,
      PermissionsBitField.Flags.ReadMessageHistory
    ]
  },


  // Admin tickets
  ...(team === "admin" ? [
    {
      id: "1527965125879795803", // ADMIN ROLE ID
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory
      ]
    },

    // Block moderators from admin tickets
    {
      id: "1523251341277925407", // MOD ROLE ID
      deny: [
        PermissionsBitField.Flags.ViewChannel
      ]
    }
  ] : []),



  // Moderator tickets
  ...(team === "moderator" ? [
    {
      id: "1523251341277925407", // MOD ROLE ID
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory
      ]
    },

    // Admins can still view moderator tickets
    {
      id: "1527965125879795803", // ADMIN ROLE ID
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory
      ]
    }
  ] : [])

]

});



    this.tickets.set(
      interaction.user.id,
      channel.id
    );


    await channel.send({

content: team === "admin"
? "<@&1527965125879795803>"
: "<@&1523251341277925407>",


allowedMentions:{
    roles:[
      "1527965125879795803",
      "1523251341277925407"
    ],
    users:[
      interaction.user.id
    ]
},


embeds:[
new EmbedBuilder()
.setColor("#5865F2")
.setTitle("📩 New Mod Mail")
.setDescription(
`User: <@${interaction.user.id}>

Department:
**${team === "admin" ? "Admin" : "Moderator"}**

A staff member will respond soon.`
)
.setTimestamp()
],


components:[
new ActionRowBuilder()
.addComponents(
new ButtonBuilder()
.setCustomId("close_ticket")
.setLabel("Close Ticket")
.setEmoji("🔒")
.setStyle(ButtonStyle.Danger)
)
]

});



    await interaction.reply({
      content: "Your request has been sent to staff.",
      ephemeral: true
    });

  });
// CLOSE TICKET BUTTON HANDLER
this.on("interactionCreate", async (interaction) => {

  if (!interaction.isButton()) return;

  if (interaction.customId !== "close_ticket") return;


  // Check if user is staff
  if (
    !interaction.member.roles.cache.has("1527965125879795803") &&
    !interaction.member.roles.cache.has("1523251341277925407")
  ) {

    return interaction.reply({
      content: "❌ You cannot close this ticket.",
      ephemeral: true
    });

  }


  await interaction.reply({
    content: "🔒 Closing ticket...",
    ephemeral: true
  });



  // Remove ticket from active tickets
  for (const [userId, channelId] of this.tickets) {

    if (channelId === interaction.channel.id) {

      this.tickets.delete(userId);

      break;

    }

  }



  // Delete channel after 3 seconds
  setTimeout(() => {

    interaction.channel.delete("Ticket closed");

  }, 3000);


});

}

async start() {
  try {
    startupLog('Starting TitanBot...');

      await new Promise(resolve => setTimeout(resolve, 1000));
      
      startupLog('Initializing database...');
      const dbInstance = await initializeDatabase();
      this.db = dbInstance.db;

      // Check database status and report
      const dbStatus = this.db.getStatus();
      if (dbStatus.isDegraded) {
        logger.warn('');
        logger.warn('╔═══════════════════════════════════════════════════════╗');
        logger.warn('║ ⚠️  DATABASE RUNNING IN DEGRADED MODE                 ║');
        logger.warn('║                                                       ║');
        logger.warn('║ Connection: In-Memory Storage (PostgreSQL unavailable)║');
        logger.warn('║ Data Persistence: DISABLED - data lost on restart    ║');
        logger.warn('║ Action Required: Fix PostgreSQL and restart bot      ║');
        logger.warn('╚═══════════════════════════════════════════════════════╝');
        logger.warn('');
      } else {
        startupLog(`✅ Database Status: ${dbStatus.connectionType} (fully operational)`);
      }
      
      startupLog('Starting web server...');
      this.startWebServer();
      
      startupLog('Loading commands...');
      await loadCommands(this);
      startupLog(`Commands loaded: ${this.commands.size}`);
      
      startupLog('Loading handlers...');
      await this.loadHandlers();
      startupLog('Handlers loaded');

    await this.setupModmail();
    
      initializeMusic(this);
      
      startupLog(`Token exists: ${!!this.config.bot.token}`);
startupLog(`Token length: ${this.config.bot.token?.length || 0}`);
startupLog(`Client ID: ${this.config.bot.clientId}`);

startupLog('Logging into Discord...');

try {
  const loginPromise = this.login(this.config.bot.token);

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error("Discord login timed out after 30 seconds"));
    }, 30000);
  });

  await Promise.race([loginPromise, timeoutPromise]);

  startupLog('Discord login successful');
} catch (err) {
  console.error('LOGIN FAILED:', err);
  logger.error('LOGIN FAILED:', err);
  throw err;
}
      
      startupLog('Registering slash commands globally...');
      await this.registerCommands();
      startupLog('Slash commands registration complete');
      
      const databaseMode = dbStatus.isDegraded
        ? 'Optional in-memory mode (data resets after restart)'
        : 'Connected (persistent data enabled)';
      const handlerSummary = `${this.buttons.size} buttons, ${this.selectMenus.size} menus, ${this.modals.size} modals`;
      startupLog(
        `ONLINE ✅ | ${this.commands.size} commands loaded | ${handlerSummary} | Database: ${databaseMode}`
      );
      
      this.setupCronJobs();
    } catch (error) {
      logger.error('Failed to start bot:', error);
      process.exit(1);
    }
  }

  startWebServer() {
    const app = express();
    const configuredPort = Number(this.config.api?.port || process.env.PORT || 3000);
    const maxPortRetryAttempts = Number(process.env.PORT_RETRY_ATTEMPTS || 5);
    const host = process.env.WEB_HOST || '0.0.0.0';
    const corsOrigin = this.config.api?.cors?.origin || '*';
    
    app.use((req, res, next) => {
      const allowedOrigins = Array.isArray(corsOrigin) ? corsOrigin : [corsOrigin];
      const origin = req.headers.origin;
      
      if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin || '*');
      }
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      
      if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
      }
      next();
    });

    const requestCounts = new Map();
    const windowMs = this.config.api?.rateLimit?.windowMs || 60000;
    const maxRequests = this.config.api?.rateLimit?.max || 100;
    
    app.use((req, res, next) => {
      const ip = req.ip;
      const now = Date.now();
      const windowStart = now - windowMs;
      
      if (!requestCounts.has(ip)) {
        requestCounts.set(ip, []);
      }
      
      const times = requestCounts.get(ip).filter(t => t > windowStart);
      
      if (times.length >= maxRequests) {
        return res.status(429).json({ error: 'Too many requests' });
      }
      
      times.push(now);
      requestCounts.set(ip, times);
      next();
    });

    app.get('/health', (req, res) => {
      const dbStatus = this.db?.getStatus?.() || { isDegraded: 'unknown' };
      const status = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        database: {
          connected: dbStatus.connectionType !== 'none',
          degraded: dbStatus.isDegraded,
          type: dbStatus.connectionType
        }
      };
      res.status(200).json(status);
    });

    app.get('/ready', (req, res) => {
      const dbStatus = this.db?.getStatus?.() || { isDegraded: true, connectionType: 'none' };
      const isReady = this.isReady() && !dbStatus.isDegraded;

      const metrics = {
        guildCount: this.guilds?.cache?.size ?? 0,
        commandCount: this.commands?.size ?? 0,
        database: {
          mode: dbStatus.connectionType,
          degraded: dbStatus.isDegraded,
          degradedReason: dbStatus.degradedReason ?? null,
        },
        schemaVersion: EXPECTED_SCHEMA_VERSION,
        schemaLabel: EXPECTED_SCHEMA_LABEL,
      };

      if (isReady) {
        return res.status(200).json({
          ready: true,
          message: 'Bot is ready',
          metrics,
        });
      }

      res.status(503).json({
        ready: false,
        reason: !this.isReady() ? 'Bot not Ready' : 'Database degraded',
        metrics,
      });
    });

    app.get('/', (req, res) => {
      res.status(200).json({ 
        message: 'TitanBot System Online',
        version: pkg.version,
        timestamp: new Date().toISOString()
      });
    });

    const startServer = (port, attempt = 0) => {
      let hasStartedListening = false;
      const server = app.listen(port, host, () => {
        hasStartedListening = true;
        this.webServer = server;
        startupLog(`✅ Web Server running on ${host}:${port}`);
        startupLog(`Health endpoint: http://${host}:${port}/health`);
        startupLog(`Ready endpoint: http://${host}:${port}/ready`);
      });

      server.on('error', (error) => {
        const errorCode = error?.code || 'UNKNOWN_ERROR';
        const errorMessage = error?.message || 'Unknown server error';

        if (!hasStartedListening && errorCode === 'EADDRINUSE' && attempt < maxPortRetryAttempts) {
          const nextPort = port + 1;
          startupLog(`Port ${port} is already in use. Trying port ${nextPort}...`);
          setTimeout(() => startServer(nextPort, attempt + 1), 250);
          return;
        }

        if (hasStartedListening && errorCode === 'EADDRINUSE') {
          logger.warn(`Web server reported a duplicate bind warning on ${host}:${port}, but the bot remains online.`);
          return;
        }

        logger.error(`❌ Web server error on port ${port} (${errorCode}): ${errorMessage}`);

        if (!hasStartedListening) {
          process.exit(1);
        }
      });
    };

    startServer(configuredPort, 0);
  }

  setupCronJobs() {
    cron.schedule('0 6 * * *', runSafeTask('birthday_check', () => checkBirthdays(this)));
    cron.schedule('* * * * *', runSafeTask('giveaway_check', () => checkGiveaways(this)));
    cron.schedule('*/15 * * * *', runSafeTask('counter_update', () => this.updateAllCounters()));
  }

  async updateAllCounters() {
    if (!this.db) {
      logger.warn('Database not available for counter updates');
      return;
    }
    
    for (const [guildId, guild] of this.guilds.cache) {
      try {
        const counters = await getServerCounters(this, guildId);
        const validCounters = [];
        const orphanedCounters = [];
        
        for (const counter of counters) {
          if (counter && counter.type && counter.channelId && counter.enabled !== false) {
            const channel = guild.channels.cache.get(counter.channelId);
            if (channel) {
              validCounters.push(counter);
              await updateCounter(this, guild, counter);
            } else {
              orphanedCounters.push(counter);
              logger.info(`Removing orphaned counter ${counter.id} (type: ${counter.type}, deleted channel: ${counter.channelId}) from guild ${guildId}`);
            }
          }
        }
        
        // Save cleaned counters if any were orphaned
        // Save cleaned counters if any were orphaned
        if (orphanedCounters.length > 0) {
          await saveServerCounters(this, guildId, validCounters);
          logger.info(`Cleaned up ${orphanedCounters.length} orphaned counter(s) from guild ${guildId} during scheduled update`);
        }
      } catch (error) {
        logger.error(`Error updating counters for guild ${guildId}:`, error);
      }
    }
  }

  async loadHandlers() {
    startupLog('Loading handlers...');
    const handlers = [
      { path: 'events', type: 'default', required: true },
      { path: 'interactions', type: 'default', required: true }
    ];

    for (const handler of handlers) {
      try {
        startupLog(`Loading handler: ${handler.path}`);
        const module = await import(`./handlers/loaders/${handler.path}.js`);
        const loaderFn = handler.type.startsWith('named:')
          ? module[handler.type.split(':')[1]]
          : module.default;

        if (typeof loaderFn === 'function') {
          await loaderFn(this);
          startupLog(`✅ Loaded ${handler.path}`);
        } else {
          throw new Error(`Invalid loader export from ${handler.path}`);
        }
      } catch (error) {
        if (handler.required) {
          logger.error(`❌ Failed to load required handler ${handler.path}:`, error.message);
          throw error;
        } else if (error.code !== 'MODULE_NOT_FOUND') {
          logger.warn(`⚠️  Failed to load optional handler ${handler.path}:`, error.message);
        }
      }
    }
  }

  async registerCommands() {
    try {
      await registerSlashCommands(this, { clientId: this.config.bot.clientId });
    } catch (error) {
      logger.error('Error registering commands:', error);
    }
  }

  async shutdown(reason = 'UNKNOWN') {
    shutdownLog(`Bot is shutting down (${reason})...`);
    logger.info(`\n${'='.repeat(60)}`);
    logger.info(`🛑 Graceful Shutdown Initiated (${reason})`);
    logger.info(`${'='.repeat(60)}`);

    try {
      
      logger.info('Stopping cron jobs...');
      cron.getTasks().forEach(task => task.stop());
      logger.info('✅ Cron jobs stopped');

      logger.info('Stopping music players...');
      await shutdownMusic(this);
      logger.info('✅ Music players stopped');

      if (this.webServer) {
        logger.info('Closing web server...');
        await new Promise((resolve) => this.webServer.close(resolve));
        logger.info('✅ Web server closed');
      }

      // Close database connection
      // Close database connection
      if (this.db && this.db.db) {
        logger.info('Closing database connection...');
        try {
          if (this.db.db.pool) {
            await this.db.db.pool.end();
            logger.info('✅ Database connection closed');
          }
        } catch (error) {
          logger.warn('Error closing database pool:', error.message);
        }
      }

      logger.info('Destroying Discord client...');
      if (this.isReady()) {
        try {
          this.destroy();
          logger.info('✅ Discord client destroyed');
        } catch (error) {

          logger.warn('Discord client destroy warning (non-critical):', error.message);
        }
      }

      logger.info('✅ Graceful shutdown complete');
  shutdownLog('Bot stopped successfully.');
      process.exit(0);
    } catch (error) {
      logger.error('Error during graceful shutdown:', error);
      process.exit(1);
    }
  }
}

try {
  const bot = new TitanBot();
  
  const setupShutdown = () => {
    process.on('SIGTERM', () => bot.shutdown('SIGTERM'));
    process.on('SIGINT', () => bot.shutdown('SIGINT'));
    
    process.on('uncaughtException', (error) => {
      // Process state may be corrupt after an uncaught throw; log and shut down cleanly.
      handleTaskError('uncaught_exception', error, { fatal: true });
      bot.shutdown('UNCAUGHT_EXCEPTION');
    });

    process.on('unhandledRejection', (reason) => {
      const code = reason?.code;
      if (code === 10062 || code === 40060 || code === 50027) {
        logger.warn('Recoverable Discord interaction rejection:', reason?.message || reason);
        return;
      }
      if (reason?.message?.includes('Queue is empty')) {
        return;
      }

      // A stray rejection is a bug to fix, not a reason to take the bot down.
      // Log loudly with full context; the central task handler categorizes it.
      handleTaskError('unhandled_rejection', reason instanceof Error ? reason : new Error(String(reason)), {
        errorCode: ErrorCodes.UNHANDLED_REJECTION,
      });
    });
  };
  
  setupShutdown();
  bot.start().catch((error) => {
    logger.error('Fatal error during bot startup:', error);
    bot.shutdown('STARTUP_ERROR');
  });
} catch (error) {
  logger.error('Fatal error during bot startup:', error);
  process.exit(1);
}

export default TitanBot;
