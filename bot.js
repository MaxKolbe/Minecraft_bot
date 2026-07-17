const mineflayer = require("mineflayer");
const { mineflayer: mineflayerViewer } = require("prismarine-viewer");
const {
  pathfinder,
  Movements,
  goals: { GoalNear },
} = require("mineflayer-pathfinder");
const Vec3 = require("vec3");

// --------------------------------------------------
// Configuration
// --------------------------------------------------

const CONFIG = {
  viewerPort: 3007,

  // How close the bot should stand to a target block.
  miningRange: 2,

  // Small pause after successfully mining a block.
  delayBetweenBlocksMs: 300,

  // Delay before starting another scan when nothing was mined.
  idleScanDelayMs: 1000,

  // Used when the server mentions a cooldown but gives no duration.
  fallbackCooldownMs: 2000,

  /*
   * Replace these coordinates with your actual coordinates.
   *
   * Minecraft block names must be exact:
   * oak_log
   * birch_log
   * coal_ore
   * deepslate_coal_ore
   * iron_ore
   * deepslate_iron_ore
   */
  targets: [
    {
      label: "Wood 1",
      position: new Vec3(10, 64, 20),
      allowedBlocks: [
        "oak_log",
        "birch_log",
        "spruce_log",
        "jungle_log",
        "acacia_log",
        "dark_oak_log",
      ],
    },
    {
      label: "Iron 1",
      position: new Vec3(120, 63, -45),
      allowedBlocks: ["iron_ore", "deepslate_iron_ore"],
    },
    {
      label: "Coal 1",
      position: new Vec3(14, 64, 20),
      allowedBlocks: ["coal_ore", "deepslate_coal_ore"],
    },
  ],
};

// Messages that should cause an immediate safety stop.
//
// Adjust these after seeing the exact warnings used by your server.
const WARNING_PATTERN =
  /\b(warning|captcha|verification required|verify yourself|macro check|bot check|staff check|suspicious activity|are you there|stop mining)\b/i;

// Messages that indicate the server has imposed a mining cooldown.
const COOLDOWN_PATTERN =
  /\b(cooldown|too fast|slow down|try again in|wait before|mine again in)\b/i;

// --------------------------------------------------
// Bot connection
// --------------------------------------------------

const bot = mineflayer.createBot({
  host: "127.0.0.1",
  port: 25565,
  username: "IfeanyiBot",
  auth: "offline",

  // Let Mineflayer detect the server version.
  // version: "1.21.11",
});

bot.loadPlugin(pathfinder);

// --------------------------------------------------
// Farming state
// --------------------------------------------------

let farming = false;
let runId = 0;
let cooldownUntil = 0;
let lastPosition = null;
let lastStopReason = "Not started";

// Prevent repeated logs for missing blocks.
const lastTargetStates = new Map();

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isCurrentRun(id) {
  return farming && id === runId;
}

function textOf(value) {
  if (value === null || value === undefined) return "";

  try {
    return value.toString();
  } catch {
    return String(value);
  }
}

// --------------------------------------------------
// Starting and stopping
// --------------------------------------------------

function startFarming() {
  if (farming) {
    console.log("The farming loop is already running.");
    return;
  }

  if (CONFIG.targets.length === 0) {
    console.log("No target coordinates have been configured.");
    return;
  }

  farming = true;
  lastStopReason = null;
  cooldownUntil = 0;
  lastPosition = bot.entity?.position?.clone() ?? null;

  const currentRunId = ++runId;

  console.log("\nFarming started.");
  console.log('Type "stop" in this terminal to stop it manually.\n');

  farmLoop(currentRunId).catch((error) => {
    if (!isCurrentRun(currentRunId)) return;

    console.error("Unexpected farming error:", error);
    emergencyStop(`Unexpected error: ${error.message}`);
  });
}

function emergencyStop(reason) {
  const wasRunning = farming;

  farming = false;
  runId += 1;
  lastStopReason = reason;

  // Immediately cancel pathfinding.
  try {
    bot.pathfinder.setGoal(null);
  } catch {
    // Ignore if Pathfinder was not active.
  }

  // Stop normal movement controls.
  bot.clearControlStates();

  // Stop an active mining attempt.
  try {
    if (bot.targetDigBlock) {
      bot.stopDigging();
    }
  } catch {
    // Ignore if there was no current dig.
  }

  if (wasRunning) {
    console.error("\n======================================");
    console.error("FARMING STOPPED");
    console.error(`Reason: ${reason}`);
    console.error("The bot will remain stopped.");
    console.error("======================================\n");
  }
}

// --------------------------------------------------
// Cooldown handling
// --------------------------------------------------

