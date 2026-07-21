const mineflayer = require("mineflayer");
// const { mineflayer: mineflayerViewer } = require("prismarine-viewer");

const bot = mineflayer.createBot({
  host: "127.0.0.1",
  port: 25565,
  username: "IfeanyiBot",
  auth: "offline", // "microsoft",
   // password: '12345678',
  version: "1.21.11",
});

bot.once("spawn", () => { 
  console.log(`${bot.username} joined the server.`);
  console.log(`Position: ${bot.entity.position}`);

  // mineflayerViewer(bot, {
  //   port: 3007,
  //   firstPerson: false,
  //   viewDistance: 6,
  // });

  // console.log("Open http://localhost:3007 in your browser.");

  bot.chat("IfeanyiBot is online!");
});

bot.on("chat", (username, message) => {
  if (username === bot.username) return;

  console.log(`<${username}> ${message}`);
});

bot.on("kicked", (reason) => {
  console.error("Bot was kicked:");
  console.error(reason);
});

bot.on("error", (error) => {
  console.error("Bot error:");
  console.error(error);
});

bot.on("end", (reason) => {
  console.log(`Bot disconnected: ${reason}`);
});