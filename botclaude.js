const mineflayer = require("mineflayer");
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
   * NOTE: all three targets below currently share the same placeholder
   * position (4, 126, -88). This is example data only — update each
   * one to the real coordinate of the resource you want farmed before
   * running this for real, or the bot will just repeatedly check the
   * same block against three different allow-lists.
   *
   * Minecraft block names must be exact — see the allowedBlocks lists
   * below for the full, verified 1.21.x names.
   */
  targets: [
    {
      label: "Wood 1",
      position: new Vec3(4, 126, -88),
      allowedBlocks: [
        "oak_log",
        "birch_log",
        "spruce_log",
        "jungle_log",
        "acacia_log",
        "dark_oak_log",
        "mangrove_log",
        "cherry_log",
        "pale_oak_log",
        "warped_stem",
        "crimson_stem",
      ],
    },
    {
      label: "Iron 1",
      position: new Vec3(4, 126, -88),
      allowedBlocks: ["iron_ore", "deepslate_iron_ore"],
    },
    {
      label: "Coal 1",
      position: new Vec3(4, 126, -88),
      allowedBlocks: ["coal_ore", "deepslate_coal_ore"],
    },
    // Example extra targets covering the rest of the verified ore list —
    // duplicate/edit these with real coordinates as needed.
    {
      label: "Copper 1",
      position: new Vec3(4, 126, -88),
      allowedBlocks: ["copper_ore", "deepslate_copper_ore"],
    },
    {
      label: "Gold 1",
      position: new Vec3(4, 126, -88),
      allowedBlocks: ["gold_ore", "deepslate_gold_ore", "nether_gold_ore"],
    },
    {
      label: "Redstone 1",
      position: new Vec3(4, 126, -88),
      allowedBlocks: ["redstone_ore", "deepslate_redstone_ore"],
    },
    {
      label: "Lapis 1",
      position: new Vec3(4, 126, -88),
      allowedBlocks: ["lapis_ore", "deepslate_lapis_ore"],
    },
    {
      label: "Diamond 1",
      position: new Vec3(4, 126, -88),
      allowedBlocks: ["diamond_ore", "deepslate_diamond_ore"],
    },
    {
      label: "Emerald 1",
      position: new Vec3(4, 126, -88),
      allowedBlocks: ["emerald_ore", "deepslate_emerald_ore"],
    },
    {
      label: "Nether Quartz 1",
      position: new Vec3(4, 126, -88),
      allowedBlocks: ["nether_quartz_ore"],
    },
    {
      label: "Ancient Debris 1",
      position: new Vec3(4, 126, -88),
      allowedBlocks: ["ancient_debris"],
    },
  ],
};

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
  version: "1.21.11",
});

bot.loadPlugin(pathfinder);

// --------------------------------------------------
// Farming state
// --------------------------------------------------

let farming = false;
let runId = 0;
let cooldownUntil = 0;
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
   *
   * NOTE: "ms" is matched before the generic "s" alternative so that
   * e.g. "2500ms" isn't misread as 2500 seconds.
   */
  const durationMatch = message.match(
    /(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s)\b/i,
  );

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

  /*
   * Compare by item type (numeric id), not inventory slot. Mineflayer
   * can shuffle items between slots internally while equipping, so a
   * slot-based comparison can falsely think the right tool isn't held
   * (or vice versa) and cause redundant/incorrect equip calls.
   */
  if (bot.heldItem && bot.heldItem.type === tool.type) return;

  try {
    await bot.equip(tool, "hand");
    console.log(`Equipped ${tool.name}.`);
  } catch (error) {
    console.log(`Failed to equip ${tool.name}: ${error.message}`);
  }
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

    /*
     * Re-fetch and re-verify the block right before digging. The
     * equip/lookAt awaits above give other players (or the server)
     * a window to have already broken this block; digging a stale
     * reference can throw or waste time on air.
     */
    const freshBlock = bot.blockAt(target.position);

    if (!blockMatchesTarget(freshBlock, target)) {
      logTargetState(target, "block changed right before digging");
      return false;
    }

    console.log(`Mining ${target.label}: ${freshBlock.name}`);

    /*
     * bot.dig performs the normal block-breaking interaction.
     * It resolves when the block is broken or the dig is interrupted.
     */
    await bot.dig(freshBlock, false);

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

  console.log('\nConfigure your target coordinates, then type "start".');
  console.log('Available terminal commands: "start", "stop", "status".\n');

  bot.chat("IfeanyiBot is online!");
});

// --------------------------------------------------
// Cooldown detection from chat
// --------------------------------------------------

bot.on("messagestr", (message) => {
  registerCooldown(textOf(message));
});

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