function registerCooldown(message) {
  if (!COOLDOWN_PATTERN.test(message)) return false;

  /*
   * Examples this tries to understand:
   *
   * "Try again in 5 seconds"
   * "Cooldown: 2500ms"
   * "Wait 1.5 seconds"
   */
  const durationMatch = message.match(/(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s)\b/i);

  let cooldownMs = CONFIG.fallbackCooldownMs;

  if (durationMatch) {
    const amount = Number(durationMatch[1]);
    const unit = durationMatch[2].toLowerCase();

    cooldownMs = unit.startsWith("m") ? amount : amount * 1000;
  }

  // Add a small buffer so we do not retry on the exact boundary.
  cooldownMs += 250;

  cooldownUntil = Math.max(cooldownUntil, Date.now() + cooldownMs);

  console.log(`Server cooldown detected. Waiting about ${Math.ceil(cooldownMs / 1000)} second(s).`);

  return true;
}

async function waitForCooldown(currentRunId) {
  while (isCurrentRun(currentRunId) && Date.now() < cooldownUntil) {
    const remaining = cooldownUntil - Date.now();
    await sleep(Math.min(remaining, 250));
  }
}

// --------------------------------------------------
// Warning detection
// --------------------------------------------------

function inspectServerText(source, rawText) {
  const message = textOf(rawText).trim();

  if (!message) return;

  // Warnings take priority over cooldown messages.
  if (WARNING_PATTERN.test(message)) {
    emergencyStop(`${source} warning detected: ${message}`);
    return;
  }

  registerCooldown(message);
}

// --------------------------------------------------
// Movement and mining
// --------------------------------------------------

async function moveNearTarget(target, currentRunId) {
  if (!isCurrentRun(currentRunId)) return false;

  console.log(
    `Moving near ${target.label} at ${target.position.x}, ${target.position.y}, ${target.position.z}`,
  );

  try {
    await bot.pathfinder.goto(
      new GoalNear(target.position.x, target.position.y, target.position.z, CONFIG.miningRange),
    );

    return isCurrentRun(currentRunId);
  } catch (error) {
    if (!isCurrentRun(currentRunId)) return false;

    console.log(`Could not reach ${target.label}: ${error.message}`);
    return false;
  }
}

function blockMatchesTarget(block, target) {
  return Boolean(block && target.allowedBlocks.includes(block.name));
}

function logTargetState(target, state) {
  const previousState = lastTargetStates.get(target.label);

  if (previousState === state) return;

  lastTargetStates.set(target.label, state);
  console.log(`${target.label}: ${state}`);
}

async function equipBestTool(block) {
  const tool = bot.pathfinder.bestHarvestTool(block);

  if (!tool) {
    console.log(`No special tool found for ${block.name}; using current hand.`);
    return;
  }

  if (bot.heldItem?.slot === tool.slot) return;

  await bot.equip(tool, "hand");

  console.log(`Equipped ${tool.name}.`);
}

async function processTarget(target, currentRunId) {
  if (!isCurrentRun(currentRunId)) return false;

  await waitForCooldown(currentRunId);

  if (!isCurrentRun(currentRunId)) return false;

  let block = bot.blockAt(target.position);

  /*
   * null means the chunk containing the coordinate may not currently
   * be loaded. Move toward it and check again.
   */
  if (!block) {
    const reached = await moveNearTarget(target, currentRunId);

    if (!reached) return false;

    block = bot.blockAt(target.position);
  }

  if (!block) {
    logTargetState(target, "coordinate is not loaded");
    return false;
  }

  /*
   * Air or another block means the resource probably has not
   * respawned yet. Skip it and check again on the next loop.
   */
  if (!blockMatchesTarget(block, target)) {
    logTargetState(target, `waiting for respawn; currently found "${block.name}"`);

    return false;
  }

  logTargetState(target, `found ${block.name}`);

  /*
   * canDigBlock also checks whether the bot is currently within
   * digging range.
   */
  if (!bot.canDigBlock(block) || !bot.canSeeBlock(block)) {
    const reached = await moveNearTarget(target, currentRunId);

    if (!reached) return false;

    block = bot.blockAt(target.position);

    // Re-check because the block may have changed while moving.
    if (!blockMatchesTarget(block, target)) {
      logTargetState(target, "block changed while approaching it");
      return false;
    }
  }

  if (!bot.canDigBlock(block)) {
    logTargetState(target, "block is still outside mining range");
    return false;
  }

  if (!bot.canSeeBlock(block)) {
    logTargetState(target, "block is obstructed or not visible");
    return false;
  }

  await waitForCooldown(currentRunId);

  if (!isCurrentRun(currentRunId)) return false;

  try {
    await equipBestTool(block);

    if (!isCurrentRun(currentRunId)) return false;

    // Look at the centre of the block.
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), false);

    if (!isCurrentRun(currentRunId)) return false;

    console.log(`Mining ${target.label}: ${block.name}`);

    /*
     * bot.dig performs the normal block-breaking interaction.
     * It resolves when the block is broken or the dig is interrupted.
     */
    await bot.dig(block, false);

    if (!isCurrentRun(currentRunId)) return false;

    console.log(`Finished mining ${target.label}.`);

    lastTargetStates.delete(target.label);

    await sleep(CONFIG.delayBetweenBlocksMs);

    return true;
  } catch (error) {
    if (!isCurrentRun(currentRunId)) return false;

    console.log(`Could not mine ${target.label}: ${error.message}`);

    /*
     * Some servers reject the mining attempt while a hidden
     * cooldown is active. Briefly pause before the next attempt.
     */
    cooldownUntil = Math.max(cooldownUntil, Date.now() + CONFIG.fallbackCooldownMs);

    return false;
  }
}

async function farmLoop(currentRunId) {
  while (isCurrentRun(currentRunId)) {
    let minedSomething = false;

    for (const target of CONFIG.targets) {
      if (!isCurrentRun(currentRunId)) return;

      const mined = await processTarget(target, currentRunId);

      if (mined) {
        minedSomething = true;
      }
    }

    /*
     * When every block is missing, avoid constantly polling
     * the server while waiting for the resources to respawn.
     */
    if (!minedSomething && isCurrentRun(currentRunId)) {
      await sleep(CONFIG.idleScanDelayMs);
    }
  }
}

// --------------------------------------------------
// Spawn setup
// --------------------------------------------------

bot.once("spawn", () => {
  console.log(`${bot.username} joined the server.`);
  console.log(`Position: ${bot.entity.position}`);

  const movements = new Movements(bot);

  // Do not destroy unrelated blocks while navigating.
  movements.canDig = false;

  // Avoid unusual or risky movement.
  movements.allow1by1towers = false;
  movements.allowParkour = false;
  movements.allowSprinting = false;

  bot.pathfinder.setMovements(movements);

  mineflayerViewer(bot, {
    port: CONFIG.viewerPort,
    firstPerson: false,
    viewDistance: 6,
  });

  console.log(`Open http://localhost:${CONFIG.viewerPort} in your browser.`);

  console.log('\nConfigure your target coordinates, then type "start".');
  console.log('Available terminal commands: "start", "stop", "status".\n');

  bot.chat("IfeanyiBot is online!");
});

// --------------------------------------------------
// Safety events
// --------------------------------------------------

bot.on("forcedMove", () => {
  if (!farming) return;

  const position = bot.entity?.position;

  emergencyStop(`The server force-moved or teleported the bot${position ? ` to ${position}` : ""}`);
});

/*
 * Backup teleport detector.
 *
 * A normal player cannot move several blocks between consecutive
 * physics ticks. This catches large sudden position changes.
 */
bot.on("physicsTick", () => {
  if (!bot.entity) return;

  const currentPosition = bot.entity.position.clone();

  if (farming && lastPosition && currentPosition.distanceTo(lastPosition) > 6) {
    emergencyStop(`Sudden position change detected: ${lastPosition} -> ${currentPosition}`);
  }

  lastPosition = currentPosition;
});

/*
 * This bot does not intentionally open chests or menus.
 * Therefore any GUI opening while farming is treated as suspicious.
 */
bot.on("windowOpen", (window) => {
  if (!farming) return;

  const title = textOf(window?.title) || "unknown window";

  emergencyStop(`Unexpected GUI/window opened: ${title}`);
});

bot.on("title", (title, type) => {
  inspectServerText(`${type || "screen"} title`, title);
});

bot.on("actionBar", (jsonMessage) => {
  inspectServerText("action bar", jsonMessage);
});

bot.on("messagestr", (message, messagePosition, jsonMessage, sender) => {
  inspectServerText(`server message${messagePosition ? ` (${messagePosition})` : ""}`, message);
});

function inspectBossBar(bossBar) {
  inspectServerText("boss bar", bossBar?.title ?? bossBar);
}

bot.on("bossBarCreated", inspectBossBar);
bot.on("bossBarUpdated", inspectBossBar);

// --------------------------------------------------
// Existing connection events
// --------------------------------------------------

bot.on("chat", (username, message) => {
  if (username === bot.username) return;

  console.log(`<${username}> ${message}`);
});

bot.on("kicked", (reason) => {
  emergencyStop(`Bot was kicked: ${textOf(reason)}`);

  console.error("Bot was kicked:");
  console.error(reason);
});

bot.on("error", (error) => {
  console.error("Bot error:");
  console.error(error);
});

bot.on("end", (reason) => {
  emergencyStop(`Bot disconnected: ${reason}`);
  console.log(`Bot disconnected: ${reason}`);
});

// --------------------------------------------------
// Terminal controls
// --------------------------------------------------

process.stdin.setEncoding("utf8");

process.stdin.on("data", (input) => {
  const command = input.trim().toLowerCase();

  if (command === "start") {
    startFarming();
    return;
  }

  if (command === "stop") {
    emergencyStop("Stopped manually from the terminal");
    return;
  }

  if (command === "status") {
    console.log({
      farming,
      position: bot.entity?.position?.toString(),
      cooldownRemainingMs: Math.max(0, cooldownUntil - Date.now()),
      lastStopReason,
    });
    return;
  }

  if (command) {
    console.log('Unknown command. Use "start", "stop", or "status".');
  }
});
